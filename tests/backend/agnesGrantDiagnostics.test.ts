import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, uncertainOutcome } from '../../server/lib/errors'
import * as client from '../../server/providers/client'
import * as guards from '../../server/providers/urlGuard'
import * as video from '../../server/generations/adapters/video'
import { collectGenerationMediaSecrets, downloadAgnesVideo, pollAgnesVideo, readAgnesJob, startAgnesVideo } from '../../server/generations/adapters/agnes'
import type { GenerationContext } from '../../server/generations/types'

// Exercise the adapter's call/error readers without sockets, DNS, a live worker, or grant issuance.
vi.mock('../../server/providers/pool', async importOriginal => {
  const actual = await importOriginal<typeof import('../../server/providers/pool')>()
  return {
    ...actual,
    pinGenerationTarget: vi.fn(),
    submitWithPool: vi.fn(async options => {
      const target = { ...options.initial, apiKey: 'sk-selected-key-secret', credentialId: 'credential' }
      options.onAttempt?.(target)
      return { target, response: await options.call(target), attempts: 1, exhausted: false }
    }),
  }
})

const token = 'abcdef0123456789'.repeat(4)
const grant = `https://studio.example/api/provider-media/${token}`
const apiKey = 'sk-pinned-key-secret'
const selectedKey = 'sk-selected-key-secret'
const ordinary = 'https://cdn.example/ordinary-reference.png'
const echo = `source=${grant} bearer=${token} key=${apiKey} selected=${selectedKey} ordinary=${ordinary} prompt=the blue scarf`

function context(): GenerationContext {
  return {
    generation: { id: 'g', user_id: 'u', provider_id: 'p', provider_job_id: 'job', snap_model_id: 'agnes-video-2.5-flash', prompt: 'the blue scarf', params_json: JSON.stringify({ mode: 'reference', referenceImages: [grant, ordinary] }) },
    provider: { baseUrl: 'https://provider.example/v1', apiKey, allowPrivate: false, credentialId: 'credential' },
    db: { prepare: vi.fn(() => ({ run: vi.fn() })) },
    env: {}, mediaStore: {},
  } as unknown as GenerationContext
}
function response(status: number, payload: unknown, requestId = `req-${grant}-${token}-${selectedKey}`): client.ProviderResponse {
  return {
    status, ok: status >= 200 && status < 300, headers: new Headers({ 'x-request-id': requestId }), body: null,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
    json: async () => typeof payload === 'string' ? JSON.parse(payload) : payload,
  }
}
async function caught(promise: Promise<unknown>): Promise<AppError> {
  try { await promise } catch (error) { expect(error).toBeInstanceOf(AppError); return error as AppError }
  throw new Error('Expected rejection')
}
function serialized(error: AppError): string {
  // Same diagnostic fields persisted by the worker and exposed in API error metadata.
  return JSON.stringify({ message: error.message, code: error.code, details: error.details, messageKey: error.messageKey, messageParams: error.messageParams })
}
function expectClean(value: unknown, includeSelected = true): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of [grant, token, apiKey, ...(includeSelected ? [selectedKey] : [])]) expect(text).not.toContain(secret)
}

beforeEach(() => {
  vi.spyOn(guards, 'guardProviderUrl').mockResolvedValue({ url: new URL(ordinary), addresses: [] })
  vi.spyOn(video, 'recordPinnedResult').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('Agnes temporary source grant diagnostics', () => {
  it('collects only reference-image grant URLs and their final hex token, deduplicated', () => {
    const generation = { params_json: JSON.stringify({ referenceImages: [grant, grant, ordinary, null, 4, `https://studio.example/?next=/api/provider-media/${token}`], prompt: grant, referenceAudios: [grant], firstFrame: grant }) }
    expect(collectGenerationMediaSecrets(generation)).toEqual([grant, token])
    expect(collectGenerationMediaSecrets({ params_json: '{bad-json' })).toEqual([])
    for (const params of [null, [], {}, { referenceImages: grant }]) expect(collectGenerationMediaSecrets({ params_json: JSON.stringify(params) })).toEqual([])
  })

  it('does not treat ordinary URL or prompt words as secrets', () => {
    const secrets = collectGenerationMediaSecrets(context().generation)
    const snapshot = readAgnesJob({ status: 'failed', error: echo }, false, 'job', [...secrets, apiKey, selectedKey])
    expectClean(snapshot)
    expect(snapshot.errorMessage).toContain(ordinary)
    expect(snapshot.errorMessage).toContain('the blue scarf')
  })

  it.each([503, 400])('redacts body and request-id diagnostics for HTTP %i before storage/API metadata', async status => {
    const call = vi.spyOn(client, 'callProvider').mockResolvedValue(response(status, { error: { message: echo } }))
    const error = await caught(startAgnesVideo(context()))
    expect(error.code).toBe(status === 503 ? 'OUTCOME_UNKNOWN' : 'PROVIDER_INCOMPATIBLE')
    expect(error.messageParams).toMatchObject({ detail: expect.stringContaining('source=*** bearer=***') })
    expectClean(serialized(error))
    expect(error.messageParams.detail).toContain(ordinary)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each(['malformed', 'missing-id'])('keeps 2xx %s submission unknown without echoing source grants in request ids', async kind => {
    const call = vi.spyOn(client, 'callProvider').mockResolvedValue(response(200, kind === 'malformed' ? `{${echo}` : { error: echo }))
    const error = await caught(startAgnesVideo(context()))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(error.messageKey).toBe('agnes.submit_id_unknown')
    expectClean(serialized(error))
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('redacts successful HTTP failed-job error objects', async () => {
    vi.spyOn(client, 'callProvider').mockResolvedValue(response(200, { video_id: 'job', status: 'failed', error: { message: echo } }))
    const error = await caught(startAgnesVideo(context()))
    expect(error.code).toBe('PROVIDER_INCOMPATIBLE')
    expectClean(serialized(error))
    expect(error.message).toContain(ordinary)
  })

  it('preserves unknown error semantics while scrubbing thrown submit diagnostics recursively', async () => {
    vi.spyOn(client, 'callProvider').mockRejectedValue(uncertainOutcome(echo, { cause: echo, nested: [grant] }))
    const error = await caught(startAgnesVideo(context()))
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expectClean(serialized(error))
  })

  it('redacts before the 500-char boundary, including a partially cut grant token', async () => {
    const raw = `${'x'.repeat(490)}${grant} ${token} ${apiKey}`
    vi.spyOn(client, 'callProvider').mockResolvedValue(response(503, raw))
    const error = await caught(startAgnesVideo(context()))
    expect(error.messageParams.detail).toBe(`${'x'.repeat(490)}*** *** **`.slice(0, 500))
    expectClean(serialized(error))
  })

  it.each(['poll', 'download'])('redacts %s HTTP failures before pinned credential diagnostics are recorded', async operation => {
    const ctx = context()
    ctx.generation.provider_result_url = operation === 'download' ? 'https://cdn.example/result.mp4' : null
    vi.spyOn(client, 'callProvider').mockResolvedValue(response(503, { error: { message: echo.replace(selectedKey, 'selected') } }))
    const error = await caught(operation === 'poll' ? pollAgnesVideo(ctx) : downloadAgnesVideo(ctx))
    expectClean(serialized(error), false)
    const recorded = vi.mocked(video.recordPinnedResult).mock.calls[0]?.[1]
    expectClean(recorded, false)
    expect(recorded).toMatchObject({ status: 503, message: expect.stringContaining('source=*** bearer=***') })
  })

  it.each(['poll', 'download'])('redacts %s network failures before pinned credential storage', async operation => {
    const ctx = context()
    ctx.generation.provider_result_url = operation === 'download' ? 'https://cdn.example/result.mp4' : null
    vi.spyOn(client, 'callProvider').mockRejectedValue(new Error(echo.replace(selectedKey, 'selected')))
    const error = await caught(operation === 'poll' ? pollAgnesVideo(ctx) : downloadAgnesVideo(ctx))
    expectClean(serialized(error), false)
    expectClean(vi.mocked(video.recordPinnedResult).mock.calls[0]?.[1], false)
  })

  it('redacts poll parser exceptions and failed-job error messages', async () => {
    const res = response(200, {})
    res.json = async () => { throw new Error(echo.replace(selectedKey, 'selected')) }
    vi.spyOn(client, 'callProvider').mockResolvedValueOnce(res).mockResolvedValueOnce(response(200, { status: 'failed', error: echo.replace(selectedKey, 'selected') }))
    expectClean(serialized(await caught(pollAgnesVideo(context()))), false)
    const snapshot = await pollAgnesVideo(context())
    expect(snapshot.state).toBe('failed')
    expectClean(snapshot, false)
  })

  it.each(['submit', 'poll'])('does not echo invalid %s result URLs or URL guard diagnostics', async operation => {
    vi.spyOn(client, 'callProvider').mockResolvedValue(response(200, { video_id: 'job', status: 'completed', url: `https://${token}.invalid/${apiKey}` }))
    vi.mocked(guards.guardProviderUrl).mockImplementation(async url => {
      if (url.includes('.invalid')) throw new Error(echo)
      return { url: new URL(url), addresses: [] }
    })
    const error = await caught(operation === 'submit' ? startAgnesVideo(context()) : pollAgnesVideo(context()))
    expect(error.messageKey).toBe('agnes.invalid_result_url')
    expectClean(serialized(error))
  })

  it('redacts download stream failures without changing their AppError semantics', async () => {
    const ctx = context(); ctx.generation.provider_result_url = 'https://cdn.example/result.mp4'
    vi.spyOn(client, 'callProvider').mockResolvedValue(response(200, {}))
    vi.spyOn(video, 'readVideoContent').mockRejectedValue(new AppError(413, 'STORAGE_LIMIT', echo.replace(selectedKey, 'selected')))
    const error = await caught(downloadAgnesVideo(ctx))
    expect(error.code).toBe('STORAGE_LIMIT')
    expectClean(serialized(error), false)
  })
})

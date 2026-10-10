import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../../server/db/index'
import type { AppEnv } from '../../server/env'
import type { Worker } from '../../server/generations/worker'
import { AppError, badRequest, errorMeta } from '../../server/lib/errors'
import { readWithPool } from '../../server/providers/pool'
import { addCredential, listCredentials } from '../../server/providers/credentials'
import { callProvider, type ProviderResponse } from '../../server/providers/client'
import { enqueueGeneration } from '../../server/generations/enqueue'
import { sweepAutoGenerate } from '../../server/generations/sweeper'
import { call, registerUser, seedProviderAndModel, startTestServer, type TestContext } from './helpers'

vi.mock('../../server/providers/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/providers/client')>(),
  callProvider: vi.fn(),
}))
vi.mock('../../server/generations/enqueue', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../server/generations/enqueue')>(),
  enqueueGeneration: vi.fn(),
}))

const contexts: TestContext[] = []
afterEach(async () => {
  vi.resetAllMocks()
  for (const context of contexts.splice(0)) await context.close()
})

function response(status: number, payload: unknown): ProviderResponse {
  return {
    status, ok: status >= 200 && status < 300, headers: new Headers(), body: null,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

async function poolFixture() {
  const context = await startTestServer()
  contexts.push(context)
  const { userId } = await registerUser(context)
  const { providerId } = await seedProviderAndModel(context, 'video')
  const first = listCredentials(context.db, userId, providerId)[0]!
  const second = addCredential(context.db, context.env, userId, providerId, { apiKey: 'sk-second-regression-key' })
  return { context, userId, providerId, first, second }
}

describe('pool read response/target consistency', () => {
  it.each([401, 403, 429, 503])('throws the terminal transport failure after HTTP %i', async (status) => {
    const { context, providerId, first, second } = await poolFixture()
    const retained = response(status, { error: { message: 'upstream failure' } })
    const failure = new Error('transport failure')
    const attempts: string[] = []
    await expect(readWithPool({
      db: context.db, env: context.env, providerId, maxAttempts: 2,
      call: async (target) => {
        attempts.push(target.credentialId)
        if (target.credentialId === first.id) return retained
        throw failure
      },
    })).rejects.toBe(failure)
    expect(attempts).toEqual([first.id, second.id])
  })

  it('throws when every read attempt fails before an HTTP response', async () => {
    const { context, providerId } = await poolFixture()
    const failure = new Error('no HTTP response')
    await expect(readWithPool({
      db: context.db, env: context.env, providerId,
      call: async () => { throw failure },
    })).rejects.toBe(failure)
  })
})

describe('provider routes exhausted upstream failures', () => {
  it.each(['test', 'sync-models', 'credentials'])('%s reports sanitized upstream 5xx, not unavailable credentials', async (route) => {
    const { context, providerId, first } = await poolFixture()
    context.env.PROVIDER_MODE = 'live'
    vi.mocked(callProvider).mockImplementation(async (target) => response(503, {
      error: { message: `Service unavailable ${target.apiKey}` },
    }))
    const path = route === 'credentials' ? `credentials/${first.id}/test` : route
    const result = await call(context, `/api/providers/${providerId}/${path}`, { method: 'POST' })
    expect(result.status).toBe(502)
    expect(result.body.error.messageKey).toBe('providers.models_list_failed')
    expect(JSON.stringify(result.body)).toContain('Service unavailable')
    expect(JSON.stringify(result.body)).not.toContain('sk-mock-key-for-tests')
    expect(JSON.stringify(result.body)).not.toContain('sk-second-regression-key')
    if (route !== 'credentials') {
      const row = context.db.prepare('SELECT last_error_key FROM provider_connections WHERE id = ?').get(providerId) as { last_error_key: string }
      expect(row.last_error_key).toBe('providers.models_list_failed')
    }
  })
})

function sweeperFixture(params: string[] = ['{}', '{}']) {
  const scenes = params.map((params_json, index) => ({
    id: `scene-${index}`, project_id: 'project', position: index,
    character_id: null, model_id: 'model', prompt: 'valid prompt', params_json,
    dialogue: '', background: '',
  }))
  const cleared: string[] = []
  const db = {
    prepare(sql: string) {
      return {
        all: () => sql.includes('SELECT DISTINCT') ? [{ userId: 'user' }]
          : sql.includes('SELECT s.*') ? scenes : [],
        get: () => sql.includes('COUNT(*)') ? { total: 0 } : undefined,
        run: (_time: number, id: string) => { cleared.push(id) },
      }
    },
  } as unknown as Database
  const env = { MAX_CONCURRENT_JOBS_PER_USER: 2 } as AppEnv
  const worker = {} as Worker
  return { db, env, worker, cleared }
}

describe('auto-generation sweeper scene error isolation', () => {
  it('continues after malformed params JSON and retains the broken scene flag', () => {
    const fixture = sweeperFixture(['{broken', '{}'])
    expect(sweepAutoGenerate(fixture)).toBe(1)
    expect(vi.mocked(enqueueGeneration)).toHaveBeenCalledTimes(1)
    expect(fixture.cleared).toEqual(['scene-1'])
  })

  it('continues after schema-invalid params and retains the invalid scene flag', () => {
    const fixture = sweeperFixture(['[]', '{}'])
    expect(sweepAutoGenerate(fixture)).toBe(1)
    expect(fixture.cleared).toEqual(['scene-1'])
  })

  it('continues after a scene-local enqueue error without consuming a slot', () => {
    const fixture = sweeperFixture(['{}', '{}', '{}'])
    vi.mocked(enqueueGeneration).mockImplementationOnce(() => { throw new Error('invalid model') })
    expect(sweepAutoGenerate(fixture)).toBe(2)
    expect(vi.mocked(enqueueGeneration)).toHaveBeenCalledTimes(3)
    expect(fixture.cleared).toEqual(['scene-1', 'scene-2'])
  })

  it('stops only for typed active-job capacity exhaustion', () => {
    const fixture = sweeperFixture()
    vi.mocked(enqueueGeneration).mockImplementationOnce(() => {
      throw badRequest('capacity reached', undefined, errorMeta('generations.too_many_active_jobs'))
    })
    expect(sweepAutoGenerate(fixture)).toBe(0)
    expect(vi.mocked(enqueueGeneration)).toHaveBeenCalledTimes(1)
    expect(fixture.cleared).toEqual([])
  })

  it('does not mistake an untyped lookalike error for capacity exhaustion', () => {
    const fixture = sweeperFixture()
    vi.mocked(enqueueGeneration).mockImplementationOnce(() => {
      throw Object.assign(new Error('not an AppError'), { messageKey: 'generations.too_many_active_jobs' })
    })
    expect(sweepAutoGenerate(fixture)).toBe(1)
    expect(fixture.cleared).toEqual(['scene-1'])
  })

  it('continues after other typed enqueue errors', () => {
    const fixture = sweeperFixture()
    vi.mocked(enqueueGeneration).mockImplementationOnce(() => {
      throw new AppError(400, 'BAD_REQUEST', 'invalid scene')
    })
    expect(sweepAutoGenerate(fixture)).toBe(1)
    expect(fixture.cleared).toEqual(['scene-1'])
  })
})

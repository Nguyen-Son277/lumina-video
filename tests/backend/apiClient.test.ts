import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, assertResponseOk } from '../../src/api/client'
import { characterApi, generationApi, modelApi, providerApi, uploadApi } from '../../src/api/endpoints'
import { entityLibraryApi } from '../../src/api/entityLibrary'
import { projectItemsApi } from '../../src/api/canvas'
import { planLocationsApi, projectLocationsApi } from '../../src/api/locations'
import { plannerApi } from '../../src/api/planner'
import { projectsApi } from '../../src/api/projects'

// Node-only transport tests: every request is intercepted, with no server or persisted data.
const fetchMock = vi.fn<typeof fetch>()
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authenticated JSON and raw-upload transport', () => {
  it('preserves JSON serialization, cookies, method, path and signal', async () => {
    const signal = new AbortController().signal
    const payload = { nested: { value: false }, count: 0 }
    fetchMock.mockResolvedValueOnce(jsonResponse({ saved: true }))

    await expect(api.post('/records?mode=exact', payload, signal)).resolves.toEqual({ saved: true })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/records?mode=exact', {
      method: 'POST', credentials: 'include', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
  })

  it('does not add JSON headers or a body for a bodyless request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await api.post('/bodyless')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/bodyless', {
      method: 'POST', credentials: 'include', signal: undefined, headers: undefined, body: undefined,
    })
  })

  it('keeps DELETE body options and cancellation for revision-checked operations', async () => {
    const signal = new AbortController().signal
    fetchMock.mockResolvedValueOnce(jsonResponse({ removed: true }))
    await expect(api.delete('/variants/a', { body: { revision: 7 }, signal })).resolves.toEqual({ removed: true })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/variants/a', {
      method: 'DELETE', credentials: 'include', signal,
      headers: { 'Content-Type': 'application/json' }, body: '{"revision":7}',
    })
  })

  it('sends the original file object with its MIME type and abort signal', async () => {
    const file = new File(['raw-image-bytes'], 'reference.png', { type: 'image/png' })
    const signal = new AbortController().signal
    fetchMock.mockResolvedValueOnce(jsonResponse({ upload: { id: 'mock-upload' } }))

    await expect(api.upload('/uploads', file, signal)).resolves.toEqual({ upload: { id: 'mock-upload' } })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/uploads', {
      method: 'POST', credentials: 'include', signal,
      headers: { 'Content-Type': 'image/png' }, body: file,
    })
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(file)
  })

  it('falls back to application/octet-stream only when the raw file has no MIME type', async () => {
    const file = new File(['raw-bytes'], 'reference')
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    await api.upload('/uploads', file)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    })
  })

  it.each(['json', 'upload'] as const)('returns undefined for 204 %s responses without reading a body', async (kind) => {
    const response = new Response(null, { status: 204 })
    const readBody = vi.spyOn(response, 'text')
    fetchMock.mockResolvedValueOnce(response)
    const request = kind === 'json' ? api.delete('/records/a') : api.upload('/uploads', new Blob(['raw']))
    await expect(request).resolves.toBeUndefined()
    expect(readBody).not.toHaveBeenCalled()
  })

  it.each(['json', 'upload'] as const)('retains existing null fallback for empty/malformed successful %s JSON', async (kind) => {
    for (const text of ['', 'not json']) {
      fetchMock.mockResolvedValueOnce(new Response(text, { status: 200 }))
      const request = kind === 'json' ? api.get('/records') : api.upload('/uploads', new Blob(['raw']))
      await expect(request).resolves.toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['json', 'upload', 'custom'] as const)('preserves semantic error metadata for %s responses', async (kind) => {
    const metadata = {
      code: 'REVISION_CONFLICT', message: 'Raw diagnostic', messageKey: 'errors.unknown',
      messageParams: { revision: 7, label: 'unchanged' }, details: { expectedRevision: 8 },
    }
    const response = jsonResponse({ error: metadata }, 409)
    fetchMock.mockResolvedValueOnce(response)
    const request = kind === 'custom' ? assertResponseOk(response)
      : kind === 'json' ? api.post('/records', {}) : api.upload('/uploads', new Blob(['raw']))
    const error: unknown = await request.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ name: 'ApiError', status: 409, ...metadata })
  })

  it.each(['json', 'upload', 'custom'] as const)('uses a stable ApiError fallback for malformed %s errors', async (kind) => {
    const response = new Response('<html>unavailable</html>', { status: 503 })
    fetchMock.mockResolvedValueOnce(response)
    const request = kind === 'custom' ? assertResponseOk(response)
      : kind === 'json' ? api.get('/records') : api.upload('/uploads', new Blob(['raw']))
    const error: unknown = await request.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 503, code: 'UNKNOWN', message: 'Request failed (503)' })
  })

  it.each(['json', 'upload'] as const)('passes network/abort failures through without retries for %s', async (kind) => {
    for (const failure of [new TypeError('mock offline'), new DOMException('mock cancellation', 'AbortError')]) {
      fetchMock.mockRejectedValueOnce(failure)
      const request = kind === 'json' ? api.get('/records') : api.upload('/uploads', new Blob(['raw']))
      await expect(request).rejects.toBe(failure)
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not consume successful custom/download responses', async () => {
    const response = new Response('kind,count\nimage,2', { headers: { 'Content-Type': 'text/csv' } })
    await assertResponseOk(response)
    expect(response.bodyUsed).toBe(false)
    expect(await (await response.blob()).text()).toBe('kind,count\nimage,2')
    await expect(assertResponseOk(new Response(null, { status: 204 }))).resolves.toBeUndefined()
  })
})

describe('backward-compatible API facades', () => {
  it('adds optional signals to provider/model/generation lists without changing query strings', async () => {
    const signal = new AbortController().signal
    fetchMock.mockImplementation(async () => jsonResponse({ providers: [], models: [], generations: [] }))
    await providerApi.list(signal)
    await modelApi.list(undefined, signal)
    await modelApi.list('video', signal)
    await generationApi.list({ kind: 'video', quickSessionId: 'session /', projectId: 'project /', limit: 0 }, signal)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/providers', '/api/models', '/api/models?kind=video',
      '/api/generations?kind=video&quickSessionId=session+%2F&projectId=project+%2F&limit=0',
    ])
    for (const [, options] of fetchMock.mock.calls) expect(options?.signal).toBe(signal)

    await providerApi.list()
    await modelApi.list()
    await generationApi.list()
    expect(fetchMock.mock.calls.slice(4).map(([path]) => path)).toEqual(['/api/providers', '/api/models', '/api/generations'])
  })

  it('removes a project character with encoded ids, cookies, no body and a 204 response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(projectsApi.removeCharacter('project /', 'character /')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/projects/project%20%2F/characters/character%20%2F', {
      method: 'DELETE', credentials: 'include', headers: undefined, body: undefined, signal: undefined,
    })
  })

  it('keeps revision bodies on both planner variant DELETE facades', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ session: { id: 'mock-session' } }))
    await plannerApi.removeVariant('plan /', 'cast /', 'variant /', 7)
    await plannerApi.removeVariantPortrait('plan /', 'cast /', 'variant /', 8)
    expect(fetchMock.mock.calls.map(([path, options]) => ({ path, method: options?.method, body: options?.body }))).toEqual([
      { path: '/api/plans/plan%20%2F/cast/cast%20%2F/variants/variant%20%2F', method: 'DELETE', body: '{"revision":7}' },
      { path: '/api/plans/plan%20%2F/cast/cast%20%2F/variants/variant%20%2F/portrait', method: 'DELETE', body: '{"revision":8}' },
    ])
  })

  it('keeps upload result unwrapping in source-upload and project-item facades', async () => {
    const file = new File(['raw-image'], 'source.webp', { type: 'image/webp' })
    const signal = new AbortController().signal
    fetchMock.mockResolvedValueOnce(jsonResponse({ upload: { id: 'mock-upload' } }))
    await expect(uploadApi.upload(file, signal)).resolves.toEqual({ id: 'mock-upload' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ item: { id: 'mock-item' } }))
    await expect(projectItemsApi('project /').uploadReference('item /', file, signal)).resolves.toEqual({ id: 'mock-item' })
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/uploads', '/api/projects/project%20%2F/items/item%20%2F/reference',
    ])
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.body).toBe(file)
      expect(options?.signal).toBe(signal)
    }
  })

  it('migrates active raw upload facades without changing encoded paths or request bodies', async () => {
    const file = new File(['raw-image'], 'source.png', { type: 'image/png' })
    fetchMock.mockImplementation(async () => jsonResponse({ character: {}, asset: {}, session: {}, locations: [] }))
    await characterApi.uploadReference('character /', file)
    await projectsApi.uploadCharacterReference('project /', 'character /', file)
    await entityLibraryApi.uploadReference('asset /', file)
    await planLocationsApi('plan /').upload('location /', file)
    await projectLocationsApi('project /').upload('location /', file)
    await plannerApi.uploadPortrait('plan /', 'cast /', file)
    await plannerApi.uploadBackground('plan /', 'frame /', file)
    await plannerApi.uploadVariantPortrait('plan /', 'cast /', 'variant /', file, 7)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/shared-characters/character%20%2F/reference',
      '/api/projects/project%20%2F/characters/character%20%2F/reference',
      '/api/entity-library/assets/asset%20%2F/reference',
      '/api/plans/plan%20%2F/locations/location%20%2F/reference/upload',
      '/api/projects/project%20%2F/locations/location%20%2F/reference/upload',
      '/api/plans/plan%20%2F/cast/cast%20%2F/portrait/upload',
      '/api/plans/plan%20%2F/timeline/frame%20%2F/background/upload',
      '/api/plans/plan%20%2F/cast/cast%20%2F/variants/variant%20%2F/portrait/upload?revision=7',
    ])
    for (const [, options] of fetchMock.mock.calls) {
      expect(options).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'image/png' } })
      expect(options?.body).toBe(file)
    }
  })

  it('keeps analysis query/payload shape and forwards abort signals', async () => {
    const file = new File(['raw-image'], 'source.png', { type: 'image/png' })
    const signal = new AbortController().signal
    fetchMock.mockImplementation(async () => jsonResponse({ suggestion: { name: 'mock' } }))
    await characterApi.analyzeReference(file, 'model /', 'vi', signal)
    await entityLibraryApi.analyzeReference(file, 'item', 'model /', signal)
    await entityLibraryApi.analyzeExistingReference('asset /', 'model /', signal)
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/shared-characters/analyze-reference?modelId=model+%2F&language=vi',
      '/api/entity-library/analyze-reference?kind=item&modelId=model+%2F',
      '/api/entity-library/assets/asset%20%2F/analyze-reference',
    ])
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(file)
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(file)
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json' }, body: '{"modelId":"model /"}',
    })
    for (const [, options] of fetchMock.mock.calls) expect(options?.signal).toBe(signal)
  })
})

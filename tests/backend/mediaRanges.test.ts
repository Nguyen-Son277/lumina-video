import { afterAll, beforeAll, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'

let ctx: TestContext
let url: string
let bytes: Uint8Array

beforeAll(async () => {
  ctx = await startTestServer()
  await registerUser(ctx)
  const { modelPk } = await seedProviderAndModel(ctx, 'image')
  const created = await call(ctx, '/api/generations', {
    method: 'POST', body: { modelId: modelPk, prompt: 'Range regression' },
  })
  const done = await waitForGeneration(ctx, created.body.generation.id)
  url = `${ctx.baseUrl}${done.assets[0].url}`
  const response = await fetch(url, { headers: { Cookie: ctx.cookie } })
  bytes = new Uint8Array(await response.arrayBuffer())
})

afterAll(async () => { if (ctx) await ctx.close() })

it.each(['bytes=0-3', 'bytes=4-7', 'bytes=4-', 'bytes=-4', 'bytes=0-999999', 'bytes=-999999'])(
  'streams exactly the declared range: %s', async (range) => {
    const [left, right] = range.slice(6).split('-')
    const start = left ? Number(left) : Math.max(0, bytes.length - Number(right))
    const end = left && right ? Math.min(Number(right), bytes.length - 1) : bytes.length - 1
    const response = await fetch(url, { headers: { Cookie: ctx.cookie, Range: range } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
    expect(response.headers.get('content-length')).toBe(String(end - start + 1))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(start, end + 1))
  },
)

it.each(['bytes=-0', 'bytes=-', 'bytes=999999-', 'bytes=7-4', 'bytes=9007199254740992-'])(
  'rejects unsatisfiable range: %s', async (range) => {
    const response = await fetch(url, { headers: { Cookie: ctx.cookie, Range: range } })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  },
)

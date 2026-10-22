import { afterAll, beforeAll, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { MOCK_PNG_BYTES } from '../../server/generations/adapters/mock'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { await ctx.close() })
async function upload(bytes: Uint8Array = MOCK_PNG_BYTES) {
  const response = await fetch(`${ctx.baseUrl}/api/uploads`, { method: 'POST',
    headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: bytes })
  expect(response.status).toBe(201)
  return ((await response.json()) as { upload: { id: string } }).upload
}
it('adopts an owned prepared image without download/reupload and preserves original bytes', async () => {
  await registerUser(ctx)
  const source = await upload()
  const prepared = await call(ctx, '/api/image-editor/sources', { method: 'POST', body: { source: { kind: 'upload', id: source.id } } })
  const created = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Edited image character', appearance: 'Blue design' } })
  const attached = await call(ctx, `/api/shared-characters/${created.body.character.id}/reference/from-upload`, {
    method: 'POST', body: { uploadId: prepared.body.source.uploadId } })
  expect(attached.status).toBe(201)
  const original = ctx.db.prepare('SELECT relative_path FROM uploads WHERE id=?').get(source.id)!
  expect(Buffer.from(ctx.mediaStore.readFile(String(original.relative_path)))).toEqual(Buffer.from(MOCK_PNG_BYTES))
  const served = await fetch(`${ctx.baseUrl}${attached.body.character.referenceUrl}`, { headers: { Cookie: ctx.cookie } })
  expect(served.status).toBe(200)
  expect(served.headers.get('content-type')).toBe('image/png')
})
it('rejects foreign uploads, foreign characters, malformed images and oversized references', async () => {
  await registerUser(ctx)
  const foreign = await upload()
  const foreignCharacter = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Foreign' } })).body.character
  await registerUser(ctx)
  const own = await upload()
  const character = (await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Owned' } })).body.character
  const attach = (id: string, uploadId: string) => call(ctx, `/api/shared-characters/${id}/reference/from-upload`, { method: 'POST', body: { uploadId } })
  expect((await attach(character.id, foreign.id)).status).toBe(404)
  expect((await attach(foreignCharacter.id, own.id)).status).toBe(404)
  const broken = new Uint8Array([...MOCK_PNG_BYTES.slice(0, 8), 0, 0, 0])
  expect((await attach(character.id, (await upload(broken)).id)).status).toBe(400)
  const previous = ctx.env.MAX_REFERENCE_BYTES
  try { ctx.env.MAX_REFERENCE_BYTES = 1; expect((await attach(character.id, own.id)).status).toBe(400) }
  finally { ctx.env.MAX_REFERENCE_BYTES = previous }
})

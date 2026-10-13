import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, seedProviderAndModel, startTestServer, waitForGeneration, type TestContext } from './helpers'
import { updatePromptDocument, type PromptDocument } from '../../shared/promptMentions'
import { openDatabase } from '../../server/db/index'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

function document(entityId: string): PromptDocument {
  // Leading/trailing whitespace and an astral symbol prove offsets are UTF-16,
  // not code-point indices and not indices into a silently trimmed string.
  const text = '  🎬 @lan bước vào khung hình.\n '
  const start = text.indexOf('@lan')
  return { version: 1, text, mentions: [{ id: 'occurrence-1', start, end: start + 4, label: 'lan', entity: { kind: 'character', id: entityId } }] }
}

async function createSession(promptDocument?: PromptDocument) {
  const result = await call(ctx, '/api/quick-sessions', { method: 'POST', body: { title: 'Mentions', ...(promptDocument ? { promptDocument } : {}) } })
  expect(result.status).toBe(201)
  return result.body.session
}

async function character() {
  const result = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Lan', appearance: 'Áo xanh' } })
  expect(result.status).toBe(201)
  return result.body.character.id as string
}

describe('Quick-session prompt documents', () => {
  it('persists exact text, spans and IDs through list/get and reopening the database', async () => {
    await registerUser(ctx)
    const doc = document('draft-entity')
    const session = await createSession(doc)
    expect(session.promptDocument).toEqual(doc)
    expect((await call(ctx, `/api/quick-sessions/${session.id}`)).body.session.promptDocument).toEqual(doc)
    const listed = await call(ctx, '/api/quick-sessions')
    expect(listed.body.sessions.find((item: { id: string }) => item.id === session.id).promptDocument).toEqual(doc)
    const reopened = openDatabase(ctx.env.DATABASE_PATH)
    try {
      const row = reopened.prepare('SELECT prompt_document_json FROM quick_sessions WHERE id = ?').get(session.id) as { prompt_document_json: string }
      expect(JSON.parse(row.prompt_document_json)).toEqual(doc)
    } finally { reopened.close() }
  })

  it('stores structural drafts including unresolved references and clears with an empty document', async () => {
    await registerUser(ctx)
    const session = await createSession()
    expect(session.promptDocument).toBeNull()
    const draft: PromptDocument = { version: 1, text: '@NotChosen and @Gone', mentions: [{ id: 'gone-binding', start: 15, end: 20, label: 'Gone', entity: { kind: 'logo', id: 'removed-logo' } }] }
    const patched = await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { promptDocument: draft } })
    expect(patched.status).toBe(200)
    expect(patched.body.session.promptDocument).toEqual(draft)
    const empty: PromptDocument = { version: 1, text: '', mentions: [] }
    expect((await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { promptDocument: empty } })).body.session.promptDocument).toEqual(empty)
  })

  it('retains a generation document for editing after entity rename without rebinding by label', async () => {
    await registerUser(ctx)
    const id = await character()
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const doc = document(id)
    const session = await createSession(doc)
    const created = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: doc.text, promptDocument: doc, quickSessionId: session.id } })
    expect(created.status, JSON.stringify(created.body)).toBe(202)
    const firstId = created.body.generation.id as string
    await waitForGeneration(ctx, firstId)
    expect((await call(ctx, `/api/shared-characters/${id}`, { method: 'PATCH', body: { name: 'Mai', appearance: 'Áo xanh' } })).status).toBe(200)
    const recent = await call(ctx, `/api/generations?quickSessionId=${session.id}`)
    const saved = recent.body.generations.find((item: { id: string }) => item.id === firstId)
    expect(saved.promptDocument).toEqual(doc)
    expect(saved.prompt).toBe(doc.text)
    const edited = updatePromptDocument(saved.promptDocument, `${saved.promptDocument.text} Ánh sáng vàng.`)
    expect(edited.mentions[0]).toEqual(doc.mentions[0])
    expect((await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { promptDocument: edited } })).status).toBe(200)
    const next = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: edited.text, promptDocument: edited, quickSessionId: session.id } })
    expect(next.status).toBe(202)
    expect(next.body.generation.promptDocument).toEqual(edited)
    expect((await call(ctx, `/api/generations/${firstId}`)).body.generation.promptDocument).toEqual(doc)
  })

  it('rejects invalid spans on create/update without overwriting the previous document', async () => {
    await registerUser(ctx)
    const doc = document('draft')
    const session = await createSession(doc)
    const bad = { ...doc, mentions: [{ ...doc.mentions[0], start: doc.mentions[0]!.start - 1 }] }
    expect((await call(ctx, '/api/quick-sessions', { method: 'POST', body: { promptDocument: bad } })).status).toBe(400)
    expect((await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { title: 'Bad', promptDocument: bad } })).status).toBe(400)
    const unchanged = (await call(ctx, `/api/quick-sessions/${session.id}`)).body.session
    expect(unchanged.promptDocument).toEqual(doc)
    expect(unchanged.title).toBe('Mentions')
    for (const value of [null, { version: 2, text: '', mentions: [] }, { version: 1, text: 'x'.repeat(8001), mentions: [] }]) {
      expect((await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { promptDocument: value } })).status).toBe(400)
    }
  })

  it('rejects generation document/text mismatch rather than trimming its span offsets', async () => {
    await registerUser(ctx)
    const id = await character()
    const doc = document(id)
    const { modelPk } = await seedProviderAndModel(ctx, 'image')
    const result = await call(ctx, '/api/generations', { method: 'POST', body: { modelId: modelPk, prompt: doc.text.trim(), promptDocument: doc } })
    expect(result.status).toBe(400)
  })

  it('isolates saved draft documents by session owner', async () => {
    await registerUser(ctx)
    const session = await createSession(document('owner-entity'))
    await registerUser(ctx)
    expect((await call(ctx, `/api/quick-sessions/${session.id}`)).status).toBe(404)
    expect((await call(ctx, `/api/quick-sessions/${session.id}`, { method: 'PATCH', body: { promptDocument: { version: 1, text: '', mentions: [] } } })).status).toBe(404)
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { insertPromptMention } from '../../shared/promptMentions'
import { normalizeProfile, normalizeVariant } from '../../server/planner/characterVariants'
import type { CharacterRow } from '../../server/projects/service'

let ctx: TestContext
let userId: string
beforeAll(async () => { ctx = await startTestServer(); userId = (await registerUser(ctx)).userId })
afterAll(async () => { await ctx?.close() })
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
const castId = 'planned-actor'
function character(id: string): CharacterRow {
  return ctx.db.prepare('SELECT * FROM characters WHERE id = ?').get(id) as CharacterRow
}
async function setup(storage: 'project' | 'library' = 'project', appearance = 'Áo đỏ', voice = { pitch: 'low', accent: 'north' }) {
  const original = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Lan', appearance, voice } })
  expect(original.status).toBe(201)
  const characterId = original.body.character.id as string
  const created = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
  const sessionId = created.body.session.id as string
  const saved = await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'PUT', body: { cast: [{ id: castId, name: 'Lan', appearance, voice, storage, reuseCharacterId: characterId }] } })
  expect(saved.status).toBe(200)
  const document = insertPromptMention({ version: 1, text: 'See ', mentions: [] }, 4, 4, { kind: 'character', id: characterId }, 'Lan')
  const timeline = await call(ctx, `/api/plans/${sessionId}/timeline`, { method: 'PUT', body: { frames: [{
    id: 'frame', title: 'Scene', context: 'Room', action: document.text, dialogue: 'Hello', speaker: 'Lan', speakerCastId: castId,
    characters: ['Lan'], durationSeconds: 8, blocking: [{ castId, action: 'waves', expression: '', position: 'center' }],
    mentionDocuments: { action: document },
  }] } })
  expect(timeline.status).toBe(200)
  return { sessionId, characterId, document }
}
async function addVariant(sessionId: string, appearance: string, select = true) {
  const base = `/api/plans/${sessionId}/cast/${castId}/variants`
  const result = await call(ctx, base, { method: 'POST', body: { label: 'Chosen design', profile: {}, appearance } })
  expect(result.status).toBe(201)
  const variant = result.body.session.cast[0].variants.at(-1)
  if (select) expect((await call(ctx, `${base}/${variant.id}/select`, { method: 'POST', body: { revision: variant.revision } })).status).toBe(200)
  return variant
}
async function uploadPortrait(sessionId: string, variantId: string, revision = 1, bytes = png) {
  const response = await fetch(`${ctx.baseUrl}/api/plans/${sessionId}/cast/${castId}/variants/${variantId}/portrait/upload?revision=${revision}`, {
    method: 'POST', headers: { Cookie: ctx.cookie, 'Content-Type': 'image/png' }, body: bytes,
  })
  expect(response.status).toBe(200)
  const result = await response.json() as { session: { cast: Array<{ portrait: { uploadId: string } }> } }
  return result.session.cast[0]!.portrait.uploadId
}
async function apply(sessionId: string) {
  const result = await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: { newProjectName: 'Selected design' } })
  expect(result.status, JSON.stringify(result.body)).toBe(201)
  const scene = ctx.db.prepare('SELECT character_id, context_documents_json FROM scenes WHERE id = ?').get(result.body.scenes[0].id) as { character_id: string; context_documents_json: string }
  const links = ctx.db.prepare('SELECT character_id FROM scene_characters WHERE scene_id = ?').all(result.body.scenes[0].id)
  expect(links).toEqual([{ character_id: scene.character_id }])
  return { result: result.body, scene, chosen: character(scene.character_id) }
}

describe('Applying explicitly selected planner variants', () => {
  it.each(['project', 'library'] as const)('creates a distinct %s identity for a changed selected profile and preserves the original and ID documents', async storage => {
    const { sessionId, characterId, document } = await setup(storage)
    const before = character(characterId)
    const base = `/api/plans/${sessionId}/cast/${castId}/variants`
    const variant = await call(ctx, base, { method: 'POST', body: { label: 'Blue coat', profile: { clothing: 'Áo xanh', hairStyle: 'Tóc ngắn' } } })
    const chosenVariant = variant.body.session.cast[0].variants.at(-1)
    await call(ctx, `${base}/${chosenVariant.id}/select`, { method: 'POST', body: { revision: 1 } })
    const applied = await apply(sessionId)
    expect(applied.chosen.id).not.toBe(characterId)
    expect(applied.chosen.name).toBe(before.name)
    expect(applied.chosen.appearance).toBe(chosenVariant.appearance)
    expect(applied.chosen.project_id).toBe(storage === 'project' ? applied.result.project.id : null)
    expect(character(characterId)).toEqual(before)
    expect(JSON.parse(applied.scene.context_documents_json)).toContainEqual(document)
    const session = await call(ctx, `/api/plans/${sessionId}`)
    expect(session.body.session.cast[0].variants).toHaveLength(2)
    expect(session.body.session.cast[0].selectedVariantId).toBe(chosenVariant.id)
  })

  it('does not clone for unselected proposals or for a selected variant with the same effective design', async () => {
    for (const select of [false, true]) {
      const { sessionId, characterId } = await setup()
      await addVariant(sessionId, select ? 'Áo đỏ' : 'Unused blue coat', select)
      const applied = await apply(sessionId)
      expect(applied.chosen.id).toBe(characterId)
    }
  })

  it('compares voice fields by value, not JSON order, and clones only a changed selected design', async () => {
    for (const changed of [false, true]) {
      const { sessionId, characterId } = await setup()
      await addVariant(sessionId, 'Áo đỏ')
      const current = (await call(ctx, `/api/plans/${sessionId}`)).body.session.cast[0]
      const saved = await call(ctx, `/api/plans/${sessionId}/cast`, { method: 'PUT', body: { cast: [{ ...current, voice: { accent: 'north', pitch: changed ? 'high' : 'low', habits: '' } }] } })
      expect(saved.status).toBe(200)
      const original = character(characterId)
      const applied = await apply(sessionId)
      expect(applied.chosen.id === characterId).toBe(!changed)
      if (changed) expect(JSON.parse(applied.chosen.voice_json).pitch).toBe('high')
      expect(character(characterId)).toEqual(original)
    }
  })

  it('preserves an edited original variant rather than silently reverting to the library appearance', async () => {
    const { sessionId, characterId } = await setup()
    const result = await call(ctx, `/api/plans/${sessionId}/cast/${castId}/variants/${castId}-original`, {
      method: 'PATCH', body: { label: 'Edited original', profile: {}, appearance: 'Áo vàng', revision: 1 },
    })
    expect(result.status).toBe(200)
    const applied = await apply(sessionId)
    expect(applied.chosen.id).not.toBe(characterId)
    expect(applied.chosen.appearance).toBe('Áo vàng')
    expect(character(characterId).appearance).toBe('Áo đỏ')
  })

  it('clones a selected portrait-only divergence, registers immutable media and never overwrites the library', async () => {
    const { sessionId, characterId } = await setup()
    const variant = await addVariant(sessionId, 'Áo đỏ')
    const uploadId = await uploadPortrait(sessionId, variant.id)
    const originalBytes = Buffer.concat([png, Buffer.from('original design')])
    const originalReference = ctx.mediaStore.saveCharacterReference({ userId, characterId, bytes: originalBytes, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
    ctx.db.prepare('UPDATE characters SET reference_path=?, reference_mime=?, reference_bytes=? WHERE id=?').run(originalReference.relativePath, originalReference.mimeType, originalReference.byteSize, characterId)
    const before = character(characterId)
    const applied = await apply(sessionId)
    expect(applied.chosen.id).not.toBe(characterId)
    expect(character(characterId)).toEqual(before)
    expect(ctx.mediaStore.readFile(applied.chosen.reference_path!)).toEqual(png)
    const upload = ctx.db.prepare('SELECT relative_path FROM uploads WHERE id = ?').get(uploadId) as { relative_path: string }
    expect(applied.chosen.reference_path).not.toBe(upload.relative_path)
    expect(ctx.db.prepare('SELECT path FROM immutable_media_versions WHERE path = ?').get(applied.chosen.reference_path)).toEqual({ path: applied.chosen.reference_path })
  })

  it('reuses identical portrait bytes and ignores a stale selected portrait', async () => {
    for (const stale of [false, true]) {
      const { sessionId, characterId } = await setup()
      const saved = ctx.mediaStore.saveCharacterReference({ userId, characterId, bytes: png, maxBytes: ctx.env.MAX_REFERENCE_BYTES })
      ctx.db.prepare('UPDATE characters SET reference_path=?, reference_mime=?, reference_bytes=? WHERE id=?').run(saved.relativePath, saved.mimeType, saved.byteSize, characterId)
      const variant = await addVariant(sessionId, 'Áo đỏ')
      await uploadPortrait(sessionId, variant.id, 1, stale ? Buffer.concat([png, Buffer.from('changed design')]) : png)
      if (stale) {
        // Same text edit invalidates the old portrait; normalization must hide it.
        await call(ctx, `/api/plans/${sessionId}/cast/${castId}/variants/${variant.id}`, { method: 'PATCH', body: { label: 'Edited', profile: {}, appearance: 'Áo đỏ', revision: 1 } })
      }
      const before = character(characterId)
      expect((await apply(sessionId)).chosen.id).toBe(characterId)
      expect(character(characterId)).toEqual(before)
    }
  })

  it('plain explicit reuse keeps the original even if legacy planner appearance or portrait differs', async () => {
    const { sessionId, characterId } = await setup()
    const stored = ctx.db.prepare('SELECT cast_json FROM plan_sessions WHERE id=?').get(sessionId) as { cast_json: string }
    const cast = JSON.parse(stored.cast_json)
    cast[0].appearance = 'Legacy description'
    cast[0].variants = [normalizeVariant({ id: `${castId}-original`, appearance: cast[0].appearance })]
    ctx.db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast), sessionId)
    await uploadPortrait(sessionId, `${castId}-original`)
    const before = character(characterId)
    expect((await apply(sessionId)).chosen.id).toBe(characterId)
    expect(character(characterId)).toEqual(before)
  })

  it('does not treat an initial structured original profile as an explicit variant choice', async () => {
    const { sessionId, characterId } = await setup()
    const stored = ctx.db.prepare('SELECT cast_json FROM plan_sessions WHERE id=?').get(sessionId) as { cast_json: string }
    const cast = JSON.parse(stored.cast_json)
    cast[0].variants = [normalizeVariant({ id: `${castId}-original`, profile: normalizeProfile({ clothing: 'AI suggested default coat' }) })]
    ctx.db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast), sessionId)
    expect((await apply(sessionId)).chosen.id).toBe(characterId)
  })

  it('never reintroduces same-name library lookup when reuse is not explicit', async () => {
    const { sessionId, characterId } = await setup()
    const stored = ctx.db.prepare('SELECT cast_json FROM plan_sessions WHERE id=?').get(sessionId) as { cast_json: string }
    const cast = JSON.parse(stored.cast_json)
    cast[0].reuseCharacterId = null
    ctx.db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast), sessionId)
    expect((await apply(sessionId)).chosen.id).not.toBe(characterId)
  })

  it('enforces account quota before copying a new variant portrait and rolls back apply', async () => {
    const { sessionId } = await setup()
    const variant = await addVariant(sessionId, 'Áo xanh')
    await uploadPortrait(sessionId, variant.id)
    const originalLimit = ctx.env.MAX_USER_MEDIA_BYTES
    ctx.env.MAX_USER_MEDIA_BYTES = ctx.mediaStore.userUsageBytes(ctx.db, userId)
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM characters').get()
    try {
      expect((await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: {} })).status).toBe(413)
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM characters').get()).toEqual(before)
      expect((await call(ctx, `/api/plans/${sessionId}`)).body.session.status).not.toBe('applied')
    } finally { ctx.env.MAX_USER_MEDIA_BYTES = originalLimit }
  })

  it('rejects cross-account explicit reuse before cloning and rolls back the new project', async () => {
    const { sessionId } = await setup()
    const ownerCookie = ctx.cookie
    await registerUser(ctx)
    const foreign = await call(ctx, '/api/shared-characters', { method: 'POST', body: { name: 'Lan', appearance: 'foreign', voice: {} } })
    ctx.cookie = ownerCookie
    await addVariant(sessionId, 'Different design')
    const stored = ctx.db.prepare('SELECT cast_json FROM plan_sessions WHERE id=?').get(sessionId) as { cast_json: string }
    const cast = JSON.parse(stored.cast_json)
    cast[0].reuseCharacterId = foreign.body.character.id
    ctx.db.prepare('UPDATE plan_sessions SET cast_json=? WHERE id=?').run(JSON.stringify(cast), sessionId)
    const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM projects').get()
    expect((await call(ctx, `/api/plans/${sessionId}/apply`, { method: 'POST', body: {} })).status).toBe(400)
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual(before)
    expect(character(foreign.body.character.id).appearance).toBe('foreign')
  })
})

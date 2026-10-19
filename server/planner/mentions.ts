import { z } from 'zod'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { promptDocumentSchema, resolvePromptDocument } from '../entityLibrary/mentions'
import { insertPromptMention, updatePromptDocument, validatePromptDocument, type PromptDocument } from '../../shared/promptMentions'
import type { CatalogEntity } from '../entityLibrary/service'
import type { ScriptDraft } from './artifacts'

export const MENTION_FIELDS = ['action', 'context', 'beats', 'shotNotes', 'backgroundPrompt'] as const
export type MentionField = typeof MENTION_FIELDS[number]
export type MentionDocuments = Partial<Record<MentionField, PromptDocument>>
export const mentionDocumentsSchema = z.object({
  action: promptDocumentSchema.optional(), context: promptDocumentSchema.optional(),
  beats: promptDocumentSchema.optional(), shotNotes: promptDocumentSchema.optional(),
  backgroundPrompt: promptDocumentSchema.optional(),
}).strict()
export const scriptPromptDocumentSchema = promptDocumentSchema.extend({ text: z.string().max(20000) })

/** Drafts may contain unbound/deleted mentions, but never forged or foreign bindings. */
export function validateDraftDocument(db: Database, userId: string, text: string, document: PromptDocument, projectId?: string): void {
  const issues = validatePromptDocument(document)
  if (issues.length || document.text !== text) throw badRequest('Tài liệu mention không khớp nội dung trường.', { issues })
  for (const binding of document.mentions) {
    const owned = binding.entity.kind === 'character'
      ? db.prepare('SELECT id FROM characters WHERE id = ? AND user_id = ? AND (? IS NULL OR project_id IS NULL OR project_id = ?)').get(binding.entity.id, userId, projectId ?? null, projectId ?? null)
      : db.prepare('SELECT id FROM library_assets WHERE id = ? AND user_id = ? AND kind = ?').get(binding.entity.id, userId, binding.entity.kind)
    const exists = binding.entity.kind === 'character'
      ? db.prepare('SELECT id FROM characters WHERE id = ?').get(binding.entity.id)
      : db.prepare('SELECT id FROM library_assets WHERE id = ?').get(binding.entity.id)
    const tombstone = !owned && !exists && db.prepare('SELECT id FROM entity_handles WHERE user_id = ? AND kind = ? AND entity_id = ? AND active = 0').get(userId, binding.entity.kind, binding.entity.id)
    if (!owned && !tombstone) throw badRequest('Mention trỏ tới đối tượng không thuộc phạm vi của bạn.')
  }
}

/** Preserve untouched occurrence IDs; changed text drops intersecting bindings, never binds by name. */
export function fieldMentionDocuments(
  fields: Partial<Record<MentionField, string>>, input?: MentionDocuments, previous?: MentionDocuments,
): MentionDocuments | undefined {
  const documents: MentionDocuments = {}
  for (const key of MENTION_FIELDS) {
    const text = fields[key]
    if (text === undefined) continue
    if (input?.[key]) documents[key] = input[key]
    else if (previous?.[key]) documents[key] = updatePromptDocument(previous[key], text)
  }
  return Object.keys(documents).length ? documents : undefined
}

/** Even legacy plain text is checked for unbound @, without a live-name fallback. */
export function frameContextDocuments(frame: Partial<Record<MentionField, string>> & { mentionDocuments?: MentionDocuments }): PromptDocument[] {
  return MENTION_FIELDS.flatMap(key => {
    const text = frame[key]
    if (text === undefined || (!text && !frame.mentionDocuments?.[key])) return []
    const document = frame.mentionDocuments?.[key] ?? { version: 1 as const, text, mentions: [] }
    if (document.text !== text || validatePromptDocument(document).length) throw badRequest('Tài liệu mention không khớp nội dung trường.')
    return [document]
  })
}

export function validateFrameDocuments(db: Database, userId: string, frame: Parameters<typeof frameContextDocuments>[0], projectId?: string): void {
  for (const document of frameContextDocuments(frame)) validateDraftDocument(db, userId, document.text, document, projectId)
}

export function resolveFrameDocuments(db: Database, userId: string, frame: Parameters<typeof frameContextDocuments>[0], projectId?: string): PromptDocument[] {
  return resolveFrameContext(db, userId, frame, projectId).contextDocuments
}

/** Resolve once at batch creation, preserving complete server-only entity metadata. */
export function resolveFrameContext(db: Database, userId: string, frame: Parameters<typeof frameContextDocuments>[0], projectId?: string): {
  contextDocuments: PromptDocument[]; resolvedContextEntities: CatalogEntity[]
} {
  const contextDocuments = frameContextDocuments(frame)
  const entities = contextDocuments.flatMap(document => resolvePromptDocument(db, userId, document, projectId).entities)
  return { contextDocuments, resolvedContextEntities: [...new Map(entities.map(entity => [`${entity.kind}:${entity.id}`, entity])).values()] }
}

export function entityPromptToken(entity: Pick<CatalogEntity, 'kind' | 'id'>): string {
  return `[[entity:${entity.kind}:${entity.id}]]`
}

function tokenizedDocument(document: PromptDocument): string {
  let text = document.text
  for (const binding of [...document.mentions].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, binding.start) + entityPromptToken(binding.entity) + text.slice(binding.end)
  }
  return text
}

/** Resolve the script before any paid text request, not by handles or library names. */
export function resolveScriptContext(db: Database, userId: string, script: ScriptDraft | null, projectId?: string): {
  script: ScriptDraft | null; entities: CatalogEntity[]
} {
  if (!script) return { script: null, entities: [] }
  const document = script.promptDocument ?? { version: 1 as const, text: script.text, mentions: [] }
  validateDraftDocument(db, userId, script.text, document, projectId)
  const entities = resolvePromptDocument(db, userId, document, projectId).entities
  const scenes = script.scenes.map(scene => {
    const resolved = resolveFrameContext(db, userId, scene, projectId)
    entities.push(...resolved.resolvedContextEntities)
    const fields = Object.fromEntries(MENTION_FIELDS.flatMap(key => {
      const fieldDocument = scene.mentionDocuments?.[key]
      return fieldDocument ? [[key, tokenizedDocument(fieldDocument)]] : []
    }))
    return { ...scene, ...fields, mentionDocuments: undefined }
  })
  return {
    script: { ...script, text: tokenizedDocument(document), promptDocument: undefined, scenes },
    entities: [...new Map(entities.map(entity => [`${entity.kind}:${entity.id}`, entity])).values()],
  }
}

/** Only exact ID tokens returned by AI transfer bindings into a generated field. */
export function restoreEntityTokens(text: string, entities: CatalogEntity[]): PromptDocument {
  let document: PromptDocument = { version: 1, text, mentions: [] }
  const pattern = /\[\[entity:(character|item|logo|location):([^\]\r\n]+)\]\]/g
  const tokens = [...text.matchAll(pattern)]
  if (text.replace(pattern, '').includes('[[entity:')) throw badRequest('AI trả về liên kết đối tượng chưa đầy đủ. Hãy chọn lại mention.')
  for (const match of tokens.reverse()) {
    const entity = entities.find(entity => entity.kind === match[1] && entity.id === match[2])
    if (!entity) throw badRequest('AI trả về ID đối tượng không thuộc ngữ cảnh đã chọn. Hãy chọn lại mention.')
    document = insertPromptMention(document, match.index!, match.index! + match[0].length, { kind: entity.kind, id: entity.id }, entity.handle)
  }
  return document
}

export function restoreFrameEntityTokens<T extends Parameters<typeof frameContextDocuments>[0]>(frame: T, entities: CatalogEntity[]): T {
  const result = { ...frame }
  const documents = { ...frame.mentionDocuments }
  for (const key of MENTION_FIELDS) {
    const text = frame[key]
    if (typeof text !== 'string' || !text.includes('[[entity:')) continue
    const document = restoreEntityTokens(text, entities)
    Object.assign(result, { [key]: document.text })
    documents[key] = document
  }
  return { ...result, ...(Object.keys(documents).length ? { mentionDocuments: documents } : {}) }
}

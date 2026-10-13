import { z } from 'zod'
import type { Database } from '../db/index'
import { badRequest } from '../lib/errors'
import { resolveEntity } from './service'
import { validatePromptDocument, findUnresolvedPromptMentions, type PromptDocument } from '../../shared/promptMentions'
import { normalizeEntityHandle } from './service'

export const promptDocumentSchema = z.object({
  version: z.literal(1),
  text: z.string().max(8000),
  mentions: z.array(z.object({
    id: z.string().min(1).max(100), start: z.number().int().nonnegative(), end: z.number().int().positive(),
    label: z.string().min(1).max(200),
    entity: z.object({ kind: z.enum(['character', 'item', 'logo']), id: z.string().min(1).max(100) }).strict(),
  }).strict()).max(100),
}).strict()

/** Render frozen occurrences as explicit identities for the provider, keeping source text unchanged. */
export function renderPromptDocument(document: PromptDocument, entities: import('./service').CatalogEntity[]): string {
  let text = document.text
  for (const binding of [...document.mentions].sort((a, b) => b.start - a.start)) {
    const entity = entities.find(item => item.kind === binding.entity.kind && item.id === binding.entity.id)
    if (!entity) throw badRequest('Thiếu đối tượng cho mention')
    text = text.slice(0, binding.start) + `${entity.name} [${entity.kind}:${entity.id}]` + text.slice(binding.end)
  }
  return text
}

/** A document is resolved by identity, never by its label or the current handle. */
export function resolvePromptDocument(db: Database, userId: string, document: PromptDocument, projectId?: string) {
  const issues = validatePromptDocument(document)
  if (issues.length) throw badRequest('Tài liệu prompt không hợp lệ', { issues })
  const unresolved = findUnresolvedPromptMentions(document)
  if (unresolved.length) throw badRequest('Có mention chưa được gắn với đối tượng. Hãy chọn lại từ danh sách @.', { mentions: unresolved })
  for (const binding of document.mentions) {
    if (normalizeEntityHandle(binding.label) !== binding.label) throw badRequest('Handle trong prompt không còn hợp lệ. Hãy chọn lại mention từ thư viện.', { bindingId: binding.id })
  }
  const entities = [...new Map(document.mentions.map(binding => {
    const entity = resolveEntity(db, userId, binding.entity, projectId)
    return [`${entity.kind}:${entity.id}`, entity] as const
  })).values()]
  const lines = entities.map(entity => `- ${entity.name} (${entity.kind}; ID ${entity.id}): ${entity.description}${entity.continuityNotes ? `. Giữ nguyên: ${entity.continuityNotes}` : ''}`)
  return { document, entities, context: lines.length ? `Đối tượng được tham chiếu (giữ đúng nhận diện):\n${lines.join('\n')}` : '' }
}

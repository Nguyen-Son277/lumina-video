/** Persistent entity mentions. All offsets are UTF-16, like textarea selections. */
export type EntityKind = 'character' | 'item' | 'logo' | 'location'

export interface EntityRef {
  kind: EntityKind
  id: string
  /** Pinned scenery view chosen explicitly, validated against owner and entity. */
  viewUploadId?: string
}

export interface MentionBinding {
  /** Identity of this occurrence, not the referenced entity. */
  id: string
  /** Inclusive @/# position and exclusive end position (prefix is inferred from text). */
  start: number
  end: number
  /** Frozen display label, without its prefix. Renaming never changes its binding. */
  label: string
  entity: EntityRef
}

export interface PromptDocument {
  version: 1
  text: string
  mentions: MentionBinding[]
}

export interface RawPromptMention {
  /** Omitted for legacy @ mentions, present for # mentions. */
  prefix?: '@' | '#'
  start: number
  end: number
  label: string
}

export type UnresolvedPromptMention = RawPromptMention & (
  | { reason: 'unbound' }
  | { reason: 'missing_entity'; bindingId: string; entity: EntityRef }
)

const handleCharacter = /[\p{L}\p{N}\p{M}_-]/u
const kinds = new Set<string>(['character', 'item', 'logo', 'location'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function previousCharacter(text: string, offset: number): string {
  const last = text.charCodeAt(offset - 1)
  const before = text.charCodeAt(offset - 2)
  return last >= 0xdc00 && last <= 0xdfff && before >= 0xd800 && before <= 0xdbff
    ? text.slice(offset - 2, offset) : text.slice(offset - 1, offset)
}

function splitsSurrogate(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

function mentionCanStart(text: string, start: number): boolean {
  let backslashes = 0
  for (let i = start - 1; i >= 0 && text[i] === '\\'; i--) backslashes++
  if (backslashes % 2 === 1) return false
  if (start === 0 || backslashes > 0) return true
  const previous = previousCharacter(text, start)
  if (text[start] === '#') {
    // URL fragments and inline hashes are text, not library references.
    const chunk = text.slice(0, start).match(/\S*$/u)?.[0] ?? ''
    if (/[@#/:.?&=%]/u.test(previous) || /(?:\w+:\/\/|www\.|\/)/iu.test(chunk)) return false
  }
  return previous !== '@' && !handleCharacter.test(previous)
}

function mentionCanEnd(text: string, end: number): boolean {
  const next = text.codePointAt(end)
  return next === undefined || !handleCharacter.test(String.fromCodePoint(next))
}

/** Raw handles only; escaped/inline tokens, URL fragments and #hex colors are literals.
 * UI autocomplete must inspect the active prefix independently (even bare # / #abc).
 * Explicit bindings are validated separately, so a selected #abc is still a mention.
 */
export function parsePromptMentions(text: string): RawPromptMention[] {
  const mentions: RawPromptMention[] = []
  const pattern = /([@#])([\p{L}\p{N}_][\p{L}\p{N}\p{M}_-]*)/gu
  for (const match of text.matchAll(pattern)) {
    const start = match.index!
    const end = start + match[0].length
    const prefix = match[1]!
    const label = match[2]!
    if (prefix === '#' && /^(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(label)) continue
    if (mentionCanStart(text, start) && mentionCanEnd(text, end)) {
      mentions.push({ start, end, label, ...(prefix === '#' ? { prefix: '#' as const } : {}) })
    }
  }
  return mentions
}

/** Validate untrusted JSON without throwing or resolving labels to entity IDs. */
export function validatePromptDocument(value: unknown): string[] {
  if (!isRecord(value)) return ['document must be an object']
  const issues: string[] = []
  if (value.version !== 1) issues.push('version must be 1')
  if (typeof value.text !== 'string') issues.push('text must be a string')
  if (!Array.isArray(value.mentions)) {
    issues.push('mentions must be an array')
    return issues
  }
  const text = typeof value.text === 'string' ? value.text : null
  const ids = new Set<string>()
  const spans: Array<{ start: number; end: number; index: number }> = []
  value.mentions.forEach((mention: unknown, index: number) => {
    const path = `mentions[${index}]`
    if (!isRecord(mention)) {
      issues.push(`${path} must be an object`)
      return
    }
    if (!nonempty(mention.id)) issues.push(`${path}.id must be a nonempty string`)
    else {
      if (ids.has(mention.id)) issues.push(`${path}.id is duplicated`)
      ids.add(mention.id)
    }
    const labelValid = nonempty(mention.label) && mention.label === mention.label.trim()
      && !/[@\r\n]/u.test(mention.label)
    if (!labelValid) issues.push(`${path}.label must be a nonempty trimmed label without @ or newlines`)
    if (!isRecord(mention.entity)) issues.push(`${path}.entity must be an object`)
    else {
      if (typeof mention.entity.kind !== 'string' || !kinds.has(mention.entity.kind)) {
        issues.push(`${path}.entity.kind must be character, item, logo or location`)
      }
      if (!nonempty(mention.entity.id)) issues.push(`${path}.entity.id must be a nonempty string`)
      if (mention.entity.viewUploadId !== undefined && (!nonempty(mention.entity.viewUploadId) || mention.entity.kind !== 'location')) issues.push(`${path}.entity.viewUploadId requires a location and upload ID`)
    }
    const { start, end } = mention
    if (typeof start !== 'number' || typeof end !== 'number'
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || (text !== null && end > text.length)) {
      issues.push(`${path} has an invalid UTF-16 span`)
      return
    }
    spans.push({ start, end, index })
    if (text !== null) {
      if (splitsSurrogate(text, start) || splitsSurrogate(text, end)) {
        issues.push(`${path} span splits a surrogate pair`)
      }
      const prefix = text[start]
      if (labelValid && text.slice(start, end) !== `${prefix === '#' ? '#' : '@'}${mention.label}`) {
        issues.push(`${path} span does not match ${prefix === '#' ? '#' : '@'}label`)
      }
      if ((prefix !== '@' && prefix !== '#') || !mentionCanStart(text, start) || !mentionCanEnd(text, end)) {
        issues.push(`${path} must cover a complete, unescaped mention`)
      }
      if (prefix === '#' && isRecord(mention.entity) && mention.entity.kind === 'character') {
        issues.push(`${path} # mentions require an item, logo or location`)
      }
    }
  })
  spans.sort((a, b) => a.start - b.start || a.end - b.end)
  let previousEnd = -1
  for (const span of spans) {
    if (span.start < previousEnd) issues.push(`mentions[${span.index}] overlaps another binding`)
    previousEnd = Math.max(previousEnd, span.end)
  }
  return issues
}

export function assertPromptDocument(value: unknown): asserts value is PromptDocument {
  const issues = validatePromptDocument(value)
  if (issues.length) throw new Error(`Invalid prompt document: ${issues.join('; ')}`)
}

/**
 * Treat a text change as one contiguous edit, using the common prefix/suffix.
 * Untouched occurrences keep their IDs. Intersected occurrences are dropped, never
 * rebound by label (including deletion followed by retyping the same name).
 */
export function updatePromptDocument(previous: PromptDocument, newText: string): PromptDocument {
  assertPromptDocument(previous)
  if (typeof newText !== 'string') throw new Error('newText must be a string')
  const oldText = previous.text
  let start = 0
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const delta = newText.length - oldText.length
  const mentions: MentionBinding[] = []
  for (const binding of previous.mentions) {
    let shifted: MentionBinding
    if (binding.end <= start) shifted = { ...binding, entity: { ...binding.entity } }
    else if (binding.start >= oldEnd) {
      shifted = { ...binding, start: binding.start + delta, end: binding.end + delta, entity: { ...binding.entity } }
    } else continue
    // An adjacent edit can turn @name into an email, escape it, or extend its handle.
    if (validatePromptDocument({ version: 1, text: newText, mentions: [shifted] }).length === 0) {
      mentions.push(shifted)
    }
  }
  return { version: 1, text: newText, mentions }
}

function randomBindingId(): string {
  // Structural typing works with both DOM and Node typecheck, without Node imports.
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (!crypto?.randomUUID) throw new Error('crypto.randomUUID is unavailable; supply a binding ID factory')
  return crypto.randomUUID()
}

/** Replace a selection with a prefixed label and bind it to an explicit entity.
 * @ remains the default for legacy callers; # only accepts noncharacter entities.
 */
export function insertPromptMention(
  doc: PromptDocument,
  start: number,
  end: number,
  entity: EntityRef,
  label: string,
  createId: () => string = randomBindingId,
  prefix: '@' | '#' = '@',
): PromptDocument {
  assertPromptDocument(doc)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start
    || end > doc.text.length || splitsSurrogate(doc.text, start) || splitsSurrogate(doc.text, end)) {
    throw new Error('Invalid insertion UTF-16 span')
  }
  if (prefix !== '@' && prefix !== '#') throw new Error('Invalid mention prefix')
  const token = `${prefix}${label}`
  const text = doc.text.slice(0, start) + token + doc.text.slice(end)
  // Use the explicit selection, not diff inference (important when replacing an
  // identical token: it must receive a new binding ID and the chosen entity).
  const delta = token.length - (end - start)
  const mentions = doc.mentions.flatMap(binding => {
    if (binding.end <= start) return [{ ...binding, entity: { ...binding.entity } }]
    if (binding.start >= end) return [{ ...binding, start: binding.start + delta, end: binding.end + delta, entity: { ...binding.entity } }]
    return []
  }).filter(binding => validatePromptDocument({ version: 1, text, mentions: [binding] }).length === 0)
  mentions.push({ id: createId(), start, end: start + token.length, label, entity: { ...entity } })
  mentions.sort((a, b) => a.start - b.start)
  const result: PromptDocument = { version: 1, text, mentions }
  assertPromptDocument(result)
  return result
}

/** Never resolves by display label. Entity existence must be checked by kind + ID. */
export function findUnresolvedPromptMentions(
  doc: PromptDocument,
  entityExists?: (entity: EntityRef) => boolean,
): UnresolvedPromptMention[] {
  assertPromptDocument(doc)
  const unresolved: UnresolvedPromptMention[] = parsePromptMentions(doc.text)
    .filter(token => !doc.mentions.some(binding => token.start >= binding.start && token.end <= binding.end))
    .map(token => ({ ...token, reason: 'unbound' }))
  if (entityExists) {
    for (const binding of doc.mentions) {
      if (!entityExists(binding.entity)) {
        unresolved.push({ start: binding.start, end: binding.end, label: binding.label,
          ...(doc.text[binding.start] === '#' ? { prefix: '#' as const } : {}),
          reason: 'missing_entity', bindingId: binding.id, entity: { ...binding.entity } })
      }
    }
  }
  return unresolved.sort((a, b) => a.start - b.start)
}

/** Throws before running a prompt containing unbound or deleted entity mentions. */
export function assertResolvedPromptDocument(
  value: unknown,
  entityExists?: (entity: EntityRef) => boolean,
): asserts value is PromptDocument {
  assertPromptDocument(value)
  const unresolved = findUnresolvedPromptMentions(value, entityExists)
  if (unresolved.length) {
    throw new Error(`Unresolved prompt mentions: ${unresolved.map(token => `${token.prefix ?? '@'}${token.label} (${token.reason})`).join(', ')}`)
  }
}

import { describe, expect, it } from 'vitest'
import {
  assertPromptDocument,
  assertResolvedPromptDocument,
  findUnresolvedPromptMentions,
  insertPromptMention,
  parsePromptMentions,
  updatePromptDocument,
  validatePromptDocument,
  type EntityRef,
  type PromptDocument,
} from '../../shared/promptMentions'

const character: EntityRef = { kind: 'character', id: 'character-old' }
const empty = (text = ''): PromptDocument => ({ version: 1, text, mentions: [] })
const bind = (text = 'Hello @Lan!'): PromptDocument => insertPromptMention(
  empty(text), text.indexOf('@Lan'), text.indexOf('@Lan') + 4, character, 'Lan', () => 'occurrence-1',
)

describe('raw prompt mention parsing', () => {
  it('parses Unicode handles and UTF-16 offsets, including astral letters', () => {
    const text = '😀 @Nguyễn @東京 @𐐀name @e\u0301 @logo-2 @_item'
    const tokens = parsePromptMentions(text)
    expect(tokens.map(token => token.label)).toEqual(['Nguyễn', '東京', '𐐀name', 'e\u0301', 'logo-2', '_item'])
    expect(tokens[0]).toEqual({ start: 3, end: 10, label: 'Nguyễn' })
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(`@${token.label}`)
  })

  it('ignores @ inside words and emails, including Unicode words', () => {
    expect(parsePromptMentions('a@b.com first.last@example.org 東京@Lan 𐐀@Lan name_@Lan foo-@Lan @@Lan')).toEqual([])
    expect(parsePromptMentions('(@Lan), @Logo.')).toEqual([
      { start: 1, end: 5, label: 'Lan' }, { start: 8, end: 13, label: 'Logo' },
    ])
  })

  it('uses odd/even backslash parity for escaped literal mentions', () => {
    expect(parsePromptMentions(String.raw`\@Lan`)).toEqual([])
    expect(parsePromptMentions(String.raw`\\\@Lan`)).toEqual([])
    expect(parsePromptMentions(String.raw`\\@Lan`)).toEqual([{ start: 2, end: 6, label: 'Lan' }])
    expect(parsePromptMentions('@ @! @- @\u0301')).toEqual([])
  })
})

describe('prompt document validation', () => {
  it('returns issues, never throws for malformed untrusted values', () => {
    for (const value of [null, undefined, false, 'text', [], {}, { version: 2, text: 3, mentions: [null] }]) {
      expect(() => validatePromptDocument(value)).not.toThrow()
      expect(validatePromptDocument(value).length).toBeGreaterThan(0)
    }
    expect(validatePromptDocument(bind())).toEqual([])
    expect(() => assertPromptDocument(empty('@Unbound'))).not.toThrow()
  })

  it('checks entity kinds and IDs and rejects mismatching spans', () => {
    const doc = bind()
    const mention = doc.mentions[0]!
    expect(validatePromptDocument({ ...doc, mentions: [{ ...mention, entity: { kind: 'location', id: '' } }] }).length).toBeGreaterThan(0)
    expect(validatePromptDocument({ ...doc, mentions: [{ ...mention, label: 'Renamed' }] })).toContain('mentions[0] span does not match @label')
    expect(validatePromptDocument({ ...doc, mentions: [{ ...mention, start: 1.5 }] })).toContain('mentions[0] has an invalid UTF-16 span')
    expect(validatePromptDocument({ ...doc, mentions: [{ ...mention, end: 100 }] }).length).toBeGreaterThan(0)
    expect(() => assertPromptDocument({ ...doc, version: 2 })).toThrow('Invalid prompt document')
  })

  it('rejects overlapping spans and duplicated occurrence IDs', () => {
    const doc = bind()
    const mention = doc.mentions[0]!
    const issues = validatePromptDocument({ ...doc, mentions: [mention, { ...mention }] })
    expect(issues).toContain('mentions[1].id is duplicated')
    expect(issues).toContain('mentions[1] overlaps another binding')
  })

  it('rejects escaped bindings and partial handles, allows display names with spaces', () => {
    const doc = bind()
    const mention = doc.mentions[0]!
    expect(validatePromptDocument({ ...doc, text: 'Hello @Lantern!' })).toContain('mentions[0] must cover a complete, unescaped mention')
    expect(validatePromptDocument({ ...doc, text: 'Hello \\@Lan!', mentions: [{ ...mention, start: 7, end: 11 }] }).length).toBeGreaterThan(0)
    const spaced = insertPromptMention(empty(), 0, 0, character, 'Nguyễn Sơn', () => 'spaced')
    expect(validatePromptDocument(spaced)).toEqual([])
    expect(findUnresolvedPromptMentions(spaced)).toEqual([])
  })

  it('rejects labels with @, newlines or surrounding whitespace', () => {
    for (const label of ['', ' Lan', 'Lan ', '@Lan', 'Lan\nNguyễn']) {
      expect(() => insertPromptMention(empty(), 0, 0, character, label, () => 'id')).toThrow('Invalid prompt document')
    }
  })
})

describe('single contiguous prompt edits', () => {
  it('keeps binding IDs and entity IDs on rename of the entity catalog', () => {
    const doc = bind()
    const catalog = new Map([[character.id, { name: 'Lan' }]])
    catalog.set(character.id, { name: 'Mai' })
    const updated = updatePromptDocument(doc, 'Today: Hello @Lan!')
    expect(updated.mentions[0]).toEqual({ ...doc.mentions[0], start: 13, end: 17 })
    expect(findUnresolvedPromptMentions(updated, entity => catalog.has(entity.id))).toEqual([])
    expect(updated.text).toContain('@Lan')
  })

  it('preserves IDs for prefix/suffix insertions and unchanged text without mutation', () => {
    const doc = bind()
    expect(updatePromptDocument(doc, doc.text)).toEqual(doc)
    expect(updatePromptDocument(doc, `${doc.text} Next.`).mentions).toEqual(doc.mentions)
    const copy = updatePromptDocument(doc, `😀 ${doc.text}`)
    expect(copy.mentions[0]?.start).toBe(9)
    expect(copy.mentions[0]?.id).toBe('occurrence-1')
    copy.mentions[0]!.entity.id = 'other'
    expect(doc.mentions[0]?.entity.id).toBe(character.id)
  })

  it('shifts later bindings after a deletion or replacement before their spans', () => {
    const doc = bind()
    expect(updatePromptDocument(doc, '@Lan!').mentions[0]).toEqual({ ...doc.mentions[0], start: 0, end: 4 })
    expect(updatePromptDocument(doc, 'Hi @Lan!').mentions[0]).toEqual({ ...doc.mentions[0], start: 3, end: 7 })
  })

  it('drops touched binding on deletion and never binds a recreated textual token', () => {
    const doc = bind()
    const deleted = updatePromptDocument(doc, 'Hello !')
    expect(deleted.mentions).toEqual([])
    const recreated = updatePromptDocument(deleted, doc.text)
    expect(recreated.mentions).toEqual([])
    expect(findUnresolvedPromptMentions(recreated)).toEqual([{ start: 6, end: 10, label: 'Lan', reason: 'unbound' }])
  })

  it('drops an intersected binding on internal insertion, deletion or replacement', () => {
    for (const text of ['Hello @Laan!', 'Hello @Ln!', 'Hello @Mai!', 'Hello Lan!']) {
      expect(updatePromptDocument(bind(), text).mentions).toEqual([])
    }
  })

  it('preserves only untouched occurrences across a conservative multi-change diff', () => {
    let doc = insertPromptMention(empty('@A @B @C'), 0, 2, character, 'A', () => 'a')
    doc = insertPromptMention(doc, 3, 5, { kind: 'item', id: 'i' }, 'B', () => 'b')
    doc = insertPromptMention(doc, 6, 8, { kind: 'logo', id: 'l' }, 'C', () => 'c')
    const next = updatePromptDocument(doc, '@A @Bee @C')
    expect(next.mentions.map(mention => mention.id)).toEqual(['a', 'c'])
    expect(next.mentions[1]?.start).toBe(8)
    expect(updatePromptDocument(doc, '@Alpha @B @Charlie').mentions).toEqual([])
  })

  it('drops bindings when adjacent edits escape them or make them part of a word', () => {
    const doc = insertPromptMention(empty('@Lan'), 0, 4, character, 'Lan', () => 'id')
    for (const text of ['x@Lan', '\\@Lan', '@Lan2']) {
      expect(updatePromptDocument(doc, text).mentions).toEqual([])
    }
    expect(updatePromptDocument(doc, '@Lan!').mentions[0]?.id).toBe('id')
  })
})

describe('mention insertion and resolution', () => {
  it('replaces a selected token with a new explicit binding, even if text is identical', () => {
    const doc = bind()
    const next = insertPromptMention(doc, 6, 10, { kind: 'item', id: 'new-item' }, 'Lan', () => 'new-occurrence')
    expect(next.text).toBe(doc.text)
    expect(next.mentions[0]?.id).toBe('new-occurrence')
    expect(next.mentions[0]?.entity).toEqual({ kind: 'item', id: 'new-item' })
    expect(doc.mentions[0]?.id).toBe('occurrence-1')
  })

  it('shifts unaffected occurrences and removes every binding touched by a selection', () => {
    let doc = insertPromptMention(empty('@A then @B'), 0, 2, character, 'A', () => 'a')
    doc = insertPromptMention(doc, 8, 10, { kind: 'logo', id: 'l' }, 'B', () => 'b')
    const next = insertPromptMention(doc, 3, 7, { kind: 'item', id: 'i' }, 'Prop', () => 'prop')
    expect(next.text).toBe('@A @Prop @B')
    expect(next.mentions.map(mention => [mention.id, mention.start])).toEqual([['a', 0], ['prop', 3], ['b', 9]])
    expect(insertPromptMention(doc, 0, 10, character, 'New', () => 'new').mentions.map(mention => mention.id)).toEqual(['new'])
  })

  it('uses UTF-16 insertion selections and rejects split surrogate pairs or bad selections', () => {
    const doc = insertPromptMention(empty('😀 '), 3, 3, { kind: 'logo', id: 'logo' }, '𐐀', () => 'unicode')
    expect(doc.mentions[0]).toEqual({ id: 'unicode', start: 3, end: 6, label: '𐐀', entity: { kind: 'logo', id: 'logo' } })
    for (const [start, end] of [[1, 1], [-1, 0], [4, 4], [3, 2], [0.5, 1]]) {
      expect(() => insertPromptMention(empty('😀 '), start!, end!, character, 'Lan', () => 'id')).toThrow('Invalid insertion UTF-16 span')
    }
  })

  it('uses safe runtime crypto.randomUUID by default', () => {
    const doc = insertPromptMention(empty(), 0, 0, character, 'Lan')
    expect(doc.mentions[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('does not fall back to Math.random if secure crypto is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined })
      expect(() => insertPromptMention(empty(), 0, 0, character, 'Lan')).toThrow('supply a binding ID factory')
      expect(insertPromptMention(empty(), 0, 0, character, 'Lan', () => 'injected').mentions[0]?.id).toBe('injected')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
      else Reflect.deleteProperty(globalThis, 'crypto')
    }
  })

  it('rejects generated occurrence IDs that are empty or already in the document', () => {
    expect(() => insertPromptMention(empty(), 0, 0, character, 'Lan', () => '')).toThrow('id must be')
    expect(() => insertPromptMention(bind(), 11, 11, character, 'Mai', () => 'occurrence-1')).toThrow('id is duplicated')
  })

  it('reports deleted entities by ID, never resolves recreated entities with the same name', () => {
    const doc = bind()
    const catalog = new Map<string, string>([['character-new', 'Lan']])
    const unresolved = findUnresolvedPromptMentions(doc, entity => catalog.has(entity.id))
    expect(unresolved).toEqual([{ start: 6, end: 10, label: 'Lan', reason: 'missing_entity', bindingId: 'occurrence-1', entity: character }])
    expect(() => assertResolvedPromptDocument(doc, entity => catalog.has(entity.id))).toThrow('missing_entity')
    expect(() => assertResolvedPromptDocument(doc, entity => entity.kind === 'character' && entity.id === character.id)).not.toThrow()
  })

  it('asserts unresolved raw tokens but allows email addresses and escaped literals', () => {
    expect(() => assertResolvedPromptDocument(empty('@Unknown'))).toThrow('unbound')
    expect(() => assertResolvedPromptDocument(empty(String.raw`Contact x@y.com or use \@literal`))).not.toThrow()
    expect(() => assertResolvedPromptDocument({ version: 2 })).toThrow('Invalid prompt document')
  })
})

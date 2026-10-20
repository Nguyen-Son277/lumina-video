import { describe, expect, it } from 'vitest'
import {
  assertResolvedPromptDocument, findUnresolvedPromptMentions, insertPromptMention,
  parsePromptMentions, updatePromptDocument, validatePromptDocument,
  type EntityKind, type PromptDocument,
} from '../../shared/promptMentions'
import { promptDocumentSchema, renderPromptDocument } from '../../server/entityLibrary/mentions'

const empty = (text = ''): PromptDocument => ({ version: 1, text, mentions: [] })
const bind = (label = 'prop', kind: EntityKind = 'item') => insertPromptMention(
  empty(), 0, 0, { kind, id: `${kind}-id` }, label, () => 'binding', '#',
)

describe('# prompt mention parsing', () => {
  it('parses mixed prefixes with legacy @ shapes and Unicode UTF-16 offsets', () => {
    const text = '😀 #Nguyễn @Lan #東京 #𐐀name #e\u0301 #logo-2 #_item'
    const tokens = parsePromptMentions(text)
    expect(tokens[0]).toEqual({ start: 3, end: 10, label: 'Nguyễn', prefix: '#' })
    expect(tokens[1]).toEqual({ start: 11, end: 15, label: 'Lan' })
    expect(tokens.map(token => token.label)).toEqual(['Nguyễn', 'Lan', '東京', '𐐀name', 'e\u0301', 'logo-2', '_item'])
    for (const token of tokens) expect(text.slice(token.start, token.end)).toBe(`${token.prefix ?? '@'}${token.label}`)
  })

  it('ignores escaped tokens, words, URLs and Markdown heading markers', () => {
    const text = String.raw`\#prop \\\#prop word#prop 東京#prop 𐐀#prop ##prop ###prop ## Heading https://example.org/#prop https://example.org#prop /path/#prop www.example.org#prop ?#prop &#prop`
    expect(parsePromptMentions(text)).toEqual([])
    expect(parsePromptMentions(String.raw`\\#prop`)).toEqual([{ start: 2, end: 7, label: 'prop', prefix: '#' }])
    expect(parsePromptMentions('# #! #- #\u0301')).toEqual([])
    expect(parsePromptMentions('(#prop), #place.').map(token => token.label)).toEqual(['prop', 'place'])
  })

  it('ignores precisely 3/4/6/8 digit hex colors, not other hashtag handles', () => {
    expect(parsePromptMentions('#abc #ABCD #123456 #aBcD1234')).toEqual([])
    expect(parsePromptMentions('#ab #abcde #abcdefg #1234567 #123456789 #abc-prop #unknown').map(token => token.label))
      .toEqual(['ab', 'abcde', 'abcdefg', '1234567', '123456789', 'abc-prop', 'unknown'])
    expect(parsePromptMentions('@abc')).toEqual([{ start: 0, end: 4, label: 'abc' }])
  })
})

describe('# explicit bindings in v1 documents', () => {
  it.each(['item', 'logo', 'location'] as const)('accepts #%s and retains the existing strict v1 schema', kind => {
    const doc = bind('prop', kind)
    expect(doc.text).toBe('#prop')
    expect(doc.mentions[0]).toEqual({ id: 'binding', start: 0, end: 5, label: 'prop', entity: { kind, id: `${kind}-id` } })
    expect(validatePromptDocument(doc)).toEqual([])
    expect(promptDocumentSchema.parse(doc)).toEqual(doc)
    expect(findUnresolvedPromptMentions(doc)).toEqual([])
    const legacy = insertPromptMention(empty(), 0, 0, { kind, id: 'legacy' }, 'prop', () => 'legacy')
    expect(legacy.text).toBe('@prop')
    expect(validatePromptDocument(legacy)).toEqual([])
  })

  it('rejects #character while preserving legacy @character', () => {
    expect(() => bind('lan', 'character')).toThrow('# mentions require an item, logo or location')
    const legacy = insertPromptMention(empty(), 0, 0, { kind: 'character', id: 'c' }, 'lan', () => 'c')
    expect(validatePromptDocument(legacy)).toEqual([])
    expect(validatePromptDocument({ ...legacy, text: '#lan' })).toContain('mentions[0] # mentions require an item, logo or location')
  })

  it.each(['abc', 'ABCD', '123456', 'aBcD1234'])('permits explicitly selected #%s despite color exclusion', label => {
    const doc = bind(label)
    expect(parsePromptMentions(doc.text)).toEqual([])
    expect(validatePromptDocument(doc)).toEqual([])
    expect(findUnresolvedPromptMentions(doc)).toEqual([])
    expect(findUnresolvedPromptMentions(doc, () => false)).toEqual([{
      start: 0, end: label.length + 1, label, prefix: '#', reason: 'missing_entity',
      bindingId: 'binding', entity: { kind: 'item', id: 'item-id' },
    }])
    expect(() => assertResolvedPromptDocument(doc, () => false)).toThrow(`#${label} (missing_entity)`)
  })

  it('errors on plain unbound hashtags but not ordinary hash syntax', () => {
    expect(() => assertResolvedPromptDocument(empty('#unknown'))).toThrow('#unknown (unbound)')
    expect(() => assertResolvedPromptDocument(empty(String.raw`#abc ##heading word#prop https://host/#prop \#prop`))).not.toThrow()
  })

  it('keeps pinned location views and renders explicit identities rather than prefix aliases', () => {
    const doc = insertPromptMention(empty(), 0, 0, { kind: 'location', id: 'place', viewUploadId: 'view' }, 'beach', () => 'beach', '#')
    expect(validatePromptDocument(doc)).toEqual([])
    expect(renderPromptDocument(doc, [{ kind: 'location', id: 'place', name: 'Renamed Beach', handle: 'beach', description: 'Sand', continuityNotes: '', revision: 1, reference: null }]))
      .toBe('Renamed Beach [location:place]')
  })

  it('validates complete unescaped spans for explicitly bound hashes too', () => {
    const doc = bind()
    for (const text of ['#propMore', '\\#prop', 'word#prop', '##prop', 'https://host/#prop']) {
      const start = text.lastIndexOf('#')
      expect(validatePromptDocument({ ...doc, text, mentions: [{ ...doc.mentions[0]!, start, end: start + 5 }] }).length).toBeGreaterThan(0)
    }
    expect(() => insertPromptMention(empty('😀 '), 1, 1, { kind: 'item', id: 'i' }, 'prop', () => 'id', '#')).toThrow('Invalid insertion UTF-16 span')
  })

  it('shifts UTF-16 spans, preserves IDs, and drops touched or newly escaped hash bindings', () => {
    const doc = bind('東京')
    const shifted = updatePromptDocument(doc, `😀 ${doc.text}`)
    expect(shifted.mentions[0]).toEqual({ ...doc.mentions[0], start: 3, end: 6 })
    expect(findUnresolvedPromptMentions(shifted)).toEqual([])
    for (const text of ['#東京2', '\\#東京', 'a#東京', '##東京', '#京都']) {
      expect(updatePromptDocument(doc, text).mentions).toEqual([])
    }
    const removed = updatePromptDocument(doc, '')
    expect(findUnresolvedPromptMentions(updatePromptDocument(removed, '#東京'))).toEqual([
      { start: 0, end: 3, label: '東京', prefix: '#', reason: 'unbound' },
    ])
  })
})

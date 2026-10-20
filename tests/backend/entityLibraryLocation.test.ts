import { describe, expect, it } from 'vitest'
import { readEntityLibraryLocation, writeEntityLibraryLocation } from '../../src/entityLibraryLocation'

describe('unified library URL state', () => {
  it('keeps an explicit All filter independent of the selected entity kind', () => {
    expect(readEntityLibraryLocation('?page=entities&type=all&entity=item-1&entityKind=item')).toEqual({ kind: 'all', selectedEntity: { id: 'item-1', kind: 'item' } })
  })
  it('legacy character aliases default to the character filter', () => {
    expect(readEntityLibraryLocation('?page=characters&entity=char-1')).toEqual({ kind: 'character', selectedEntity: { id: 'char-1', kind: 'character' } })
  })
  it('invalid kinds cannot become a filter or entity reference kind', () => {
    expect(readEntityLibraryLocation('?page=entities&type=bad&entity=unknown&entityKind=bad')).toEqual({ kind: 'all', selectedEntity: { id: 'unknown' } })
  })
  it('round trips selection and preserves unrelated URL parameters', () => {
    const url = new URL('https://example.test/?page=characters&other=value')
    writeEntityLibraryLocation(url, 'all', { id: 'item-1', kind: 'item' })
    expect(url.searchParams.get('other')).toBe('value')
    expect(readEntityLibraryLocation(url.search)).toEqual({ kind: 'all', selectedEntity: { id: 'item-1', kind: 'item' } })
    writeEntityLibraryLocation(url, 'logo', null)
    expect(url.searchParams.has('entity')).toBe(false)
    expect(url.searchParams.has('entityKind')).toBe(false)
  })
})

import type { EntityKind } from '../shared/promptMentions'

export type EntityLibraryFilter = EntityKind | 'all'
/** Legacy links contain only an ID; the page resolves their kind from the catalog. */
export type SelectedEntityRef = { id: string; kind?: EntityKind }

const ENTITY_KINDS: EntityKind[] = ['character', 'item', 'location', 'logo']
export function isEntityKind(value: string | null): value is EntityKind {
  return ENTITY_KINDS.includes(value as EntityKind)
}

export function readEntityLibraryLocation(search: string): { kind: EntityLibraryFilter; selectedEntity: SelectedEntityRef | null } {
  const params = new URLSearchParams(search)
  const alias = params.get('page') === 'characters'
  const type = params.get('type')
  const entityKind = params.get('entityKind')
  const id = params.get('entity')
  const selectedKind = isEntityKind(entityKind) ? entityKind : alias ? 'character' : isEntityKind(type) ? type : undefined
  return {
    kind: alias ? 'character' : type === 'all' ? 'all' : isEntityKind(type) ? type : id && selectedKind ? selectedKind : 'all',
    selectedEntity: id ? { id, ...(selectedKind ? { kind: selectedKind } : {}) } : null,
  }
}

/** Change only resource-owned parameters, leaving integrations and future parameters intact. */
export function writeEntityLibraryLocation(url: URL, kind: EntityLibraryFilter, selectedEntity: SelectedEntityRef | null): void {
  url.searchParams.set('page', 'entities')
  url.searchParams.set('type', kind)
  if (selectedEntity) {
    url.searchParams.set('entity', selectedEntity.id)
    if (selectedEntity.kind) url.searchParams.set('entityKind', selectedEntity.kind)
    else url.searchParams.delete('entityKind')
  } else {
    url.searchParams.delete('entity')
    url.searchParams.delete('entityKind')
  }
}

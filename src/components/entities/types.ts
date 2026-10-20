import type { LibraryCandidate } from '../../../shared/entityCreation'
import type { EntityKind, LibraryAssetKind } from '../../api/entityLibrary'
import type { CharacterInput } from '../../api/projectTypes'

export type EntityCardKind = EntityKind | 'project' | 'generation' | 'plan_session'

export interface EntityCardData {
  id: string
  kind: EntityCardKind
  name: string
  description?: string
  handle?: string
  imageUrl?: string | null
  badges?: Array<{ label: string; tone?: 'neutral' | 'info' | 'warning' }>
  views?: Array<{ id: string; label: string; url: string }>
}

export interface EntityDetailSection {
  label: string
  value: string
}

export interface EntityDetailsData extends EntityCardData {
  sections?: EntityDetailSection[]
}

export type EntityFilter = 'all' | EntityKind

export interface EntitySelection {
  id: string
  kind?: EntityKind
}

/** Preserve the native character fields rather than flattening character drafts into assets. */
export type EntityCreationDraft =
  | { kind: 'character'; input: CharacterInput }
  | { kind: LibraryAssetKind; input: LibraryCandidate }

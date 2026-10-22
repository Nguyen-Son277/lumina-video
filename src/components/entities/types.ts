import type { ImageEditorSource } from '../../../shared/imageEditor'
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
  /** Present only while this preview is waiting for an image operation. */
  imageStatus?: { phase: 'queued' | 'sending' | 'generating' | 'publishing' | 'saving'; label: string; progress?: number | null }
  badges?: Array<{ label: string; tone?: 'neutral' | 'info' | 'warning' }>
  views?: Array<{ id: string; label: string; url: string; editableSource?: ImageEditorSource }>
  /** Typed source for the image editor; derived from record data, never from a URL. */
  editableSource?: ImageEditorSource
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

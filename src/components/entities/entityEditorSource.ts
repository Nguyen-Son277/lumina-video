import type { ImageEditorSource } from '../../../shared/imageEditor'

/**
 * Pure helpers for typed image editor sources.
 *
 * This module must stay free of runtime imports and of any `src/api` import so
 * both the browser bundle and the server typecheck can consume it: `src/api`
 * pulls the DOM-dependent API client into the server program.
 */

export type EditorEntityKind = 'character' | 'item' | 'logo' | 'location'

/** Structural subset of a catalog entity needed to build an editor source. */
export type EditorEntityRecord<K extends string = EditorEntityKind> = {
  id: string
  kind: K
  name: string
  handle: string
  description: string
  revision: number
  reference?: { mime?: string; uploadId?: string; url?: string } | null
  referenceViews?: ReadonlyArray<{ id: string; label: string; uploadId: string; sheet: boolean }>
}

export type EditorCardData<K extends string = EditorEntityKind> = {
  id: string
  kind: K
  name: string
  handle: string
  description: string
  imageUrl?: string | null
  /** Typed source for the image editor; derived from record data, never from a URL. */
  editableSource?: ImageEditorSource
  views?: Array<{ id: string; label: string; url: string; editableSource?: ImageEditorSource }>
}

/** Typed editor source built from catalog data; a URL is never parsed into a source. */
export function entityEditorSource<K extends string>(entity: EditorEntityRecord<K>, viewId?: string): ImageEditorSource | undefined {
  const kind = entity.kind
  // Only library entities are addressable by the editor.
  if (kind !== 'character' && kind !== 'item' && kind !== 'logo' && kind !== 'location') return undefined
  return { kind: 'entity', entityKind: kind as EditorEntityKind, id: entity.id, revision: entity.revision, ...(viewId ? { viewId } : {}) }
}

/** Card payload for a catalog entity; the reference URL is resolved by the caller. */
export function entityCardData<K extends string>(entity: EditorEntityRecord<K>, imageUrl: string | null): EditorCardData<K> {
  return {
    id: entity.id, kind: entity.kind, name: entity.name, handle: entity.handle,
    description: entity.description, imageUrl,
    // Without a stored reference there is nothing to edit.
    editableSource: imageUrl ? entityEditorSource(entity) : undefined,
    views: entity.referenceViews?.map(view => ({ id: view.id, label: view.label,
      url: `/api/uploads/${encodeURIComponent(view.uploadId)}`,
      editableSource: entityEditorSource(entity, view.id) })),
  }
}

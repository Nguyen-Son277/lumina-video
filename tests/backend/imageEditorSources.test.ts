import { describe, expect, it } from 'vitest'
import { entityCardData, entityEditorSource, type EditorEntityRecord } from '../../src/components/entities/entityEditorSource'
import type { ImageEditorSource } from '../../shared/imageEditor'

function entity(overrides: Partial<EditorEntityRecord> = {}): EditorEntityRecord {
  return {
    id: 'asset-1', kind: 'item', name: 'Lantern', handle: 'lantern', description: '',
    revision: 7, reference: { mime: 'image/png', uploadId: 'upload-1' },
    ...overrides,
  }
}

describe('typed image editor sources', () => {
  it('library entities expose the entity kind, id and revision', () => {
    const source = entityEditorSource(entity({ kind: 'logo' }))
    expect(source).toEqual({ kind: 'entity', entityKind: 'logo', id: 'asset-1', revision: 7 })
  })

  it('a picked reference view carries its view id', () => {
    const source = entityEditorSource(entity({ kind: 'location' }), 'view-2')
    expect(source).toEqual({ kind: 'entity', entityKind: 'location', id: 'asset-1', revision: 7, viewId: 'view-2' })
  })

  it('card data fills the main image and every reference view', () => {
    const data = entityCardData(entity({
      kind: 'location',
      referenceViews: [{ id: 'view-1', label: 'wide', uploadId: 'upload-2', sheet: true }],
    }), '/api/entity-library/assets/asset-1/reference?revision=7')
    expect(data.editableSource).toEqual({ kind: 'entity', entityKind: 'location', id: 'asset-1', revision: 7 })
    expect(data.views?.[0]?.editableSource).toEqual({ kind: 'entity', entityKind: 'location', id: 'asset-1', revision: 7, viewId: 'view-1' })
    expect(data.views?.[0]?.url).toContain('/api/uploads/')
  })

  it('an entity without a stored reference stays view-only', () => {
    const data = entityCardData(entity({ reference: null }), null)
    expect(data.editableSource).toBeUndefined()
  })

  it('never derives a source from a URL', () => {
    const data = entityCardData(entity(), '/api/entity-library/assets/asset-1/reference?revision=7')
    const sources: Array<ImageEditorSource | undefined> = [data.editableSource, ...(data.views ?? []).map(view => view.editableSource)]
    for (const source of sources) {
      expect(source).toBeDefined()
      expect(JSON.stringify(source)).not.toContain('/api/')
    }
  })
})

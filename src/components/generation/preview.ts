import type { GenerationPreview } from '../../api/endpoints'
import type { EntityGenerationPreview } from '../EntityGenerationOptions'

/** Keep server preview data intact; only narrow entity kinds supported by the dialog. */
export function toEntityGenerationPreview(preview: GenerationPreview): EntityGenerationPreview {
  return { ...preview, entities: preview.entities.flatMap(entity => {
    const kind = entity.kind
    return kind === 'character' || kind === 'item' || kind === 'logo' || kind === 'location' ? [{ ...entity, kind }] : []
  }) }
}

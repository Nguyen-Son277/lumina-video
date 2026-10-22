import { useCallback, useEffect, useRef, useState } from 'react'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../../api/entityLibrary'
import { entityCardData as buildEntityCardData, entityEditorSource } from './entityEditorSource'
import type { EntityCardData } from './types'

export { entityEditorSource }

export function newestEntities(entities: EntityLibraryEntity[]): EntityLibraryEntity[] {
  const timestamp = (entity: EntityLibraryEntity) => Number.isFinite(entity.createdAt) ? entity.createdAt! : 0
  return [...entities].sort((a, b) => timestamp(b) - timestamp(a)
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
export const entityKey = (entity: Pick<EntityLibraryEntity, 'id' | 'kind'>) => `${entity.kind}:${entity.id}`
/** Card payload for a catalog entity; the reference URL is resolved here. */
export function entityCardData(entity: EntityLibraryEntity): EntityCardData {
  return buildEntityCardData(entity, entityReferenceUrl(entity))
}

/** Catalog is the single list source; native character data is hydrated separately. */
export function useEntityLibrary() {
  const [entities, setEntities] = useState<EntityLibraryEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const request = useRef<{ epoch: number; controller?: AbortController }>({ epoch: 0 })
  const refresh = useCallback(async () => {
    request.current.controller?.abort()
    const controller = new AbortController()
    const epoch = ++request.current.epoch
    request.current.controller = controller
    setLoading(true)
    setError(null)
    try {
      const result = await entityLibraryApi.list({}, controller.signal)
      if (!controller.signal.aborted && request.current.epoch === epoch) setEntities(newestEntities(result.entities))
    } catch (cause) {
      if (!controller.signal.aborted && request.current.epoch === epoch) setError(cause)
    } finally {
      if (!controller.signal.aborted && request.current.epoch === epoch) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    return () => { request.current.epoch++; request.current.controller?.abort() }
  }, [refresh])
  const replace = useCallback((entity: EntityLibraryEntity) => {
    setEntities(current => newestEntities(current.some(item => entityKey(item) === entityKey(entity))
      ? current.map(item => entityKey(item) === entityKey(entity) ? entity : item)
      : [...current, entity]))
  }, [])
  const remove = useCallback((entity: Pick<EntityLibraryEntity, 'id' | 'kind'>) => {
    setEntities(current => current.filter(item => entityKey(item) !== entityKey(entity)))
  }, [])
  return { entities, loading, error, refresh, replace, remove }
}

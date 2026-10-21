import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { entityLibraryPreferencesDefaults, type EntityLibraryPreferences } from '../../../shared/entityLibraryPreferences'

// No cached account data. A newly opened dialog waits for writes from the old one.
let writes: Promise<unknown> = Promise.resolve()
export function useEntityPreferences(enabled = true) {
  const [settings, setSettings] = useState<EntityLibraryPreferences>({ ...entityLibraryPreferencesDefaults })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState(0)
  const pending = useRef<Partial<EntityLibraryPreferences>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  const ready = useRef(false)
  const accountId = useRef<string | null>(null)
  const inFlight = useRef(false)
  function flush() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (!Object.keys(pending.current).length || !ready.current || !accountId.current || inFlight.current) return
    inFlight.current = true
    if (mounted.current) setSaving(true)
    // Drain in a single serialized operation, including edits made during a request.
    // Reopening waits for the entire drain, never just its first HTTP request.
    const expectedUserId = accountId.current
    writes = writes.catch(() => {}).then(async () => {
      while (Object.keys(pending.current).length) {
        const patch = pending.current
        pending.current = {}
        try {
          await api.patch('/entity-library/preferences', { version: 1, expectedUserId, settings: patch })
          if (mounted.current) setError(null)
        } catch (cause) {
          pending.current = { ...patch, ...pending.current }
          if (mounted.current) setError(cause)
          break
        }
      }
      inFlight.current = false
      if (mounted.current) setSaving(false)
    })
  }
  useEffect(() => {
    mounted.current = true
    if (!enabled) { setLoaded(true); return () => { mounted.current = false } }
    const controller = new AbortController()
    setLoaded(false); ready.current = false
    void writes.catch(() => {}).then(() => api.get<{ userId: string; settings: EntityLibraryPreferences }>('/entity-library/preferences', controller.signal))
      .then(result => { if (!controller.signal.aborted) { accountId.current = result.userId; setSettings({ ...entityLibraryPreferencesDefaults, ...result.settings }); ready.current = true; setLoaded(true); setError(null) } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause) })
    return () => { controller.abort(); mounted.current = false; flush() }
  }, [version, enabled])
  function update(patch: Partial<EntityLibraryPreferences>) {
    if (!ready.current) return
    setSettings(current => ({ ...current, ...patch }))
    pending.current = { ...pending.current, ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = inFlight.current ? null : setTimeout(flush, 300)
  }
  return { settings, loaded, saving, error, update, retry: () => loaded ? flush() : setVersion(value => value + 1) }
}

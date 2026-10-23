import { useCallback, useEffect, useRef, useState } from 'react'
import { modelApi } from '../../api/endpoints'
import type { ModelInfo } from '../../api/types'
import { speechApi, type NarrationInput, type NarrationPreferences, type SpeechJob, type SpeechScope } from '../../api/speech'
import { defaultNarrationPreferences } from '../../../shared/speech'

export function useNarration(scope: SpeechScope) {
  const { projectId, quickSessionId } = scope
  const [preferences, setPreferences] = useState(defaultNarrationPreferences)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [jobs, setJobs] = useState<SpeechJob[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const saved = useRef('')
  const current = useRef(preferences)
  const loaded = useRef(false)
  const generationGuard = useRef(false)
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())
  const speechKey = useRef<{ signature: string; key: string } | null>(null)
  current.current = preferences

  useEffect(() => {
    const controller = new AbortController()
    loaded.current = false
    setLoading(true)
    setError(null)
    void Promise.all([
      speechApi.preferences({ projectId, quickSessionId }, controller.signal),
      modelApi.list('tts', controller.signal),
      speechApi.list({ projectId, quickSessionId }, controller.signal),
    ]).then(([settings, catalog, history]) => {
      if (controller.signal.aborted) return
      saved.current = JSON.stringify(settings.preferences)
      setPreferences(settings.preferences)
      setModels(catalog.models.filter(model => model.enabled))
      setJobs(history.jobs)
      loaded.current = true
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause)
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [projectId, quickSessionId, reload])

  const save = useCallback(async (value: NarrationPreferences) => {
    const signature = JSON.stringify(value)
    setSaving(true)
    const request = saveChain.current.catch(() => undefined).then(() => speechApi.savePreferences({ projectId, quickSessionId }, value))
    saveChain.current = request
    try {
      await request
      saved.current = signature
    } finally {
      setSaving(false)
    }
  }, [projectId, quickSessionId])

  useEffect(() => {
    if (!loaded.current || saved.current === JSON.stringify(preferences)) return
    const timer = window.setTimeout(() => void save(preferences).catch(setError), 400)
    return () => window.clearTimeout(timer)
  }, [preferences, save])

  useEffect(() => () => {
    if (loaded.current && saved.current !== JSON.stringify(current.current)) void save(current.current).catch(() => undefined)
  }, [save])

  const active = jobs.some(job => job.status === 'queued' || job.status === 'running')
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const timer = window.setInterval(() => {
      void speechApi.list({ projectId, quickSessionId }, controller.signal).then(result => setJobs(result.jobs)).catch(cause => {
        if (!controller.signal.aborted) setError(cause)
      })
    }, 1500)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [projectId, quickSessionId, active])

  const matching = jobs.find(job => job.modelId === preferences.modelId && job.input === preferences.input.trim()
    && (job.status === 'succeeded' || job.status === 'queued' || job.status === 'running'))
  const valid = Boolean(preferences.modelId && preferences.input.trim() && models.some(model => model.id === preferences.modelId))
  const ready = !loading && loaded.current && (!preferences.enabled || valid)

  async function generate() {
    if (!valid || generationGuard.current) return
    generationGuard.current = true
    setBusy(true)
    setError(null)
    try {
      await save(preferences)
      const body = { projectId, quickSessionId, modelId: preferences.modelId!, input: preferences.input.trim() }
      const signature = JSON.stringify(body)
      if (speechKey.current?.signature !== signature) speechKey.current = { signature, key: crypto.randomUUID() }
      const result = await speechApi.create(body, speechKey.current.key)
      speechKey.current = null
      setJobs(existing => [result.job, ...existing.filter(job => job.id !== result.job.id)])
    } catch (cause) {
      setError(cause)
    } finally {
      generationGuard.current = false
      setBusy(false)
    }
  }

  async function prepare(): Promise<NarrationInput | undefined> {
    if (!ready) throw new Error('Narration settings are not ready')
    if (!preferences.enabled) return undefined
    await save(preferences)
    const audio = { mode: preferences.mode, originalVolume: preferences.originalVolume }
    return matching
      ? { speechJobId: matching.id, ...audio }
      : { modelId: preferences.modelId!, input: preferences.input.trim(), ...audio }
  }

  async function remove(id: string) {
    setError(null)
    try {
      await speechApi.remove(id)
      setJobs(existing => existing.filter(job => job.id !== id))
    } catch (cause) {
      setError(cause)
    }
  }

  return {
    preferences, models, jobs, loading, busy, saving, error, matching, ready, valid,
    update: (patch: Partial<NarrationPreferences>) => setPreferences(value => ({ ...value, ...patch })),
    generate, prepare, remove,
    refreshJobs: async () => {
      try {
        const result = await speechApi.list({ projectId, quickSessionId })
        setJobs(result.jobs)
      } catch (cause) {
        setError(cause)
      }
    },
    reload: () => setReload(value => value + 1),
  }
}

export type NarrationState = ReturnType<typeof useNarration>

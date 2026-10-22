import { useEffect, useRef, useState } from 'react'
import { characterApi, generationApi, uploadApi } from '../../api/endpoints'
import { entityLibraryApi, type EntityKind, type EntityLibraryEntity } from '../../api/entityLibrary'
import type { Generation } from '../../api/types'
import type { EntityCreationDraft } from './types'

export type CreationIssue = { key?: 'aiTimeout' | 'aiNoAsset' | 'aiImageFailed' | 'aiPublicationFailed'; cause?: unknown }
export type CandidateStatus = 'ready' | 'imaging' | 'saving' | 'saved' | 'error' | 'stopped'
export type CandidateImagePhase = 'queued' | 'sending' | 'generating' | 'publishing' | 'saving'
export interface CreationRun {
  readonly kind: EntityKind
  readonly description: string
  readonly count: number
  readonly language: string
  readonly modelId: string
  readonly imageModelId: string
  readonly size: string
  readonly quality: string
  readonly includeImages: boolean
  readonly autoSave: boolean
  readonly sourceFile: File | null
  /** Existing owned source from the image editor; never owned/deleted by this hook. */
  readonly initialSource?: { uploadId: string; url: string }
  readonly existingEntity?: EntityLibraryEntity
}
export interface CreationCandidate {
  candidateId: string
  draft: EntityCreationDraft
  run: Readonly<CreationRun>
  sourceUploadId?: string
  sourcePreview?: string
  status: CandidateStatus
  imagePhase?: CandidateImagePhase
  progress: number | null
  generationId?: string
  assetId?: string
  assetUrl?: string
  createdId?: string
  attached?: boolean
  publicationStatus?: Generation['libraryPublishStatus']
  issue?: CreationIssue
  idempotencyKey: string
}
class StaleOperation extends Error {}
class CreationFailure extends Error {
  constructor(readonly issue: CreationIssue) { super(issue.key ?? 'creation-failed') }
}
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new StaleOperation()); return }
  const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  function abort() { window.clearTimeout(timer); reject(new StaleOperation()) }
  signal.addEventListener('abort', abort, { once: true })
})
const newId = () => crypto.randomUUID()

/** Holds paid jobs separately from rendering: retries never lose an accepted generation. */
export function useEntityCreation({ onSaved, confirmChanged }: {
  onSaved: (name: string) => void
  confirmChanged: () => boolean
}) {
  const [candidates, setCandidates] = useState<CreationCandidate[]>([])
  const [phase, setPhase] = useState<'idle' | 'upload' | 'text' | 'images' | 'save'>('idle')
  const [issue, setIssue] = useState<CreationIssue | null>(null)
  const [activeCandidateIds, setActiveCandidateIds] = useState<string[]>([])
  const activeIds = useRef<string[]>([])
  const records = useRef(new Map<string, CreationCandidate>())
  const revision = useRef(0)
  const mounted = useRef(true)
  const operation = useRef<AbortController | null>(null)
  const ownedUploads = useRef(new Set<string>())
  const previews = useRef(new Set<string>())
  const active = useRef(false)
  const metadataWrites = useRef(new Map<string, Promise<string>>())
  const imageWrites = useRef(new Map<string, Promise<{ generation: Generation }>>())
  const referenceWrites = useRef(new Map<string, Promise<unknown>>())
  function writeReference(id: string, write: () => Promise<unknown>) {
    let pending = referenceWrites.current.get(id)
    if (!pending) {
      pending = write()
      referenceWrites.current.set(id, pending)
      const retained = pending
      void pending.catch(() => { if (referenceWrites.current.get(id) === retained) referenceWrites.current.delete(id) })
    }
    return pending
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      revision.current += 1
      operation.current?.abort()
      for (const id of ownedUploads.current) void uploadApi.remove(id).catch(() => {})
      for (const url of previews.current) URL.revokeObjectURL(url)
    }
  }, [])

  function publish() { if (mounted.current) setCandidates([...records.current.values()]) }
  function patch(id: string, changes: Partial<CreationCandidate>) {
    const previous = records.current.get(id)
    if (!previous) return
    records.current.set(id, { ...previous, ...changes })
    publish()
  }
  function track(ids: string[]) {
    activeIds.current = ids
    setActiveCandidateIds(ids)
  }
  function settled(id: string, token: number) {
    if (!mounted.current || token !== revision.current || !activeIds.current.includes(id)) return
    patch(id, { imagePhase: undefined })
  }
  function prepend(created: CreationCandidate[]) {
    records.current = new Map([...created.map(candidate => [candidate.candidateId, candidate] as const), ...records.current])
    publish()
  }
  function begin(nextPhase: typeof phase) {
    if (active.current) return null
    active.current = true
    const controller = new AbortController()
    operation.current = controller
    const token = ++revision.current
    track([])
    setIssue(null)
    setPhase(nextPhase)
    return { token, signal: controller.signal }
  }
  function check(token: number) {
    if (!mounted.current || revision.current !== token || operation.current?.signal.aborted) throw new StaleOperation()
  }
  function finish(token: number) {
    if (revision.current !== token || !mounted.current) return
    active.current = false
    track([])
    setPhase('idle')
  }
  function report(cause: unknown): CreationIssue {
    return cause instanceof CreationFailure ? cause.issue : { cause }
  }
  function stop() {
    revision.current += 1
    operation.current?.abort()
    active.current = false
    for (const id of activeIds.current) {
      const candidate = records.current.get(id)
      if (candidate && (candidate.imagePhase || candidate.status === 'imaging' || candidate.status === 'saving')) {
        patch(id, { status: 'stopped', imagePhase: undefined, progress: null })
      }
    }
    track([])
    setPhase('idle')
  }

  async function save(id: string, token: number, signal: AbortSignal) {
    check(token)
    let candidate = records.current.get(id)!
    const { draft, run } = candidate
    patch(id, { status: 'saving', imagePhase: 'saving', issue: undefined })
    // Asset autosave belongs exclusively to durable server publication.
    if (draft.kind !== 'character' && run.autoSave && run.includeImages && !run.existingEntity) {
      if (!candidate.generationId) throw new CreationFailure({ key: 'aiPublicationFailed' })
      const current = (await generationApi.get(candidate.generationId, signal)).generation
      check(token)
      applyGeneration(id, current)
      const publication = current.libraryPublications?.[0]
      if (current.libraryPublishStatus !== 'succeeded' || !publication) {
        throw new CreationFailure({ key: 'aiPublicationFailed' })
      }
      patch(id, { status: 'saved', createdId: publication.targetId, issue: undefined })
      onSaved(draft.input.name)
      return
    }
    let createdId = candidate.createdId ?? run.existingEntity?.id
    if (!createdId) {
      // Do not abort a write after acceptance: retain its ID even if Stop was pressed.
      let write = metadataWrites.current.get(id)
      if (!write) {
        write = draft.kind === 'character'
          ? characterApi.create(draft.input).then(result => result.character.id)
          : entityLibraryApi.create({ kind: draft.kind, ...draft.input, autoHandle: true }).then(result => result.asset.id)
        metadataWrites.current.set(id, write)
        // A failed request can be explicitly retried; an accepted pending request is reused.
        void write.catch(() => { if (metadataWrites.current.get(id) === write) metadataWrites.current.delete(id) })
      }
      createdId = await write
      patch(id, { createdId })
    }
    check(token)
    candidate = records.current.get(id)!
    if (candidate.generationId && candidate.assetUrl && !candidate.attached) {
      if (run.existingEntity) {
        const latest = (await entityLibraryApi.get(createdId, signal)).asset
        check(token)
        if (latest.revision !== run.existingEntity.revision && !confirmChanged()) {
          patch(id, { status: 'ready' })
          return
        }
      }
      await writeReference(id, () => draft.kind === 'character'
        ? characterApi.attachReferenceFromGeneration(createdId!, candidate.generationId!, candidate.assetId)
        : entityLibraryApi.attachReferenceFromGeneration(createdId!, candidate.generationId!, candidate.assetId))
      patch(id, { attached: true })
    } else if (run.initialSource && draft.kind === 'character' && !candidate.attached && !run.existingEntity) {
      await writeReference(id, () => characterApi.attachReferenceFromUpload(createdId!, run.initialSource!.uploadId))
      patch(id, { attached: true })
    } else if (run.sourceFile && !candidate.attached && !run.existingEntity) {
      // Keep the original File: no unsafe download or silent loss of metadata-only sources.
      await writeReference(id, () => draft.kind === 'character'
        ? characterApi.uploadReference(createdId!, run.sourceFile!)
        : entityLibraryApi.uploadReference(createdId!, run.sourceFile!))
      patch(id, { attached: true })
    }
    check(token)
    patch(id, { status: 'saved', createdId, issue: undefined })
    onSaved(draft.input.name)
  }

  function applyGeneration(id: string, current: Generation) {
    const candidate = records.current.get(id)!
    const asset = current.assets.find(asset => asset.id === candidate.assetId) ?? current.assets[0]
    patch(id, {
      progress: current.progress,
      publicationStatus: current.libraryPublishStatus,
      ...(asset ? { assetId: asset.id, assetUrl: asset.url } : {}),
    })
  }

  async function image(id: string, token: number, signal: AbortSignal) {
    check(token)
    let candidate = records.current.get(id)!
    patch(id, { status: 'imaging', imagePhase: candidate.generationId ? 'generating' : 'sending', progress: null, issue: undefined })
    if (!candidate.generationId) {
      const { draft, run } = candidate
      let write = imageWrites.current.get(id)
      if (!write) {
        write = draft.kind === 'character'
        ? characterApi.illustrate({ modelId: run.imageModelId, size: run.size, quality: run.quality, name: draft.input.name,
          appearance: draft.input.appearance, sourceUploadId: candidate.sourceUploadId,
          idempotencyKey: candidate.idempotencyKey })
        : entityLibraryApi.illustrate({ kind: draft.kind, modelId: run.imageModelId, size: run.size, quality: run.quality as '' | 'low' | 'medium' | 'high',
          name: draft.input.name, description: draft.input.description,
          continuityNotes: draft.input.continuityNotes, sourceUploadId: candidate.sourceUploadId,
          autoSave: run.autoSave && !run.existingEntity, idempotencyKey: candidate.idempotencyKey })
        imageWrites.current.set(id, write)
        void write.catch(() => { if (imageWrites.current.get(id) === write) imageWrites.current.delete(id) })
      }
      const result = await write
      // Acceptance is recorded BEFORE guards/polling. Stop does not erase a paid job.
      patch(id, { generationId: result.generation.id })
      if (candidate.sourceUploadId) ownedUploads.current.delete(candidate.sourceUploadId)
      applyGeneration(id, result.generation)
      check(token)
      patch(id, { imagePhase: 'generating' })
    }
    candidate = records.current.get(id)!
    const deadline = Date.now() + 4 * 60 * 1000
    while (Date.now() < deadline) {
      check(token)
      const current = (await generationApi.get(candidate.generationId!, signal)).generation
      check(token)
      applyGeneration(id, current)
      patch(id, { imagePhase: current.status === 'queued' ? 'queued' : 'generating' })
      if (current.status === 'failed' || current.status === 'unknown') {
        throw new CreationFailure({ key: 'aiImageFailed', cause: current })
      }
      if (current.status === 'succeeded') {
        if (!current.assets.length) throw new CreationFailure({ key: 'aiNoAsset' })
        if (candidate.run.autoSave && candidate.draft.kind !== 'character' && !candidate.run.existingEntity) {
          if (current.libraryPublishStatus === 'failed') throw new CreationFailure({ key: 'aiPublicationFailed' })
          if (current.libraryPublishStatus !== 'succeeded') { patch(id, { imagePhase: 'publishing', progress: null }); await delay(1500, signal); continue }
        }
        patch(id, { status: 'ready', progress: 100 })
        if (candidate.run.autoSave || candidate.run.existingEntity) await save(id, token, signal)
        return
      }
      await delay(1500, signal)
    }
    throw new CreationFailure({ key: 'aiTimeout' })
  }

  async function process(id: string, token: number, signal: AbortSignal) {
    try { await image(id, token, signal) }
    catch (cause) {
      if (cause instanceof StaleOperation || signal.aborted) return
      patch(id, { status: 'error', imagePhase: undefined, issue: report(cause) })
    } finally { settled(id, token) }
  }

  async function generate(input: CreationRun) {
    const existingAsset = input.existingEntity && input.existingEntity.kind !== 'character'
    const context = begin(input.sourceFile ? 'upload' : existingAsset ? 'images' : 'text')
    if (!context) return
    const { token, signal } = context
    // Freeze primitive settings; File and existing entity are retained snapshots.
    const run = Object.freeze({ ...input, existingEntity: input.existingEntity ? { ...input.existingEntity } : undefined })
    try {
      let sourceUploadId: string | undefined = run.initialSource?.uploadId ?? run.existingEntity?.reference?.uploadId
      let sourcePreview: string | undefined = run.initialSource?.url
      if (run.sourceFile) {
        const uploaded = await uploadApi.upload(run.sourceFile)
        ownedUploads.current.add(uploaded.id)
        if (!mounted.current || revision.current !== token) {
          void uploadApi.remove(uploaded.id).catch(() => {})
          throw new StaleOperation()
        }
        sourceUploadId = uploaded.id
        sourcePreview = URL.createObjectURL(run.sourceFile)
        previews.current.add(sourcePreview)
      }
      check(token)
      if (!existingAsset) setPhase('text')
      let drafts: EntityCreationDraft[]
      if (run.existingEntity && run.existingEntity.kind !== 'character') {
        const entity = run.existingEntity
        drafts = [{ kind: entity.kind as Exclude<EntityKind, 'character'>, input: { name: entity.name, handle: entity.handle,
          description: entity.description, continuityNotes: entity.continuityNotes } }]
      } else if (run.kind === 'character') {
        const result = await characterApi.generate({ description: run.description, count: run.count,
          language: run.language, modelId: run.modelId, sourceUploadId }, signal)
        drafts = result.candidates.map(input => ({ kind: 'character', input }))
      } else {
        const result = await entityLibraryApi.generate({ kind: run.kind, description: run.description,
          count: run.count, language: run.language, modelId: run.modelId, sourceUploadId }, signal)
        drafts = result.candidates.map(input => ({ kind: run.kind as Exclude<EntityKind, 'character'>, input }))
      }
      check(token)
      const created: CreationCandidate[] = drafts.map(draft => ({ candidateId: newId(), draft, run,
        sourceUploadId, sourcePreview, status: run.includeImages ? 'imaging' : 'ready',
        imagePhase: run.includeImages ? 'queued' : undefined, progress: null, idempotencyKey: newId() }))
      track(created.map(candidate => candidate.candidateId))
      prepend(created)
      if (run.includeImages) {
        setPhase('images')
        const queue = created.map(candidate => candidate.candidateId)
        await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
          while (queue.length) { check(token); const id = queue.shift()!; await process(id, token, signal) }
        }))
      } else if (run.autoSave) {
        setPhase('save')
        for (const candidate of created) {
          try { check(token); await save(candidate.candidateId, token, signal) }
          catch (cause) { if (signal.aborted) throw cause; patch(candidate.candidateId, { status: 'error', imagePhase: undefined, issue: report(cause) }) }
          finally { settled(candidate.candidateId, token) }
        }
      }
    } catch (cause) {
      if (!(cause instanceof StaleOperation) && !signal.aborted && mounted.current) setIssue(report(cause))
    } finally { finish(token) }
  }

  async function act(id: string, action: 'save' | 'resume' | 'publication' | 'new-image') {
    const candidate = records.current.get(id)
    if (!candidate) return
    const context = begin(action === 'save' ? 'save' : 'images')
    if (!context) return
    const { token, signal } = context
    let activeId = id
    track([id])
    try {
      if (action === 'new-image') {
        // Retain the original paid job/card; a confirmed new job gets its own identity.
        const copy = { ...candidate, candidateId: newId(), idempotencyKey: newId(), generationId: undefined,
          assetId: undefined, assetUrl: undefined, createdId: undefined, attached: false,
          publicationStatus: undefined, status: 'imaging' as const, imagePhase: 'queued' as const, progress: null, issue: undefined }
        activeId = copy.candidateId
        track([activeId])
        prepend([copy])
        await image(copy.candidateId, token, signal)
      } else if (action === 'publication') {
        if (!candidate.generationId) return
        patch(id, { status: 'imaging', imagePhase: 'publishing', progress: null, issue: undefined })
        const result = await generationApi.retryLibraryPublication(candidate.generationId)
        check(token)
        applyGeneration(id, result.generation)
        await image(id, token, signal)
      } else if (action === 'save') await save(id, token, signal)
      else await image(id, token, signal)
    } catch (cause) {
      if (!(cause instanceof StaleOperation) && !signal.aborted) patch(activeId, { status: 'error', imagePhase: undefined, issue: report(cause) })
    } finally { settled(activeId, token); finish(token) }
    return records.current.get(activeId)?.status === 'saved'
  }

  const activeCandidates = candidates.filter(candidate => activeCandidateIds.includes(candidate.candidateId))
  const summary = {
    total: activeCandidateIds.length,
    completed: activeCandidates.filter(candidate => candidate.run.includeImages ? !!candidate.assetUrl : candidate.status === 'ready' || candidate.status === 'saved').length,
    failed: activeCandidates.filter(candidate => candidate.status === 'error').length,
  }
  const pendingCandidates = activeCandidates.filter(candidate => candidate.imagePhase)
  const displayPhase = phase === 'images' && pendingCandidates.length > 0 && pendingCandidates.every(candidate => candidate.imagePhase === 'saving') ? 'save' : phase
  return { candidates, phase: displayPhase, issue, activeCandidateIds, summary, running: phase !== 'idle', generate, act, stop }
}

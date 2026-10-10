import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Copy, ImagePlus, LoaderCircle, Plus, Save, Sparkles, Trash2, Upload } from 'lucide-react'
import { plannerApi, uploadUrl, type CastMember, type PlanSession } from '../api/planner'
import { generationApi, modelApi } from '../api/endpoints'
import { errorMessage, storedErrorMessage } from '../api/client'
import type { ModelInfo } from '../api/types'
import { notification, type Notification } from '../i18n/messages'
import { profileAppearance } from '../../shared/characterVariants'
import { useTranslation } from '../i18n/useTranslation'
import { plannerCharactersCatalog } from '../i18n/catalogs/plannerCharacters'
import '../styles/plannerCharacters.css'

type Profile = Record<'nationality' | 'age' | 'gender' | 'skinTone' | 'face' | 'eyes' | 'hairColor' | 'hairStyle' | 'heightCm' | 'build' | 'posture' | 'clothing' | 'footwear' | 'accessories' | 'distinctiveFeatures' | 'contextNotes', string>
type Variant = { sourceAppearance?: string; id: string; label: string; profile: Profile; appearance: string; rationale: string; assumptions: string[]; portrait: { uploadId: string } | null; revision: number; portraitRevision: number | null; generationId: string | null }
type Character = CastMember & { variants?: Variant[]; selectedVariantId?: string | null; revision?: number }
type Draft = { name: string; role: string; storage: 'library' | 'project'; variant: Variant | null }
const groups = [
  { title: 'identity', fields: ['nationality', 'age', 'gender'] },
  { title: 'body', fields: ['skinTone', 'face', 'eyes', 'hairColor', 'hairStyle', 'heightCm', 'build', 'posture', 'distinctiveFeatures'] },
  { title: 'wardrobe', fields: ['clothing', 'footwear', 'accessories'] },
  { title: 'context', fields: ['contextNotes'] },
] as const
const blankProfile = (): Profile => Object.fromEntries(groups.flatMap(group => group.fields).map(key => [key, ''])) as Profile
const clone = <T,>(value: T): T => structuredClone(value)
const blankVariant = () => ({ label: '', profile: blankProfile(), appearance: '', rationale: '', assumptions: [] as string[] })
const variantInput = (variant: Pick<Variant, 'label' | 'profile' | 'appearance' | 'rationale' | 'assumptions'>) => ({
  label: variant.label.trim(), profile: clone(variant.profile),
  // Structured profiles are the source of truth; only legacy blank profiles accept free text.
  ...(profileAppearance(variant.profile) ? {} : { appearance: variant.appearance }),
  rationale: variant.rationale, assumptions: [...variant.assumptions],
})
const draftOf = (member: Character, variant?: Variant): Draft => ({ name: member.name, role: member.role, storage: member.storage, variant: variant ? clone(variant) : null })

export interface PlannerCharactersPageProps {
  sessionId: string
  onSelectSession: (id: string) => void
  onBackToChat: (id: string) => void
  onOpenTimeline: (id: string) => void
  onNotify: (message: Notification) => void
  onRegisterNavigationGuard?: (guard: ((action: () => void) => void) | null) => void
}

/** Dedicated workshop. Only explicit saves modify content; navigation never silently discards drafts. */
export function PlannerCharactersPage({ sessionId, onSelectSession, onBackToChat, onOpenTimeline, onNotify, onRegisterNavigationGuard }: PlannerCharactersPageProps) {
  const { t } = useTranslation(plannerCharactersCatalog)
  const [session, setSession] = useState<PlanSession | null>(null)
  const [sessions, setSessions] = useState<PlanSession[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [memberId, setMemberId] = useState('')
  const [variantId, setVariantId] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState('')
  const [busy, setBusy] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [localError, setLocalError] = useState<'required' | 'timeout' | 'unknown' | 'failed' | null>(null)
  const [batchStatus, setBatchStatus] = useState<{ current: number; total: number } | null>(null)
  const stopBatch = useRef(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [count, setCount] = useState(3)
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState<(() => void) | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<'member' | 'variant' | null>(null)
  const alive = useRef(true)
  const busyRef = useRef(false)
  const sessionRef = useRef(sessionId)
  const latestSession = useRef(session)
  const monitoring = useRef(new Set<string>())
  latestSession.current = session
  function revisionOf(castId: string, id: string, fallback: number): number {
    return (latestSession.current?.cast.find(item => item.id === castId) as Character | undefined)?.variants?.find(item => item.id === id)?.revision ?? fallback
  }
  const dialogRef = useRef<HTMLDivElement>(null)
  sessionRef.current = sessionId
  const member = session?.cast.find(item => item.id === memberId) as Character | undefined
  const variants = member?.variants ?? []
  const current = variants.find(item => item.id === variantId)
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline)
  const disabled = Boolean(busy) || loading
  const structuredAppearance = draft?.variant ? profileAppearance(draft.variant.profile) : ''
  const appearancePreview = structuredAppearance || draft?.variant?.appearance || ''

  function openMember(value: Character | undefined, preferred?: string | null) {
    if (value && latestSession.current?.id === sessionRef.current) {
      value = (latestSession.current.cast.find(item => item.id === value!.id) as Character | undefined) ?? value
    }
    const variant = value?.variants?.find(item => item.id === preferred) ?? value?.variants?.find(item => item.id === value.selectedVariantId) ?? value?.variants?.[0]
    const next = value ? draftOf(value, variant) : null
    setMemberId(value?.id ?? ''); setVariantId(variant?.id ?? '')
    setDraft(next); setBaseline(JSON.stringify(next)); setLocalError(null)
  }
  function apply(value: PlanSession, preferredMember = memberId, preferredVariant = variantId) {
    if (!alive.current || sessionRef.current !== value.id) return
    latestSession.current = value
    setSession(value)
    setSessions(list => list.map(item => item.id === value.id ? value : item))
    openMember((value.cast.find(item => item.id === preferredMember) ?? value.cast[0]) as Character | undefined, preferredVariant)
  }
  function refreshPortrait(value: PlanSession) {
    if (!alive.current || sessionRef.current !== value.id) return
    latestSession.current = value
    setSession(value)
    setSessions(list => list.map(item => item.id === value.id ? value : item))
    // Image metadata must never replace user edits or reset their dirty baseline.
  }
  useEffect(() => {
    onRegisterNavigationGuard?.(dirty || disabled ? guard : null)
    return () => onRegisterNavigationGuard?.(null)
  }, [onRegisterNavigationGuard, dirty, disabled])
  useEffect(() => {
    if (!session) return
    for (const cast of session.cast as Character[]) {
      for (const variant of cast.variants ?? []) {
        if (variant.generationId) void monitorPortrait(session.id, cast.id, variant.id, variant.generationId, variant.revision)
      }
    }
  }, [session])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setSession(null); setDraft(null); setBaseline(''); setError(null); setLocalError(null)
    Promise.all([plannerApi.get(sessionId), plannerApi.list(), modelApi.list()]).then(([result, list, modelList]) => {
      if (!active) return
      latestSession.current = result.session
      setSession(result.session); setSessions(list.sessions); setModels(modelList.models)
      openMember(result.session.cast[0] as Character | undefined)
    }).catch(cause => { if (active) setError(cause) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sessionId])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    if (!pending && !confirmDelete) return
    const previous = document.activeElement as HTMLElement | null
    const items = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
    items()[0]?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { setPending(null); setConfirmDelete(null) }
      if (event.key !== 'Tab') return
      const list = items(); const first = list[0]; const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); previous?.focus() }
  }, [Boolean(pending), confirmDelete])

  async function run(tag: string, action: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true; setBusy(tag); setError(null); setLocalError(null)
    try { await action(); return true } catch (cause) { if (alive.current) setError(cause); return false }
    finally { busyRef.current = false; if (alive.current) { setBusy(''); setProgress(null) } }
  }
  function guard(action: () => void) {
    if (disabled) return
    if (dirty) setPending(() => action)
    else action()
  }
  async function save(): Promise<boolean> {
    if (!session || !member || !draft) return false
    if (!draft.name.trim() || (draft.variant && !draft.variant.label.trim())) { setLocalError('required'); return false }
    const value = clone(draft)
    return run('save', async () => {
      let result = session
      // Metadata and profile saves are sequential. If a profile conflicts, retain the draft for recovery.
      if (member.name !== value.name || member.role !== value.role || member.storage !== value.storage) {
        result = (await plannerApi.saveCast(session.id, session.cast.map(item => item.id === member.id ? { ...item, name: value.name.trim(), role: value.role, storage: value.storage } : item))).session
        if (alive.current && sessionRef.current === result.id) setSession(result)
      }
      if (value.variant && JSON.stringify(variantInput(value.variant)) !== JSON.stringify(variantInput(current!))) {
        result = (await plannerApi.updateVariant(session.id, member.id, value.variant.id, {
          ...variantInput(value.variant), revision: value.variant.revision,
        })).session
      }
      apply(result); onNotify(notification('plannerCharacters', 'saved'))
    })
  }
  function changeVariant(value: Partial<Variant>) {
    setDraft(previous => previous?.variant ? { ...previous, variant: { ...previous.variant, ...value } } : previous)
  }
  async function createVariant(source?: Variant) {
    if (!session || !member) return
    if (source) source = (latestSession.current?.cast.find(item => item.id === member.id) as Character | undefined)?.variants?.find(item => item.id === source!.id) ?? source
    await run('variant', async () => {
      const input = variantInput(source ? { ...source, label: `${source.label} (2)` } : { ...blankVariant(), label: t('addVariant') })
      const result = await plannerApi.createVariant(session.id, member.id, input)
      const updated = result.session.cast.find(item => item.id === member.id) as Character | undefined
      const added = updated?.variants?.find(item => !variants.some(old => old.id === item.id))
      apply(result.session, member.id, added?.id)
    })
  }
  async function monitorPortrait(id: string, castId: string, targetId: string, generationId: string, revision: number) {
    const key = `${id}:${generationId}`
    if (monitoring.current.has(key)) return
    monitoring.current.add(key)
    try {
      let generation = (await generationApi.get(generationId)).generation
      const start = Date.now()
      while (alive.current && sessionRef.current === id && ['queued', 'running', 'downloading'].includes(generation.status)) {
        if (revisionOf(castId, targetId, revision) !== revision) return
        setProgress(generation.progress ?? 0)
        if (Date.now() - start > 6 * 60_000) { setLocalError('timeout'); return }
        await new Promise(resolve => window.setTimeout(resolve, 1500))
        if (!alive.current || sessionRef.current !== id) return
        generation = (await generationApi.get(generationId)).generation
      }
      if (!alive.current || sessionRef.current !== id) return
      if (generation.status === 'unknown') { setLocalError('unknown'); return }
      if (generation.status !== 'succeeded') { setError(new Error(storedErrorMessage(generation) || t('failed'))); return }
      // Re-read the persisted variant: a stale result must not attach to an edited profile.
      const fresh = (await plannerApi.get(id)).session
      if (!alive.current || sessionRef.current !== id) return
      const target = (fresh.cast.find(item => item.id === castId) as Character | undefined)?.variants?.find(item => item.id === targetId)
      refreshPortrait(fresh)
      if (!target || target.revision !== revision || target.generationId !== generationId) return
      const attached = await plannerApi.attachVariantPortrait(id, castId, targetId, { generationId, revision })
      refreshPortrait(attached.session)
    } catch (cause) {
      if (alive.current && sessionRef.current === id) setError(cause)
    } finally {
      if (alive.current && sessionRef.current === id) setProgress(null)
      monitoring.current.delete(key)
    }
  }
  async function generatePortrait() {
    if (!session || !member || !current) return
    const id = session.id; const castId = member.id; const targetId = current.id
    await run('portrait', async () => {
      const created = await plannerApi.generateVariantPortrait(id, castId, targetId)
      await monitorPortrait(id, castId, targetId, created.generation.id, created.revision)
    })
  }

  async function generateBatchPortraits() {
    if (!session || !member || !session.imageModelId) return
    const id = session.id; const castId = member.id
    const fresh = latestSession.current?.cast.find(item => item.id === castId)
    const targets = (fresh?.variants ?? []).filter(v => v.appearance.trim() && (!v.portrait || v.portraitRevision !== v.revision) && !v.generationId)
    if (!targets.length || !window.confirm(t('batchConfirm', { count: targets.length }))) return
    stopBatch.current = false
    await run('batch-portraits', async () => {
      let completed = 0
      try {
        for (const [index, target] of targets.entries()) {
          if (!alive.current || sessionRef.current !== id || stopBatch.current) break
          setBatchStatus({ current: index + 1, total: targets.length })
          const created = await plannerApi.generateVariantPortrait(id, castId, target.id)
          // Persisted generation IDs also allow the normal reload monitor to resume.
          const persisted = (await plannerApi.get(id)).session
          refreshPortrait(persisted)
          await monitorPortrait(id, castId, target.id, created.generation.id, created.revision)
          const updated = (await plannerApi.get(id)).session
          refreshPortrait(updated)
          const result = updated.cast.find(item => item.id === castId)?.variants?.find(v => v.id === target.id)
          if (!result?.portrait || result.portraitRevision !== created.revision || result.generationId) {
            onNotify(notification('plannerCharacters', 'batchStopped'))
            return
          }
          completed += 1
        }
        if (alive.current && sessionRef.current === id) onNotify(notification('plannerCharacters', 'batchDone', { count: completed }))
      } finally { if (alive.current) setBatchStatus(null) }
    })
  }
  const batchTargets = variants.filter(v => v.appearance.trim() && (!v.portrait || v.portraitRevision !== v.revision) && !v.generationId)
  const errorText = localError ? t(localError) : error ? errorMessage(error) : ''
  return <main className="pc-workshop" data-testid="planner-characters-page" aria-busy={disabled}>
    <header className="pc-header"><div><h1>{t('title')}</h1><p>{t('intro')}</p></div><nav>
      <button className="secondary-button" disabled={disabled} onClick={() => guard(() => onBackToChat(sessionId))}><ArrowLeft size={16} />{t('back')}</button>
      <button className="secondary-button" disabled={disabled} onClick={() => guard(() => onOpenTimeline(sessionId))}>{t('timeline')}</button>
    </nav></header>
    {errorText && <div className="form-error" role="alert">{errorText}</div>}
    {(busy || progress !== null) && <div className="pc-status" role="status"><LoaderCircle size={16} className="spin" />{progress === null ? t('working') : t('generating', { progress })}</div>}
    {loading ? <div className="pc-empty" role="status">{t('loading')}</div> : !session ? <div className="pc-empty">{t('missingSession')}</div> : <div className="pc-layout">
      <aside className="pc-sidebar">
        <label>{t('session')}<select value={sessionId} disabled={disabled} onChange={event => { const id = event.target.value; guard(() => onSelectSession(id)) }}>{sessions.map(item => <option key={item.id} value={item.id}>{item.title || item.id}</option>)}</select></label>
        <details className="pc-models"><summary>{t('models')}</summary>{(['chatModelId', 'imageModelId'] as const).map(key => <label key={key}>{t(key === 'chatModelId' ? 'chatModel' : 'imageModel')}<select value={session[key] ?? ''} disabled={disabled} onChange={event => { const value = event.target.value || null; guard(() => void run('model', async () => { apply((await plannerApi.setup(session.id, { [key]: value })).session) })) }}><option value="">{t('noModel')}</option>{models.filter(model => model.enabled && model.kind === (key === 'chatModelId' ? 'llm' : 'image')).map(model => <option value={model.id} key={model.id}>{model.displayName || model.modelId}</option>)}</select></label>)}</details>
        <h2>{t('cast')}</h2><div className="pc-member-list">{session.cast.map(item => <button key={item.id} className={`pc-member ${memberId === item.id ? 'is-active' : ''}`} disabled={disabled} onClick={() => guard(() => openMember(item as Character))}>{item.portrait ? <img src={uploadUrl(item.portrait.uploadId)} alt="" /> : <ImagePlus size={22} />}<span><strong>{item.name}</strong><small>{item.role}</small></span></button>)}</div>
        <button className="secondary-button" disabled={disabled} onClick={() => guard(() => void run('add-member', async () => {
          const id = crypto.randomUUID()
          const next: CastMember = { id, name: t('addMember'), role: '', appearance: '', voice: {}, storage: 'project', portrait: null, reuseCharacterId: null }
          apply((await plannerApi.saveCast(session.id, [...(latestSession.current?.cast ?? session.cast), next])).session, id)
        }))}><Plus size={15} />{t('addMember')}</button>
        <button className="secondary-button" disabled={disabled || !session.script || !session.chatModelId} onClick={() => guard(() => void run('cast', async () => { apply((await plannerApi.generateCast(session.id)).session) }))}><Sparkles size={15} />{t('generateCast')}</button>
      </aside>
      <section className="pc-main">{!member || !draft ? <div className="pc-empty"><h2>{t('empty')}</h2><p>{t('emptyHint')}</p></div> : <>
        <div className="pc-meta pc-panel"><label>{t('name')}<input value={draft.name} disabled={disabled} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>{t('role')}<input value={draft.role} disabled={disabled} onChange={event => setDraft({ ...draft, role: event.target.value })} /></label><label>{t('storage')}<select disabled={disabled} value={draft.storage} onChange={event => setDraft({ ...draft, storage: event.target.value as Draft['storage'] })}><option value="project">{t('project')}</option><option value="library">{t('library')}</option></select></label><button className="secondary-button pc-danger" disabled={disabled} onClick={() => guard(() => setConfirmDelete('member'))}><Trash2 size={15} />{t('removeMember')}</button></div>
        <div className="pc-proposals pc-panel"><h2>{t('variants')}</h2><div className="pc-proposal-fields"><label>{t('proposalCount')}<input type="number" min={1} max={6} value={count} disabled={disabled} onChange={event => setCount(Math.min(6, Math.max(1, Number(event.target.value) || 1)))} /></label><label>{t('instruction')}<textarea rows={2} value={instruction} disabled={disabled} placeholder={t('instructionHint')} onChange={event => setInstruction(event.target.value)} /></label></div><div className="pc-actions"><button className="primary-small-button" disabled={disabled || !session.chatModelId} onClick={() => guard(() => void run('propose', async () => { apply((await plannerApi.proposeVariants(session.id, member.id, { count, instruction })).session) }))}><Sparkles size={15} />{t('propose')}</button><button className="secondary-button" disabled={disabled || !session.imageModelId || !batchTargets.length} onClick={() => guard(() => void generateBatchPortraits())}><ImagePlus size={15} />{t('batchPortraits')}</button><button className="secondary-button" disabled={disabled} onClick={() => guard(() => void createVariant())}><Plus size={15} />{t('addVariant')}</button></div></div>
        <p>{t('batchHint')}</p>
        {batchStatus && <div className="pc-status" role="status"><span>{t('batchProgress', batchStatus)}</span><button type="button" className="secondary-button" onClick={() => { stopBatch.current = true }}>{t('stopBatch')}</button></div>}
        <div className="pc-variants">{!variants.length && <p>{t('noVariant')}</p>}{variants.map(variant => <button key={variant.id} className={`pc-variant ${variantId === variant.id ? 'is-active' : ''}`} disabled={disabled} onClick={() => guard(() => { const freshMember = (latestSession.current?.cast.find(item => item.id === member.id) as Character | undefined) ?? member; const freshVariant = freshMember.variants?.find(item => item.id === variant.id) ?? variant; const value = draftOf(freshMember, freshVariant); setVariantId(variant.id); setDraft(value); setBaseline(JSON.stringify(value)) })}>{variant.portrait ? <img src={uploadUrl(variant.portrait.uploadId)} alt="" loading="lazy" /> : <ImagePlus size={28} />}<strong>{variant.label}</strong>{member.selectedVariantId === variant.id && <span className="pc-selected"><Check size={13} />{t('selected')}</span>}</button>)}</div>
        {draft.variant && current && <div className="pc-editor pc-panel">
          <div className="pc-editor-heading"><label>{t('label')}<input value={draft.variant.label} disabled={disabled} onChange={event => changeVariant({ label: event.target.value })} /></label><div className="pc-actions"><button className="secondary-button" disabled={disabled || member.selectedVariantId === current.id} onClick={() => guard(() => void run('select', async () => { apply((await plannerApi.selectVariant(session.id, member.id, current.id, revisionOf(member.id, current.id, current.revision))).session) }))}><Check size={15} />{t('select')}</button><button className="secondary-button" disabled={disabled} onClick={() => guard(() => void createVariant(current))}><Copy size={15} />{t('clone')}</button><button className="secondary-button pc-danger" disabled={disabled} onClick={() => guard(() => setConfirmDelete('variant'))}><Trash2 size={15} />{t('removeVariant')}</button></div></div>
          <div className="pc-portrait"><div className="pc-portrait-image">{current.portrait ? <a href={uploadUrl(current.portrait.uploadId)} target="_blank" rel="noreferrer"><img src={uploadUrl(current.portrait.uploadId)} alt={member.name} /></a> : <><ImagePlus size={40} /><span>{t('noPortrait')}</span></>}</div><div><h3>{t('portrait')}</h3>{current.portrait && current.portraitRevision !== revisionOf(member.id, current.id, current.revision) && <p className="pc-stale" role="status">{t('stale')}</p>}<div className="pc-actions"><button className="secondary-button" disabled={disabled || !session.imageModelId} onClick={() => guard(() => void generatePortrait())}><Sparkles size={15} />{t('generatePortrait')}</button><label className={`secondary-button pc-upload ${disabled ? 'is-disabled' : ''}`}><Upload size={15} />{t('upload')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} aria-label={t('upload')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) guard(() => void run('upload', async () => { apply((await plannerApi.uploadVariantPortrait(session.id, member.id, current.id, file, revisionOf(member.id, current.id, current.revision))).session) })) }} /></label><button className="secondary-button" disabled={disabled || !current.portrait} onClick={() => guard(() => void run('remove-portrait', async () => { apply((await plannerApi.removeVariantPortrait(session.id, member.id, current.id, revisionOf(member.id, current.id, current.revision))).session) }))}>{t('removePortrait')}</button></div></div></div>
          <button className="secondary-button" disabled={disabled || !session.chatModelId} onClick={() => guard(() => void run('complete-profile', async () => {
            apply((await plannerApi.completeVariantProfile(session.id, member.id, current.id, revisionOf(member.id, current.id, current.revision))).session)
          }))}><Sparkles size={15} />{t('completeProfile')}</button>
          {current.sourceAppearance && <details><summary>{t('sourceAppearance')}</summary><p>{current.sourceAppearance}</p></details>}
          {groups.map(group => <fieldset key={group.title} disabled={disabled}><legend>{t(group.title)}</legend><div className="pc-profile-grid">{group.fields.map(key => <label key={key}>{t(key)}<textarea rows={key === 'clothing' || key === 'contextNotes' ? 3 : 2} value={draft.variant!.profile[key]} onChange={event => changeVariant({ profile: { ...draft.variant!.profile, [key]: event.target.value } })} /></label>)}</div></fieldset>)}
          <div className="pc-profile-grid"><label>{t('rationale')}<textarea rows={3} disabled={disabled} value={draft.variant.rationale} onChange={event => changeVariant({ rationale: event.target.value })} /></label><label>{t('assumptions')}<textarea rows={3} disabled={disabled} value={draft.variant.assumptions.join('\n')} onChange={event => changeVariant({ assumptions: event.target.value.split('\n') })} /></label></div>
          <label className="pc-prompt">{t('appearance')}<textarea rows={7} disabled={disabled} readOnly={Boolean(structuredAppearance)} value={appearancePreview} onChange={event => changeVariant({ appearance: event.target.value })} /><small>{t(structuredAppearance ? 'promptHint' : 'legacyPromptHint')}</small></label><button className="secondary-button" disabled={disabled || !appearancePreview} onClick={() => void run('copy', async () => { await navigator.clipboard.writeText(appearancePreview); onNotify(notification('plannerCharacters', 'copied')) })}><Copy size={15} />{t('copy')}</button>
        </div>}
        <footer className="pc-save-bar"><button className="primary-small-button" disabled={disabled || !dirty} onClick={() => void save()}><Save size={16} />{t('save')}</button><button className="secondary-button" disabled={disabled || !dirty} onClick={() => openMember(member, variantId)}>{t('discard')}</button></footer>
      </>}</section>
    </div>}
    {(pending || confirmDelete) && <div className="pc-dialog-backdrop"><div className="pc-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="pc-dialog-title"><h2 id="pc-dialog-title">{pending ? t('dirtyTitle') : t(confirmDelete === 'member' ? 'confirmMember' : 'confirmVariant')}</h2>{pending && <p>{t('dirtyHint')}</p>}<div className="pc-actions">
      {pending ? <><button className="primary-small-button" disabled={disabled} onClick={() => { const action = pending; void save().then(ok => { if (ok) { setPending(null); action() } }) }}>{t('save')}</button><button className="secondary-button" disabled={disabled} onClick={() => { const action = pending; openMember(member, variantId); setPending(null); action() }}>{t('discard')}</button></> : <button className="primary-small-button" disabled={disabled} onClick={() => void run('delete', async () => { if (!session || !member) return; const result = confirmDelete === 'member' ? await plannerApi.saveCast(session.id, session.cast.filter(item => item.id !== member.id)) : await plannerApi.removeVariant(session.id, member.id, current!.id, current!.revision); apply(result.session); setConfirmDelete(null) })}>{t(confirmDelete === 'member' ? 'removeMember' : 'removeVariant')}</button>}
      <button className="secondary-button" disabled={disabled} onClick={() => { setPending(null); setConfirmDelete(null) }}>{t('cancel')}</button>
    </div></div></div>}
  </main>
}

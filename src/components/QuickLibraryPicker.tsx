import { useEffect, useId, useRef, useState } from 'react'
import { BookOpen, Check, ChevronDown, ImageOff, LoaderCircle, Search } from 'lucide-react'
import { entityLibraryApi, entityReferenceUrl, type EntityLibraryEntity } from '../api/entityLibrary'
import { generationApi } from '../api/endpoints'
import type { Generation } from '../api/types'
import { errorMessage } from '../api/client'
import { useTranslation } from '../i18n'
import { entityLibraryCatalog } from '../i18n/catalogs/entityLibrary'
import '../styles/quick-library-picker.css'

export type LibrarySelection = { entity: EntityLibraryEntity; uploadId?: string; label?: string }
export type GeneratedImageSelection = { generation: Generation; asset: Generation['assets'][number] }
/** Explicit owner-scoped entity/view selection; callers pin identity into prompt bindings. */
export function QuickLibraryPicker({ onSelect, onSelectGeneratedImage, disabled, selectedKeys = [], selectedAssetIds = [] }: {
  onSelect: (selection: LibrarySelection) => void
  onSelectGeneratedImage?: (selection: GeneratedImageSelection) => void
  disabled?: boolean
  selectedKeys?: string[]
  selectedAssetIds?: string[]
}) {
  const { t } = useTranslation(entityLibraryCatalog)
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<EntityLibraryEntity[]>([])
  const [generations, setGenerations] = useState<Generation[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [kind, setKind] = useState('all')
  const [search, setSearch] = useState('')
  const [views, setViews] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setLoading(true)
    setError('')
    Promise.all([entityLibraryApi.list({}, abort.signal), generationApi.list({ kind: 'image', limit: 100 }, abort.signal)])
      .then(([entityResult, generationResult]) => {
        if (abort.signal.aborted) return
        setItems(entityResult.entities)
        setGenerations(generationResult.generations)
      })
      .catch(cause => { if (!abort.signal.aborted) setError(errorMessage(cause)) })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [open, retry])

  const availableItems = items.filter(entity => entity.kind !== 'character')
  const filteredItems = availableItems.filter(entity =>
    (kind === 'all' || entity.kind === kind) &&
    `${entity.name} ${entity.handle}`.toLowerCase().includes(search.toLowerCase()),
  )
  const generatedImages = (kind === 'all' ? generations.flatMap(generation => generation.status === 'succeeded'
    ? generation.assets.filter(asset => asset.mimeType.startsWith('image/')).map(asset => ({ generation, asset }))
    : [],
  ).filter(({ generation }) => generation.prompt.toLowerCase().includes(search.toLowerCase()) || generation.model.toLowerCase().includes(search.toLowerCase())) : [])
  const hasResults = filteredItems.length > 0 || generatedImages.length > 0

  return <div className="quick-library-picker">
    <button
      ref={toggleRef}
      type="button"
      className="qlp-toggle"
      disabled={disabled}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => {
        if (!open) { setLoading(true); setError('') }
        setOpen(current => !current)
      }}
    >
      <BookOpen size={17} aria-hidden="true" />
      <span>{t('chooseLibrary')}</span>
      <ChevronDown size={16} className="qlp-chevron" aria-hidden="true" />
    </button>
    <section id={panelId} className="qlp-panel" hidden={!open} aria-label={t('chooseLibrary')}>
      <div className="qlp-toolbar">
        <label className="qlp-field">
          <span>{t('kind')}</span>
          <select value={kind} onChange={event => setKind(event.target.value)}>
            {(['all', 'item', 'location', 'logo'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}
          </select>
        </label>
        <label className="qlp-field qlp-search">
          <span>{t('search')}</span>
          <span className="qlp-search-control">
            <Search size={17} aria-hidden="true" />
            <input type="search" value={search} placeholder={t('searchPlaceholder')} onChange={event => setSearch(event.target.value)} />
          </span>
        </label>
      </div>
      {loading ? <div className="qlp-feedback" role="status">
        <LoaderCircle size={22} className="qlp-spinner" aria-hidden="true" />
        <p>{t('loading')}</p>
      </div> : error ? <div className="qlp-feedback qlp-error" role="alert">
        <strong>{t('pickerLoadError')}</strong>
        <p>{error}</p>
        <button type="button" className="qlp-action" onClick={() => { setLoading(true); setRetry(current => current + 1) }}>{t('retry')}</button>
      </div> : !availableItems.length && !generatedImages.length ? <div className="qlp-feedback" role="status">
        <BookOpen size={24} aria-hidden="true" />
        <strong>{t('pickerEmpty')}</strong>
        <p>{t('pickerEmptyHint')}</p>
      </div> : !hasResults ? <div className="qlp-feedback" role="status">
        <Search size={24} aria-hidden="true" />
        <strong>{t('mentionEmpty')}</strong>
        <p>{t('pickerFilterEmptyHint')}</p>
        <button type="button" className="qlp-action" onClick={() => { setKind('all'); setSearch('') }}>{t('pickerClearFilters')}</button>
      </div> : <>
        {filteredItems.length > 0 && <ul className="qlp-grid">
        {filteredItems.map(entity => {
          const key = `${entity.kind}:${entity.id}`
          const uploadId = views[key] ?? entity.reference?.uploadId
          const view = entity.referenceViews?.find(candidate => candidate.uploadId === uploadId)
          const preview = uploadId ? `/api/uploads/${encodeURIComponent(uploadId)}` : entityReferenceUrl(entity)
          const selected = selectedKeys.includes(key)
          return <li key={key} className={`qlp-card${selected ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="qlp-select"
              disabled={disabled || selected}
              onClick={() => {
                onSelect({ entity, uploadId, label: view?.label })
                setOpen(false)
                toggleRef.current?.focus()
              }}
            >
              <span className="qlp-preview">
                {preview ? <img src={preview} alt="" loading="lazy" /> : <ImageOff size={23} aria-label={t('noReference')} role="img" />}
              </span>
              <span className="qlp-card-copy">
                <span className="qlp-kind">{t(entity.kind)}</span>
                <strong>{entity.name}</strong>
                <span className="qlp-handle">@{entity.handle}</span>
                {selected && <span className="qlp-selected"><Check size={14} aria-hidden="true" />{t('pickerSelected')}</span>}
              </span>
            </button>
            {entity.kind === 'location' && Boolean(entity.referenceViews?.length) && <label className="qlp-field qlp-view">
              <span>{t('referenceView')}</span>
              <select value={uploadId ?? ''} onChange={event => setViews(current => ({ ...current, [key]: event.target.value }))}>
                {entity.referenceViews!.map(referenceView => <option key={referenceView.id} value={referenceView.uploadId}>{referenceView.label || t('defaultView')}</option>)}
              </select>
            </label>}
          </li>
        })}
        </ul>}
        {generatedImages.length > 0 && <>
          <h3 className="qlp-section-title">{t('generatedImages')}</h3>
          <ul className="qlp-grid">
            {generatedImages.map(({ generation, asset }) => {
              const selected = selectedAssetIds.includes(asset.id)
              return <li key={asset.id} className={`qlp-card${selected ? ' is-selected' : ''}`}>
                <button
                  type="button"
                  className="qlp-select"
                  disabled={disabled || selected || !onSelectGeneratedImage}
                  onClick={() => {
                    onSelectGeneratedImage?.({ generation, asset })
                    setOpen(false)
                    toggleRef.current?.focus()
                  }}
                >
                  <span className="qlp-preview"><img src={asset.url} alt="" loading="lazy" /></span>
                  <span className="qlp-card-copy">
                    <span className="qlp-kind">{t('generatedImage')}</span>
                    <strong>{generation.prompt || t('generatedImage')}</strong>
                    <span className="qlp-handle">{generation.model}</span>
                    {selected && <span className="qlp-selected"><Check size={14} aria-hidden="true" />{t('pickerSelected')}</span>}
                  </span>
                </button>
              </li>
            })}
          </ul>
        </>}
      </>}
      <p className="qlp-hint">{t('pickerHint')}</p>
    </section>
  </div>
}

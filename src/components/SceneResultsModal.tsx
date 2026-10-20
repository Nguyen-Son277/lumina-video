import { Check, Film, Pencil, LoaderCircle } from 'lucide-react'
import type { ProjectGeneration, ProjectScene } from '../api/projectTypes'
import { useTranslation } from '../i18n'
import { sceneResultsCatalog } from '../i18n/catalogs/sceneResults'
import { GenerationProgress, isGenerationActive } from './Common'
import { SceneEditorModal } from './SceneEditorModal'
import '../styles/scene-results.css'

export type SceneResultsModalProps = {
  scene: ProjectScene
  generations: ProjectGeneration[]
  loading?: boolean
  busy: boolean
  onClose: () => void
  onEdit: () => void
  onSelect: (generationId: string) => void
}

/** Read-only history: the parent owns fetching, polling and selection persistence. */
export function SceneResultsModal({ scene, generations, loading = false, busy, onClose, onEdit, onSelect }: SceneResultsModalProps) {
  const { t, locale } = useTranslation(sceneResultsCatalog)
  const versions = [...generations].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
  const dateFormatter = new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <SceneEditorModal
      title={t('title', { title: scene.title.trim() || t('untitled') })}
      closeLabel={t('close')}
      onClose={onClose}
      headerActions={
        <button type="button" className="secondary-button scene-results-edit" disabled={busy} onClick={onEdit}>
          <Pencil size={16} aria-hidden="true" />{t('edit')}
        </button>
      }
    >
      <div className="scene-results">
        {loading ? <div className="scene-results-empty" role="status"><LoaderCircle size={28} className="spin" /><p>{t('loading')}</p></div> : versions.length > 0 ? <>
          <p className="scene-results-intro">{t('intro')}</p>
          <ol className="scene-results-list" aria-label={t('versions')}>
            {versions.map((generation, index) => {
              const number = versions.length - index
              const selected = scene.selectedGenerationId === generation.id
              const active = isGenerationActive(generation)
              const succeeded = generation.status === 'succeeded'
              return (
                <li key={generation.id} className={`scene-results-card${selected ? ' is-selected' : ''}`}>
                  <div className="scene-results-card-header">
                    <div className="scene-results-version">
                      <h3>{t('version', { number })}</h3>
                      <time dateTime={new Date(generation.createdAt).toISOString()}>{dateFormatter.format(generation.createdAt)}</time>
                    </div>
                    {selected && <span className="scene-results-selected"><Check size={15} aria-hidden="true" />{t('selected')}</span>}
                  </div>
                  {succeeded && generation.assets.length > 0 ? (
                    <div className="scene-results-media">
                      {generation.assets.map(asset => generation.kind === 'video' ? (
                        <video key={asset.id} src={asset.url} controls playsInline preload="metadata" aria-label={t('preview', { number })} />
                      ) : (
                        <img key={asset.id} src={asset.url} alt={t('preview', { number })} loading="lazy" />
                      ))}
                    </div>
                  ) : !active && <div className="scene-results-placeholder"><Film size={28} aria-hidden="true" /><p>{t('noAsset')}</p></div>}
                  <div className="scene-results-details">
                    {active ? <GenerationProgress generation={generation} /> : <span className={`scene-results-status is-${generation.status}`}>{t(generation.status)}</span>}
                    <p className="scene-results-model">{[generation.model, generation.provider].filter(Boolean).join(' · ')}</p>
                    {generation.status === 'failed' && <p className="scene-results-failure">{t('failedDescription')}</p>}
                    {succeeded && <div className="scene-results-actions">
                      <button type="button" className="primary-small-button scene-results-select" disabled={busy || selected} aria-label={t('selectAria', { number })} onClick={() => onSelect(generation.id)}>
                        <Check size={16} aria-hidden="true" />{t(selected ? 'selected' : 'select')}
                      </button>
                    </div>}
                  </div>
                </li>
              )
            })}
          </ol>
        </> : <div className="scene-results-empty">
          <Film size={36} aria-hidden="true" />
          <h3>{t('emptyTitle')}</h3>
          <p>{t('emptyDescription')}</p>
          <button type="button" className="primary-small-button scene-results-edit" disabled={busy} onClick={onEdit}><Pencil size={16} aria-hidden="true" />{t('edit')}</button>
        </div>}
      </div>
    </SceneEditorModal>
  )
}

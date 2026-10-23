import { Download, LoaderCircle, Mic, RefreshCw, Trash2 } from 'lucide-react'
import { errorMessage, storedErrorMessage } from '../../api/client'
import { useTranslation } from '../../i18n'
import { speechCatalog } from '../../i18n/catalogs/speech'
import { SPEECH_MAX_INPUT } from '../../../shared/speech'
import type { NarrationState } from './useNarration'
import '../../styles/speech.css'

export function NarrationPanel({ state, disabled = false }: { state: NarrationState; disabled?: boolean }) {
  const { t } = useTranslation(speechCatalog)
  const { preferences, update } = state
  const playing = state.matching?.status === 'succeeded' ? state.matching : undefined
  return <section className="narration-panel" aria-label={t('title')}>
    <div className="narration-heading"><h3><Mic size={17} /> {t('title')}</h3>
      {state.saving && <small role="status">{t('saving')}</small>}
    </div>
    {state.loading ? <p role="status">{t('loading')}</p> : <>
      <label className="narration-toggle">
        <input type="checkbox" checked={preferences.enabled} disabled={disabled} onChange={event => update({ enabled: event.target.checked })} />
        <span>{t('enabled')}</span>
      </label>
      {preferences.enabled && <fieldset disabled={disabled} className="narration-fields">
        <p className="narration-hint">{t('hint')}</p>
        {!state.models.length && <p className="notice-banner">{t('noModels')}</p>}
        <label>{t('model')}
          <select aria-label={t('model')} value={preferences.modelId ?? ''} onChange={event => update({ modelId: event.target.value || null })}>
            <option value="">{t('choose')}</option>
            {state.models.map(model => <option key={model.id} value={model.id}>{model.displayName} · {model.providerName}</option>)}
          </select>
        </label>
        <label>{t('script')}
          <textarea rows={5} maxLength={SPEECH_MAX_INPUT} value={preferences.input} placeholder={t('placeholder')} onChange={event => update({ input: event.target.value })} />
        </label>
        <div className="narration-audio-settings">
          <label>{t('mode')}
            <select aria-label={t('mode')} value={preferences.mode} onChange={event => update({ mode: event.target.value as 'replace' | 'mix' })}>
              <option value="replace">{t('replace')}</option>
              <option value="mix">{t('mix')}</option>
            </select>
          </label>
          {preferences.mode === 'mix' && <label>{t('volume')} · {Math.round(preferences.originalVolume * 100)}%
            <input aria-label={t('volume')} type="range" min={0} max={100} step={1} value={Math.round(preferences.originalVolume * 100)} onChange={event => update({ originalVolume: Number(event.target.value) / 100 })} />
          </label>}
        </div>
        {preferences.mode === 'mix' && <p className="narration-hint">{t('mixHint')}</p>}
        <div className="narration-actions">
          <button type="button" className="secondary-button" disabled={!state.valid || state.busy || state.matching?.status === 'queued' || state.matching?.status === 'running'} onClick={() => void state.generate()}>
            {state.busy || state.matching?.status === 'queued' || state.matching?.status === 'running' ? <LoaderCircle size={15} /> : <Mic size={15} />}
            {state.busy || state.matching?.status === 'queued' || state.matching?.status === 'running' ? t('generating') : t('preview')}
          </button>
          {playing?.downloadUrl && <a className="secondary-button" href={playing.downloadUrl} download><Download size={14} /> {t('download')}</a>}
        </div>
        {playing?.url && <div className="narration-player">
          <audio key={playing.id} controls preload="metadata" src={playing.url} aria-label={t('title')} />
          <small>{t('duration', { seconds: (playing.durationSeconds ?? 0).toFixed(2) })}</small>
        </div>}
        {!state.matching && state.jobs.some(job => job.status === 'succeeded') && <p className="narration-hint">{t('changed')}</p>}
        <details className="narration-history">
          <summary>{t('history')} ({state.jobs.length})</summary>
          {!state.jobs.length && <p>{t('empty')}</p>}
          {state.jobs.map(job => <article key={job.id} className="narration-history-item">
            <div><strong>{job.model}</strong><span className={`speech-status is-${job.status}`}>{t(job.status)}</span></div>
            <p>{job.input}</p>
            {job.durationSeconds != null && <small>{t('duration', { seconds: job.durationSeconds.toFixed(2) })}</small>}
            {(job.status === 'failed' || job.status === 'unknown') && <p className="form-error">{storedErrorMessage(job)}</p>}
            <div className="narration-actions">
              {job.status === 'succeeded' && job.modelId && state.models.some(model => model.id === job.modelId) && <button type="button" className="secondary-button" onClick={() => update({ modelId: job.modelId, input: job.input })}>{t('use')}</button>}
              {job.downloadUrl && <a href={job.downloadUrl} download>{t('download')}</a>}
              {job.status !== 'running' && <button type="button" className="row-action" aria-label={t('remove')} onClick={() => void state.remove(job.id)}><Trash2 size={14} /></button>}
            </div>
          </article>)}
        </details>
      </fieldset>}
    </>}
    {state.error != null && <div className="form-error" role="alert">{errorMessage(state.error)}
      <button type="button" className="row-action" onClick={state.reload}><RefreshCw size={14} /> {t('retry')}</button>
    </div>}
  </section>
}

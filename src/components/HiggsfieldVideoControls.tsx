import { useRef, useState } from 'react'
import type { GenerationParamsInput, ModelInfo } from '../api/types'
import { uploadApi } from '../api/endpoints'
import { errorMessage } from '../api/client'
import { inferVideoApiStyle } from '../../shared/videoApi'
import { HIGGSFIELD_RATIOS, normalizeHiggsfieldParams, type HiggsfieldParams } from '../../shared/higgsfield'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'

export const usesHiggsfield = (model?: ModelInfo) => Boolean(model && (model.videoApiStyle ?? inferVideoApiStyle(model.modelId)) === 'higgsfield')
export function higgsfieldInput(value: GenerationParamsInput, prompt: string): GenerationParamsInput {
  return normalizeHiggsfieldParams(value as HiggsfieldParams, prompt) as GenerationParamsInput
}
export function HiggsfieldVideoControls({ value, onChange }: { value: GenerationParamsInput; onChange: (p: GenerationParamsInput) => void }) {
  const { t } = useTranslation(studioCatalog)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState('')
  const latest = useRef(value); latest.current = value
  const revision = useRef(0)
  const mode = value.mode === 'image' ? 'image' : 'text'
  const change = (key: keyof GenerationParamsInput, next: unknown) => onChange({ ...value, [key]: next })
  const upload = async (prefix: 'image' | 'endImage', file?: File) => {
    if (!file) return
    const rev = revision.current
    setUploading(prefix); setError('')
    try {
      const uploaded = await uploadApi.upload(file)
      if (revision.current !== rev) return
      const next = { ...latest.current }
      delete next[`${prefix}Url`]; delete next[`${prefix}AssetId`]
      next[`${prefix}UploadId`] = uploaded.id; onChange(next)
    } catch (e) { setError(errorMessage(e)) }
    finally { setUploading(null) }
  }
  return <div className="agnes-controls">
    <div className="creation-actions">
      {(['text','image'] as const).map(m => <button type="button" className="creation-action" key={m} aria-pressed={mode === m} disabled={Boolean(uploading)} onClick={() => {
        revision.current++; onChange({ mode: m, duration: value.duration ?? 5, resolution: value.resolution ?? '720p', bitrateMode: value.bitrateMode ?? 'high', generateAudio: value.generateAudio ?? true, useCharacterReference: false,
          ...(m === 'text' ? { aspectRatio: '16:9', outputFormat: 'mp4' as const } : {}) })
      }}>{t(m === 'text' ? 'hfText' : 'hfImage')}</button>)}
    </div>
    <div className="controls-grid">
      <label className="select-control"><span>{t('durationLabel')}</span><input type="number" min={4} max={30} step={1} value={value.duration ?? 5} onChange={e => change('duration', Number(e.target.value))} /></label>
      <label className="select-control"><span>{t('hfResolution')}</span><select value={value.resolution ?? '720p'} onChange={e => change('resolution', e.target.value)}>{['480p','720p','1080p'].map(v => <option key={v}>{v}</option>)}</select></label>
      <label className="select-control"><span>{t('hfBitrate')}</span><select value={value.bitrateMode ?? 'high'} onChange={e => change('bitrateMode', e.target.value)}><option value="standard">{t('hfStandard')}</option><option value="high">{t('hfHigh')}</option></select></label>
      <label className="select-control"><span>{t('hfAudio')}</span><input type="checkbox" checked={value.generateAudio ?? true} onChange={e => change('generateAudio', e.target.checked)} /></label>
      {mode === 'text' && <>
        <label className="select-control"><span>{t('agnesRatio')}</span><select value={value.aspectRatio ?? '16:9'} onChange={e => change('aspectRatio', e.target.value)}>{HIGGSFIELD_RATIOS.map(v => <option key={v}>{v}</option>)}</select></label>
        <label className="select-control"><span>{t('hfFormat')}</span><select value={value.outputFormat ?? 'mp4'} onChange={e => change('outputFormat', e.target.value)}><option value="mp4">{t('hfFormatMp4')}</option><option value="mov">{t('hfFormatMov')}</option></select></label>
      </>}
    </div>
    {mode === 'image' && <>
      <p className="project-hint">{t('hfUploadHint')}</p>
      <div className="controls-grid">{(['image','endImage'] as const).map(prefix => {
        const uploadId = value[`${prefix}UploadId`], assetId = value[`${prefix}AssetId`], url = value[`${prefix}Url`]
        const preview = uploadId ? `/api/uploads/${encodeURIComponent(uploadId)}` : assetId ? `/api/assets/${encodeURIComponent(assetId)}` : url
        return <div key={prefix}>
          <label className="select-control"><span>{t(prefix === 'image' ? 'hfStartFrame' : 'hfEndFrame')}</span><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={Boolean(uploading)} onChange={e => { void upload(prefix, e.target.files?.[0]); e.target.value = '' }} /></label>
          {preview && <><img src={preview} alt={t(prefix === 'image' ? 'hfStartFrame' : 'hfEndFrame')} style={{ maxWidth: '100%', maxHeight: 160 }} /><button type="button" className="creation-action" disabled={Boolean(uploading)} onClick={() => {
            revision.current++; const next = { ...value }; delete next[`${prefix}Url`]; delete next[`${prefix}UploadId`]; delete next[`${prefix}AssetId`]; onChange(next)
          }}>{t('hfRemoveFrame')}</button></>}
          {!uploadId && !assetId && <input type="url" placeholder={t('hfFrameUrlPlaceholder')} value={url ?? ''} disabled={Boolean(uploading)} onChange={e => {
            const next = { ...value }; if (e.target.value) next[`${prefix}Url`] = e.target.value; else delete next[`${prefix}Url`]; onChange(next)
          }} />}
        </div>
      })}</div>
    </>}
    {uploading && <p role="status">{t('hfUploading')}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="project-hint">{t(mode === 'image' ? 'hfOptionalPrompt' : 'hfRequiredPrompt')}</p>
  </div>
}

import { ChevronDown } from 'lucide-react'
import type { ImageApiStyle, VideoReferenceStyle } from '../../api/types'

export type ProviderConnectionDraft = {
  name: string
  baseUrl: string
  imageApiStyle: ImageApiStyle
  videoReferenceStyle: VideoReferenceStyle
}

/** Callers own wording: create and edit intentionally use different catalogs. */
type ProviderConnectionLabels = {
  name: string
  namePlaceholder: string
  baseUrl: string
  imageApiStyle: string
  imageDefault: string
  imageOpenai: string
  imageExtraBody: string
  videoReferenceStyle: string
  videoObject: string
  videoString: string
  videoHint: string
}

/** Controlled connection fields only; callers retain validation, secrets and payloads. */
export function ProviderConnectionFields({ value, onChange, labels }: {
  value: ProviderConnectionDraft
  onChange: (value: ProviderConnectionDraft) => void
  labels: ProviderConnectionLabels
}) {
  return <>
    <label>
      {labels.name}
      <input placeholder={labels.namePlaceholder} value={value.name} onChange={event => onChange({ ...value, name: event.target.value })} />
    </label>
    <label>
      {labels.baseUrl}
      <input placeholder="https://api.example.com/v1" value={value.baseUrl} onChange={event => onChange({ ...value, baseUrl: event.target.value })} />
    </label>
    <label>
      {labels.imageApiStyle}
      <div className="select-wrap">
        <select value={value.imageApiStyle} onChange={event => onChange({ ...value, imageApiStyle: event.target.value as ImageApiStyle })}>
          <option value="default">{labels.imageDefault}</option>
          <option value="openai">{labels.imageOpenai}</option>
          <option value="extra_body">{labels.imageExtraBody}</option>
        </select>
        <ChevronDown size={14} />
      </div>
    </label>
    <label>
      {labels.videoReferenceStyle}
      <div className="select-wrap">
        <select value={value.videoReferenceStyle} onChange={event => onChange({ ...value, videoReferenceStyle: event.target.value as VideoReferenceStyle })}>
          <option value="image_url_object">{labels.videoObject}</option>
          <option value="image_url_string">{labels.videoString}</option>
        </select>
        <ChevronDown size={14} />
      </div>
      <p>{labels.videoHint}</p>
    </label>
  </>
}

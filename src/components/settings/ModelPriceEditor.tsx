import { Save } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { shellCatalog } from '../../i18n/catalogs/shell'

/** String drafts allow free editing; parsing and mutation remain in SettingsPage. */
export type PriceDraft = {
  priceUnit: string
  priceInput1k: string
  priceOutput1k: string
  currency: string
}

export function ModelPriceEditor({ name, tokenPricing, draft, saving, status, onChange, onSave, onClose }: {
  name: string
  tokenPricing: boolean
  draft: PriceDraft
  saving: boolean
  status?: { state: 'saving' | 'saved' | 'error'; text: string }
  onChange: (field: keyof PriceDraft, value: string) => void
  onSave: () => void
  onClose: () => void
}) {
  const { t } = useTranslation(shellCatalog)
  const priceField = (field: 'priceInput1k' | 'priceOutput1k' | 'priceUnit', label: string) => <label className="model-price-field">
    <span>{label}</span>
    <input type="number" min="0" inputMode="decimal" value={draft[field]} onChange={event => onChange(field, event.target.value)} aria-label={`${label} ${name}`} />
  </label>

  return <div className="model-price-editor" role="group" aria-label={t('modelPriceTitle', { name })}>
    {tokenPricing ? <>
      {priceField('priceInput1k', t('modelPriceInput'))}
      {priceField('priceOutput1k', t('modelPriceOutput'))}
    </> : priceField('priceUnit', t('modelPriceUnit'))}
    <label className="model-price-field is-currency">
      <span>{t('modelPriceCurrency')}</span>
      <input type="text" maxLength={10} value={draft.currency} onChange={event => onChange('currency', event.target.value)} aria-label={`${t('modelPriceCurrency')} ${name}`} />
    </label>
    <div className="model-price-actions">
      <button type="button" className="primary-small-button" disabled={saving} onClick={onSave}>
        <Save size={13} /> {t('modelPriceSave')}
      </button>
      <button type="button" className="model-price-close" onClick={onClose}>{t('modelPriceClose')}</button>
    </div>
    <p className="model-price-hint">{t('modelPriceClearHint')}</p>
    {status && <small className={`model-price-status ${status.state === 'error' ? 'is-error' : status.state === 'saved' ? 'is-ok' : ''}`} role="status">{status.text}</small>}
  </div>
}

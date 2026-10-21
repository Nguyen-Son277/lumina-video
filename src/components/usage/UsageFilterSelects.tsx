import { USAGE_KINDS, USAGE_OUTCOMES, type UsageKind, type UsageOutcome } from '../../api/usage'
import { useTranslation } from '../../i18n'
import { usageCatalog, type UsageCatalogKey } from '../../i18n/catalogs/usage'

export type UsageKindFilter = 'all' | UsageKind
export type UsageOutcomeFilter = 'all' | UsageOutcome

export const USAGE_KIND_KEYS: Record<UsageKind, UsageCatalogKey> = {
  image: 'kindImage',
  video: 'kindVideo',
  llm: 'kindLlm',
}

export const USAGE_OUTCOME_KEYS: Record<UsageOutcome, UsageCatalogKey> = {
  ok: 'outcomeOk',
  failed: 'outcomeFailed',
  unknown: 'outcomeUnknown',
  pending: 'outcomePending',
}

export function UsageKindSelect({ value, onChange }: {
  value: UsageKindFilter
  onChange: (value: UsageKindFilter) => void
}) {
  const { t } = useTranslation(usageCatalog)
  return <label className="usage-field">
    <span>{t('filterKind')}</span>
    <select value={value} onChange={event => onChange(event.target.value as UsageKindFilter)} aria-label={t('filterKind')}>
      <option value="all">{t('kindAll')}</option>
      {USAGE_KINDS.map(kind => <option key={kind} value={kind}>{t(USAGE_KIND_KEYS[kind])}</option>)}
    </select>
  </label>
}

export function OutcomeSelect({ value, onChange }: {
  value: UsageOutcomeFilter
  onChange: (value: UsageOutcomeFilter) => void
}) {
  const { t } = useTranslation(usageCatalog)
  return <label className="usage-field">
    <span>{t('filterOutcome')}</span>
    <select value={value} onChange={event => onChange(event.target.value as UsageOutcomeFilter)} aria-label={t('filterOutcome')}>
      <option value="all">{t('outcomeAll')}</option>
      {USAGE_OUTCOMES.map(outcome => <option key={outcome} value={outcome}>{t(USAGE_OUTCOME_KEYS[outcome])}</option>)}
    </select>
  </label>
}

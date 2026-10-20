import { usageCatalog, type UsageCatalogKey } from '../i18n/catalogs/usage'
import { useTranslation } from '../i18n'
import type { UsageRange } from '../../shared/usageRanges'

export type UsageRangeControlsProps = {
  range: UsageRange
  from: string
  to: string
  onRangeChange: (value: UsageRange) => void
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
}

const RANGES: Array<[UsageRange, UsageCatalogKey]> = [
  ['today', 'rangeToday'], ['yesterday', 'rangeYesterday'], ['previousWeek', 'rangePreviousWeek'],
  ['previousMonth', 'rangePreviousMonth'], ['thisMonth', 'rangeThisMonth'], ['7d', 'range7d'],
  ['30d', 'range30d'], ['all', 'rangeAll'], ['custom', 'rangeCustom'],
]

export function UsageRangeControls({ range, from, to, onRangeChange, onFromChange, onToChange }: UsageRangeControlsProps) {
  const { t } = useTranslation(usageCatalog)
  return <div className="usage-range-controls">
    <label className="usage-field usage-range-field">
      <span>{t('filterRange')}</span>
      <select aria-label={t('filterRange')} value={range} onChange={event => onRangeChange(event.target.value as UsageRange)}>
        {RANGES.map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}
      </select>
    </label>
    {range === 'custom' && <div className="usage-field-row usage-range-dates">
      <label className="usage-field"><span>{t('filterFrom')}</span><input type="date" value={from} onChange={event => onFromChange(event.target.value)} /></label>
      <label className="usage-field"><span>{t('filterTo')}</span><input type="date" value={to} onChange={event => onToChange(event.target.value)} /></label>
    </div>}
    <p className="usage-range-timezone">{t('rangeTimezoneNote')}</p>
  </div>
}

export default UsageRangeControls

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
    <div className="usage-range-row">
      <span className="usage-label">{t('filterRange')}</span>
      <div className="usage-range-buttons" role="group" aria-label={t('filterRange')}>
        {RANGES.map(([value, key]) => <button type="button" key={value} className={range === value ? 'active' : ''}
          aria-pressed={range === value} onClick={() => onRangeChange(value)}>{t(key)}</button>)}
      </div>
    </div>
    {range === 'custom' && <div className="usage-field-row usage-range-dates">
      <label className="usage-field"><span>{t('filterFrom')}</span><input type="date" value={from} onChange={event => onFromChange(event.target.value)} /></label>
      <label className="usage-field"><span>{t('filterTo')}</span><input type="date" value={to} onChange={event => onToChange(event.target.value)} /></label>
    </div>}
    <p className="usage-range-timezone">{t('rangeTimezoneNote')}</p>
  </div>
}

export default UsageRangeControls

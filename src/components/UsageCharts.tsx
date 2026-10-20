import { useId, useMemo, useState } from 'react'
import type { UsageSummary } from '../api/usage'
import { useTranslation } from '../i18n/useTranslation'
import { usageChartsCatalog } from '../i18n/catalogs/usageCharts'
import { buildUsageBreakdown, buildUsageTimeline, USAGE_CHART_KINDS, type UsageChartBucket, type UsageChartKind } from '../../shared/usageCharts'

export type UsageChartsProps = { summary: UsageSummary; from?: number; to?: number; loading?: boolean }
const COLORS: Record<UsageChartKind, string> = {
  image: 'var(--usage-chart-image, #818cf8)',
  video: 'var(--usage-chart-video, #22c55e)',
  llm: 'var(--usage-chart-llm, #f59e0b)',
}

/** Count-only visualizations shared by personal and administrator usage reports. */
export function UsageCharts({ summary, from, to, loading = false }: UsageChartsProps) {
  const { t, locale } = useTranslation(usageChartsCatalog)
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const timeline = useMemo(() => buildUsageTimeline(summary.daily, { from, to }), [summary.daily, from, to])
  const breakdown = useMemo(() => buildUsageBreakdown(summary.totals), [summary.totals])
  const number = new Intl.NumberFormat(locale)
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  const date = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  const shortDate = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', timeZone: 'UTC' })
  const period = (bucket: UsageChartBucket) => bucket.start === bucket.end
    ? date.format(bucket.start) : `${date.format(bucket.start)} – ${date.format(bucket.end)}`
  const label = (bucket: UsageChartBucket) => `${period(bucket)} · ${USAGE_CHART_KINDS.map(kind => `${t(kind)}: ${number.format(bucket.counts[kind])}`).join(' · ')} · ${t('total')}: ${number.format(bucket.total)}`
  const total = breakdown.reduce((sum, row) => sum + row.count, 0)
  const hasTimeline = timeline.buckets.some(bucket => bucket.total > 0)
  const max = Math.max(1, ...timeline.buckets.map(bucket => bucket.total))
  const width = 760, height = 260, left = 58, right = 16, top = 16, bottom = 42
  const plotWidth = width - left - right, plotHeight = height - top - bottom
  const slot = plotWidth / Math.max(1, timeline.buckets.length)
  const barWidth = Math.min(36, slot * 0.76)
  const caption = timeline.granularity === 'month' && timeline.step > 1
    ? t('groupedMonths', { step: timeline.step }) : t(timeline.granularity)
  const activeBucket = active === null ? undefined : timeline.buckets[active]

  return <section className="usage-charts" aria-label={t('title')} aria-busy={loading}>
    {loading ? <p className="usage-chart-empty" role="status">{t('loading')}</p> : <>
      <section className="usage-chart-panel" aria-labelledby={`${id}-timeline-heading`}>
        <h3 id={`${id}-timeline-heading`}>{t('timeline')}</h3>
        <p className="usage-chart-subtitle">{caption}</p>
        <ul className="usage-chart-legend" aria-label={t('legend')}>
          {USAGE_CHART_KINDS.map(kind => <li key={kind}><span className={`usage-chart-swatch usage-chart-swatch--${kind}`} style={{ background: COLORS[kind] }} aria-hidden="true" />{t(kind)}</li>)}
        </ul>
        {!hasTimeline ? <p className="usage-chart-empty">{t('empty')}</p> : <>
          <svg className="usage-chart-bars" width="100%" viewBox={`0 0 ${width} ${height}`} role="group" aria-labelledby={`${id}-svg-title ${id}-svg-desc`}>
            <title id={`${id}-svg-title`}>{t('timeline')}</title>
            <desc id={`${id}-svg-desc`}>{t('description')}</desc>
            {[0, 0.5, 1].map(fraction => {
              const y = top + plotHeight * (1 - fraction)
              return <g key={fraction} className="usage-chart-axis" aria-hidden="true">
                <line className="usage-chart-grid" x1={left} x2={width - right} y1={y} y2={y} stroke="currentColor" opacity="0.15" />
                <text x={left - 8} y={y + 4} textAnchor="end" fill="currentColor" fontSize="11">{number.format(Math.round(max * fraction))}</text>
              </g>
            })}
            {timeline.buckets.map((bucket, index) => {
              const x = left + slot * index + (slot - barWidth) / 2
              let stack = 0
              const fullLabel = label(bucket)
              return <g key={bucket.start} tabIndex={0} role="img" aria-label={fullLabel}
                className="usage-chart-bucket" onFocus={() => setActive(index)} onBlur={() => setActive(null)}
                onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
                <title>{fullLabel}</title>
                <rect x={left + slot * index} y={top} width={slot} height={plotHeight} fill="transparent" />
                {USAGE_CHART_KINDS.map(kind => {
                  const h = bucket.counts[kind] / max * plotHeight
                  stack += h
                  return <rect key={kind} className={`usage-chart-bar usage-chart-bar--${kind}`} x={x} y={top + plotHeight - stack} width={barWidth} height={h} fill={COLORS[kind]} />
                })}
                {(index === 0 || index === timeline.buckets.length - 1 || index % Math.ceil(timeline.buckets.length / 6) === 0) && <text className="usage-chart-label" x={x + barWidth / 2} y={height - 15} textAnchor="middle" fill="currentColor" fontSize="11" aria-hidden="true">{shortDate.format(bucket.start)}</text>}
              </g>
            })}
          </svg>
          <p className="usage-chart-tooltip" role="status" aria-live="polite">{activeBucket ? label(activeBucket) : t('description')}</p>
        </>}
      </section>
      <section className="usage-chart-panel" aria-labelledby={`${id}-breakdown-heading`}>
        <h3 id={`${id}-breakdown-heading`}>{t('breakdown')}</h3>
        {total === 0 ? <p className="usage-chart-empty">{t('empty')}</p> : <ul className="usage-chart-breakdown">
          {breakdown.map(row => <li key={row.kind} className="usage-chart-breakdown-row">
            <div className="usage-chart-breakdown-label"><span>{t(row.kind)}</span><span>{number.format(row.count)} · {percent.format(row.percent / 100)}</span></div>
            <div className="usage-chart-breakdown-track" aria-hidden="true"><div className={`usage-chart-breakdown-fill usage-chart-bar--${row.kind}`} style={{ width: `${row.percent}%`, background: COLORS[row.kind], height: '100%' }} /></div>
          </li>)}
        </ul>}
      </section>
      <details className="usage-chart-details">
        <summary>{t('details')}</summary>
        <div className="usage-chart-table-wrap">
          <table className="usage-chart-table">
            <caption>{t('timeline')} · {caption}</caption>
            <thead><tr><th scope="col">{t('period')}</th>{USAGE_CHART_KINDS.map(kind => <th scope="col" key={kind}>{t(kind)}</th>)}<th scope="col">{t('total')}</th></tr></thead>
            <tbody>{timeline.buckets.map(bucket => <tr key={bucket.start}><th scope="row">{period(bucket)}</th>{USAGE_CHART_KINDS.map(kind => <td key={kind}>{number.format(bucket.counts[kind])}</td>)}<td>{number.format(bucket.total)}</td></tr>)}</tbody>
          </table>
          <table className="usage-chart-table"><caption>{t('breakdown')}</caption><thead><tr><th scope="col">{t('type')}</th><th scope="col">{t('count')}</th><th scope="col">{t('percent')}</th></tr></thead><tbody>{breakdown.map(row => <tr key={row.kind}><th scope="row">{t(row.kind)}</th><td>{number.format(row.count)}</td><td>{percent.format(row.percent / 100)}</td></tr>)}</tbody></table>
        </div>
      </details>
    </>}
  </section>
}

export default UsageCharts

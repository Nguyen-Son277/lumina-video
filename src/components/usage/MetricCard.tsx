import type { ReactNode } from 'react'

/** Keeps an article as the direct grid child in both personal and admin usage. */
export function MetricCard({ label, value, detail, labelClassName = 'usage-card-label' }: {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  labelClassName?: string
}) {
  return <article className="usage-card">
    <span className={labelClassName || undefined}>{label}</span>
    <strong>{value}</strong>
    {detail != null && <small>{detail}</small>}
  </article>
}

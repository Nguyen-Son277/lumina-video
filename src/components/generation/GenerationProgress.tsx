import type { Generation } from '../../api/types'
import { useTranslation } from '../../i18n'
import { shellCatalog } from '../../i18n/catalogs/shell'
import { statusLabel } from './status'

/** Never fabricate a percentage while the provider has not reported progress. */
export function GenerationProgress({ generation }: { generation: Generation }) {
  const { t } = useTranslation(shellCatalog)
  const progress = typeof generation.progress === 'number' && Number.isFinite(generation.progress)
    && generation.progress > 0 && generation.status === 'running'
    ? Math.min(100, generation.progress) : undefined
  return <div className="generation-progress">
    <div className="generation-progress-label"><span>{statusLabel(generation.status)}</span>{progress !== undefined && <strong>{progress}%</strong>}</div>
    <div className={`card-progress ${progress === undefined ? 'is-indeterminate' : ''}`} role="progressbar" aria-label={t('generationProgressAria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-valuetext={statusLabel(generation.status)}>
      <span style={progress !== undefined ? { width: `${progress}%` } : undefined} />
    </div>
  </div>
}

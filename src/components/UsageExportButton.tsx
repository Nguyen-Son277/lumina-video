import { useRef, useState } from 'react'
import { Download } from 'lucide-react'
import { adminUsageApi, usageApi, type UsageFilters } from '../api/usage'
import { errorMessage } from '../api/client'
import { useTranslation } from '../i18n'
import { usageCatalog } from '../i18n/catalogs/usage'

export type UsageExportButtonProps = {
  filters: UsageFilters & { userId?: string }
  admin?: boolean
  disabled?: boolean
  /** Optionally recompute time-sensitive filters (such as rolling ranges) at click time. */
  getFilters?: () => UsageFilters & { userId?: string }
}

export function UsageExportButton({ filters, admin = false, disabled = false, getFilters }: UsageExportButtonProps) {
  const { t } = useTranslation(usageCatalog)
  const busy = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const exportCsv = async () => {
    if (busy.current || disabled) return
    busy.current = true
    setError('')
    setLoading(true)
    try {
      const result = admin
        ? await adminUsageApi.exportCsv(getFilters?.() ?? filters)
        : await usageApi.exportCsv(getFilters?.() ?? filters)
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      try { anchor.click() } finally {
        anchor.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 0)
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.name !== 'ApiError' ? t('exportError') : errorMessage(cause))
    } finally {
      busy.current = false
      setLoading(false)
    }
  }

  return <div className="usage-export">
    <button type="button" className="usage-inline-button usage-export-button" onClick={exportCsv} disabled={disabled || loading} aria-busy={loading}>
      <Download size={16} aria-hidden="true" /> {loading ? t('exporting') : t('exportCsv')}
    </button>
    <details className="usage-export-help">
      <summary>{t('exportHelp')}</summary>
      <p className="usage-export-hint">{t('exportHint')}</p>
    </details>
    {error && <p className="usage-export-error" role="alert">{error}</p>}
  </div>
}

export default UsageExportButton

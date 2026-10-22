import { useState, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { DialogFrame } from './ui'
import { useTranslation } from '../i18n'
import { studioCatalog } from '../i18n/catalogs/studio'
import { shellCatalog } from '../i18n/catalogs/shell'

/** Keep the full controls shared with the legacy session form, but outside the dock. */
export function QuickOptionsPanel({ compact, count, preview, children }: { compact: boolean; count: number; preview?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation(studioCatalog)
  const { t: shellT } = useTranslation(shellCatalog)
  if (!compact) return children
  return <>
    <div className="quick-home-tools">
      <button type="button" className="secondary-button quick-home-options-trigger" onClick={() => setOpen(true)}>
        <Plus size={16} /> {t('quickAttachments')}{count > 0 ? ` · ${count}` : ''}
      </button>
      {preview}
    </div>
    {open && <DialogFrame portal className="modal-card quick-options-modal" aria-label={t('quickAdvanced')} onClose={() => setOpen(false)}>
      <header className="modal-header"><h2>{t('quickAdvanced')}</h2><button type="button" className="close-button" aria-label={shellT('close')} onClick={() => setOpen(false)}><X size={20} /></button></header>
      <div className="studio-page">{children}</div>
    </DialogFrame>}
  </>
}

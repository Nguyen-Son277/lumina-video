import { useRef, useState } from 'react'
import { LoaderCircle, Mic } from 'lucide-react'
import { speechApi } from '../../api/speech'
import { errorMessage } from '../../api/client'
import { useTranslation } from '../../i18n'
import { speechCatalog } from '../../i18n/catalogs/speech'
import '../../styles/speech.css'

export function SpeechModelSync({ providerId, onChanged }: { providerId: string; onChanged?: () => void }) {
  const { t } = useTranslation(speechCatalog)
  const [catalog, setCatalog] = useState<'models' | 'edge-tts'>('edge-tts')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null)
  const guard = useRef(false)
  async function sync() {
    if (guard.current) return
    guard.current = true
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      setResult(await speechApi.syncModels(providerId, catalog))
      onChanged?.()
    } catch (cause) {
      setError(cause)
    } finally {
      setBusy(false)
      guard.current = false
    }
  }
  return <div className="speech-sync-panel">
    <div className="speech-sync-controls">
      <label>{t('source')}<select value={catalog} disabled={busy} onChange={event => setCatalog(event.target.value as 'models' | 'edge-tts')}>
        <option value="edge-tts">{t('edgeSource')}</option>
        <option value="models">{t('modelsSource')}</option>
      </select></label>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => void sync()}>
        {busy ? <LoaderCircle size={15} /> : <Mic size={15} />} {t('sync')}
      </button>
    </div>
    {result && <p role="status">{t('syncResult', result)}</p>}
    {error != null && <p className="form-error" role="alert">{errorMessage(error)}</p>}
    <p>{t('syncHint')}</p>
  </div>
}

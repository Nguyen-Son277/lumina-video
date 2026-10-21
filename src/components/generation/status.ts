import type { Generation, GenerationStatus } from '../../api/types'
import { getLocale, translate, type Locale } from '../../i18n'
import { shellCatalog, type ShellCatalogKey } from '../../i18n/catalogs/shell'

/** Catalog keys keep labels reactive to the selected language without changing payload enums. */
const STATUS_KEYS: Record<GenerationStatus, ShellCatalogKey> = {
  queued: 'statusQueued',
  running: 'statusRunning',
  downloading: 'statusDownloading',
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  unknown: 'statusUnknown',
}

/** The optional locale preserves the original Common API. */
export function statusLabel(status: GenerationStatus, locale: Locale = getLocale()): string {
  return translate(shellCatalog, STATUS_KEYS[status], undefined, locale)
}

export function isGenerationActive(generation: Generation): boolean {
  return ['queued', 'running', 'downloading'].includes(generation.status)
}

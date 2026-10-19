import type { Request, Response } from 'express'
import type { Database } from '../db/index'
import type { UsageEvent, UsageFilters } from './service'
import { iterateUsageExportEvents } from './service'

type ExportEvent = Pick<UsageEvent,
  | 'kind' | 'source' | 'outcome' | 'status' | 'createdAt'
  | 'userEmail' | 'modelName' | 'providerName' | 'projectName'
  | 'sceneTitle' | 'sessionTitle' | 'latencyMs'
  | 'cost' | 'costUnknown' | 'preview' | 'responsePreview'
> & { userName: string; priceCurrency: string | null }

const USER_COLUMNS = [
  'time_utc', 'name', 'kind', 'source', 'status', 'outcome', 'model_name',
  'provider_name', 'project_name', 'scene_name', 'session_name', 'latency_ms',
  'cost', 'price_currency', 'cost_unknown', 'preview', 'response_preview',
] as const
const ADMIN_COLUMNS = ['time_utc', 'name', 'user_email', ...USER_COLUMNS.slice(2)]

/** Escape CSV fields and protect textual values from spreadsheet formula execution. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  let text = String(value)
  if (typeof value === 'string' && /^[\s\u0000-\u001f\u007f\ufeff]*[=+\-@]/u.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export function usageExportHeader(withUserEmail: boolean): string {
  return (withUserEmail ? ADMIN_COLUMNS : USER_COLUMNS).join(',')
}

export function usageExportRow(event: ExportEvent, withUserEmail: boolean): string {
  const timestamp = Number.isFinite(event.createdAt) ? new Date(event.createdAt).toISOString() : ''
  const values: Array<string | number | boolean | null | undefined> = [
    timestamp, event.userName,
    ...(withUserEmail ? [event.userEmail ?? ''] : []),
    event.kind, event.source, event.status, event.outcome, event.modelName,
    event.providerName, event.projectName, event.sceneTitle, event.sessionTitle,
    event.latencyMs, event.cost, event.priceCurrency, event.costUnknown,
    event.preview, event.responsePreview,
  ]
  return values.map(csvCell).join(',')
}

function safeFilename(scope: 'user' | 'admin', now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace(/[^0-9TZ-]/g, '')
  return `usage-${scope}-${stamp}.csv`
}

/** Stream a bounded-by-filter export, respecting backpressure and client disconnects. */
export async function streamUsageExport(
  req: Request,
  res: Response,
  db: Database,
  filters: UsageFilters,
  withUserEmail: boolean,
): Promise<void> {
  const now = Date.now()
  const filename = safeFilename(withUserEmail ? 'admin' : 'user', now)
  res.status(200)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  let disconnected = false
  const onClose = () => { if (!res.writableEnded) disconnected = true }
  res.once('close', onClose)
  const write = async (chunk: string): Promise<boolean> => {
    if (disconnected || req.destroyed) return false
    if (res.write(chunk)) return true
    return await new Promise<boolean>((resolve) => {
      const onDrain = () => { cleanup(); resolve(!disconnected && !req.destroyed) }
      const onDisconnect = () => { cleanup(); resolve(false) }
      const cleanup = () => {
        res.off('drain', onDrain)
        res.off('close', onDisconnect)
      }
      res.once('drain', onDrain)
      res.once('close', onDisconnect)
    })
  }

  try {
    if (!(await write(`\ufeff${usageExportHeader(withUserEmail)}\r\n`))) return
    for (const event of iterateUsageExportEvents(db, filters)) {
      if (!(await write(`${usageExportRow(event, withUserEmail)}\r\n`))) return
    }
    if (!disconnected) res.end()
  } catch (error) {
    if (res.headersSent) res.destroy(error instanceof Error ? error : new Error(String(error)))
    else throw error
  } finally {
    res.off('close', onClose)
  }
}

export type { ExportEvent }
export { USER_COLUMNS, ADMIN_COLUMNS }

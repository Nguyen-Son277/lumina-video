/**
 * Logger tối giản có che thông tin nhạy cảm.
 * Không bao giờ ghi API key, Authorization header hay token phiên.
 */

const SECRET_PATTERNS: RegExp[] = [
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi,
  /(api[-_]?key["'\s:=]+)[^\s,;"']+/gi,
  /(sk-[A-Za-z0-9_-]{8,})/g,
  /(token["'\s:=]+)[^\s,;"']+/gi,
]

export function redact(value: unknown): string {
  let text = typeof value === 'string' ? value : safeStringify(value)
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (_match, prefix: string) => `${prefix ?? ''}[đã ẩn]`)
  }
  return text
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)) ?? ''
  } catch {
    return String(value)
  }
}

type Level = 'info' | 'warn' | 'error'

function write(level: Level, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString()
  const suffix = meta === undefined ? '' : ` ${redact(meta)}`
  const line = `[${timestamp}] ${level.toUpperCase()} ${message}${suffix}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
}

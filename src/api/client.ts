/**
 * Client gọi API backend.
 * Luôn gửi cookie phiên và giữ metadata để hiển thị lỗi theo ngôn ngữ giao diện.
 */

import { formatErrorMessage, isErrorMessageKey, resolveErrorMessageKey } from '../../shared/errorCatalog'
import { getLocale } from '../i18n/locale'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly messageKey?: string
  readonly messageParams?: Record<string, string | number>
  readonly details?: unknown

  constructor(status: number, code: string, message: string, metadata: {
    messageKey?: string
    messageParams?: Record<string, string | number>
    details?: unknown
  } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.messageKey = metadata.messageKey
    this.messageParams = metadata.messageParams
    this.details = metadata.details
  }
}

type ErrorPayload = { error?: {
  code?: string
  message?: string
  messageKey?: string
  messageParams?: Record<string, string | number>
  details?: unknown
} }

export async function assertResponseOk(response: Response): Promise<void> {
  if (response.ok) return
  const payload = await response.json().catch(() => null) as ErrorPayload | null
  const error = payload?.error
  throw new ApiError(response.status, error?.code ?? 'UNKNOWN', error?.message ?? `Request failed (${response.status})`, error)
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const error = (payload as ErrorPayload | null)?.error
    throw new ApiError(
      response.status,
      error?.code ?? 'UNKNOWN',
      error?.message ?? `Request failed (${response.status})`,
      error,
    )
  }

  return payload as T
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Chuyển lỗi bất kỳ thành thông báo hiển thị được cho người dùng. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = resolveErrorMessageKey(error.message, error.code, isErrorMessageKey(error.messageKey) ? error.messageKey : undefined)
    return formatErrorMessage(key, error.messageParams, getLocale())
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return getLocale() === 'vi' ? 'Yêu cầu đã bị hủy' : 'The request was cancelled'
    if (error instanceof TypeError) return getLocale() === 'vi' ? 'Không thể kết nối máy chủ. Vui lòng thử lại.' : 'Unable to connect to the server. Please try again.'
    const key = resolveErrorMessageKey(error.message, undefined)
    if (key !== 'errors.unknown') return formatErrorMessage(key, undefined, getLocale())
    return error.message
  }
  return formatErrorMessage('errors.unknown', undefined, getLocale())
}

/** Localized heading for persisted diagnostics; raw provider text is separate detail. */
export function storedErrorMessage(value: {
  errorCode?: string | null
  errorMessage?: string | null
  errorMessageKey?: string | null
  errorMessageParams?: Record<string, string | number> | null
}): string {
  if (!value.errorMessage && !value.errorMessageKey && !value.errorCode) return ''
  const key = resolveErrorMessageKey(value.errorMessage ?? '', value.errorCode,
    isErrorMessageKey(value.errorMessageKey) ? value.errorMessageKey : undefined)
  return formatErrorMessage(key, value.errorMessageParams ?? undefined, getLocale())
}

import { Agent, type Dispatcher } from 'undici'
import type { ResolvedAddress } from './urlGuard'
import { guardProviderUrl, joinUrl } from './urlGuard'
import { badRequest, providerError, uncertainOutcome } from '../lib/errors'

export type ProviderTarget = {
  baseUrl: string
  apiKey: string
  allowPrivate: boolean
}

export type ProviderResponse = {
  status: number
  ok: boolean
  headers: Headers
  json: () => Promise<unknown>
  text: () => Promise<string>
  body: ReadableStream<Uint8Array> | null
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Tạo dispatcher ghim địa chỉ IP đã kiểm tra. Nhờ vậy kết nối đi đúng tới
 * địa chỉ đã qua kiểm tra SSRF, không bị DNS rebinding đổi đích giữa chừng.
 */
function createPinnedDispatcher(addresses: ResolvedAddress[]): Dispatcher {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        // Node gọi lookup với (hostname, options, callback) hoặc (hostname, callback).
        const done = (typeof options === 'function' ? options : callback) as (
          error: NodeJS.ErrnoException | null,
          address: string | { address: string; family: number }[],
          family?: number,
        ) => void

        const wantsAll = typeof options === 'object' && options !== null && options.all === true

        const first = addresses[0]
        if (!first) {
          done(badRequest(`Không phân giải được "${hostname}"`), '', 0)
          return
        }

        if (wantsAll) {
          done(null, addresses.map((item) => ({ address: item.address, family: item.family })))
          return
        }

        done(null, first.address, first.family)
      },
    },
    headersTimeout: DEFAULT_TIMEOUT_MS,
    bodyTimeout: DEFAULT_TIMEOUT_MS,
  })
}

/**
 * Gọi một endpoint của provider.
 *
 * - Kiểm tra SSRF trước khi kết nối và ghim DNS.
 * - Không tự động theo redirect, tránh rò rỉ API key sang origin khác.
 * - Chỉ gửi API key khi tới đúng origin của provider.
 */
export async function callProvider(
  target: ProviderTarget,
  endpointPath: string,
  init: {
    method?: string
    body?: unknown
    /**
     * Gửi dạng multipart/form-data (dùng cho /images/edits).
     * Không đặt Content-Type để fetch tự thêm boundary.
     */
    formData?: FormData
    headers?: Record<string, string>
    timeoutMs?: number
    /** Đặt false khi tải media từ CDN khác origin để không gửi key. */
    sendApiKey?: boolean
  } = {},
): Promise<ProviderResponse> {
  const url = joinUrl(target.baseUrl, endpointPath)
  const guarded = await guardProviderUrl(url, { allowPrivate: target.allowPrivate })
  const dispatcher = createPinnedDispatcher(guarded.addresses)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers ?? {}),
  }

  const sendApiKey = init.sendApiKey !== false
  if (sendApiKey) {
    headers.Authorization = `Bearer ${target.apiKey}`
  }

  let body: string | FormData | undefined
  if (init.formData !== undefined) {
    body = init.formData
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const response = await fetch(guarded.url, {
      method: init.method ?? 'GET',
      headers,
      body,
      redirect: 'manual',
      signal: controller.signal,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher })

    if (response.status >= 300 && response.status < 400) {
      throw providerError(
        'Provider trả về chuyển hướng. Vì an toàn, ứng dụng không tự động gửi API key sang địa chỉ khác.',
        { status: response.status, location: response.headers.get('location') },
      )
    }

    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      json: () => response.json(),
      text: () => response.text(),
      body: response.body,
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Với request tạo nội dung, hết thời gian chờ nghĩa là provider CÓ THỂ
      // đã nhận và đang xử lý. Không được gửi lại để tránh tính phí hai lần.
      if (init.method === 'POST') {
        throw uncertainOutcome(
          'Provider không phản hồi kịp. Yêu cầu có thể đã được gửi và đang xử lý — hãy kiểm tra lại trước khi thử tạo mới.',
        )
      }
      throw providerError('Provider phản hồi quá lâu, yêu cầu đã bị hủy')
    }

    // Lỗi mạng sau khi đã gửi request tạo nội dung cũng là kết quả không xác định.
    if (init.method === 'POST' && error instanceof Error && isNetworkError(error)) {
      throw uncertainOutcome(
        'Mất kết nối tới provider sau khi gửi yêu cầu. Yêu cầu có thể đã được xử lý — hãy kiểm tra lại trước khi thử tạo mới.',
        { cause: error.message },
      )
    }

    throw error
  } finally {
    clearTimeout(timer)
    // Đóng kết nối đã ghim sau mỗi request.
    void dispatcher.close()
  }
}

/**
 * Lỗi mạng (không phải lỗi HTTP) xảy ra sau khi request đã được gửi đi.
 * Khi đó ta không biết provider đã xử lý hay chưa.
 */
function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true
  }
  return /socket|network|fetch failed|terminated|other side closed/i.test(error.message)
}

/**
 * Đọc thông báo lỗi từ provider một cách an toàn.
 * Cắt ngắn và không bao giờ trả về nguyên văn nếu quá dài.
 */
export async function readProviderError(response: ProviderResponse): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return `Provider trả về mã ${response.status}`

    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
      const message = parsed.error?.message ?? parsed.message
      if (typeof message === 'string' && message.trim()) return message.slice(0, 500)
    } catch {
      // Không phải JSON, dùng text thô.
    }
    return text.slice(0, 500)
  } catch {
    return `Provider trả về mã ${response.status}`
  }
}

export type RemoteModel = {
  id: string
  displayName: string
}

/**
 * Lấy danh sách model từ provider. Không tạo nội dung nên không phát sinh chi phí.
 *
 * @param mode 'mock' để dùng danh sách giả lập trong test, không gọi mạng.
 */
export async function listProviderModels(
  target: ProviderTarget,
  mode: 'live' | 'mock' = 'live',
): Promise<RemoteModel[]> {
  if (mode === 'mock') {
    const { mockModelList } = await import('../generations/adapters/mock')
    return mockModelList().data.map((item) => ({ id: item.id, displayName: item.name }))
  }

  const response = await callProvider(target, 'models', { timeoutMs: 20_000 })

  if (response.status === 404 || response.status === 405) {
    throw badRequest(
      'Provider này không hỗ trợ endpoint /models. Bạn vẫn có thể thêm model thủ công.',
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw badRequest('API key không hợp lệ hoặc không có quyền truy cập')
  }
  if (!response.ok) {
    throw providerError(`Không lấy được danh sách model: ${await readProviderError(response)}`)
  }

  const payload = (await response.json()) as { data?: unknown }
  if (!Array.isArray(payload.data)) {
    throw providerError('Provider trả về danh sách model không đúng định dạng mong đợi')
  }

  return payload.data
    .map((item) => {
      if (typeof item !== 'object' || item === null) return null
      const record = item as { id?: unknown; name?: unknown }
      if (typeof record.id !== 'string' || !record.id) return null
      return {
        id: record.id,
        displayName: typeof record.name === 'string' && record.name ? record.name : record.id,
      }
    })
    .filter((item): item is RemoteModel => item !== null)
}

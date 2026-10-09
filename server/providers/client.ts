import { Agent, type Dispatcher } from 'undici'
import type { ResolvedAddress } from './urlGuard'
import { guardProviderUrl, joinUrl } from './urlGuard'
import { badRequest, errorMeta, providerError, uncertainOutcome } from '../lib/errors'

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
          done(
            badRequest(`Không phân giải được "${hostname}"`, undefined, errorMeta('providers.dns_resolve_failed', { host: hostname })),
            '',
            0,
          )
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
      const location = response.headers.get('location')
      throw providerError(
        'Provider trả về chuyển hướng. Vì an toàn, ứng dụng không tự động gửi API key sang địa chỉ khác.',
        {
          status: response.status,
          location: location ? redactSecrets(location, [target.apiKey]) : null,
        },
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
 * Rửa sạch bí mật xuất hiện nguyên văn trong một chuỗi chẩn đoán.
 *
 * Provider đôi khi dội lại chính API key trong thông báo lỗi. Không bao giờ để
 * key thô lọt vào log, cột lỗi hay phản hồi HTTP. Chỉ thay thế chuỗi khớp CHÍNH
 * XÁC (không dùng regex) nên không làm hỏng văn bản khác.
 */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let result = text
  for (const secret of secrets) {
    // Bỏ qua bí mật rỗng/quá ngắn: thay thế chuỗi 1-3 ký tự sẽ phá nát thông báo.
    if (!secret || secret.length < 4) continue
    if (result.includes(secret)) result = result.split(secret).join('***')
  }
  return result
}

/**
 * Đọc số giây từ header `Retry-After` (dạng số giây hoặc HTTP-date).
 * Trả null khi thiếu hoặc không hợp lệ; tầng service sẽ tự kẹp về khoảng cho phép.
 */
export function parseRetryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get('retry-after')
  if (!raw) return null

  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds)

  const date = Date.parse(raw)
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000)
    return delta > 0 ? delta : 1
  }

  return null
}

/**
 * Đọc thông báo lỗi từ provider một cách an toàn.
 * Cắt ngắn và không bao giờ trả về nguyên văn nếu quá dài. Truyền `secrets` để
 * rửa sạch API key nếu provider dội lại chính key đó.
 */
export async function readProviderError(
  response: ProviderResponse,
  secrets: Array<string | null | undefined>,
): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return `Provider trả về mã ${response.status}`

    try {
      const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string }
      const message = parsed.error?.message ?? parsed.message
      if (typeof message === 'string' && message.trim()) {
        return redactSecrets(message.slice(0, 500), secrets)
      }
    } catch {
      // Không phải JSON, dùng text thô.
    }
    return redactSecrets(text.slice(0, 500), secrets)
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
    const detail = await readProviderError(response, [target.apiKey])
    throw providerError(
      `Không lấy được danh sách model: ${detail}`,
      undefined,
      errorMeta('providers.models_list_failed', { detail }),
    )
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

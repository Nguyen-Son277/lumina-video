/**
 * Lỗi có kiểu, ánh xạ thẳng sang HTTP status và mã lỗi cho client.
 * Thông báo tiếng Việt, không chứa thông tin nhạy cảm.
 *
 * Ngoài `code`/`message`/`details` cũ, mỗi lỗi do ứng dụng tạo ra còn mang
 * `messageKey` (khoá ngữ nghĩa) và `messageParams` để giao diện dịch sang ngôn
 * ngữ đang dùng. Xem `shared/errorCatalog.ts`.
 */
import {
  genericMessageKeyForCode,
  messageKeyForLegacyMessage,
  resolveErrorMessageKey,
  type ErrorMessageKey,
  type ErrorMessageParams,
} from '../../shared/errorCatalog'

export type { ErrorMessageKey, ErrorMessageParams }

/** Metadata ngữ nghĩa bổ sung cho một lỗi. */
export type ErrorMeta = {
  messageKey?: ErrorMessageKey
  messageParams?: ErrorMessageParams
}

/**
 * Tạo metadata ngữ nghĩa cho lỗi có thông báo động (nội suy). Dùng cho các
 * trường hợp không thể khớp mẫu tĩnh trong danh mục.
 */
export const errorMeta = (messageKey: ErrorMessageKey, messageParams?: ErrorMessageParams): ErrorMeta => ({
  messageKey,
  messageParams,
})

export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown
  /** Khoá ngữ nghĩa luôn có, kể cả khi chỉ suy ra từ `code`. */
  readonly messageKey: ErrorMessageKey
  readonly messageParams: ErrorMessageParams

  constructor(status: number, code: string, message: string, details?: unknown, meta?: ErrorMeta) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.messageKey = meta?.messageKey ?? resolveErrorMessageKey(message, code)
    this.messageParams = meta?.messageParams ?? {}
  }
}

export const badRequest = (message: string, details?: unknown, meta?: ErrorMeta) =>
  new AppError(400, 'BAD_REQUEST', message, details, meta)

export const unauthorized = (message = 'Bạn cần đăng nhập để tiếp tục', meta?: ErrorMeta) =>
  new AppError(401, 'UNAUTHORIZED', message, undefined, meta)

export const forbidden = (message = 'Bạn không có quyền thực hiện thao tác này', meta?: ErrorMeta) =>
  new AppError(403, 'FORBIDDEN', message, undefined, meta)

export const notFound = (message = 'Không tìm thấy dữ liệu', meta?: ErrorMeta) =>
  new AppError(404, 'NOT_FOUND', message, undefined, meta)

export const conflict = (message: string, meta?: ErrorMeta) => new AppError(409, 'CONFLICT', message, undefined, meta)

export const tooManyRequests = (message = 'Bạn thao tác quá nhanh, vui lòng thử lại sau', meta?: ErrorMeta) =>
  new AppError(429, 'RATE_LIMITED', message, undefined, meta)

export const providerIncompatible = (message: string, details?: unknown, meta?: ErrorMeta) =>
  new AppError(502, 'PROVIDER_INCOMPATIBLE', message, details, meta)

export const providerError = (message: string, details?: unknown, meta?: ErrorMeta) =>
  new AppError(502, 'PROVIDER_ERROR', message, details, meta)

/**
 * Kết quả không xác định: request tạo nội dung có thể đã tới provider
 * (timeout hoặc mất kết nối sau khi gửi) nhưng ta không biết chắc.
 * Không được tự động gửi lại vì có thể bị tính phí hai lần.
 */
export const uncertainOutcome = (message: string, details?: unknown, meta?: ErrorMeta) =>
  new AppError(504, 'OUTCOME_UNKNOWN', message, details, meta)

/** Kiểm tra một lỗi có phải kết quả không xác định hay không. */
export function isUncertain(error: unknown): boolean {
  return error instanceof AppError && error.code === 'OUTCOME_UNKNOWN'
}

export const insufficientStorage = (message: string, meta?: ErrorMeta) =>
  new AppError(413, 'STORAGE_LIMIT', message, undefined, meta)

/** Một issue tối thiểu của Zod đủ để dựng lỗi kiểm tra dữ liệu. */
export type ValidationIssue = {
  message?: string
  path?: ReadonlyArray<PropertyKey>
}

/**
 * Lỗi kiểm tra dữ liệu đầu vào (Zod). Giữ nguyên câu `message` cũ nhưng gắn
 * thêm khoá ngữ nghĩa: khớp mẫu tĩnh nếu có, nếu không dùng khoá chung kèm
 * `field` (đường dẫn) và `reason` (lý do thô).
 */
export function validationError(
  source: { issues?: ReadonlyArray<ValidationIssue> } | undefined,
  fallbackMessage = 'Dữ liệu không hợp lệ',
): AppError {
  const issue = source?.issues?.[0]
  const message = issue?.message ?? fallbackMessage
  const matched = messageKeyForLegacyMessage(message)
  const params: ErrorMessageParams = {}
  if (issue?.path && issue.path.length > 0) params.field = issue.path.map(String).join('.')
  if (!matched && issue?.message) params.reason = issue.message
  return new AppError(400, 'BAD_REQUEST', message, undefined, {
    messageKey: matched ?? 'validation.invalid_payload',
    messageParams: params,
  })
}

/**
 * Trích metadata ngữ nghĩa từ một lỗi bất kỳ để lưu lại (worker) hoặc trả về
 * client. Lỗi thô (không phải AppError) chỉ nhận khoá dự phòng chung.
 */
export function errorMetadataOf(error: unknown): { messageKey: ErrorMessageKey; messageParams: ErrorMessageParams } {
  if (error instanceof AppError) {
    return { messageKey: error.messageKey, messageParams: error.messageParams }
  }
  const message = error instanceof Error ? error.message : ''
  return {
    messageKey: message ? messageKeyForLegacyMessage(message) ?? genericMessageKeyForCode(undefined) : genericMessageKeyForCode(undefined),
    messageParams: {},
  }
}

/**
 * Lỗi có kiểu, ánh xạ thẳng sang HTTP status và mã lỗi cho client.
 * Thông báo tiếng Việt, không chứa thông tin nhạy cảm.
 */
export class AppError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details)

export const unauthorized = (message = 'Bạn cần đăng nhập để tiếp tục') =>
  new AppError(401, 'UNAUTHORIZED', message)

export const forbidden = (message = 'Bạn không có quyền thực hiện thao tác này') =>
  new AppError(403, 'FORBIDDEN', message)

export const notFound = (message = 'Không tìm thấy dữ liệu') =>
  new AppError(404, 'NOT_FOUND', message)

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message)

export const tooManyRequests = (message = 'Bạn thao tác quá nhanh, vui lòng thử lại sau') =>
  new AppError(429, 'RATE_LIMITED', message)

export const providerIncompatible = (message: string, details?: unknown) =>
  new AppError(502, 'PROVIDER_INCOMPATIBLE', message, details)

export const providerError = (message: string, details?: unknown) =>
  new AppError(502, 'PROVIDER_ERROR', message, details)

/**
 * Kết quả không xác định: request tạo nội dung có thể đã tới provider
 * (timeout hoặc mất kết nối sau khi gửi) nhưng ta không biết chắc.
 * Không được tự động gửi lại vì có thể bị tính phí hai lần.
 */
export const uncertainOutcome = (message: string, details?: unknown) =>
  new AppError(504, 'OUTCOME_UNKNOWN', message, details)

/** Kiểm tra một lỗi có phải kết quả không xác định hay không. */
export function isUncertain(error: unknown): boolean {
  return error instanceof AppError && error.code === 'OUTCOME_UNKNOWN'
}

export const insufficientStorage = (message: string) =>
  new AppError(413, 'STORAGE_LIMIT', message)

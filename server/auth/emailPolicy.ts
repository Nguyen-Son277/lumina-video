/**
 * Chính sách tên miền email được phép tạo tài khoản.
 *
 * Đây là lớp kiểm tra có thẩm quyền, chạy ở backend. Giao diện cũng kiểm tra
 * trước cho tiện, nhưng không bao giờ được tin kiểm tra phía client.
 */

/**
 * Chuẩn hóa danh sách tên miền từ biến môi trường.
 * Chấp nhận "gigone.com", "@gigone.com", "gigone.com, other.com".
 */
export function parseAllowedDomains(raw: string): string[] {
  const domains = raw
    .split(',')
    .map((part) => part.trim().toLowerCase().replace(/^@+/, ''))
    .filter((part) => part.length > 0)

  // Loại bỏ tên miền trùng lặp nhưng giữ nguyên thứ tự.
  return Array.from(new Set(domains))
}

/**
 * Lấy phần tên miền của email.
 *
 * Dùng lastIndexOf('@') để xử lý đúng cả trường hợp email chứa nhiều dấu '@',
 * và trả về null nếu email không có cấu trúc hợp lệ.
 */
export function emailDomain(email: string): string | null {
  const atIndex = email.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === email.length - 1) return null
  return email.slice(atIndex + 1).toLowerCase()
}

/**
 * Kiểm tra email có thuộc tên miền được phép hay không.
 *
 * So khớp CHÍNH XÁC toàn bộ tên miền, không dùng kiểm tra kiểu "kết thúc bằng".
 * Nhờ vậy các dạng lừa đảo như "user@gigone.com.evil.com" đều bị từ chối.
 * Tên miền con (sub.gigone.com) cũng bị từ chối vì không khớp chính xác.
 */
export function isAllowedEmail(email: string, allowedDomains: string[]): boolean {
  const domain = emailDomain(email)
  if (!domain) return false
  return allowedDomains.includes(domain)
}

/** Thông báo lỗi thống nhất cho cả backend và giao diện. */
export function domainRejectionMessage(allowedDomains: string[]): string {
  const list = allowedDomains.map((domain) => `@${domain}`).join(' hoặc ')
  return `Chỉ tài khoản có email thuộc tên miền ${list} mới được đăng ký.`
}

/**
 * Lỗi tên miền email kèm khoá ngữ nghĩa. `message` giữ nguyên câu cũ để không
 * phá vỡ bài test, còn client dùng `messageKey`/`messageParams` để dịch.
 */
export function domainRejectionIssue(allowedDomains: string[]): {
  message: string
  messageKey: 'auth.email_domain_not_allowed'
  messageParams: { domains: string }
} {
  return {
    message: domainRejectionMessage(allowedDomains),
    messageKey: 'auth.email_domain_not_allowed',
    messageParams: { domains: allowedDomains.map((domain) => `@${domain}`).join(', ') },
  }
}

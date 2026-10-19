/** Return a usable display name for legacy or empty-name account rows. */
export function accountName(name: unknown, email: string): string {
  if (typeof name === 'string' && name.trim()) return name
  return email.split('@', 1)[0] ?? ''
}

/** Names are trimmed, non-empty, bounded, and must not contain control characters. */
export function isValidAccountName(value: string): boolean {
  return value.length >= 1 && value.length <= 100 && !/[\p{Cc}]/u.test(value)
}

export function accountNameSchemaMessage(): string {
  return 'Tên phải dài từ 1 đến 100 ký tự và không chứa ký tự điều khiển'
}

export function accountNameSchemaValue(value: string): string {
  return value.trim()
}

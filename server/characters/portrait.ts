/**
 * Ảnh tham chiếu nhân vật: một "phiếu thiết kế" (character sheet) duy nhất gồm
 * cận mặt và bốn góc nhìn toàn thân.
 *
 * Prompt nằm ở server để mọi lối vào (AI tạo nhân vật ở trang Nhân vật, ảnh chân
 * dung nhân vật trong Tạo kịch bản AI) dùng đúng một chuẩn — giao diện không tự
 * dựng prompt nữa. Một ảnh duy nhất nên giữ nguyên schema hiện tại (mỗi nhân vật
 * một ảnh tham chiếu) và không đổi hợp đồng gửi provider.
 */

/** Kích thước dùng cho ảnh sheet; giữ như ảnh minh hoạ trước đây. */
export const CHARACTER_SHEET_SIZE = '1024x1024'

export function buildCharacterSheetPrompt(character: { name: string; appearance: string }): string {
  const name = character.name.trim() || 'nhân vật'
  const appearance = character.appearance.trim()

  const parts = [`Phiếu thiết kế nhân vật (character sheet) của ${name}.`]
  if (appearance) parts.push(`Ngoại hình: ${appearance}.`)
  parts.push(
    'Một ảnh duy nhất chia 5 ô rõ ràng trên nền trung tính, cùng một nhân vật ở mọi ô: (1) cận mặt chính diện nhìn thẳng vào máy ảnh, (2) toàn thân nhìn thẳng (góc nhìn trước), (3) toàn thân nhìn từ phía sau (góc nhìn sau), (4) toàn thân nghiêng bên trái, (5) toàn thân nghiêng bên phải.',
  )
  parts.push(
    'Giữ nguyên khuôn mặt, kiểu tóc, trang phục và tỉ lệ cơ thể ở tất cả các ô; biểu cảm trung tính, ánh sáng mềm và đều, phong cách ảnh chụp chân thực, chi tiết cao.',
  )
  parts.push('Không có chữ, nhãn hay watermark trong ảnh; không thêm người khác.')

  return parts.join(' ')
}

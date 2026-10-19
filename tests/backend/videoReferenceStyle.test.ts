/**
 * Kiểu gửi ảnh tham chiếu cho yêu cầu tạo video, theo từng provider.
 *
 * Lỗi thực tế: gateway new-api (NexusMMO) khai báo `input_reference` là CHUỖI.
 * Gửi object `{ image_url }` khiến provider từ chối yêu cầu với thông báo
 * "Video request failed", dù cùng model đó chạy tốt khi không kèm ảnh.
 */
import { describe, expect, it } from 'vitest'
import {
  buildVideoRequestBody,
  readVideoReferenceStyle,
} from '../../server/generations/adapters/video'

const DATA_URL = 'data:image/png;base64,AAAA'
const HTTPS_URL = 'https://cdn.example.com/ref.png'

describe('Kiểu gửi ảnh tham chiếu video', () => {
  it('mặc định giữ object { image_url } (chuẩn OpenAI/Sora)', () => {
    const body = buildVideoRequestBody('sora', 'p', {}, DATA_URL)
    expect(body.input_reference).toEqual({ image_url: DATA_URL })
    expect(readVideoReferenceStyle(null)).toBe('image_url_object')
    expect(readVideoReferenceStyle(undefined)).toBe('image_url_object')
    expect(readVideoReferenceStyle('gia-tri-la')).toBe('image_url_object')
  })

  it('gửi chuỗi thuần khi provider dùng kiểu image_url_string', () => {
    const body = buildVideoRequestBody('minimax-h3', 'p', {}, DATA_URL, null, 'image_url_string')
    expect(body.input_reference).toBe(DATA_URL)
    expect(readVideoReferenceStyle('image_url_string')).toBe('image_url_string')
  })

  it('chấp nhận cả data URL và URL công khai ở kiểu chuỗi', () => {
    const body = buildVideoRequestBody('minimax-h3', 'p', {}, HTTPS_URL, null, 'image_url_string')
    expect(body.input_reference).toBe(HTTPS_URL)
  })

  it('giữ nguyên thứ tự ưu tiên: ảnh đầu vào rõ ràng thắng ảnh nhân vật', () => {
    const body = buildVideoRequestBody('m', 'p', {}, DATA_URL, HTTPS_URL, 'image_url_string')
    expect(body.input_reference).toBe(HTTPS_URL)
  })

  it('vẫn tôn trọng tắt ảnh tham chiếu ở cả hai kiểu', () => {
    for (const style of ['image_url_object', 'image_url_string'] as const) {
      const disabled = buildVideoRequestBody('m', 'p', { useCharacterReference: false }, DATA_URL, null, style)
      expect(disabled.input_reference, `style=${style}`).toBeUndefined()
    }
  })

  it('không gửi gì khi không có ảnh nào, kể cả khi bật kiểu chuỗi', () => {
    const body = buildVideoRequestBody('m', 'p', {}, null, null, 'image_url_string')
    expect(body.input_reference).toBeUndefined()
    expect(body).not.toHaveProperty('input_reference')
  })
})

/**
 * Provider giả lập dùng cho test tự động.
 *
 * Chỉ hoạt động khi PROVIDER_MODE=mock. Không gọi mạng, không dùng API key thật
 * và không phát sinh chi phí. Trả về media hợp lệ (PNG và MP4 tối thiểu) để
 * kiểm tra được toàn bộ luồng lưu trữ và phục vụ media.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** MP4 tối thiểu: hộp ftyp để nhận dạng đúng định dạng video. */
function makeMinimalMp4(): Buffer {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32BE(32, 0)
  buffer.write('ftyp', 4, 'ascii')
  buffer.write('isom', 8, 'ascii')
  buffer.writeUInt32BE(512, 12)
  buffer.write('isomiso2', 16, 'ascii')
  return buffer
}

/** Trạng thái job video giả lập, đếm số lần poll để mô phỏng tiến trình. */
const videoJobs = new Map<string, { polls: number; failAt?: number }>()

let counter = 0

export function resetMockProvider(): void {
  videoJobs.clear()
  counter = 0
}

export function mockImageResponse(count = 1): { data: Array<{ b64_json: string }> } {
  return {
    data: Array.from({ length: count }, () => ({ b64_json: PNG_1X1.toString('base64') })),
  }
}

export function mockModelList(): { data: Array<{ id: string; name: string }> } {
  return {
    data: [
      { id: 'mock-image-model', name: 'Mock Image Model' },
      { id: 'mock-video-model', name: 'Mock Video Model' },
    ],
  }
}

export function createMockVideoJob(options: { failAt?: number } = {}): { id: string; status: string } {
  counter += 1
  const id = `mock-video-${counter}`
  videoJobs.set(id, { polls: 0, failAt: options.failAt })
  return { id, status: 'queued' }
}

export function pollMockVideoJob(id: string): {
  id: string
  status: string
  progress: number
  error?: { message: string }
} {
  const job = videoJobs.get(id)
  if (!job) {
    return { id, status: 'failed', progress: 0, error: { message: 'Job không tồn tại' } }
  }

  job.polls += 1

  if (job.failAt !== undefined && job.polls >= job.failAt) {
    return { id, status: 'failed', progress: 40, error: { message: 'Provider giả lập báo lỗi render' } }
  }

  // Hoàn tất sau 2 lần poll để test được cả trạng thái trung gian.
  if (job.polls >= 2) {
    return { id, status: 'completed', progress: 100 }
  }

  return { id, status: 'in_progress', progress: 50 }
}

export function mockVideoContent(): Buffer {
  return makeMinimalMp4()
}

export const MOCK_PNG_BYTES = PNG_1X1

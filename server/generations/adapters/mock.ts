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

/** Danh sách model chat giả lập cho kết nối LLM ở chế độ test. */
export function mockChatModelList(): { data: Array<{ id: string; name: string }> } {
  return {
    data: [
      { id: 'mock-chat-model', name: 'Mock Chat Model' },
      { id: 'mock-script-model', name: 'Mock Script Model' },
    ],
  }
}

const MOCK_CHAT_NAMES = ['An', 'Bình', 'Chi', 'Dũng', 'Hà', 'Khánh']

const MOCK_VOICE = {
  language: 'vi',
  accent: 'Miền Bắc',
  pitch: 'Trung trầm',
  timbre: 'Ấm',
  pace: 'Vừa phải',
  articulation: 'Rõ ràng',
  habits: 'Ngắt nghỉ nhẹ cuối câu',
}

/** Đề xuất ý kiến giả lập cho Trợ lý AI. */
export function mockIdeasResponse(): string {
  return JSON.stringify({
    logline: 'Một chuyến đi ngắn giữa hai người bạn',
    audience: 'Người xem phổ thông',
    tone: 'Ấm áp, nhẹ nhàng',
    durationSeconds: 60,
    aspectRatio: '16:9',
    keyPoints: ['Giới thiệu bối cảnh', 'Cuộc trò chuyện trên tàu', 'Kết thúc nhẹ nhàng'],
    characters: ['An', 'Bình'],
    visualStyle: 'Màu ấm, ánh sáng tự nhiên',
    risks: ['Hai nhân vật cần giữ nhất quán ngoại hình giữa các cảnh'],
  })
}

/**
 * Kế hoạch giả lập cho Trợ lý AI.
 *
 * Hai cảnh, mỗi cảnh một người nói chính, thời lượng nằm trong khoảng mặc định
 * 4–12 giây để test được cả bước kẹp thời lượng theo cấu hình model.
 */
export function mockPlanResponse(): string {
  return JSON.stringify({
    title: 'Chuyến đi ngắn',
    characters: [
      {
        name: 'An',
        appearance: 'Nam, 28 tuổi, tóc đen ngắn, áo khoác xanh, dáng nhanh nhẹn',
        role: 'Nhân vật chính',
        voice: MOCK_VOICE,
      },
      {
        name: 'Bình',
        appearance: 'Nữ, 30 tuổi, tóc ngang vai, áo len be, dáng điềm tĩnh',
        role: 'Bạn đồng hành',
        voice: MOCK_VOICE,
      },
    ],
    scenes: [
      {
        title: 'Mở đầu ở sân ga',
        background: 'Sân ga buổi sớm, ánh nắng nhạt, tàu đang đỗ',
        action: 'An kéo vali bước nhanh tới cửa toa tàu',
        dialogue: 'Đi thôi, sắp muộn rồi!',
        speaker: 'An',
        characters: ['An'],
        durationSeconds: 8,
        shotNotes: 'Toàn cảnh, máy di chuyển ngang',
      },
      {
        title: 'Trò chuyện trên tàu',
        background: 'Khoang tàu, cửa sổ lớn nhìn ra đồng quê',
        action: 'An và Bình ngồi đối diện, cùng xem bản đồ',
        dialogue: 'Cậu nhớ mang theo bản đồ chứ?',
        speaker: 'Bình',
        characters: ['An', 'Bình'],
        durationSeconds: 8,
        shotNotes: 'Cận trung, hai người trong khung',
      },
    ],
    warnings: ['Nên dùng ảnh tham chiếu cho An và Bình để giữ nhất quán ngoại hình'],
  })
}

/**
 * Câu trả lời chat giả lập cho kết nối LLM ở chế độ test.
 *
 * Nhận diện loại yêu cầu qua hợp đồng JSON nêu trong system prompt:
 *  - có `"scenes":[{"title"` → kế hoạch đầy đủ;
 *  - có `"logline"` → đề xuất ý kiến;
 *  - còn lại → danh sách nhân vật, số lượng lấy từ dòng "Số lượng cần tạo: N".
 *
 * Phải kiểm tra kế hoạch TRƯỚC ý kiến, vì prompt kế hoạch có nhúng cả JSON ý kiến.
 */
export function mockChatCompletion(
  messages: Array<{ role: string; content: string }>,
): string {
  const prompt = messages.map((message) => message.content).join('\n')

  if (/"scenes"\s*:\s*\[\s*\{/.test(prompt)) return mockPlanResponse()
  if (/"logline"/.test(prompt)) return mockIdeasResponse()
  // Chat tự do: trả lời văn xuôi để test phân biệt được với các hợp đồng JSON.
  if (prompt.includes('trao đổi với người dùng để chốt ý tưởng video')) {
    return 'Mình đã nắm được ý tưởng. Bạn cho biết video dài khoảng bao lâu và hướng tới người xem nào?'
  }

  const requested = Number(prompt.match(/Số lượng cần tạo:\s*(\d+)/)?.[1] ?? 3)
  const count = Math.min(6, Math.max(1, Number.isFinite(requested) ? requested : 3))

  return JSON.stringify({
    characters: Array.from({ length: count }, (_, index) => ({
      name: MOCK_CHAT_NAMES[index % MOCK_CHAT_NAMES.length],
      appearance: `Ngoại hình gợi ý ${index + 1}: áo sơ mi, dáng thư sinh`,
      voice: MOCK_VOICE,
    })),
  })
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

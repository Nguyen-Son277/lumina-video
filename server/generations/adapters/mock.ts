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
export const MOCK_CHARACTER_PROFILE = { nationality: 'Việt Nam (đề xuất)', age: '28', gender: 'Nam', skinTone: 'Da nâu sáng', face: 'Mặt oval', eyes: 'Nâu đậm', hairColor: 'Đen', hairStyle: 'Ngắn, gọn', heightCm: '172', build: 'Cân đối', posture: 'Tự nhiên', clothing: 'Áo sơ mi cotton xanh, quần vải tối màu', footwear: 'Giày vải đen', accessories: 'Đồng hồ', distinctiveFeatures: 'Nốt ruồi nhỏ', contextNotes: 'Phù hợp chuyến đi đời thường' }
export function mockPlanResponse(): string {
  return JSON.stringify({
    title: 'Chuyến đi ngắn',
    characters: [
      {
        name: 'An',
        appearance: 'Nam, 28 tuổi, tóc đen ngắn, áo khoác xanh, dáng nhanh nhẹn',
        role: 'Nhân vật chính',
        profile: MOCK_CHARACTER_PROFILE,
        assumptions: ['Chiều cao và xuất thân là đề xuất thiết kế'],
        voice: MOCK_VOICE,
      },
      {
        name: 'Bình',
        appearance: 'Nữ, 30 tuổi, tóc ngang vai, áo len be, dáng điềm tĩnh',
        role: 'Bạn đồng hành',
        profile: MOCK_CHARACTER_PROFILE,
        assumptions: ['Chiều cao và xuất thân là đề xuất thiết kế'],
        voice: MOCK_VOICE,
      },
    ],
    scenes: [
      {
        title: 'Mở đầu ở sân ga',
        background: 'Sân ga buổi sớm, ánh nắng nhạt, tàu đang đỗ',
        action: 'An kéo vali bước nhanh tới cửa toa tàu',
        beats: '0–2s An siết quai vali và liếc đồng hồ; 2–5s bước dài, vai hơi nghiêng về trước; 5–8s dừng trước cửa toa, thở ra nhẹ nhõm',
        dialogue: 'Đi thôi, sắp muộn rồi!',
        speaker: 'An',
        characters: ['An'],
        durationSeconds: 8,
        shotNotes: 'Toàn cảnh, máy di chuyển ngang',
        blocking: [{ name: 'An', action: 'kéo vali bước nhanh tới cửa toa tàu', expression: 'mắt mở to, lông mày nhướng, miệng hé mở lo lắng rồi thả lỏng dần', position: 'center' }],
      },
      {
        title: 'Trò chuyện trên tàu',
        background: 'Khoang tàu, cửa sổ lớn nhìn ra đồng quê',
        action: 'An và Bình ngồi đối diện, cùng xem bản đồ',
        beats: '0–3s Bình gõ nhẹ ngón tay lên bản đồ; 3–6s An nghiêng người nhìn theo; 6–8s cả hai nhìn nhau gật đầu',
        dialogue: 'Cậu nhớ mang theo bản đồ chứ?',
        speaker: 'Bình',
        characters: ['An', 'Bình'],
        durationSeconds: 8,
        shotNotes: 'Cận trung, hai người trong khung',
        blocking: [
          { name: 'An', action: 'ngồi mở bản đồ trên bàn', expression: 'mắt tập trung nhìn xuống bản đồ, lông mày hơi cau, khoé miệng nhếch nhẹ', position: 'left' },
          { name: 'Bình', action: 'nghiêng người chỉ tay vào bản đồ', expression: 'ánh mắt tinh nghịch liếc sang An, miệng cười mở, cằm hơi nâng', position: 'right' },
        ],
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
  const prompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.split('Dữ liệu phiên hiện có')[0])
    .join('\n')
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? ''

  // Mô phỏng định tuyến agent: người dùng yêu cầu rõ một bước thì model trả `run`.
  const requestedRun = /lên timeline/i.test(lastUser)
    ? 'timeline'
    : /(tạo|đề xuất|ý tưởng)\s+nhân vật/i.test(lastUser)
      ? 'cast'
      : /viết (lại )?kịch bản/i.test(lastUser)
        ? 'script'
        : null

  const withRun = (payload: string): string => {
    if (!requestedRun) return payload
    const fallbackReply = 'Đã hiểu. Mình chạy bước tiếp theo cho bạn.'
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      return JSON.stringify({
        ...parsed,
        reply: typeof parsed.reply === 'string' && parsed.reply ? parsed.reply : fallbackReply,
        run: requestedRun,
      })
    } catch {
      return JSON.stringify({ reply: payload.trim() || fallbackReply, run: requestedRun })
    }
  }

  // Sắp xếp lại một frame: chỉ trả blocking cho đúng những người được liệt kê.
  if (/"blocking"\s*:\s*\[\s*\{\s*"name"/.test(prompt) && !/"scenes"/.test(prompt)) {
    const listed = lastUser.match(/Nhân vật đang có trong frame:\s*(.+)/)?.[1] ?? ''
    const names = listed
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0 && name !== 'chưa xác định')
    const positions = ['left', 'center', 'right'] as const
    return JSON.stringify({
      reply: 'Đã sắp xếp lại vị trí và hành động cho frame.',
      blocking: names.map((name, index) => ({
        name,
        action: `hoạt động nhịp nhàng ở vị trí ${index + 1}`,
        expression: 'ánh mắt hướng theo hành động, lông mày hơi nhướng, miệng thả lỏng',
        position: names.length === 1 ? 'center' : positions[index] ?? 'background',
      })),
    })
  }

  if (prompt.includes('Bạn hoàn thiện hồ sơ nhân vật')) {
    const input=JSON.parse(lastUser) as {characters:Array<{id:string}>}
    return JSON.stringify({profiles:input.characters.map(character=>({id:character.id,profile:MOCK_CHARACTER_PROFILE,rationale:'Phù hợp bối cảnh',assumptions:['Thông tin chưa xác định là đề xuất']}))})
  }
  if (/"scenes"\s*:\s*\[\s*\{/.test(prompt)) {
    const plan = JSON.parse(mockPlanResponse()) as Record<string, unknown>
    const system = messages.find((message) => message.role === 'system')?.content ?? ''
    const stateJson = system.split('Dữ liệu phiên hiện có')[1]?.split('\n').slice(1).join('\n')
    const state = stateJson ? JSON.parse(stateJson) as { cast?: unknown[] } : null
    if (prompt.includes('Tab hiện tại: TIMELINE') && state?.cast?.length) delete plan.characters
    return withRun(JSON.stringify(plan))
  }
  if (prompt.includes('nhà thiết kế nhân vật cho kịch bản')) {
    const request = JSON.parse(messages.find(message => message.role === 'user')?.content ?? '{}') as { count?: number; character?: { variants?: unknown[] } }
    const offset = request.character?.variants?.length ?? 0
    return JSON.stringify({ variants: Array.from({ length: request.count ?? 3 }, (_, index) => ({ label: `Thiết kế ${offset + index + 1}`, profile: { nationality: 'Việt Nam (đề xuất theo bối cảnh)', age: '28', gender: '', skinTone: 'Da nâu sáng', face: 'Mặt oval, nét tự nhiên', eyes: 'Nâu đậm', hairColor: 'Đen', hairStyle: 'Ngắn, gọn', heightCm: '172', build: 'Cân đối', posture: 'Dáng đứng tự nhiên', clothing: `Áo sơ mi cotton ${['xanh', 'be', 'trắng', 'nâu'][((offset + index) % 4)]}, quần vải tối màu, thiết kế ${offset + index + 1}`, footwear: 'Giày vải đen', accessories: 'Đồng hồ đơn giản', distinctiveFeatures: 'Nốt ruồi nhỏ bên má trái', contextNotes: 'Trang phục đời thường phù hợp chuyến đi' }, rationale: 'Thiết kế phù hợp vai trò và bối cảnh', assumptions: ['Tuổi, xuất thân và chiều cao là đề xuất thiết kế'] })) })
  }
  if (/"logline"/.test(prompt)) return mockIdeasResponse()
  // Chat tự do: trả lời văn xuôi để test phân biệt được với các hợp đồng JSON.
  if (prompt.includes('trao đổi với người dùng để chốt ý tưởng video')) {
    return withRun('Mình đã nắm được ý tưởng. Bạn cho biết video dài khoảng bao lâu và hướng tới người xem nào?')
  }

  const requested = Number(messages.map((message) => message.content).join('\n').match(/Số lượng cần tạo:\s*(\d+)/)?.[1] ?? 3)
  const count = Math.min(6, Math.max(1, Number.isFinite(requested) ? requested : 3))

  return withRun(JSON.stringify({
    characters: Array.from({ length: count }, (_, index) => ({
      name: MOCK_CHAT_NAMES[index % MOCK_CHAT_NAMES.length],
      appearance: `Ngoại hình gợi ý ${index + 1}: áo sơ mi, dáng thư sinh`,
      profile: MOCK_CHARACTER_PROFILE,
      assumptions: ['Chiều cao và xuất thân là đề xuất thiết kế'],
      voice: MOCK_VOICE,
    })),
  }))
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

import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerUser, startTestServer, type TestContext } from './helpers'
import { normalizeCandidates, buildCharacterMessages } from '../../server/characters/generate'
import { parseJsonLoose } from '../../server/llm/chat'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

/** Tạo provider + model LLM & Chat để tính năng văn bản có credential dùng. */
async function seedLlm(target: TestContext, baseUrl = 'https://llm.mock.test/v1') {
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: { name: 'LLM provider', baseUrl, apiKey: 'sk-llm-abcd1234' },
  })
  expect(provider.status).toBe(201)
  const model = await call(target, '/api/models', {
    method: 'POST',
    body: { providerId: provider.body.provider.id, modelId: 'mock-chat-model', kind: 'llm' },
  })
  expect(model.status).toBe(201)
  return model.body.model.id as string
}

describe('Bóc JSON từ câu trả lời của AI', () => {
  it('chấp nhận JSON thuần, JSON trong rào markdown và JSON có lời dẫn', () => {
    const payload = '{"characters":[{"name":"An"}]}'
    expect(parseJsonLoose(payload)).toEqual({ characters: [{ name: 'An' }] })
    expect(parseJsonLoose('```json\n' + payload + '\n```')).toEqual({
      characters: [{ name: 'An' }],
    })
    expect(parseJsonLoose('Đây là kết quả:\n' + payload + '\nChúc bạn vui vẻ')).toEqual({
      characters: [{ name: 'An' }],
    })
    expect(parseJsonLoose('[{"name":"Bình"}]')).toEqual([{ name: 'Bình' }])
  })

  it('trả null khi không có JSON', () => {
    expect(parseJsonLoose('Xin lỗi, tôi không tạo được nhân vật.')).toBeNull()
    expect(parseJsonLoose('')).toBeNull()
  })
})

describe('Chuẩn hóa ứng viên nhân vật', () => {
  it('cắt độ dài, bỏ ứng viên thiếu tên và giới hạn số lượng', () => {
    const result = normalizeCandidates(
      {
        characters: [
          { name: 'An', appearance: 'x'.repeat(5000), voice: { accent: 'Miền Nam' } },
          { appearance: 'Thiếu tên' },
          { name: 'Bình' },
          { name: 'Chi' },
          { name: 'Dũng' },
        ],
      },
      { count: 2, language: 'vi' },
    )
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('An')
    expect(result[0]!.appearance).toHaveLength(4000)
    expect(result[0]!.voice.accent).toBe('Miền Nam')
    // Trường ngôn ngữ được điền mặc định theo yêu cầu.
    expect(result[0]!.voice.language).toBe('vi')
  })

  it('không trùng tên với nhân vật đã có, và tự tránh trùng nhau', () => {
    const result = normalizeCandidates(
      {
        characters: [{ name: 'An' }, { name: 'an' }, { name: 'Bình' }],
      },
      { count: 5, language: 'vi', existingNames: ['An'] },
    )
    expect(result.map((item) => item.name)).toEqual(['Bình'])
  })

  it('chấp nhận mảng trần và bỏ qua dữ liệu sai kiểu', () => {
    expect(normalizeCandidates([{ name: 'An' }, null, 'x', 42], { count: 3, language: 'vi' }))
      .toHaveLength(1)
    expect(normalizeCandidates({ characters: 'không phải mảng' }, { count: 3, language: 'vi' }))
      .toHaveLength(0)
  })

  it('prompt nêu rõ số lượng và tên đã có', () => {
    const messages = buildCharacterMessages({
      description: 'phi hành gia trẻ',
      count: 4,
      language: 'vi',
      existingNames: ['An', 'Bình'],
    })
    const text = messages.map((message) => message.content).join('\n')
    expect(text).toContain('phi hành gia trẻ')
    expect(text).toContain('Số lượng cần tạo: 4')
    expect(text).toContain('An, Bình')
    expect(messages[0]!.role).toBe('system')
  })
})

describe('Sinh nhân vật mẫu bằng AI', () => {
  it('trả ứng viên nhưng KHÔNG lưu vào database', async () => {
    await registerUser(ctx)
    await seedLlm(ctx)

    const result = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một phi hành gia trẻ, điềm tĩnh, người Việt' },
    })
    expect(result.status).toBe(200)
    expect(result.body.candidates).toHaveLength(3)
    expect(result.body.modelId).toBeTruthy()
    expect(result.body.model).toBe('mock-chat-model')

    const first = result.body.candidates[0]
    expect(first.name).toBeTruthy()
    expect(first.appearance).toBeTruthy()
    expect(first.voice.language).toBe('vi')

    // Chưa bấm thêm thì thư viện vẫn trống.
    expect((await call(ctx, '/api/shared-characters')).body.characters).toHaveLength(0)
  })

  it('tôn trọng số lượng người dùng chọn', async () => {
    await registerUser(ctx)
    await seedLlm(ctx)

    const result = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'ba nhân vật', count: 5 },
    })
    expect(result.body.candidates).toHaveLength(5)
  })

  it('ứng viên lưu được bằng endpoint tạo nhân vật và giữ nguyên hồ sơ giọng', async () => {
    await registerUser(ctx)
    await seedLlm(ctx)

    const generated = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật', count: 1 },
    })
    const candidate = generated.body.candidates[0]

    const saved = await call(ctx, '/api/shared-characters', { method: 'POST', body: candidate })
    expect(saved.status).toBe(201)
    expect(saved.body.character.name).toBe(candidate.name)
    expect(saved.body.character.voice.accent).toBe(candidate.voice.accent)
    expect(saved.body.character.projectId).toBeNull()

    expect((await call(ctx, '/api/shared-characters')).body.characters).toHaveLength(1)
  })

  it('từ chối khi chưa có kết nối LLM', async () => {
    await registerUser(ctx)

    const result = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('Chưa có model LLM & Chat')
  })

  it('hướng dẫn phân loại model khi provider chưa có model LLM & Chat', async () => {
    await registerUser(ctx)
    // Có provider nhưng model vẫn chưa được phân loại thành LLM & Chat.
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Nhà', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
    })
    await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: provider.body.provider.id, modelId: 'mock-image-model', kind: 'image' },
    })

    const result = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.message).toContain('Chưa có model LLM & Chat')
    expect(result.body.error.message).toContain('LLM & Chat')
  })

  it('bỏ qua model không phải LLM khi tự chọn model chat', async () => {
    await registerUser(ctx)
    // Model ảnh không được dùng làm model chat dù được tạo trước.
    const provider = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Ảnh', baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-anh' },
    })
    await call(ctx, '/api/models', {
      method: 'POST',
      body: { providerId: provider.body.provider.id, modelId: 'mock-image-model', kind: 'image' },
    })
    await seedLlm(ctx)

    const result = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật', count: 1 },
    })
    expect(result.status).toBe(200)
    expect(result.body.candidates).toHaveLength(1)
  })

  it('kiểm tra dữ liệu vào và quyền sở hữu model', async () => {
    await registerUser(ctx)
    const modelId = await seedLlm(ctx)

    // Thiếu mô tả.
    expect(
      (await call(ctx, '/api/shared-characters/generate', { method: 'POST', body: {} })).status,
    ).toBe(400)
    // Mô tả quá dài.
    expect(
      (await call(ctx, '/api/shared-characters/generate', {
        method: 'POST',
        body: { description: 'x'.repeat(2001) },
      })).status,
    ).toBe(400)
    // Số lượng ngoài khoảng cho phép.
    expect(
      (await call(ctx, '/api/shared-characters/generate', {
        method: 'POST',
        body: { description: 'ok', count: 99 },
      })).status,
    ).toBe(400)
    // Yêu cầu đăng nhập.
    expect(
      (await fetch(`${ctx.baseUrl}/api/shared-characters/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'ok' }),
      })).status,
    ).toBe(401)

    // Model LLM của tài khoản khác.
    await registerUser(ctx)
    const stolen = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'ok', modelId },
    })
    expect(stolen.status).toBe(404)
  })
})

describe('Gọi LLM thật để sinh nhân vật', () => {
  it('gửi đúng hợp đồng chat/completions và bóc JSON có rào markdown', async () => {
    const captured: Array<{ path: string; authorization?: string; body: any }> = []

    const fake = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        captured.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '```json\n{"characters":[{"name":"An","appearance":"Áo xanh","voice":{"accent":"Miền Nam","language":"vi"}}]}\n```',
                },
              },
            ],
          }),
        )
      })
    })
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port))
    })

    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const modelId = await seedLlm(live, `http://127.0.0.1:${port}/v1`)

      const result = await call(live, '/api/shared-characters/generate', {
        method: 'POST',
        body: { description: 'một người lính già', count: 1, modelId },
      })
      expect(result.status).toBe(200)
      expect(result.body.candidates).toHaveLength(1)
      expect(result.body.candidates[0].name).toBe('An')

      expect(captured).toHaveLength(1)
      expect(captured[0]!.path).toBe('/v1/chat/completions')
      expect(captured[0]!.authorization).toBe('Bearer sk-llm-abcd1234')
      expect(captured[0]!.body.model).toBe('mock-chat-model')
      const prompt = JSON.stringify(captured[0]!.body.messages)
      expect(prompt).toContain('một người lính già')
      // Không gửi response_format để tương thích gateway.
      expect(captured[0]!.body).not.toHaveProperty('response_format')
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('báo lỗi rõ ràng khi AI trả về văn bản không đọc được', async () => {
    const fake = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'Xin chào, tôi là AI.' } }] }))
      })
    })
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port))
    })

    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const modelId = await seedLlm(live, `http://127.0.0.1:${port}/v1`)

      const result = await call(live, '/api/shared-characters/generate', {
        method: 'POST',
        body: { description: 'một nhân vật', modelId },
      })
      expect(result.status).toBe(502)
      expect(result.body.error.message).toContain('không đọc được')
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })

  it('báo lỗi key khi provider trả 401', async () => {
    const fake = createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      })
    })
    const port = await new Promise<number>((resolve) => {
      fake.listen(0, '127.0.0.1', () => resolve((fake.address() as { port: number }).port))
    })

    const live = await startTestServer({ allowPrivate: true, providerMode: 'live' })
    try {
      await registerUser(live)
      const modelId = await seedLlm(live, `http://127.0.0.1:${port}/v1`)

      const result = await call(live, '/api/shared-characters/generate', {
        method: 'POST',
        body: { description: 'một nhân vật', modelId },
      })
      expect(result.status).toBe(400)
      expect(result.body.error.message).toContain('API key')
    } finally {
      await live.close()
      await new Promise<void>((resolve) => fake.close(() => resolve()))
    }
  })
})

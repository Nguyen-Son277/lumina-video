/**
 * Hạn chót gọi provider phải do từng request quyết định, không bị timeout mức
 * socket (undici `headersTimeout`/`bodyTimeout`) ghim cứng 60 giây.
 *
 * Lỗi thực tế: provider ảnh trả lời sau ~1m10s, nhưng dispatcher cắt kết nối ở
 * giây thứ 60 nên người dùng nhận lỗi kết nối dù ảnh sắp về. Các test dưới đây
 * khoá lại bất biến: timeout mức socket LUÔN dài hơn hạn chót của request.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey } from '../../server/crypto/providerKey'
import { loadEnv } from '../../server/env'
import { callProvider, resolveDispatcherTimeouts } from '../../server/providers/client'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // Request bị abort có thể để lại kết nối treo: đóng cưỡng bức để test
          // không chờ tới hết timeout của chính server.
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

type FakeProvider = {
  baseUrl: string
  /** Số byte thân request cuối cùng đã nhận (để chắc rằng POST đã được gửi). */
  received: () => number
}

/** Provider giả: chờ `delayMs` rồi mới trả JSON; `delayMs = null` là không bao giờ trả. */
function startFakeProvider(delayMs: number | null, payload: unknown = { data: [] }): Promise<FakeProvider> {
  let received = 0
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      received += Buffer.concat(chunks).byteLength
      if (delayMs === null) return
      setTimeout(() => {
        if (response.writableEnded) return
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }, delayMs)
    })
  })
  servers.push(server)

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, received: () => received })
    })
  })
}

describe('Timeout mức socket suy ra từ hạn chót của request', () => {
  it('luôn dài hơn hạn chót của request, kể cả khi request cho chờ 5 phút', () => {
    for (const timeoutMs of [20_000, 90_000, 120_000, 180_000, 300_000]) {
      const timeouts = resolveDispatcherTimeouts(timeoutMs)
      expect(timeouts.headersTimeout).toBeGreaterThan(timeoutMs)
      expect(timeouts.bodyTimeout).toBeGreaterThan(timeoutMs)
      // Bất biến quan trọng: với các hạn chót dài (tạo ảnh 1,5–5 phút), timeout
      // mức socket không bao giờ quay lại mức ghim cứng 60 giây.
      if (timeoutMs >= 90_000) {
        expect(timeouts.headersTimeout).toBeGreaterThan(60_000)
        expect(timeouts.bodyTimeout).toBeGreaterThan(60_000)
      }
    }
  })

  it('dùng hạn chót mặc định khi giá trị không hợp lệ', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const timeouts = resolveDispatcherTimeouts(invalid)
      expect(timeouts.headersTimeout).toBeGreaterThan(60_000)
      expect(timeouts.bodyTimeout).toBeGreaterThan(60_000)
    }
  })
})

describe('Thời gian chờ tạo ảnh cấu hình được', () => {
  const base = {
    APP_ENCRYPTION_KEY: generateMasterKey(),
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv

  it('mặc định 3 phút — dư cho provider phản hồi 60–90 giây', () => {
    expect(loadEnv(base).IMAGE_REQUEST_TIMEOUT_MS).toBe(180_000)
  })

  it('đặt được 2 phút hoặc 1 phút 30 giây qua .env', () => {
    expect(loadEnv({ ...base, IMAGE_REQUEST_TIMEOUT_MS: '120000' }).IMAGE_REQUEST_TIMEOUT_MS).toBe(120_000)
    expect(loadEnv({ ...base, IMAGE_REQUEST_TIMEOUT_MS: '90000' }).IMAGE_REQUEST_TIMEOUT_MS).toBe(90_000)
  })
})

describe('callProvider giữ kết nối tới khi provider trả lời', () => {
  it('POST chậm hơn 1 giây vẫn nhận được phản hồi khi hạn chót còn hiệu lực', async () => {
    const fake = await startFakeProvider(1_200, { data: [{ b64_json: 'AA==' }] })
    const response = await callProvider(
      { baseUrl: fake.baseUrl, apiKey: 'sk-test-1234', allowPrivate: true },
      'images/generations',
      { method: 'POST', body: { prompt: 'frame 2' }, timeoutMs: 90_000 },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: [{ b64_json: 'AA==' }] })
  })

  it('POST quá hạn chót bị huỷ và báo kết quả không xác định thay vì treo', async () => {
    const fake = await startFakeProvider(null)
    const startedAt = Date.now()

    await expect(
      callProvider(
        { baseUrl: fake.baseUrl, apiKey: 'sk-test-1234', allowPrivate: true },
        'images/generations',
        { method: 'POST', body: { prompt: 'frame 3' }, timeoutMs: 400 },
      ),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })

    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(5_000)
    // POST đã thực sự được gửi tới provider trước khi bị huỷ.
    expect(fake.received()).toBeGreaterThan(0)
  })
})

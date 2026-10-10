import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp } from '../../server/app'
import { openDatabase, type Database } from '../../server/db/index'
import { createMediaStore, type MediaStore } from '../../server/media/store'
import { createWorker, type Worker } from '../../server/generations/worker'
import { generateMasterKey } from '../../server/crypto/providerKey'
import { loadEnv, type AppEnv } from '../../server/env'
import { resetMockProvider } from '../../server/generations/adapters/mock'

export type TestContext = {
  baseUrl: string
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  worker: Worker
  /** Cookie phiên của tài khoản đang đăng nhập. */
  cookie: string
  dir: string
  close: () => Promise<void>
}

/**
 * Khởi động một backend thật trên cổng ngẫu nhiên với database và thư mục media
 * tạm. Dùng PROVIDER_MODE=mock nên không có request nào ra mạng ngoài.
 */
export async function startTestServer(
  options: {
    allowPrivate?: boolean
    providerMode?: 'mock' | 'live'
    /** Trỏ tới ffmpeg giả để test luồng xuất video mà không cần ffmpeg thật. */
    ffmpegPath?: string
    /** Email super admin cho test luồng duyệt tài khoản (phân tách bằng dấu phẩy). */
    superAdminEmails?: string
  } = {},
): Promise<TestContext> {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-test-'))

  /**
   * Tài khoản đăng ký mới phải chờ duyệt; các bộ test cũ chỉ cần một tài khoản
   * dùng được ngay. `SUPER_ADMIN_EMAILS` được đặt tường minh trong từng bài test
   * cần quyền quản trị, còn lại để rỗng.
   */
  const env = loadEnv({
    SUPER_ADMIN_EMAILS: options.superAdminEmails ?? '',
    APP_ENCRYPTION_KEY: generateMasterKey(),
    // Cổng thật do listen(0) chọn; giá trị này chỉ để qua bước kiểm tra cấu hình.
    PORT: '8787',
    DATABASE_PATH: join(dir, 'app.db'),
    MEDIA_DIR: join(dir, 'media'),
    APP_ORIGIN: 'http://127.0.0.1:5173',
    // Cho phép gọi provider giả lập chạy trên 127.0.0.1 khi test cần HTTP thật.
    ALLOW_PRIVATE_PROVIDER_URLS: options.allowPrivate ? 'true' : 'false',
    PROVIDER_MODE: options.providerMode ?? 'mock',
    COOKIE_SECURE: 'false',
    NODE_ENV: 'test',
    // Tắt rate limit để nhiều bài test có thể tạo tài khoản.
    RATE_LIMIT_REGISTER_PER_HOUR: '0',
    RATE_LIMIT_LOGIN_PER_10MIN: '0',
    RATE_LIMIT_GENERATE_PER_MIN: '0',
    RATE_LIMIT_LLM_CHAT_PER_MIN: '0',
    // Mặc định không có ffmpeg: test tự tạo ffmpeg giả khi cần.
    FFMPEG_PATH: options.ffmpegPath ?? '',
  } as NodeJS.ProcessEnv)

  resetMockProvider()

  const db = openDatabase(env.DATABASE_PATH)
  const mediaStore = createMediaStore({
    root: env.MEDIA_DIR,
    maxImageBytes: env.MAX_IMAGE_BYTES,
    maxVideoBytes: env.MAX_VIDEO_BYTES,
    maxUserBytes: env.MAX_USER_MEDIA_BYTES,
  })

  const worker = createWorker({ db, mediaStore, env, intervalMs: 60_000 })
  const app = createApp({ db, env, mediaStore, worker })

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  return {
    baseUrl,
    db,
    env,
    mediaStore,
    worker,
    cookie: '',
    dir,
    async close() {
      await worker.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export type ApiResult<T = any> = {
  status: number
  body: T
  headers: Headers
}

/** Gọi API kèm cookie phiên hiện tại và tự cập nhật cookie khi server đặt mới. */
export async function call<T = any>(
  ctx: TestContext,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; raw?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {}
  const cookie = init.cookie ?? ctx.cookie
  if (cookie) headers.Cookie = cookie
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })

  const setCookies = response.headers.getSetCookie()
  if (setCookies.length > 0 && init.cookie === undefined) {
    ctx.cookie = setCookies.map((value) => value.split(';')[0]).join('; ')
  }

  const text = await response.text()
  let body: any = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }

  return { status: response.status, body, headers: response.headers }
}

/** Duyệt thẳng trong DB cho các bài test không kiểm tra luồng quản trị. */
export function approveAccountInDb(ctx: TestContext, email: string): void {
  ctx.db
    .prepare("UPDATE users SET status = 'approved', approved_at = ? WHERE email = ?")
    .run(Date.now(), email)
}

/**
 * Đăng ký tài khoản rồi để nó dùng được ngay (duyệt trong DB + đăng nhập).
 *
 * Tài khoản mới mặc định `pending` nên đăng ký KHÔNG trả phiên; helper duyệt rồi
 * đăng nhập để giữ nguyên hợp đồng cũ: sau khi gọi, `ctx.cookie` thuộc tài khoản
 * vừa tạo và mọi API đều gọi được.
 */
export async function registerUser(
  ctx: TestContext,
  email = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@gigone.com`,
  password = 'matkhau-rat-dai-123',
): Promise<{ email: string; userId: string }> {
  const result = await call(ctx, '/api/auth/register', {
    method: 'POST',
    body: { email, password },
  })
  if (result.status !== 201) {
    throw new Error(`Đăng ký thất bại: ${JSON.stringify(result.body)}`)
  }
  const userId = result.body.user.id as string
  approveAccountInDb(ctx, email)

  const login = await call(ctx, '/api/auth/login', { method: 'POST', body: { email, password } })
  if (login.status !== 200) {
    throw new Error(`Đăng nhập sau khi duyệt thất bại: ${JSON.stringify(login.body)}`)
  }
  return { email, userId }
}

/** Đăng ký tài khoản ở trạng thái chờ duyệt, không có phiên. */
export async function registerPendingUser(
  ctx: TestContext,
  email = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@gigone.com`,
  password = 'matkhau-rat-dai-123',
): Promise<{ email: string; userId: string; password: string }> {
  const result = await call(ctx, '/api/auth/register', {
    method: 'POST',
    body: { email, password },
  })
  if (result.status !== 201) {
    throw new Error(`Đăng ký tài khoản chờ duyệt thất bại: ${JSON.stringify(result.body)}`)
  }
  // Không có Set-Cookie: xóa phiên cũ của context để các khẳng định "không đăng
  // nhập được" không bị ảnh hưởng bởi bài test trước.
  ctx.cookie = ''
  return { email, userId: result.body.user.id as string, password }
}

/**
 * Bảo đảm có phiên super admin trong context (email phải nằm trong
 * `SUPER_ADMIN_EMAILS` của test server).
 *
 * Gọi lại được nhiều lần trong cùng một file test: nếu tài khoản đã tồn tại thì
 * đăng nhập thay vì đăng ký, nên `ctx.cookie` luôn thuộc tài khoản quản trị.
 */
export async function ensureSuperAdmin(
  ctx: TestContext,
  email = 'admin@gigone.com',
  password = 'matkhau-admin-rat-dai-123',
): Promise<{ email: string; userId: string }> {
  const result = await call(ctx, '/api/auth/register', {
    method: 'POST',
    body: { email, password },
  })

  if (result.status === 201) {
    if (result.body.user.role !== 'admin') {
      throw new Error(`Email ${email} không nằm trong SUPER_ADMIN_EMAILS của test server`)
    }
    return { email, userId: result.body.user.id as string }
  }

  if (result.status === 409) {
    const session = await signIn(ctx, email, password)
    if (session.role !== 'admin') throw new Error(`Tài khoản ${email} không có vai trò admin`)
    return { email, userId: session.userId }
  }

  throw new Error(`Không tạo được super admin: ${JSON.stringify(result.body)}`)
}

/** Đăng nhập và lưu phiên vào context (dùng để chuyển giữa admin và user). */
export async function signIn(
  ctx: TestContext,
  email: string,
  password: string,
): Promise<{ userId: string; role: string }> {
  const result = await call(ctx, '/api/auth/login', { method: 'POST', body: { email, password } })
  if (result.status !== 200) {
    throw new Error(`Đăng nhập thất bại: ${JSON.stringify(result.body)}`)
  }
  return { userId: result.body.user.id as string, role: result.body.user.role as string }
}

/** Tạo provider và model để dùng cho các bước tạo nội dung. */
export async function seedProviderAndModel(
  ctx: TestContext,
  kind: 'image' | 'video',
): Promise<{ providerId: string; modelPk: string }> {
  const provider = await call(ctx, '/api/providers', {
    method: 'POST',
    body: {
      name: `Provider ${kind}`,
      baseUrl: `https://${kind}.mock.test/v1`,
      apiKey: 'sk-mock-key-for-tests',
    },
  })
  if (provider.status !== 201) {
    throw new Error(`Tạo provider thất bại: ${JSON.stringify(provider.body)}`)
  }

  const model = await call(ctx, '/api/models', {
    method: 'POST',
    body: {
      providerId: provider.body.provider.id,
      modelId: `mock-${kind}-model`,
      displayName: `Mock ${kind}`,
      kind,
    },
  })
  if (model.status !== 201) {
    throw new Error(`Tạo model thất bại: ${JSON.stringify(model.body)}`)
  }

  return { providerId: provider.body.provider.id, modelPk: model.body.model.id }
}

/** Chờ tới khi tác vụ đạt trạng thái kết thúc, dùng worker.tick() thay vì chờ timer. */
export async function waitForGeneration(
  ctx: TestContext,
  id: string,
  options: { timeoutMs?: number } = {},
): Promise<any> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)

  while (Date.now() < deadline) {
    await ctx.worker.tick()
    const result = await call(ctx, `/api/generations/${id}`)
    const status = result.body?.generation?.status
    if (status === 'succeeded' || status === 'failed' || status === 'unknown') {
      return result.body.generation
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  throw new Error(`Tác vụ ${id} không kết thúc trong thời gian cho phép`)
}

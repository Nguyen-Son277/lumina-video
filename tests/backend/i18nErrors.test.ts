import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ERROR_CATALOG,
  errorCatalogKeys,
  formatErrorMessage,
  genericMessageKeyForCode,
  messageKeyForLegacyMessage,
  type ErrorMessageKey,
} from '../../shared/errorCatalog'
import { AppError, errorMetadataOf, validationError } from '../../server/lib/errors'
import { errorHandler } from '../../server/auth/middleware'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext

beforeAll(async () => {
  ctx = await startTestServer()
})

afterAll(async () => {
  if (ctx) await ctx.close()
})

function columnNames(table: string): string[] {
  return (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
}

function captureResponse() {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    status(code: number) {
      out.status = code
      return res
    },
    json(payload: unknown) {
      out.body = payload
      return res
    },
  }
  return { res, out }
}

describe('Danh mục lỗi dùng chung', () => {
  it('mọi khoá đều có bản tiếng Việt và tiếng Anh', () => {
    const keys = errorCatalogKeys()
    expect(keys.length).toBeGreaterThan(50)
    for (const key of keys) {
      const entry = ERROR_CATALOG[key]
      expect(entry.vi.trim().length, `vi của ${key}`).toBeGreaterThan(0)
      expect(entry.en.trim().length, `en của ${key}`).toBeGreaterThan(0)
    }
  })

  it('không có hai khoá tĩnh dùng chung một câu tiếng Việt', () => {
    const seen = new Map<string, ErrorMessageKey>()
    for (const key of errorCatalogKeys()) {
      const entry = ERROR_CATALOG[key]
      if (/\{[a-zA-Z0-9_]+\}/.test(entry.vi)) continue
      expect(seen.has(entry.vi), `trùng câu: ${entry.vi}`).toBe(false)
      seen.set(entry.vi, key)
    }
  })

  it('nội suy tham số vào mẫu câu', () => {
    expect(formatErrorMessage('generations.prompt_too_long', { max: 123 })).toContain('123')
    expect(formatErrorMessage('auth.password_too_short', { min: 10 }, 'en')).toContain('10')
  })

  it('khớp chính xác câu cũ với khoá ngữ nghĩa', () => {
    expect(messageKeyForLegacyMessage('Không tìm thấy dự án')).toBe('projects.not_found')
    expect(messageKeyForLegacyMessage('Không tìm thấy tác vụ')).toBe('generations.not_found')
    expect(messageKeyForLegacyMessage('câu không thuộc danh mục')).toBeUndefined()
  })

  it('suy khoá dự phòng từ code, kể cả code lạ', () => {
    expect(genericMessageKeyForCode('NOT_FOUND')).toBe('errors.not_found')
    expect(genericMessageKeyForCode('PROVIDER_MISSING')).toBe('generations.provider_missing')
    expect(genericMessageKeyForCode('KHONG_CO_TON_TAI')).toBe('errors.unknown')
    expect(genericMessageKeyForCode(null)).toBe('errors.unknown')
  })
})

describe('AppError mang metadata ngữ nghĩa', () => {
  it('khớp mẫu tĩnh và giữ nguyên câu gốc', () => {
    const error = new AppError(404, 'NOT_FOUND', 'Không tìm thấy dự án')
    expect(error.message).toBe('Không tìm thấy dự án')
    expect(error.messageKey).toBe('projects.not_found')
    expect(error.messageParams).toEqual({})
  })

  it('ưu tiên metadata tường minh cho câu động', () => {
    const error = new AppError(400, 'BAD_REQUEST', 'Mô tả tối đa 500 ký tự', undefined, {
      messageKey: 'generations.prompt_too_long',
      messageParams: { max: 500 },
    })
    expect(error.messageKey).toBe('generations.prompt_too_long')
    expect(error.messageParams).toEqual({ max: 500 })
  })

  it('rơi về khoá chung khi code lạ và câu không khớp', () => {
    const error = new AppError(500, 'SOMETHING_WEIRD', 'lỗi nội bộ bí mật')
    expect(error.messageKey).toBe('errors.unknown')
    expect(error.messageParams).toEqual({})
  })

  it('validationError gắn field và giữ câu Zod gốc', () => {
    const error = validationError({ issues: [{ message: 'Invalid input: expected string', path: ['name'] }] })
    expect(error.status).toBe(400)
    expect(error.message).toBe('Invalid input: expected string')
    expect(error.messageKey).toBe('validation.invalid_payload')
    expect(error.messageParams).toEqual({ field: 'name', reason: 'Invalid input: expected string' })
  })

  it('validationError nhận diện câu Zod đã có trong danh mục', () => {
    const error = validationError({ issues: [{ message: 'Email không hợp lệ', path: ['email'] }] })
    expect(error.messageKey).toBe('validation.email_invalid')
    expect(error.messageParams).toEqual({ field: 'email' })
  })

  it('errorMetadataOf trích được metadata từ lỗi bất kỳ', () => {
    expect(errorMetadataOf(new AppError(409, 'CONFLICT', 'Email này đã được đăng ký'))).toEqual({
      messageKey: 'auth.email_taken',
      messageParams: {},
    })
    expect(errorMetadataOf(new Error('raw'))).toEqual({ messageKey: 'errors.unknown', messageParams: {} })
  })
})

describe('errorHandler trả metadata và không rò rỉ chi tiết', () => {
  it('AppError giữ nguyên HTTP code và thêm messageKey/messageParams', () => {
    const { res, out } = captureResponse()
    errorHandler(new AppError(409, 'CONFLICT', 'Email này đã được đăng ký'), {} as any, res, (() => {}) as any)
    expect(out.status).toBe(409)
    expect(out.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Email này đã được đăng ký',
      messageKey: 'auth.email_taken',
      messageParams: {},
    })
  })

  it('lỗi nội bộ không trả chi tiết gốc cho client', () => {
    const { res, out } = captureResponse()
    errorHandler(new Error('chi tiết tuyệt mật của máy chủ'), {} as any, res, (() => {}) as any)
    expect(out.status).toBe(500)
    expect(out.body.error.code).toBe('INTERNAL_ERROR')
    expect(out.body.error.messageKey).toBe('errors.internal')
    expect(JSON.stringify(out.body)).not.toContain('chi tiết tuyệt mật')
  })
})

describe('Phản hồi lỗi HTTP có metadata', () => {
  it('endpoint /api không tồn tại trả khoá riêng', async () => {
    const result = await call(ctx, '/api/khong-ton-tai')
    expect(result.status).toBe(404)
    expect(result.body.error.messageKey).toBe('errors.endpoint_not_found')
  })

  it('chưa đăng nhập vẫn là 401 kèm khoá chung', async () => {
    const result = await call(ctx, '/api/providers', { cookie: '' })
    expect(result.status).toBe(401)
    expect(result.body.error).toMatchObject({
      code: 'UNAUTHORIZED',
      messageKey: 'errors.unauthorized',
      messageParams: {},
    })
  })
})

describe('Xác thực: chính sách email và mật khẩu', () => {
  it('mật khẩu quá ngắn trả khoá kèm tham số min', async () => {
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: `i18n-short-${Date.now()}@gigone.com`, password: 'ngan' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.messageKey).toBe('auth.password_too_short')
    expect(result.body.error.messageParams).toEqual({ min: 10 })
  })

  it('tên miền email bị từ chối trả khoá kèm danh sách miền', async () => {
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: `i18n-domain-${Date.now()}@example.com`, password: 'matkhau-rat-dai-123' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.messageKey).toBe('auth.email_domain_not_allowed')
    expect(String(result.body.error.messageParams.domains)).toContain('@gigone.com')
  })

  it('email sai định dạng trả khoá Zod tương ứng', async () => {
    const result = await call(ctx, '/api/auth/register', {
      method: 'POST',
      body: { email: 'khong-phai-email', password: 'matkhau-rat-dai-123' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.messageKey).toBe('validation.email_invalid')
    expect(result.body.error.message).toBe('Email không hợp lệ')
  })

  it('sai mật khẩu đăng nhập trả đúng khoá và giữ HTTP 401', async () => {
    const email = `i18n-login-${Date.now()}@gigone.com`
    await registerUser(ctx, email)
    const result = await call(ctx, '/api/auth/login', {
      method: 'POST',
      body: { email, password: 'sai-mat-khau-hoan-toan' },
    })
    expect(result.status).toBe(401)
    expect(result.body.error.messageKey).toBe('auth.invalid_credentials')
    expect(result.body.error.message).toBe('Email hoặc mật khẩu không đúng')
  })
})

describe('Kiểm tra dữ liệu đầu vào (Zod)', () => {
  it('thiếu tên provider trả khoá Zod của trường đó', async () => {
    await registerUser(ctx)
    const result = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: '', baseUrl: 'https://x.test', apiKey: 'k' },
    })
    expect(result.status).toBe(400)
    expect(result.body.error.messageKey).toBe('validation.display_name_required')
    expect(result.body.error.message).toBe('Vui lòng nhập tên hiển thị')
  })

  it('lỗi Zod mặc định dùng khoá chung kèm field/reason', async () => {
    await registerUser(ctx)
    const result = await call(ctx, '/api/models', { method: 'POST', body: { providerId: 123 } })
    expect(result.status).toBe(400)
    expect(result.body.error.messageKey).toBe('validation.invalid_payload')
    expect(result.body.error.messageParams.field).toBeDefined()
  })
})

describe('Metadata lỗi được lưu và trả lại', () => {
  it('migration thêm cột metadata nullable', () => {
    expect(columnNames('generations')).toContain('error_message_key')
    expect(columnNames('generations')).toContain('error_message_params')
    expect(columnNames('exports')).toContain('error_message_key')
    expect(columnNames('exports')).toContain('error_message_params')
    expect(columnNames('provider_connections')).toContain('last_error_key')
    expect(columnNames('provider_connections')).toContain('last_error_params')
    expect(columnNames('plan_image_batch_items')).toContain('error_message_key')
    expect(columnNames('plan_image_batch_items')).toContain('error_message_params')
  })

  it('tác vụ mất provider lưu khoá ngữ nghĩa và API trả lại', async () => {
    const { userId } = await registerUser(ctx)
    const id = randomUUID()
    const now = Date.now()
    // Hàng đang chờ với provider_id NULL: worker không dựng được context và phải
    // ghi lỗi kèm metadata ngữ nghĩa.
    ctx.db
      .prepare(
        `INSERT INTO generations
           (id, user_id, kind, prompt, params_json, snap_provider, snap_base_url, snap_model_id,
            status, attempt_count, created_at, updated_at)
         VALUES (?, ?, 'image', 'một bức ảnh', '{}', 'p', 'https://p.test', 'm', 'queued', 0, ?, ?)`,
      )
      .run(id, userId, now, now)

    await ctx.worker.tick()

    const result = await call(ctx, `/api/generations/${id}`)
    expect(result.status).toBe(200)
    expect(result.body.generation.errorCode).toBe('PROVIDER_MISSING')
    expect(result.body.generation.errorMessageKey).toBe('generations.provider_missing')
    expect(result.body.generation.errorMessageParams).toEqual({})
  })

  it('dữ liệu cũ không có khoá được suy từ error_code', async () => {
    const { userId } = await registerUser(ctx)
    const id = randomUUID()
    const now = Date.now()
    ctx.db
      .prepare(
        `INSERT INTO generations
           (id, user_id, kind, prompt, params_json, snap_provider, snap_base_url, snap_model_id,
            status, error_code, error_message, attempt_count, created_at, updated_at)
         VALUES (?, ?, 'image', 'x', '{}', 'p', 'https://p.test', 'm', 'failed', 'PROVIDER_FAILED',
                 'Provider báo tác vụ thất bại', 1, ?, ?)`,
      )
      .run(id, userId, now, now)

    const result = await call(ctx, `/api/generations/${id}`)
    expect(result.body.generation.errorMessageKey).toBe('generations.provider_failed')
    expect(result.body.generation.errorMessageParams).toEqual({})
  })

  it('bản xuất lưu và trả metadata, kể cả tham số JSON', async () => {
    const { userId } = await registerUser(ctx)
    const project = await call(ctx, '/api/projects', { method: 'POST', body: { name: 'Dự án i18n' } })
    const projectId = project.body.project.id
    const id = randomUUID()
    const now = Date.now()
    ctx.db
      .prepare(
        `INSERT INTO exports
           (id, user_id, project_id, status, spec_json, error_code, error_message,
            error_message_key, error_message_params, created_at, updated_at)
         VALUES (?, ?, ?, 'failed', '{"items":[]}', 'EXPORT_FAILED', 'ffmpeg lỗi',
                 'exports.failed', '{"detail":"ffmpeg lỗi"}', ?, ?)`,
      )
      .run(id, userId, projectId, now, now)

    const result = await call(ctx, `/api/exports/${id}`)
    expect(result.status).toBe(200)
    expect(result.body.export.errorMessageKey).toBe('exports.failed')
    expect(result.body.export.errorMessageParams).toEqual({ detail: 'ffmpeg lỗi' })
    expect(result.body.export.errorMessage).toBe('ffmpeg lỗi')
  })

  it('provider lưu last_error_key/params và dữ liệu cũ rơi về khoá bọc', async () => {
    await registerUser(ctx)
    const created = await call(ctx, '/api/providers', {
      method: 'POST',
      body: { name: 'Provider i18n', baseUrl: 'https://i18n.test/v1', apiKey: 'sk-i18n' },
    })
    const providerId = created.body.provider.id

    ctx.db
      .prepare(
        "UPDATE provider_connections SET status = 'error', last_error = 'timeout', last_error_key = 'providers.timeout', last_error_params = '{}' WHERE id = ?",
      )
      .run(providerId)
    let list = await call(ctx, '/api/providers')
    let row = list.body.providers.find((item: any) => item.id === providerId)
    expect(row.lastErrorKey).toBe('providers.timeout')

    // Dữ liệu cũ: có last_error nhưng chưa có khoá.
    ctx.db
      .prepare(
        "UPDATE provider_connections SET last_error = 'raw provider failure', last_error_key = NULL, last_error_params = NULL WHERE id = ?",
      )
      .run(providerId)
    list = await call(ctx, '/api/providers')
    row = list.body.providers.find((item: any) => item.id === providerId)
    expect(row.lastErrorKey).toBe('providers.test_failed')
    expect(row.lastErrorParams).toEqual({ detail: 'raw provider failure' })
    expect(row.lastError).toBe('raw provider failure')
  })
})

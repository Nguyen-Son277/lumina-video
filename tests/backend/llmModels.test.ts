import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase } from '../../server/db/index'
import { call, registerUser, startTestServer, type TestContext } from './helpers'

let ctx: TestContext
beforeAll(async () => { ctx = await startTestServer() })
afterAll(async () => { if (ctx) await ctx.close() })

/**
 * Tạo provider + model với phân loại cho trước. LLM dùng chung provider với
 * ảnh/video nên chỉ cần một provider là đủ cho cả hai loại.
 */
async function seedModelRow(
  target: TestContext,
  options: { modelId?: string; kind?: string; enabled?: boolean; apiKey?: string } = {},
): Promise<{ providerId: string; modelPk: string }> {
  const provider = await call(target, '/api/providers', {
    method: 'POST',
    body: {
      name: 'Provider test',
      baseUrl: 'https://llm.mock.test/v1',
      apiKey: options.apiKey ?? 'sk-llm-abcd1234',
    },
  })
  expect(provider.status).toBe(201)

  const model = await call(target, '/api/models', {
    method: 'POST',
    body: {
      providerId: provider.body.provider.id,
      modelId: options.modelId ?? 'mock-chat-model',
      kind: options.kind ?? 'llm',
    },
  })
  expect(model.status).toBe(201)

  if (options.enabled === false) {
    const patched = await call(target, `/api/models/${model.body.model.id}`, {
      method: 'PATCH',
      body: { enabled: false },
    })
    expect(patched.status).toBe(200)
  }

  return {
    providerId: provider.body.provider.id as string,
    modelPk: model.body.model.id as string,
  }
}

describe('LLM & Chat là một phân loại trong Model catalog', () => {
  it('phân loại model thành llm rồi dùng cho AI tạo nhân vật', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedModelRow(ctx)

    // Lọc theo kind mới trả đúng model LLM và không lẫn với ảnh/video.
    const llmList = await call(ctx, '/api/models?kind=llm')
    expect(llmList.status).toBe(200)
    expect(llmList.body.models).toHaveLength(1)
    expect(llmList.body.models[0].kind).toBe('llm')
    expect((await call(ctx, '/api/models?kind=image')).body.models).toHaveLength(0)

    const generated = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một phi hành gia trẻ', count: 1 },
    })
    expect(generated.status).toBe(200)
    expect(generated.body.candidates).toHaveLength(1)
    // Trả về id dòng model (để phiên chat ghi nhớ) và model ID gửi provider.
    expect(generated.body.modelId).toBe(modelPk)
    expect(generated.body.model).toBe('mock-chat-model')
  })

  it('không trả API key qua danh sách model và provider', async () => {
    await registerUser(ctx)
    await seedModelRow(ctx, { apiKey: 'sk-llm-secret-9999' })

    const models = await call(ctx, '/api/models')
    const providers = await call(ctx, '/api/providers')
    expect(JSON.stringify(models.body)).not.toContain('sk-llm-secret-9999')
    expect(JSON.stringify(providers.body)).not.toContain('sk-llm-secret-9999')
    // Chỉ hiển thị 4 ký tự cuối, có che phần đầu.
    expect(providers.body.providers[0].keyHint).toBe('••••9999')
  })

  it('không còn API kết nối LLM riêng', async () => {
    await registerUser(ctx)
    expect((await call(ctx, '/api/llm')).status).toBe(404)
    expect(
      (await call(ctx, '/api/llm', {
        method: 'POST',
        body: { baseUrl: 'https://llm.mock.test/v1', apiKey: 'sk-llm-abcd1234' },
      })).status,
    ).toBe(404)
    expect((await call(ctx, '/api/llm/models', { method: 'POST', body: {} })).status).toBe(404)
  })

  it('phiên Tạo kịch bản AI gắn model chat đã chọn và tự chốt model khi bỏ trống', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedModelRow(ctx)

    const explicit = await call(ctx, '/api/plans', {
      method: 'POST',
      body: { kind: 'planner', chatModelId: modelPk },
    })
    expect(explicit.status).toBe(201)
    expect(explicit.body.session.chatModelId).toBe(modelPk)

    // Không truyền model: phiên bắt đầu ở bước chọn model, backend tự chọn model
    // LLM đang bật đầu tiên khi thao tác đầu tiên chạy và ghi lại vào phiên.
    const auto = await call(ctx, '/api/plans', { method: 'POST', body: { kind: 'planner' } })
    expect(auto.status).toBe(201)
    expect(auto.body.session.chatModelId).toBeNull()
    expect(auto.body.session.status).toBe('setup')

    const sessionId = auto.body.session.id as string
    const replied = await call(ctx, `/api/plans/${sessionId}/script`, { method: 'POST' })
    expect(replied.status).toBe(200)

    const fetched = await call(ctx, `/api/plans/${sessionId}`)
    expect(fetched.body.session.chatModelId).toBe(modelPk)
  })

  it('báo lỗi rõ ràng khi chưa có model LLM & Chat', async () => {
    await registerUser(ctx)
    // Có provider và model ảnh, nhưng chưa phân loại model nào thành LLM & Chat.
    await seedModelRow(ctx, { modelId: 'mock-image-model', kind: 'image' })

    const generated = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật' },
    })
    expect(generated.status).toBe(400)
    expect(generated.body.error.message).toContain('Chưa có model LLM & Chat')
  })

  it('chặn model của tài khoản khác', async () => {
    await registerUser(ctx)
    const { modelPk } = await seedModelRow(ctx)

    await registerUser(ctx)
    expect(
      (
        await call(ctx, '/api/shared-characters/generate', {
          method: 'POST',
          body: { description: 'một nhân vật', modelId: modelPk },
        })
      ).status,
    ).toBe(404)
    expect(
      (await call(ctx, '/api/plans', {
        method: 'POST',
        body: { kind: 'planner', chatModelId: modelPk },
      })).status,
    ).toBe(404)
  })

  it('chặn model bị tắt và model không phải LLM & Chat', async () => {
    await registerUser(ctx)
    const image = await seedModelRow(ctx, { modelId: 'mock-image-model', kind: 'image' })
    const disabled = await seedModelRow(ctx, { enabled: false })

    const wrongKind = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật', modelId: image.modelPk },
    })
    expect(wrongKind.status).toBe(400)
    expect(wrongKind.body.error.message).toContain('chưa được phân loại')

    const turnedOff = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật', modelId: disabled.modelPk },
    })
    expect(turnedOff.status).toBe(400)
    expect(turnedOff.body.error.message).toContain('đang bị tắt')

    // Tự chọn model cũng bỏ qua model đã tắt.
    const implicit = await call(ctx, '/api/shared-characters/generate', {
      method: 'POST',
      body: { description: 'một nhân vật' },
    })
    expect(implicit.status).toBe(400)
    expect(implicit.body.error.message).toContain('Chưa có model LLM & Chat')
  })
})

describe('Migration: kết nối LLM cũ chuyển thành provider + model LLM & Chat', () => {
  it('giữ nguyên key, model và liên kết phiên; không làm mất model_pk của tác vụ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumina-llm-migration-'))
    const path = join(dir, 'app.db')

    try {
      const before = [
        '001_init.sql',
        '002_projects.sql',
        '003_character_reference.sql',
        '004_source_images.sql',
        '005_image_api_style.sql',
        '006_generation_character_reference.sql',
        '007_llm_connections.sql',
        '008_shared_characters.sql',
        '009_planner.sql',
        '010_export_error_code.sql',
      ]
      const old = new DatabaseSync(path)
      for (const file of before) {
        old.exec(readFileSync(join('server/db/migrations', file), 'utf8'))
      }
      old.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
      for (const file of before) {
        old.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)').run(file, 1)
      }

      const now = Date.now()
      old
        .prepare('INSERT INTO users VALUES (?,?,?,?,?)')
        .run('u1', 'llm-migration@gigone.com', 'hash', 'salt', now)
      old
        .prepare(
          `INSERT INTO provider_connections
             (id,user_id,name,base_url,api_key_ciphertext,api_key_iv,api_key_tag,key_hint,status,last_error,created_at,updated_at,image_api_style)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('pc1', 'u1', 'Provider ảnh', 'https://img.test/v1', new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), 'abcd', 'connected', null, now, now, 'openai')
      old
        .prepare(
          'INSERT INTO models (id,user_id,provider_id,model_id,display_name,kind,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run('m1', 'u1', 'pc1', 'img-model', 'Img', 'image', 1, now, now)
      old
        .prepare(
          `INSERT INTO generations
             (id,user_id,model_pk,provider_id,kind,prompt,params_json,snap_provider,snap_base_url,snap_model_id,status,attempt_count,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('g1', 'u1', 'm1', 'pc1', 'image', 'x', '{}', 'Provider ảnh', 'https://img.test/v1', 'img-model', 'succeeded', 1, now, now)
      // Kết nối LLM cũ: key đã mã hoá (giá trị giả, test chỉ kiểm tra việc copy).
      old
        .prepare(
          `INSERT INTO llm_connections
             (id,user_id,name,base_url,model_id,api_key_ciphertext,api_key_iv,api_key_tag,key_hint,status,last_error,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run('lc1', 'u1', 'Chat cũ', 'https://llm.test/v1', 'gpt-4o-mini', new Uint8Array([9]), new Uint8Array([8]), new Uint8Array([7]), '1234', 'connected', null, now, now)
      old
        .prepare(
          'INSERT INTO plan_sessions (id,user_id,kind,llm_connection_id,project_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run('ps1', 'u1', 'planner', 'lc1', null, 'Phiên cũ', 'chatting', now, now)
      old.close()

      const migrated = openDatabase(path)

      // models.kind nhận 'llm'.
      const modelsSql = (
        migrated
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='models'")
          .get() as { sql: string }
      ).sql
      expect(modelsSql).toContain("'llm'")

      // model_pk của tác vụ cũ KHÔNG bị NULL hoá khi dựng lại bảng models.
      const generation = migrated
        .prepare('SELECT model_pk FROM generations WHERE id = ?')
        .get('g1') as { model_pk: string | null }
      expect(generation.model_pk).toBe('m1')

      // Kết nối LLM cũ thành provider giữ nguyên URL, key hint và trạng thái.
      const provider = migrated
        .prepare('SELECT id, name, base_url, key_hint, status FROM provider_connections WHERE base_url = ?')
        .get('https://llm.test/v1') as {
        id: string
        name: string
        key_hint: string
        status: string
      }
      expect(provider.name).toBe('Chat cũ')
      expect(provider.key_hint).toBe('1234')
      expect(provider.status).toBe('connected')

      // Model chat được tạo với kind='llm' và trỏ đúng provider vừa chuyển.
      const model = migrated
        .prepare("SELECT id, provider_id, model_id FROM models WHERE kind = 'llm'")
        .get() as { id: string; provider_id: string; model_id: string }
      expect(model.provider_id).toBe(provider.id)
      expect(model.model_id).toBe('gpt-4o-mini')

      // Phiên planner cũ trỏ sang model mới; cột cũ giữ lại để rollback.
      const session = migrated
        .prepare('SELECT llm_connection_id, chat_model_id, status FROM plan_sessions WHERE id = ?')
        .get('ps1') as {
        llm_connection_id: string | null
        chat_model_id: string | null
        status: string
      }
      // 012 đổi tên llm_model_id -> chat_model_id và map lại trạng thái.
      expect(session.llm_connection_id).toBe('lc1')
      expect(session.chat_model_id).toBe(model.id)
      expect(session.status).toBe('scripting')

      // Bảng legacy vẫn còn và dữ liệu nhất quán.
      expect(
        migrated.prepare('SELECT COUNT(*) AS count FROM llm_connections').get()!.count,
      ).toBe(1)
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)

      migrated.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

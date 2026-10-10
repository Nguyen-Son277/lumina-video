import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerUser,
  seedProviderAndModel,
  startTestServer,
  waitForGeneration,
  type TestContext,
} from './helpers'

/**
 * ffmpeg giả: ghi vài byte vào tham số cuối (đường dẫn kết quả) rồi thoát.
 * Nhờ vậy test kiểm tra được toàn bộ luồng xuất mà không cần ffmpeg thật.
 */
const FAKE_FFMPEG = `#!/bin/sh
for last in "$@"; do :; done
printf 'FAKE_MP4_CONTENT' > "$last"
exit 0
`

/**
 * ffprobe giả: trả kích thước cho luồng video, không có luồng âm thanh.
 * Hợp đồng: tham số chứa "a" (select_streams a) thì không in gì.
 */
const FAKE_FFPROBE = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "a" ]; then exit 0; fi
done
printf '1280,720\\n'
exit 0
`

let toolDir = ''
let ctx: TestContext
let stubbed: TestContext

beforeAll(async () => {
  // Không có ffmpeg: dùng để kiểm tra thông báo hướng dẫn cài đặt.
  ctx = await startTestServer({ ffmpegPath: join(tmpdir(), `lumina-missing-ffmpeg-${process.pid}`) })

  toolDir = mkdtempSync(join(tmpdir(), 'lumina-ffmpeg-'))
  const ffmpegPath = join(toolDir, 'ffmpeg')
  const ffprobePath = join(toolDir, 'ffprobe')
  writeFileSync(ffmpegPath, FAKE_FFMPEG)
  writeFileSync(ffprobePath, FAKE_FFPROBE)
  chmodSync(ffmpegPath, 0o755)
  chmodSync(ffprobePath, 0o755)

  stubbed = await startTestServer({ ffmpegPath })
})

afterAll(async () => {
  if (ctx) await ctx.close()
  if (stubbed) await stubbed.close()
  if (toolDir) rmSync(toolDir, { recursive: true, force: true })
})

type SceneVideo = { projectId: string; sceneId: string; generationId: string }

/**
 * Chờ tới khi bản xuất kết thúc.
 *
 * Không thể chỉ gọi `tick()` một lần: route tạo bản xuất có gọi `worker.wake()`,
 * nên một vòng tick có thể đang chạy và lần gọi tick của test sẽ trả về ngay.
 */
async function waitForExport(target: TestContext, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    await target.worker.tick()
    const result = await call(target, `/api/exports/${id}`)
    const status = (result.body?.export as { status?: string } | undefined)?.status
    if (status === 'succeeded' || status === 'failed') {
      return result.body.export as Record<string, unknown>
    }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }

  throw new Error(`Bản xuất ${id} không kết thúc trong thời gian cho phép`)
}

/** Tạo một cảnh có video đã tạo thành công (chạy worker bằng tick). */
async function sceneWithVideo(target: TestContext, label: string): Promise<SceneVideo> {
  const { modelPk } = await seedProviderAndModel(target, 'video')
  const project = (
    await call(target, '/api/projects', { method: 'POST', body: { name: `Dự án ${label}` } })
  ).body.project as { id: string }

  const scene = (
    await call(target, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: `Cảnh ${label}`, prompt: 'Nội dung cảnh', modelId: modelPk },
    })
  ).body.scene as { id: string }

  const enqueued = await call(target, `/api/scenes/${scene.id}/generate`, {
    method: 'POST',
    body: { idempotencyKey: `export-${label}-${Date.now()}` },
  })
  expect(enqueued.status).toBe(202)

  const done = await waitForGeneration(target, enqueued.body.generation.id)
  expect(done.status).toBe('succeeded')

  return { projectId: project.id, sceneId: scene.id, generationId: done.id }
}

/** Tạo hai cảnh có video trong cùng một dự án. */
async function projectWithTwoScenes(target: TestContext) {
  const { modelPk } = await seedProviderAndModel(target, 'video')
  const project = (
    await call(target, '/api/projects', { method: 'POST', body: { name: 'Dự án xuất' } })
  ).body.project as { id: string }

  const generationIds: string[] = []
  for (const index of [1, 2]) {
    const scene = (
      await call(target, `/api/projects/${project.id}/scenes`, {
        method: 'POST',
        body: { title: `Cảnh ${index}`, prompt: 'Nội dung', modelId: modelPk },
      })
    ).body.scene as { id: string }

    const enqueued = await call(target, `/api/scenes/${scene.id}/generate`, {
      method: 'POST',
      body: { idempotencyKey: `export-${index}-${Date.now()}-${Math.random()}` },
    })
    const done = await waitForGeneration(target, enqueued.body.generation.id)
    expect(done.status).toBe('succeeded')
    generationIds.push(done.id as string)
  }

  return { projectId: project.id, modelPk, generationIds }
}

describe('Xuất video hoàn chỉnh', () => {
  it('báo lỗi rõ ràng khi máy chủ chưa có ffmpeg', async () => {
    await registerUser(ctx)
    const { projectId } = await projectWithTwoScenes(ctx)

    const created = await call(ctx, `/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: {},
    })
    expect(created.status).toBe(202)

    await waitForExport(ctx, created.body.export.id)

    const fetched = await call(ctx, `/api/exports/${created.body.export.id}`)
    expect(fetched.body.export.status).toBe('failed')
    expect(fetched.body.export.errorCode).toBe('FFMPEG_MISSING')
    expect(fetched.body.export.errorMessage).toContain('ffmpeg')
    expect(fetched.body.export.url).toBeNull()
  })

  it('ghép các cảnh thành một tệp tải được', async () => {
    await registerUser(stubbed)
    const { projectId, generationIds } = await projectWithTwoScenes(stubbed)

    const created = await call(stubbed, `/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: {},
    })
    expect(created.status).toBe(202)
    expect(created.body.export.itemCount).toBe(2)

    const finished = await waitForExport(stubbed, created.body.export.id)

    const fetched = await call(stubbed, `/api/exports/${created.body.export.id}`)
    expect(fetched.body.export.status).toBe('succeeded')
    expect(finished.status).toBe('succeeded')
    expect(fetched.body.export.byteSize).toBeGreaterThan(0)
    expect(fetched.body.export.url).toBe(`/api/exports/${created.body.export.id}/file`)

    // Tệp tải được và đúng nội dung ffmpeg (giả) ghi ra.
    const file = await fetch(`${stubbed.baseUrl}${fetched.body.export.url}?download=1`, {
      headers: { Cookie: stubbed.cookie },
    })
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toContain('video/mp4')
    expect(await file.text()).toBe('FAKE_MP4_CONTENT')

    // Danh sách theo dự án thấy bản xuất này.
    const listed = await call(stubbed, `/api/projects/${projectId}/exports`)
    expect(listed.body.exports).toHaveLength(1)

    // Thứ tự cảnh trong spec khớp thứ tự timeline đã tạo.
    const spec = JSON.parse(
      (
        stubbed.db.prepare('SELECT spec_json FROM exports WHERE id = ?').get(
          created.body.export.id,
        ) as { spec_json: string }
      ).spec_json,
    ) as { items: Array<{ generationId: string }> }
    expect(spec.items.map((item) => item.generationId)).toEqual(generationIds)
  })

  it('từ chối khi cảnh chưa có video thành công', async () => {
    await registerUser(stubbed)
    const { modelPk } = await seedProviderAndModel(stubbed, 'video')
    const project = (
      await call(stubbed, '/api/projects', { method: 'POST', body: { name: 'Thiếu video' } })
    ).body.project as { id: string }

    await call(stubbed, `/api/projects/${project.id}/scenes`, {
      method: 'POST',
      body: { title: 'Cảnh trống', prompt: 'Nội dung', modelId: modelPk },
    })

    const created = await call(stubbed, `/api/projects/${project.id}/exports`, {
      method: 'POST',
      body: {},
    })
    expect(created.status).toBe(400)
    expect(created.body.error.message).toContain('chưa có video thành công')
  })

  it('xuất theo danh sách cảnh chỉ định và kiểm tra quyền sở hữu', async () => {
    await registerUser(stubbed)
    const first = await sceneWithVideo(stubbed, 'A')

    // Cảnh không thuộc dự án thì bị từ chối.
    const foreign = await call(stubbed, `/api/projects/${first.projectId}/exports`, {
      method: 'POST',
      body: { items: [{ sceneId: 'khong-ton-tai', generationId: first.generationId }] },
    })
    expect(foreign.status).toBe(400)

    const ok = await call(stubbed, `/api/projects/${first.projectId}/exports`, {
      method: 'POST',
      body: { items: [{ sceneId: first.sceneId, generationId: first.generationId }] },
    })
    expect(ok.status).toBe(202)

    // Tài khoản khác không xem và không tải được bản xuất này.
    await registerUser(stubbed)
    expect((await call(stubbed, `/api/exports/${ok.body.export.id}`)).status).toBe(404)
    const stolen = await fetch(`${stubbed.baseUrl}/api/exports/${ok.body.export.id}/file`, {
      headers: { Cookie: stubbed.cookie },
    })
    expect(stolen.status).toBe(404)
  })

  it('giới hạn một bản xuất chạy đồng thời', async () => {
    await registerUser(stubbed)
    const { projectId } = await projectWithTwoScenes(stubbed)

    const first = await call(stubbed, `/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: {},
    })
    expect(first.status).toBe(202)

    // Chưa chạy worker nên bản thứ nhất vẫn đang chờ.
    const second = await call(stubbed, `/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: {},
    })
    expect(second.status).toBe(400)
    expect(second.body.error.message).toContain('Đang có bản xuất')
  })

  it('không xóa được bản xuất đang chạy, xóa được bản đã xong', async () => {
    await registerUser(stubbed)
    const { projectId } = await projectWithTwoScenes(stubbed)

    const created = await call(stubbed, `/api/projects/${projectId}/exports`, {
      method: 'POST',
      body: {},
    })

    // Đang chờ nên chưa xoá được.
    expect(
      (await call(stubbed, `/api/exports/${created.body.export.id}`, { method: 'DELETE' })).status,
    ).toBe(400)

    await waitForExport(stubbed, created.body.export.id)

    expect(
      (await call(stubbed, `/api/exports/${created.body.export.id}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect((await call(stubbed, `/api/exports/${created.body.export.id}`)).status).toBe(404)
  })
})

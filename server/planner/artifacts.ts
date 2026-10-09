import { randomUUID } from 'node:crypto'
import type { Voice } from '../projects/schemas'
import type { VideoPlan } from './prompts'

/**
 * Ba artifact của một phiên Tạo kịch bản AI:
 *   - `ScriptDraft`   — tab Chat: bản kịch bản nháp (text + danh sách cảnh có cấu trúc)
 *   - `CastMember[]`  — tab Nhân vật: ý tưởng nhân vật, ảnh chân dung, nơi lưu
 *   - `Timeline`      — tab Timeline: từng frame với thời gian, bối cảnh, ảnh nền, nhân vật
 *
 * Dữ liệu do AI sinh luôn đi qua `normalizePlan` trước, nên ở đây chỉ cần chuyển
 * sang hình dạng ổn định cho giao diện và chịu được dữ liệu cũ (phiên tạo trước
 * migration 012 chỉ có `ideas_json`/`plan_json`).
 */

export type DraftScene = {
  id: string
  title: string
  /** Text bối cảnh của cảnh (cột `background` của model). */
  context: string
  action: string
  dialogue: string
  /** Tên nhân vật nói chính; rỗng khi cảnh không có lời thoại. */
  speaker: string
  /** Tên các nhân vật xuất hiện trong cảnh. */
  characters: string[]
  durationSeconds: number
  shotNotes: string
}

export type ScriptDraft = {
  /** Bản kịch bản dạng văn bản để người dùng sửa trực tiếp. */
  text: string
  scenes: DraftScene[]
}

export type CastMember = {
  id: string
  name: string
  appearance: string
  role: string
  voice: Voice
  /** Trỏ tới nhân vật đã có trong thư viện để dùng lại thay vì tạo bản sao. */
  reuseCharacterId: string | null
  /** Người dùng chọn cho từng nhân vật khi chốt vào Studio. */
  storage: 'library' | 'project'
  /** Ảnh chân dung đã gắn (id trong bảng uploads). */
  portrait: { uploadId: string } | null
}

/** Vị trí tương đối của một nhân vật trong khung hình. */
export type FramePosition = 'left' | 'center' | 'right' | 'background'

/** Một nhân vật trong frame: ai, hành động riêng của người đó, đứng ở đâu. */
export type FrameBlocking = {
  castId: string
  action: string
  position: FramePosition
}

export type TimelineFrame = DraftScene & {
  /** Mô tả dùng để sinh ảnh storyboard cho frame. */
  backgroundPrompt: string
  background: { uploadId: string } | null
  /**
   * Danh sách nhân vật có mặt kèm hành động riêng và vị trí tương đối.
   * Đây là nguồn sự thật cho số người trong frame; `characters` được đồng bộ từ đây.
   */
  blocking: FrameBlocking[]
}

export type Timeline = { frames: TimelineFrame[] }

export const newArtifactId = (): string => randomUUID()

const POSITION_ORDER: FramePosition[] = ['left', 'center', 'right']

/**
 * Gợi ý vị trí theo số người trong frame: một người ở giữa, hai người trái/phải,
 * ba người trái/giữa/phải, người thứ tư trở đi đứng ở nền. Đây là gợi ý để người
 * dùng sửa, không phải toạ độ chính xác trên ảnh.
 */
export function suggestPosition(index: number, total: number): FramePosition {
  if (total <= 1) return 'center'
  if (total === 2) return index === 0 ? 'left' : 'right'
  return POSITION_ORDER[index] ?? 'background'
}

const isPosition = (value: unknown): value is FramePosition =>
  value === 'left' || value === 'center' || value === 'right' || value === 'background'

/** Mục blocking thô: giao diện gửi `castId`, AI trả tên nhân vật. */
type RawBlocking = {
  castId?: unknown
  name?: unknown
  character?: unknown
  action?: unknown
  position?: unknown
}

/**
 * Chuẩn hoá nhân vật trong một frame theo cast của phiên.
 *
 * Nhận cả `castId` (giao diện gửi id) lẫn tên nhân vật (AI trả tên) nên chỉ có một
 * đường mã. Tên/id lạ bị bỏ, mỗi nhân vật chỉ xuất hiện một lần, `characters` được
 * đồng bộ lại từ blocking để số người và dữ liệu Studio luôn khớp. Phiên chưa có
 * cast thì giữ nguyên tên để không mất dữ liệu người dùng đã nhập.
 */
export function normalizeBlocking(
  frame: { blocking?: unknown; characters?: unknown; speaker?: unknown },
  cast: CastMember[],
): { blocking: FrameBlocking[]; characters: string[]; speaker: string } {
  const byId = new Map(cast.map((member) => [member.id.trim().toLowerCase(), member]))
  const byName = new Map(cast.map((member) => [member.name.trim().toLowerCase(), member]))

  const rawList: RawBlocking[] = Array.isArray(frame.blocking) ? (frame.blocking as RawBlocking[]) : []
  const source: Array<{ id: string; name: string; action: string; position: FramePosition | null }> = []
  const seen = new Set<string>()

  for (const raw of rawList) {
    const key = [raw.castId, raw.name, raw.character].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (!key) continue
    const member = byId.get(key.trim().toLowerCase()) ?? byName.get(key.trim().toLowerCase())
    if (!member || seen.has(member.id)) continue
    seen.add(member.id)
    source.push({
      id: member.id,
      name: member.name,
      action: typeof raw.action === 'string' ? raw.action.trim().slice(0, 2000) : '',
      position: isPosition(raw.position) ? raw.position : null,
    })
  }

  // Không có blocking (dữ liệu cũ hoặc model bỏ qua hợp đồng): suy ra từ tên nhân vật.
  // Hành động riêng để trống vì đó là thông tin chưa biết, không được đoán.
  if (!source.length) {
    const names = (Array.isArray(frame.characters) ? frame.characters : []).filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    const total = names.length
    names.forEach((rawName, index) => {
      const name = rawName.trim()
      const member = byName.get(name.toLowerCase()) ?? byId.get(name.toLowerCase())
      // Phiên chưa có cast: giữ tên đã nhập với id tạm chính là tên.
      if (!member && cast.length) return
      const id = member?.id ?? name
      if (seen.has(id)) return
      seen.add(id)
      source.push({ id, name: member?.name ?? name, action: '', position: suggestPosition(index, total) })
    })
  }

  const blocking: FrameBlocking[] = source.map((entry, index) => ({
    castId: entry.id,
    action: entry.action,
    position: entry.position ?? suggestPosition(index, source.length),
  }))
  const characters = source.map((entry) => entry.name)
  const requested = typeof frame.speaker === 'string' ? frame.speaker.trim().toLowerCase() : ''
  const speaker = characters.find((name) => name.toLowerCase() === requested) ?? characters[0] ?? ''

  return { blocking, characters, speaker }
}

/** Chuẩn hoá blocking cho cả timeline (idempotent, dùng được cho dữ liệu cũ). */
export function normalizeTimelineBlocking(timeline: Timeline, cast: CastMember[]): Timeline {
  return {
    frames: timeline.frames.map((frame) => {
      const { blocking, characters, speaker } = normalizeBlocking(frame, cast)
      return { ...frame, blocking, characters, speaker }
    }),
  }
}

/** Một cảnh của kế hoạch (kết quả normalizePlan) → cảnh của kịch bản. */
export function sceneFromPlan(scene: VideoPlan['scenes'][number]): DraftScene {
  return {
    id: newArtifactId(),
    title: scene.title,
    context: scene.background,
    action: scene.action,
    dialogue: scene.dialogue,
    speaker: scene.speaker,
    characters: [...scene.characters],
    durationSeconds: scene.durationSeconds,
    shotNotes: scene.shotNotes,
  }
}

/** Bản kịch bản dạng text suy ra từ các cảnh, dùng khi AI không trả về `script`. */
export function scriptTextFromScenes(title: string, scenes: DraftScene[]): string {
  const lines: string[] = []
  if (title.trim()) lines.push(title.trim(), '')
  scenes.forEach((scene, index) => {
    lines.push(`CẢNH ${index + 1}: ${scene.title} (${scene.durationSeconds}s)`)
    if (scene.context) lines.push(`Bối cảnh: ${scene.context}`)
    if (scene.action) lines.push(`Hành động: ${scene.action}`)
    if (scene.characters.length) lines.push(`Nhân vật: ${scene.characters.join(', ')}`)
    if (scene.dialogue) lines.push(`${scene.speaker || 'Lời thoại'}: "${scene.dialogue}"`)
    if (scene.shotNotes) lines.push(`Góc máy: ${scene.shotNotes}`)
    lines.push('')
  })
  return lines.join('\n').trim()
}

export function scriptFromPlan(plan: VideoPlan, text?: string): ScriptDraft {
  const scenes = plan.scenes.map(sceneFromPlan)
  return { text: text?.trim() || scriptTextFromScenes(plan.title, scenes), scenes }
}

/** Nhân vật AI đề xuất → ý tưởng nhân vật của phiên (mặc định lưu vào thư viện). */
export function castFromPlan(plan: VideoPlan, previous: CastMember[] = []): CastMember[] {
  const byName = new Map(previous.map((member) => [member.name.trim().toLowerCase(), member]))
  return plan.characters.map((character) => {
    const existing = byName.get(character.name.trim().toLowerCase())
    return {
      id: existing?.id ?? newArtifactId(),
      name: character.name,
      appearance: character.appearance,
      role: character.role,
      voice: character.voice,
      reuseCharacterId: character.reuseCharacterId,
      // Người dùng đã chọn nơi lưu thì giữ nguyên lựa chọn đó.
      storage: existing?.storage ?? 'library',
      portrait: existing?.portrait ?? null,
    }
  })
}

export function timelineFromPlan(plan: VideoPlan, previous: Timeline | null = null): Timeline {
  const byTitle = new Map(
    (previous?.frames ?? []).map((frame) => [frame.title.trim().toLowerCase(), frame]),
  )
  return {
    frames: plan.scenes.map((scene) => {
      const existing = byTitle.get(scene.title.trim().toLowerCase())
      const draft = sceneFromPlan(scene)
      // `characters` được suy từ blocking theo đúng thứ tự, nên ghép theo chỉ số là đủ
      // để giữ hành động/vị trí người dùng đã sửa cho nhân vật trùng tên.
      const reusable = new Map(
        (existing?.blocking ?? []).map((entry, index) => [
          (existing?.characters[index] ?? '').trim().toLowerCase(),
          entry,
        ]),
      )
      // Blocking do AI trả cho frame này là ưu tiên; nếu model không trả thì giữ
      // hành động/vị trí người dùng đã sửa cho nhân vật trùng tên.
      const fromAi = scene.blocking ?? []
      const blocking: FrameBlocking[] = draft.characters.map((name, index) => {
        const generated = fromAi.find((entry) => entry.name.trim().toLowerCase() === name.trim().toLowerCase())
        if (generated) {
          return {
            castId: name,
            action: generated.action,
            position: generated.position || suggestPosition(index, fromAi.length),
          }
        }
        const kept = reusable.get(name.trim().toLowerCase())
        return {
          castId: kept?.castId ?? name,
          action: kept?.action ?? '',
          position: kept?.position ?? suggestPosition(index, draft.characters.length),
        }
      })
      return {
        ...draft,
        // Giữ ảnh storyboard đã gắn khi frame trùng tiêu đề (sinh lại timeline không mất ảnh).
        id: existing?.id ?? newArtifactId(),
        backgroundPrompt: scene.background,
        background: existing?.background ?? null,
        blocking,
      }
    }),
  }
}

export function parseScript(json: string | null): ScriptDraft | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<ScriptDraft>
    if (typeof parsed.text !== 'string' || !Array.isArray(parsed.scenes)) return null
    return { text: parsed.text, scenes: parsed.scenes as DraftScene[] }
  } catch {
    return null
  }
}

export function parseCast(json: string | null): CastMember[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as unknown
    return Array.isArray(parsed) ? (parsed as CastMember[]) : []
  } catch {
    return []
  }
}

export function parseTimeline(json: string | null): Timeline | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json) as Partial<Timeline>
    if (!Array.isArray(parsed.frames)) return null
    return {
      frames: (parsed.frames as TimelineFrame[]).map((frame) => ({
        ...frame,
        blocking: Array.isArray(frame.blocking) ? frame.blocking : [],
      })),
    }
  } catch {
    return null
  }
}

/**
 * Dữ liệu legacy: phiên tạo trước migration 012 chỉ có `plan_json`/`ideas_json`.
 * Suy ra artifact để phiên cũ mở được ngay, không cần backfill phức tạp trong SQL.
 */
type LegacyRow = { plan_json: string | null; ideas_json: string | null }

function legacyPlan(row: LegacyRow): VideoPlan | null {
  if (!row.plan_json) return null
  try {
    return JSON.parse(row.plan_json) as VideoPlan
  } catch {
    return null
  }
}

export function legacyScript(row: LegacyRow): ScriptDraft | null {
  const plan = legacyPlan(row)
  if (plan) return scriptFromPlan(plan)
  if (!row.ideas_json) return null
  try {
    const ideas = JSON.parse(row.ideas_json) as {
      logline?: string
      keyPoints?: string[]
      characters?: string[]
    }
    const lines = [ideas.logline ?? '', ...(ideas.keyPoints ?? []).map((point) => `- ${point}`)]
    return { text: lines.filter(Boolean).join('\n'), scenes: [] }
  } catch {
    return null
  }
}

export function legacyCast(row: LegacyRow): CastMember[] {
  const plan = legacyPlan(row)
  return plan ? castFromPlan(plan) : []
}

export function legacyTimeline(row: LegacyRow): Timeline | null {
  const plan = legacyPlan(row)
  return plan ? timelineFromPlan(plan) : null
}

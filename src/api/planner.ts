import { api } from './client'

export type PlanKind = 'planner' | 'copilot'
export type PlanStatus =
  | 'setup'
  | 'scripting'
  | 'script_ready'
  | 'cast_ready'
  | 'timeline_ready'
  | 'applied'

export type Voice = {
  language?: string
  accent?: string
  pitch?: string
  timbre?: string
  pace?: string
  articulation?: string
  habits?: string
}

/** Tab AI đang hỗ trợ sửa. */
export type PlanTarget = 'script' | 'cast' | 'timeline'

/** Một cảnh trong kịch bản nháp / một frame của timeline. */
export type DraftScene = {
  id: string
  title: string
  /** Text bối cảnh. */
  context: string
  action: string
  dialogue: string
  speaker: string
  characters: string[]
  durationSeconds: number
  shotNotes: string
}

export type ScriptDraft = {
  text: string
  scenes: DraftScene[]
}

export type CastMember = {
  id: string
  name: string
  appearance: string
  role: string
  voice: Voice
  reuseCharacterId: string | null
  /** Người dùng chọn nơi lưu khi chốt vào Studio. */
  storage: 'library' | 'project'
  portrait: { uploadId: string } | null
}

/** Vị trí tương đối của nhân vật trong khung hình. */
export type FramePosition = 'left' | 'center' | 'right' | 'background'

/** Một nhân vật trong frame: ai, hành động riêng, đứng ở đâu. */
export type FrameBlocking = {
  castId: string
  action: string
  position: FramePosition
}

export type TimelineFrame = DraftScene & {
  /** Mô tả dùng để sinh ảnh storyboard cho frame. */
  backgroundPrompt: string
  background: { uploadId: string } | null
  /** Nguồn sự thật cho số người trong frame; `characters` được đồng bộ từ đây. */
  blocking: FrameBlocking[]
}

export type Timeline = { frames: TimelineFrame[] }

export type PlanSession = {
  id: string
  kind: PlanKind
  chatModelId: string | null
  imageModelId: string | null
  videoModelId: string | null
  projectId: string | null
  title: string
  status: PlanStatus
  script: ScriptDraft | null
  cast: CastMember[]
  timeline: Timeline | null
  messageCount: number
  createdAt: number
  updatedAt: number
}

export type PlanMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export type ApplyInput = {
  newProjectName?: string
  modelId?: string
  sceneModelIds?: Record<string, string>
  autoGenerate?: boolean
}

export type ApplyResult = {
  project: { id: string; name: string }
  characters: Array<{ id: string; name: string }>
  scenes: Array<{ id: string; title: string; position: number }>
  pending: number
  alreadyApplied?: boolean
}

/** Trạng thái một frame trong batch sinh ảnh storyboard. */
export type ImageBatchItemStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped'

export type ImageBatch = {
  id: string
  sessionId: string
  status: 'running' | 'done' | 'stopped'
  total: number
  done: number
  failed: number
  pending: number
  items: Array<{
    id: string
    frameId: string
    position: number
    status: ImageBatchItemStatus
    title: string
    error: string | null
  }>
  updatedAt: number
}

export type SetupInput = {
  chatModelId?: string | null
  imageModelId?: string | null
  videoModelId?: string | null
}

/** Ảnh của phiên (chân dung / nền) phục vụ qua endpoint có xác thực. */
export const uploadUrl = (uploadId: string): string => `/api/uploads/${encodeURIComponent(uploadId)}`

async function uploadImage(path: string, file: File): Promise<{ session: PlanSession }> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null
    throw new Error(payload?.error?.message ?? `Tải ảnh thất bại (mã ${response.status})`)
  }
  return (await response.json()) as { session: PlanSession }
}

/** Tạo kịch bản AI: chọn model, chat + kịch bản nháp, nhân vật, timeline. */
export const plannerApi = {
  list: (params: { projectId?: string; kind?: PlanKind } = {}) => {
    const query = new URLSearchParams()
    if (params.projectId) query.set('projectId', params.projectId)
    if (params.kind) query.set('kind', params.kind)
    const suffix = query.toString()
    return api.get<{ sessions: PlanSession[] }>(`/plans${suffix ? `?${suffix}` : ''}`)
  },
  create: (input: { kind?: PlanKind; title?: string; chatModelId?: string; projectId?: string }) =>
    api.post<{ session: PlanSession }>('/plans', input),
  get: (id: string) =>
    api.get<{ session: PlanSession; messages: PlanMessage[] }>(`/plans/${encodeURIComponent(id)}`),
  update: (id: string, input: { title?: string; chatModelId?: string | null }) =>
    api.patch<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}`, input),
  remove: (id: string) => api.delete<void>(`/plans/${encodeURIComponent(id)}`),

  /** Bước 0: chọn model chat / ảnh / video. */
  setup: (id: string, input: SetupInput) =>
    api.patch<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/setup`, input),

  /**
   * Chat trong một tab; AI trả lời và trả về artifact đã cập nhật.
   * `ran` cho biết AI đã tự chạy thêm một bước (script/cast/timeline) theo yêu cầu.
   */
  sendMessage: (id: string, content: string, target: PlanTarget) =>
    api.post<{
      session: PlanSession
      messages: PlanMessage[]
      reply: PlanMessage
      ran: PlanTarget | null
    }>(`/plans/${encodeURIComponent(id)}/messages`, { content, target }),

  /** AI viết (hoặc viết lại) kịch bản nháp. */
  rewriteScript: (id: string) =>
    api.post<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/script`),
  saveScript: (id: string, script: { text: string; scenes: DraftScene[] }) =>
    api.put<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/script`, script),

  generateCast: (id: string) =>
    api.post<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/cast`),
  saveCast: (id: string, cast: CastMember[]) =>
    api.put<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/cast`, { cast }),

  generateTimeline: (id: string) =>
    api.post<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/timeline`),
  /** AI sắp xếp lại MỘT frame: ai có mặt, hành động riêng, vị trí. */
  arrangeFrame: (id: string, frameId: string) =>
    api.post<{ session: PlanSession; reply: string }>(
      `/plans/${encodeURIComponent(id)}/timeline/${encodeURIComponent(frameId)}/arrange`,
    ),
  saveTimeline: (id: string, frames: TimelineFrame[]) =>
    api.put<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/timeline`, { frames }),

  generatePortrait: (id: string, castId: string) =>
    api.post<{ generation: { id: string } }>(
      `/plans/${encodeURIComponent(id)}/cast/${encodeURIComponent(castId)}/portrait`,
    ),
  attachPortrait: (id: string, castId: string, generationId: string) =>
    api.post<{ session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/cast/${encodeURIComponent(castId)}/portrait/attach`,
      { generationId },
    ),
  uploadPortrait: (id: string, castId: string, file: File) =>
    uploadImage(
      `/plans/${encodeURIComponent(id)}/cast/${encodeURIComponent(castId)}/portrait/upload`,
      file,
    ),
  removePortrait: (id: string, castId: string) =>
    api.delete<{ session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/cast/${encodeURIComponent(castId)}/portrait`,
    ),

  generateBackground: (id: string, frameId: string) =>
    api.post<{ generation: { id: string } }>(
      `/plans/${encodeURIComponent(id)}/timeline/${encodeURIComponent(frameId)}/background`,
    ),
  attachBackground: (id: string, frameId: string, generationId: string) =>
    api.post<{ session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/timeline/${encodeURIComponent(frameId)}/background/attach`,
      { generationId },
    ),
  uploadBackground: (id: string, frameId: string, file: File) =>
    uploadImage(
      `/plans/${encodeURIComponent(id)}/timeline/${encodeURIComponent(frameId)}/background/upload`,
      file,
    ),
  removeBackground: (id: string, frameId: string) =>
    api.delete<{ session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/timeline/${encodeURIComponent(frameId)}/background`,
    ),

  /**
   * Batch sinh ảnh storyboard cho cả timeline; trạng thái nằm ở server nên tải lại
   * trang vẫn theo dõi tiếp được.
   */
  imageBatch: {
    create: (id: string, input: { regenerateAll?: boolean } = {}) =>
      api.post<{ batch: ImageBatch }>(`/plans/${encodeURIComponent(id)}/image-batch`, input),
    latest: (id: string) =>
      api.get<{ batch: ImageBatch | null }>(`/plans/${encodeURIComponent(id)}/image-batch`),
    get: (id: string, batchId: string) =>
      api.get<{ batch: ImageBatch }>(
        `/plans/${encodeURIComponent(id)}/image-batch/${encodeURIComponent(batchId)}`,
      ),
    stop: (id: string, batchId: string) =>
      api.post<{ batch: ImageBatch }>(
        `/plans/${encodeURIComponent(id)}/image-batch/${encodeURIComponent(batchId)}/stop`,
      ),
    retry: (id: string, batchId: string) =>
      api.post<{ batch: ImageBatch }>(
        `/plans/${encodeURIComponent(id)}/image-batch/${encodeURIComponent(batchId)}/retry`,
      ),
  },

  /** Chốt timeline thành dự án Studio (cảnh ở trạng thái chưa duyệt). */
  apply: (id: string, input: ApplyInput) =>
    api.post<ApplyResult>(`/plans/${encodeURIComponent(id)}/apply`, input),
}

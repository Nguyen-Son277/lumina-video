import { api, assertResponseOk } from './client'
import type { CharacterVariant } from '../../shared/characterVariants'
export type { CharacterVariant, CharacterProfile } from '../../shared/characterVariants'

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
export type LocationReference = { id: string; name: string; stage: string; description: string; continuityNotes: string; imagePrompt: string; reference: { uploadId: string } | null; revision: number }
export type LocationInput = Omit<LocationReference, 'id' | 'revision'> & { id?: string }
/** Bề mặt có bước "đề xuất rồi mới ghi". */
export type PlanSurface = 'timeline' | 'locations'

/** Một thay đổi cụ thể do server tự so sánh; UI dịch nhãn theo ngôn ngữ. */
export type ProposalChange = {
  action: 'add' | 'update' | 'remove' | 'assign' | 'unassign' | 'reorder' | 'frame_update'
  entity: 'location' | 'frame'
  id: string
  label: string
  fields: Array<{ field: string; from: string; to: string }>
}

export type PlanProposal = {
  surface: PlanSurface
  /** Dữ liệu sẽ ghi nếu người dùng xác nhận (đúng dạng API lưu hiện có). */
  payload: { locations?: LocationReference[]; frames?: TimelineFrame[] }
  /** Dấu vân tay trạng thái lúc đề xuất, dùng để từ chối ghi đè. */
  baseStamp: string
}

export type ProposalResult = {
  reply: string
  summary: string
  changes: ProposalChange[]
  proposal: PlanProposal
  session: PlanSession
  messages: PlanMessage[]
}

/** Một cảnh của kịch bản nháp. */
export type DraftScene = {
  locationId?: string | null
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
  /** Nhịp hành động theo thời gian trong đúng `durationSeconds`. */
  beats: string
}

export type ScriptDraft = {
  text: string
  scenes: DraftScene[]
}

export type CastMember = {
  variants?: CharacterVariant[]
  selectedVariantId?: string
  revision?: number
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

/** Một nhân vật trong frame: ai, hành động riêng, biểu cảm, đứng ở đâu. */
export type FrameBlocking = {
  castId: string
  action: string
  /** Biểu cảm khuôn mặt và ánh mắt của riêng người này trong frame. */
  expression: string
  position: FramePosition
}

export type TimelineFrame = DraftScene & {
  /** Mô tả dùng để sinh ảnh storyboard cho frame. */
  backgroundPrompt: string
  background: { uploadId: string } | null
  backgroundLocationRevision?: number | null
  backgroundStale?: boolean
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
  locations?: LocationReference[]
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
    errorCode?: string | null
    errorMessageKey?: string | null
    errorMessageParams?: Record<string, string | number> | null
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
  await assertResponseOk(response)
  return (await response.json()) as { session: PlanSession }
}

/** Tạo kịch bản AI: chọn model, chat + kịch bản nháp, nhân vật, timeline. */
function variantPath(id: string, castId: string, variantId?: string): string {
  return `/plans/${encodeURIComponent(id)}/cast/${encodeURIComponent(castId)}/variants${variantId ? '/' + encodeURIComponent(variantId) : ''}`
}
async function variantDelete(path: string, revision: number): Promise<{ session: PlanSession }> {
  const response = await fetch('/api' + path, { method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) })
  await assertResponseOk(response)
  return response.json()
}
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

  /**
   * Yêu cầu AI sửa ở timeline hoặc bối cảnh. Server CHỈ đề xuất: trả tóm tắt +
   * danh sách thay đổi + `baseStamp`; chưa ghi gì cho tới khi gọi `applyProposal`.
   */
  proposeChange: (id: string, surface: PlanSurface, content: string) =>
    api.post<ProposalResult>(`/plans/${encodeURIComponent(id)}/propose`, { surface, content }),
  /** Áp dụng đúng đề xuất người dùng đã xác nhận; `baseStamp` chống ghi đè. */
  applyProposal: (id: string, input: {
    surface: PlanSurface
    baseStamp: string
    locations?: LocationReference[]
    frames?: TimelineFrame[]
  }) =>
    api.post<{ session: PlanSession; locations?: LocationReference[] }>(
      `/plans/${encodeURIComponent(id)}/propose/apply`,
      input,
    ),

  /** AI viết (hoặc viết lại) kịch bản nháp. */
  rewriteScript: (id: string) =>
    api.post<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/script`),  saveScript: (id: string, script: { text: string; scenes: DraftScene[] }) =>
    api.put<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/script`, script),

  completeVariantProfile: (id: string, castId: string, variantId: string, revision: number) => api.post<{ session: PlanSession }>(variantPath(id, castId, variantId) + '/profile/complete', { revision }),
  proposeVariants: (id: string, castId: string, input: { count: number; instruction?: string }) => api.post<{ session: PlanSession }>(variantPath(id, castId) + '/propose', input),
  createVariant: (id: string, castId: string, input: Partial<CharacterVariant>) => api.post<{ session: PlanSession }>(variantPath(id, castId), input),
  updateVariant: (id: string, castId: string, variantId: string, input: Partial<CharacterVariant>) => api.patch<{ session: PlanSession }>(variantPath(id, castId, variantId), input),
  removeVariant: (id: string, castId: string, variantId: string, revision: number) => variantDelete(variantPath(id, castId, variantId), revision),
  selectVariant: (id: string, castId: string, variantId: string, revision: number) => api.post<{ session: PlanSession }>(variantPath(id, castId, variantId) + '/select', { revision }),
  generateVariantPortrait: (id: string, castId: string, variantId: string) => api.post<{ generation: import('./types').Generation; revision: number }>(variantPath(id, castId, variantId) + '/portrait'),
  attachVariantPortrait: (id: string, castId: string, variantId: string, input: { generationId: string; revision: number; assetId?: string }) => api.post<{ session: PlanSession }>(variantPath(id, castId, variantId) + '/portrait/attach', input),
  uploadVariantPortrait: (id: string, castId: string, variantId: string, file: File, revision: number) => uploadImage(variantPath(id, castId, variantId) + '/portrait/upload?revision=' + revision, file),
  removeVariantPortrait: (id: string, castId: string, variantId: string, revision: number) => variantDelete(variantPath(id, castId, variantId) + '/portrait', revision),
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
  /** Quản lý bối cảnh tham chiếu của phiên. */
  listLocations: (id: string) =>
    api.get<{ locations: LocationReference[]; session: PlanSession }>(`/plans/${encodeURIComponent(id)}/locations`),
  saveLocations: (id: string, locations: Array<LocationInput & { id?: string }>) =>
    api.put<{ locations: LocationReference[]; session: PlanSession }>(`/plans/${encodeURIComponent(id)}/locations`, { locations }),
  createLocation: (id: string, location: LocationInput) =>
    api.post<{ locations: LocationReference[]; session: PlanSession }>(`/plans/${encodeURIComponent(id)}/locations`, location),
  updateLocation: (id: string, locationId: string, patch: Partial<LocationInput>) =>
    api.patch<{ locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}`, patch),
  removeLocation: (id: string, locationId: string) =>
    api.delete<{ locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}`),
  proposeLocations: (id: string) =>
    api.post<{ suggestions: LocationInput[]; locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/propose`),
  assignLocation: (id: string, locationId: string | null, frameIds: string[]) =>
    api.post<{ locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/assign`, { locationId, frameIds }),
  generateLocationReference: (id: string, locationId: string) =>
    api.post<{ generation: import('./types').Generation; locationId: string; revision: number }>(
      `/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}/reference`),
  uploadLocationReference: async (id: string, locationId: string, file: File) => {
    const response = await fetch(`/api/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}/reference/upload`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
    })
    await assertResponseOk(response)
    return (await response.json()) as { locations: LocationReference[]; session: PlanSession }
  },
  attachLocationReference: (id: string, locationId: string, input: { generationId: string; assetId?: string; revision?: number }) =>
    api.post<{ locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}/reference/attach`, input),
  removeLocationReference: (id: string, locationId: string) =>
    api.delete<{ locations: LocationReference[]; session: PlanSession }>(
      `/plans/${encodeURIComponent(id)}/locations/${encodeURIComponent(locationId)}/reference`),

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

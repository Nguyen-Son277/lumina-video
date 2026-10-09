import { api } from './client'

export type PlanKind = 'planner' | 'copilot'
export type PlanStatus =
  | 'chatting'
  | 'ideas_ready'
  | 'ideas_approved'
  | 'plan_ready'
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

export type VideoIdeas = {
  logline: string
  audience: string
  tone: string
  durationSeconds: number
  aspectRatio: string
  keyPoints: string[]
  characters: string[]
  visualStyle: string
  risks: string[]
}

export type PlannedCharacter = {
  name: string
  appearance: string
  role: string
  /** Có giá trị khi dùng lại nhân vật đã có trong thư viện. */
  reuseCharacterId: string | null
  voice: Voice
}

export type PlannedScene = {
  title: string
  background: string
  action: string
  dialogue: string
  speaker: string
  characters: string[]
  durationSeconds: number
  shotNotes: string
}

export type VideoPlan = {
  title: string
  characters: PlannedCharacter[]
  scenes: PlannedScene[]
  totalSeconds: number
  warnings: string[]
}

export type PlanSession = {
  id: string
  kind: PlanKind
  llmConnectionId: string | null
  projectId: string | null
  title: string
  status: PlanStatus
  ideas: VideoIdeas | null
  plan: VideoPlan | null
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

/** Trợ lý AI: chat lập kế hoạch rồi áp dụng thành dự án Studio. */
export const plannerApi = {
  list: (params: { projectId?: string; kind?: PlanKind } = {}) => {
    const query = new URLSearchParams()
    if (params.projectId) query.set('projectId', params.projectId)
    if (params.kind) query.set('kind', params.kind)
    const suffix = query.toString()
    return api.get<{ sessions: PlanSession[] }>(`/plans${suffix ? `?${suffix}` : ''}`)
  },
  create: (input: { kind?: PlanKind; title?: string; connectionId?: string; projectId?: string }) =>
    api.post<{ session: PlanSession }>('/plans', input),
  get: (id: string) =>
    api.get<{ session: PlanSession; messages: PlanMessage[] }>(`/plans/${encodeURIComponent(id)}`),
  update: (id: string, input: { title?: string; connectionId?: string | null }) =>
    api.patch<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}`, input),
  remove: (id: string) => api.delete<void>(`/plans/${encodeURIComponent(id)}`),
  /** Gửi tin nhắn và nhận câu trả lời của AI. */
  sendMessage: (id: string, content: string) =>
    api.post<{ session: PlanSession; messages: PlanMessage[]; reply: PlanMessage }>(
      `/plans/${encodeURIComponent(id)}/messages`,
      { content },
    ),
  /** Tổng hợp hội thoại thành đề xuất ý kiến. */
  ideas: (id: string) =>
    api.post<{ session: PlanSession; ideas: VideoIdeas }>(
      `/plans/${encodeURIComponent(id)}/ideas`,
    ),
  approveIdeas: (id: string) =>
    api.post<{ session: PlanSession }>(`/plans/${encodeURIComponent(id)}/ideas/approve`),
  /** Sinh kịch bản + nhân vật + timeline từ ý kiến đã duyệt. */
  plan: (id: string) =>
    api.post<{ session: PlanSession; plan: VideoPlan }>(`/plans/${encodeURIComponent(id)}/plan`),
  /** Chốt kế hoạch: tạo dự án mới (planner) hoặc vá vào dự án đang mở (copilot). */
  apply: (id: string, input: ApplyInput) =>
    api.post<ApplyResult>(`/plans/${encodeURIComponent(id)}/apply`, input),
}

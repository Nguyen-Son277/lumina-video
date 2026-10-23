import { randomUUID } from 'node:crypto'
import type { Database } from '../db/index'
import type { AppEnv } from '../env'
import type { MediaStore } from '../media/store'
import { badRequest, errorMeta, insufficientStorage, notFound, tooManyRequests } from '../lib/errors'
import { ownedProject } from '../projects/service'
import { ownedQuickSession } from '../quickSessions/service'
import { narrationSchema, type NarrationInput, type NarrationSnapshot, type SpeechInput, type SpeechJob, type SpeechScope, type SpeechStatus } from '../../shared/speech'

export type SpeechRow = {
  id: string
  user_id: string
  project_id: string | null
  quick_session_id: string | null
  model_pk: string | null
  provider_id: string | null
  input: string
  snap_model_id: string
  snap_provider: string
  snap_base_url: string
  credential_id: string | null
  snap_credential_hint: string | null
  snap_credential_base_url: string | null
  status: SpeechStatus
  relative_path: string | null
  mime_type: string | null
  byte_size: number | null
  duration_seconds: number | null
  error_code: string | null
  error_message: string | null
  error_message_key: string | null
  error_message_params: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

export function requireSpeechScope(db: Database, userId: string, scope: SpeechScope, writable = false): string {
  if (scope.projectId) return `project:${ownedProject(db, userId, scope.projectId, writable).id}`
  if (scope.quickSessionId) return `quick:${ownedQuickSession(db, userId, scope.quickSessionId).id}`
  return 'user'
}

export function ownedSpeech(db: Database, userId: string, id: string): SpeechRow {
  const row = db.prepare('SELECT * FROM speech_jobs WHERE id=? AND user_id=?').get(id, userId) as SpeechRow | undefined
  if (!row) throw notFound('Không tìm thấy bản giọng đọc.', errorMeta('speech.not_found'))
  return row
}

export function speechPublic(row: SpeechRow): SpeechJob {
  return {
    id: row.id,
    projectId: row.project_id,
    quickSessionId: row.quick_session_id,
    modelId: row.model_pk,
    model: row.snap_model_id,
    provider: row.snap_provider,
    input: row.input,
    status: row.status,
    durationSeconds: row.duration_seconds,
    byteSize: row.byte_size,
    mimeType: row.mime_type,
    url: row.status === 'succeeded' && row.relative_path ? `/api/speech-jobs/${row.id}/file` : null,
    downloadUrl: row.status === 'succeeded' && row.relative_path ? `/api/speech-jobs/${row.id}/file?download=1` : null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    errorMessageKey: row.error_message_key,
    errorMessageParams: row.error_message_params ? JSON.parse(row.error_message_params) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export function createSpeechJob(db: Database, env: AppEnv, mediaStore: MediaStore, userId: string, input: SpeechInput): SpeechRow {
  requireSpeechScope(db, userId, input, true)
  const model = db.prepare(`SELECT m.model_id, p.id AS provider_id, p.name, p.base_url, p.auth_scheme
    FROM models m JOIN provider_connections p ON p.id=m.provider_id
    WHERE m.id=? AND m.user_id=? AND p.user_id=? AND m.kind='tts' AND m.enabled=1`)
    .get(input.modelId, userId, userId) as { model_id: string; provider_id: string; name: string; base_url: string; auth_scheme: string } | undefined
  if (!model || model.auth_scheme === 'higgsfield') throw badRequest('Hãy chọn model giọng nói đang bật.', undefined, errorMeta('speech.model_required'))
  const active = db.prepare("SELECT COUNT(*) AS count FROM speech_jobs WHERE user_id=? AND status IN ('queued','running')").get(userId) as { count: number }
  if (active.count >= 20) throw tooManyRequests('Có quá nhiều tác vụ giọng đọc đang chờ. Hãy đợi tác vụ trước hoàn tất.', errorMeta('speech.queue_full'))
  if (mediaStore.userUsageBytes(db, userId) >= env.MAX_USER_MEDIA_BYTES) throw insufficientStorage('Đã hết dung lượng lưu trữ')
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`INSERT INTO speech_jobs(id,user_id,project_id,quick_session_id,model_pk,provider_id,input,snap_model_id,snap_provider,snap_base_url,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)`)
    .run(id, userId, input.projectId ?? null, input.quickSessionId ?? null, input.modelId, model.provider_id, input.input.trim(), model.model_id, model.name, model.base_url, now, now)
  return ownedSpeech(db, userId, id)
}

export function resolveNarration(db: Database, env: AppEnv, mediaStore: MediaStore, userId: string, scope: SpeechScope, input: NarrationInput): NarrationSnapshot {
  const parsed = narrationSchema.parse(input)
  const row = 'speechJobId' in parsed
    ? ownedSpeech(db, userId, parsed.speechJobId)
    : createSpeechJob(db, env, mediaStore, userId, { ...scope, modelId: parsed.modelId, input: parsed.input })
  if ((row.project_id && row.project_id !== scope.projectId) || (row.quick_session_id && row.quick_session_id !== scope.quickSessionId)) {
    throw badRequest('Bản giọng đọc thuộc dự án hoặc phiên Quick khác.', undefined, errorMeta('speech.scope_mismatch'))
  }
  if (row.status === 'failed' || row.status === 'unknown') throw badRequest('Bản giọng đọc chưa sẵn sàng. Hãy kiểm tra trạng thái trước khi xuất.', undefined, errorMeta('speech.not_ready'))
  return { speechJobId: row.id, mode: parsed.mode, originalVolume: parsed.originalVolume }
}

export function speechInUse(db: Database, id: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM exports WHERE speech_job_id=? AND status IN ('queued','running') LIMIT 1").get(id))
}

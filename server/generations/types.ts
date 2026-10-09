import type { AppEnv } from '../env'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import type { ProviderTarget } from '../providers/client'

export type GenerationKind = 'image' | 'video'

export type GenerationStatus =
  | 'queued'
  | 'running'
  | 'downloading'
  | 'succeeded'
  | 'failed'
  | 'unknown'

export type GenerationRow = {
  id: string
  user_id: string
  model_pk: string | null
  provider_id: string | null
  kind: GenerationKind
  prompt: string
  project_id?: string | null
  scene_id?: string | null
  prompt_snapshot_json?: string | null
  effective_prompt?: string | null
  source_images_json?: string | null
  /** Snapshot ảnh tham chiếu nhân vật đã dùng cho tác vụ này. */
  character_reference_json?: string | null
  /** Mảng ảnh tham chiếu theo thứ tự; phần tử [0] là người nói chính. */
  character_references_json?: string | null
  params_json: string
  snap_provider: string
  snap_base_url: string
  snap_model_id: string
  snap_image_style?: string | null
  /** Key trong pool đã ghim cho tác vụ (null khi chưa gửi provider). */
  credential_id?: string | null
  /** Bản rút gọn của key đã ghim, chụp lúc gửi (chỉ để hiển thị). */
  snap_credential_hint?: string | null
  /** Base URL đã dùng lúc gửi; poll/tải lại luôn dùng đúng URL này. */
  snap_credential_base_url?: string | null
  status: GenerationStatus
  provider_job_id: string | null
  progress: number | null
  error_code: string | null
  error_message: string | null
  /** Khoá ngữ nghĩa của lỗi do ứng dụng tạo ra (nullable với dữ liệu cũ). */
  error_message_key?: string | null
  /** Tham số JSON của khoá ngữ nghĩa, ví dụ `{"max":4}`. */
  error_message_params?: string | null
  attempt_count: number
  next_poll_at: number | null
  poll_started_at: number | null
  idempotency_key: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

/** Thông số người dùng chọn cho một lần tạo nội dung. */
export type GenerationParams = {
  size?: string
  quality?: string
  /** Một số provider nhận số giây dạng số, số khác nhận chuỗi. */
  seconds?: string | number
  n?: number
  background?: string
  [key: string]: unknown
}

export type GenerationContext = {
  generation: GenerationRow
  /**
   * Đích gọi provider. Với tác vụ đã gửi, đây là đúng key + URL đã ghim
   * (`credentialId`/`keyHint`), không bao giờ đổi sang key khác khi poll/tải.
   */
  provider: GenerationProviderTarget
  db: Database
  mediaStore: MediaStore
  env: AppEnv
}

/**
 * `ProviderTarget` kèm thông tin key đã chọn. `credentialId` có thể vắng trong
 * các bài test dựng context thủ công; luồng worker thật luôn đặt đủ.
 */
export type GenerationProviderTarget = ProviderTarget & {
  credentialId?: string
  keyHint?: string
}

export type AdapterOutcome =
  | { state: 'succeeded'; providerJobId?: string; progress?: number }
  | { state: 'running'; providerJobId: string; progress?: number | null }
  | { state: 'failed'; code: string; message: string }

export type GenerationAdapter = {
  /** Bắt đầu tác vụ. Với ảnh thường xong ngay; với video chỉ tạo job. */
  start: (context: GenerationContext) => Promise<AdapterOutcome>
  /** Kiểm tra tiến trình tác vụ đang chạy. */
  poll: (context: GenerationContext) => Promise<AdapterOutcome>
}

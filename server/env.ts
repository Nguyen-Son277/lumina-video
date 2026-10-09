import { z } from 'zod'

/**
 * Cấu hình môi trường. Backend từ chối khởi động nếu cấu hình không hợp lệ,
 * đặc biệt là khóa mã hóa API key.
 */
const boolFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')

const envSchema = z.object({
  APP_ENCRYPTION_KEY: z
    .string()
    .min(1, 'APP_ENCRYPTION_KEY là bắt buộc. Chạy: pnpm run key:generate')
    .refine((value) => {
      try {
        return Buffer.from(value, 'base64').length === 32
      } catch {
        return false
      }
    }, 'APP_ENCRYPTION_KEY phải là base64 của đúng 32 byte (AES-256)'),

  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default('data/app.db'),
  MEDIA_DIR: z.string().default('data/media'),
  APP_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  ALLOW_PRIVATE_PROVIDER_URLS: boolFromString.default(false),
  PROVIDER_MODE: z.enum(['live', 'mock']).default('live'),
  COOKIE_SECURE: boolFromString.default(false),

  MAX_CONCURRENT_JOBS_PER_USER: z.coerce.number().int().positive().default(2),
  MAX_PROMPT_LENGTH: z.coerce.number().int().positive().default(8000),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),
  MAX_USER_MEDIA_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  /** Ảnh tham chiếu nhân vật được gửi kèm dạng data URL nên cần giới hạn nhỏ. */
  MAX_REFERENCE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  /** Ảnh nguồn tải lên để tạo ảnh mới; gửi lại provider dạng multipart. */
  MAX_SOURCE_IMAGE_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  /** Số ảnh nguồn tối đa cho một lần tạo ảnh. */
  MAX_SOURCE_IMAGES: z.coerce.number().int().positive().max(16).default(4),
  VIDEO_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),

  /**
   * Giới hạn số lần đăng ký và đăng nhập theo IP trong một giờ / 10 phút.
   * Đặt 0 để tắt (chỉ dùng trong môi trường test).
   */
  RATE_LIMIT_REGISTER_PER_HOUR: z.coerce.number().int().nonnegative().default(20),
  RATE_LIMIT_LOGIN_PER_10MIN: z.coerce.number().int().nonnegative().default(10),
  RATE_LIMIT_GENERATE_PER_MIN: z.coerce.number().int().nonnegative().default(20),
  /** Số lần gọi LLM sinh văn bản (tạo nhân vật, kịch bản) mỗi phút. */
  RATE_LIMIT_LLM_CHAT_PER_MIN: z.coerce.number().int().nonnegative().default(10),

  /** Đường dẫn tới ffmpeg; để trống thì tìm trong PATH. */
  FFMPEG_PATH: z.string().default(''),
  /** Thời gian tối đa cho một lần ghép video (mặc định 10 phút). */
  EXPORT_TIMEOUT_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  /** Số cảnh tối đa cho một lần xuất video. */
  EXPORT_MAX_SCENES: z.coerce.number().int().positive().max(200).default(30),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
})

export type AppEnv = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Cấu hình môi trường không hợp lệ:\n${details}`)
  }
  return parsed.data
}

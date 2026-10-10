import express, { type Express } from 'express'
import cookieParser from 'cookie-parser'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AppEnv } from './env'
import type { Database } from './db/index'
import type { MediaStore } from './media/store'
import { attachUser, errorHandler, requireTrustedOrigin } from './auth/middleware'
import { authRoutes } from './auth/routes'
import { providerRoutes } from './providers/routes'
import { modelRoutes } from './models/routes'
import { generationRoutes } from './generations/routes'
import { assetRoutes, characterAssetRoutes } from './media/routes'
import type { Worker } from './generations/worker'
import { logger } from './lib/logger'
import { projectRoutes } from './projects/routes'
import { uploadRoutes } from './uploads/routes'
import { characterRoutes } from './characters/routes'
import { planRoutes } from './planner/routes'
import { planLocationRoutes } from './planner/locationRoutes'
import { projectLocationRoutes } from './projects/locationRoutes'
import { exportRoutes } from './exports/routes'
import { adminRoutes } from './admin/routes'
import { parseAdminEmails, syncAdminAllowlist } from './auth/accounts'

export function createApp(options: {
  db: Database
  env: AppEnv
  mediaStore: MediaStore
  worker: Worker
  /** Thư mục build của frontend; nếu có thì phục vụ luôn ở production. */
  staticDir?: string
}): Express {
  const { db, env, mediaStore, worker, staticDir } = options
  const app = express()

  // Áp dụng danh sách super admin ngay khi dựng app (cả production lẫn test):
  // đổi SUPER_ADMIN_EMAILS rồi restart là tài khoản cũ được nâng quyền, không cần
  // thao tác thủ công trên database.
  const adminEmails = parseAdminEmails(env.SUPER_ADMIN_EMAILS)
  const promoted = syncAdminAllowlist(db, adminEmails)
  if (adminEmails.length === 0) {
    logger.warn('SUPER_ADMIN_EMAILS đang rỗng: sẽ không có tài khoản nào duyệt được đăng ký mới')
  } else if (promoted > 0) {
    logger.info('Đã đồng bộ danh sách super admin', { accounts: promoted })
  }

  // Cần thiết để lấy IP chính xác khi chạy sau proxy.
  app.set('trust proxy', true)
  app.disable('x-powered-by')

  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(attachUser(db))
  app.use(requireTrustedOrigin(env.APP_ORIGIN))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: env.PROVIDER_MODE })
  })

  app.use(
    '/api/auth',
    authRoutes(db, {
      cookieSecure: env.COOKIE_SECURE,
      registerPerHour: env.RATE_LIMIT_REGISTER_PER_HOUR,
      loginPer10Min: env.RATE_LIMIT_LOGIN_PER_10MIN,
      adminEmails,
    }),
  )
  // Quản trị tài khoản: duyệt, từ chối và thu hồi. Bắt buộc vai trò admin.
  app.use('/api/admin', adminRoutes(db))
  app.use('/api/providers', providerRoutes(db, env))
  app.use('/api/models', modelRoutes(db))
  // Bối cảnh chung của dự án phải đứng trước router projectRoutes chung.
  app.use('/api/projects', projectLocationRoutes(db, env, mediaStore, worker))
  app.use('/api', projectRoutes(db, mediaStore, env))
  const jobs = generationRoutes(db, env, mediaStore, worker)
  app.use('/api/generations', jobs)
  // Forward only scene generation paths to the same enqueue handler.
  app.use('/api/scenes/:sceneId/generate', (req, res, next) => {
    req.url = `/scenes/${req.params.sceneId}/generate`
    jobs(req, res, next)
  })
  app.use('/api/assets', assetRoutes(db, mediaStore))
  app.use('/api/characters', characterAssetRoutes(db, mediaStore))
  app.use('/api/uploads', uploadRoutes(db, mediaStore, env))
  // Thư viện nhân vật dùng chung: CRUD, ảnh tham chiếu và phục vụ ảnh có xác thực.
  app.use('/api/shared-characters', characterRoutes(db, mediaStore, env, worker))
  // Trợ lý AI: chat lập kế hoạch và (chế độ copilot) chat trong dự án.
  app.use('/api/plans', planLocationRoutes(db, env, mediaStore, worker))
  app.use('/api/plans', planRoutes(db, env, mediaStore, worker))
  // Xuất video: ghép các cảnh đã tạo thành một tệp hoàn chỉnh.
  app.use('/api', exportRoutes(db, env, mediaStore, worker))

  app.use('/api', (_req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint không tồn tại',
        messageKey: 'errors.endpoint_not_found',
        messageParams: {},
      },
    })
  })

  if (staticDir) {
    const absoluteStatic = resolve(staticDir)
    if (existsSync(absoluteStatic)) {
      app.use(express.static(absoluteStatic))
      // SPA fallback: mọi đường dẫn không phải /api đều trả index.html.
      app.get(/^(?!\/api).*/, (_req, res) => {
        res.sendFile(join(absoluteStatic, 'index.html'))
      })
      logger.info('Đang phục vụ frontend đã build', { staticDir: absoluteStatic })
    }
  }

  app.use(errorHandler)

  return app
}

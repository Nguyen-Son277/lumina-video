import { loadDotEnv } from './loadDotEnv'

loadDotEnv()

import { loadEnv } from './env'
import { openDatabase } from './db/index'
import { createMediaStore } from './media/store'
import { createWorker } from './generations/worker'
import { createApp } from './app'
import { purgeExpiredSessions } from './auth/sessions'
import { logger } from './lib/logger'

async function main(): Promise<void> {
  const env = loadEnv()
  const db = openDatabase(env.DATABASE_PATH)
  const mediaStore = createMediaStore({
    root: env.MEDIA_DIR,
    maxImageBytes: env.MAX_IMAGE_BYTES,
    maxVideoBytes: env.MAX_VIDEO_BYTES,
    maxUserBytes: env.MAX_USER_MEDIA_BYTES,
  })

  const worker = createWorker({ db, mediaStore, env })
  const app = createApp({
    db,
    env,
    mediaStore,
    worker,
    staticDir: env.NODE_ENV === 'production' ? 'dist' : undefined,
  })

  purgeExpiredSessions(db)
  worker.start()

  const server = app.listen(env.PORT, () => {
    logger.info('Backend đang chạy', {
      url: `http://127.0.0.1:${env.PORT}`,
      mode: env.PROVIDER_MODE,
    })
    if (env.PROVIDER_MODE === 'mock') {
      logger.warn('PROVIDER_MODE=mock: không gọi provider thật, chỉ dùng cho test')
    }
  })

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Nhận ${signal}, đang dừng...`)
    server.close()
    await worker.stop()
    db.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Không khởi động được backend:\n${message}`)
  process.exit(1)
})

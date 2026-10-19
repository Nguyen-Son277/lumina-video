import { Router } from 'express'
import type { Database } from '../db/index'
import { requireUser } from '../auth/middleware'
import { badRequest } from '../lib/errors'
import { saveQuickPreferences, getQuickPreferences } from './service'

export function quickGenerationPreferencesRoutes(db: Database): Router {
  const router = Router()

  router.get('/', (req, res) => {
    const user = requireUser(req)
    res.json({ preferences: getQuickPreferences(db, user.id) })
  })

  router.put('/:mode', (req, res) => {
    const user = requireUser(req)
    if (req.params.mode !== 'image' && req.params.mode !== 'video') throw badRequest('Loại cài đặt không hợp lệ')
    const body = req.body
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1 || !('settings' in body)
      || Object.keys(body).some(key => key !== 'version' && key !== 'settings')) {
      throw badRequest('Dữ liệu cài đặt không hợp lệ')
    }
    let settingsSize: number
    try {
      settingsSize = Buffer.byteLength(JSON.stringify(body.settings), 'utf8')
    } catch {
      throw badRequest('Dữ liệu cài đặt không hợp lệ')
    }
    if (settingsSize > 16 * 1024) throw badRequest('Dữ liệu cài đặt quá lớn')
    try {
      const settings = saveQuickPreferences(db, user.id, req.params.mode, body.settings)
      res.json({ settings })
    } catch (error) {
      throw badRequest((error as Error).message || 'Dữ liệu cài đặt không hợp lệ')
    }
  })

  return router
}

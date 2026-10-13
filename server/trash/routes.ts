import { Router } from 'express'
import { z } from 'zod'
import type { Database } from '../db/index'
import type { MediaStore } from '../media/store'
import { requireUser } from '../auth/middleware'
import { validationError } from '../lib/errors'
import { TRASH_KINDS, listTrash, restoreTrash, purgeTrashItem, emptyTrash } from './service'
import { cleanMediaJobs } from '../projectsTrash/service'

export function trashRoutes(db: Database, mediaStore: MediaStore): Router {
  const router = Router()
  const kindSchema = z.enum(TRASH_KINDS)
  router.get('/', (req, res) => {
    const user = requireUser(req)
    const query = z.object({ kind: kindSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(30), offset: z.coerce.number().int().min(0).default(0) }).safeParse(req.query)
    if (!query.success) throw validationError(query.error)
    res.json(listTrash(db, user.id, query.data))
  })
  router.post('/:kind/:id/restore', (req, res) => {
    const user = requireUser(req), kind = kindSchema.safeParse(req.params.kind)
    if (!kind.success) throw validationError(kind.error)
    restoreTrash(db, user.id, kind.data, String(req.params.id))
    res.json({ restored: { kind: kind.data, id: req.params.id } })
  })
  router.delete('/:kind/:id', (req, res) => {
    const user = requireUser(req), kind = kindSchema.safeParse(req.params.kind)
    if (!kind.success) throw validationError(kind.error)
    purgeTrashItem(db, user.id, kind.data, String(req.params.id))
    cleanMediaJobs({ db, mediaStore })
    res.json({ purged: 1 })
  })
  router.delete('/', (req, res) => {
    const user = requireUser(req)
    const result = emptyTrash(db, user.id)
    cleanMediaJobs({ db, mediaStore })
    res.json(result)
  })
  return router
}

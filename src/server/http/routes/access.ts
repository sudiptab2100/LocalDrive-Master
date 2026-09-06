import { Router } from 'express'
import { requireAdmin } from '../middleware.js'
import {
  listPendingAccessRequests,
  approveAccessRequest,
  denyAccessRequest
} from '../../access.js'

/**
 * Admin approvals for per-drive access requests. Mirrors the desktop IPC
 * surface (`access:list/approve/deny`) so the web control panel reuses the same
 * UI. Every route is admin-only.
 */
export const accessRouter = Router()

accessRouter.use(requireAdmin)

accessRouter.get('/', async (_req, res) => {
  res.json({ requests: await listPendingAccessRequests() })
})

accessRouter.post('/:id/approve', async (req, res) => {
  try {
    const request = await approveAccessRequest(Number(req.params.id), req.user!.id)
    res.json({ ok: true, request })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

accessRouter.post('/:id/deny', (req, res) => {
  denyAccessRequest(Number(req.params.id), req.user!.id)
  res.json({ ok: true })
})

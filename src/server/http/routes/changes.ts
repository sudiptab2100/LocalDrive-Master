import { Router } from 'express'
import { requireAuth } from '../middleware.js'
import { getChangesSince } from '../../db/index.js'
import { hasPermission, getUserHome, homeNameFor } from '../../auth.js'
import { viewModeFor } from '../scope.js'
import { scopeOut } from '../../util/fs-safe.js'

/**
 * Lightweight polling feed of recent changes for background sync (e.g. the
 * mobile app waking periodically to surface local notifications while
 * disconnected). Returns file changes the caller can read — mapped into their
 * own scope — plus generic access/drive pings.
 *
 * Without `since`, returns an empty list and a baseline `cursor` so a first
 * poll never floods the client with historical changes; subsequent polls pass
 * the previous `cursor` back as `since`.
 */
export const changesRouter = Router()

changesRouter.get('/', requireAuth, (req, res) => {
  const user = req.user!
  const since = typeof req.query.since === 'string' ? req.query.since.trim() : ''
  const cursor = new Date().toISOString()

  if (!since) {
    res.json({ changes: [], cursor })
    return
  }

  const homeFor = (driveUuid: string): string | null => {
    if (user.role === 'admin') {
      return viewModeFor(req, user) === 'user' ? homeNameFor(user.username) : ''
    }
    return getUserHome(user, driveUuid)
  }

  const out: Array<Record<string, unknown>> = []
  for (const row of getChangesSince(since, 300)) {
    if (row.kind === 'file' && row.driveUuid) {
      const home = homeFor(row.driveUuid)
      if (home == null) continue
      const full = row.path ?? ''
      if (!hasPermission(user, row.driveUuid, full, 'read')) continue
      out.push({
        id: row.id,
        kind: row.kind,
        action: row.action,
        drive: row.driveUuid,
        path: scopeOut(home, full),
        by: row.username,
        at: row.ts
      })
    } else {
      // Access/drive changes are visible to every authenticated user; the app
      // just refetches its drive list on receipt.
      out.push({ id: row.id, kind: row.kind, action: row.action, at: row.ts })
    }
  }

  res.json({ changes: out, cursor })
})

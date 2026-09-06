import { Router } from 'express'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import { Server as TusServer, MemoryLocker } from '@tus/server'
import { FileStore } from '@tus/file-store'
import type { IncomingMessage, ServerResponse } from 'http'
import { getPaths } from '../../config.js'
import { resolveUser } from '../middleware.js'
import { hasPermission, getUserHome } from '../../auth.js'
import { scopeIn } from '../../util/fs-safe.js'
import { finalizeUpload } from '../../files.js'
import { bumpStat, logActivity } from '../../db/index.js'
import { fileChanged } from '../../changes.js'
import type { User } from '../../../shared/types.js'

/**
 * Resumable, chunked uploads via the tus protocol. Files stage in the app
 * support dir, then finalise atomically onto the destination drive so an
 * interrupted or crashed upload never corrupts existing files and can resume.
 */

const uploadsDir = join(getPaths().configDir, 'uploads')

const tus = new TusServer({
  path: '/api/upload',
  datastore: new FileStore({ directory: uploadsDir }),
  locker: new MemoryLocker(),
  namingFunction: () => randomBytes(16).toString('hex'),
  // Authenticate every tus request (create, patch, head).
  onIncomingRequest: async (req: IncomingMessage) => {
    const user = resolveUser(req as never)
    if (!user) {
      throw { status_code: 401, body: 'Authentication required' }
    }
    ;(req as unknown as { _ldUser: User })._ldUser = user
  },
  // Authorise the upload target when the upload is created.
  onUploadCreate: async (req: IncomingMessage, res: ServerResponse, upload) => {
    const user = (req as unknown as { _ldUser: User })._ldUser
    const meta = upload.metadata || {}
    const drive = meta.drive
    const home = drive ? getUserHome(user, drive) : null
    if (!drive || home == null) {
      throw { status_code: 403, body: 'Permission denied' }
    }
    const full = scopeIn(home, meta.path || '')
    if (full == null || !hasPermission(user, drive, full, 'write')) {
      throw { status_code: 403, body: 'Permission denied' }
    }
    return { res }
  },
  // Move the completed upload onto the drive atomically.
  onUploadFinish: async (req: IncomingMessage, res: ServerResponse, upload) => {
    const user = (req as unknown as { _ldUser?: User })._ldUser
    const meta = upload.metadata || {}
    const drive = meta.drive!
    const home = user ? getUserHome(user, drive) : null
    const destFull = scopeIn(home ?? '', meta.path || '')
    if (home == null || destFull == null) {
      throw { status_code: 403, body: 'Permission denied' }
    }
    const filename = meta.filename || upload.id
    const srcData = join(uploadsDir, upload.id)
    await finalizeUpload(drive, destFull, filename, srcData)
    // Clean up the tus metadata sidecar (data file already moved).
    await fs.rm(join(uploadsDir, upload.id + '.json'), { force: true })
    bumpStat('bytes_in', upload.size || 0)
    bumpStat('uploads', 1)
    logActivity('upload', {
      userId: user?.id ?? null,
      username: user?.username ?? null,
      detail: `${meta.path || ''}/${filename}`
    })
    fileChanged({
      action: 'upload',
      driveUuid: drive,
      path: destFull,
      userId: user?.id ?? null,
      username: user?.username ?? null
    })
    return { res }
  }
})

export const uploadRouter = Router()

// tus needs the raw request; hand every method under the mount to the tus server.
uploadRouter.all(['/', '/*'], (req, res) => {
  tus.handle(req, res)
})

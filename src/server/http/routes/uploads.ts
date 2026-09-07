import { Router } from 'express'
import { join } from 'path'
import { promises as fs } from 'fs'
import { randomBytes } from 'crypto'
import { Server as TusServer, MemoryLocker } from '@tus/server'
import type { IncomingMessage, ServerResponse } from 'http'
import { getPaths } from '../../config.js'
import { resolveUser } from '../middleware.js'
import { hasPermission, getUserHome } from '../../auth.js'
import { scopeIn } from '../../util/fs-safe.js'
import { finalizeUpload } from '../../files.js'
import { bumpStat, logActivity } from '../../db/index.js'
import { backupByUpload } from '../../db/backup-uploads.js'
import { fileChanged } from '../../changes.js'
import {
  BackupFileStore, BackupUploadError, createBackupUpload, finishBackupUpload,
  prepareBackupRequest, releaseBackupRequest
} from '../../backup-uploads.js'
import type { User } from '../../../shared/types.js'

/**
 * Resumable, chunked uploads via the tus protocol. Files stage in the app
 * support dir, then finalise atomically onto the destination drive so an
 * interrupted or crashed upload never corrupts existing files and can resume.
 */

const uploadsDir = join(getPaths().configDir, 'uploads')

const tus = new TusServer({
  path: '/api/upload',
  datastore: new BackupFileStore({ directory: uploadsDir }),
  locker: new MemoryLocker(),
  namingFunction: () => randomBytes(16).toString('hex'),
  generateUrl: (_req, { proto, host, path, id }) => backupByUpload(id)
    ? `${path}/${id}`
    : `${proto}://${host}${path}/${id}`,
  getFileIdFromRequest: (_req, id) => id && /^[a-f0-9]{32}$/.test(id) ? id : undefined,
  // Authenticate every tus request (create, patch, head).
  onIncomingRequest: async (req: IncomingMessage, _res: ServerResponse, uploadId: string) => {
    const user = resolveUser(req as never)
    if (!user) {
      throw { status_code: 401, body: 'Authentication required' }
    }
    ;(req as unknown as { _ldUser: User })._ldUser = user
    await prepareBackupRequest(req, user, uploadId)
  },
  // Authorise the upload target when the upload is created.
  onUploadCreate: async (req: IncomingMessage, res: ServerResponse, upload) => {
    const user = (req as unknown as { _ldUser: User })._ldUser
    const backupMetadata = await createBackupUpload(req, user, upload)
    if (backupMetadata) return { res, metadata: backupMetadata }
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
    if (user && await finishBackupUpload(user, upload.id)) return { res }
    if (meta.backupJobId || meta.backupSha256) {
      throw new BackupUploadError(404, 'Backup upload not found')
    }
    const drive = meta.drive!
    const home = user ? getUserHome(user, drive) : null
    const destFull = scopeIn(home ?? '', meta.path || '')
    if (home == null || destFull == null || !user || !hasPermission(user, drive, destFull, 'write')) {
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
uploadRouter.all(['/', '/*'], async (req, res, next) => {
  try {
    await tus.handle(req, res)
  } catch (error) {
    next(error)
  } finally {
    releaseBackupRequest(req)
  }
})

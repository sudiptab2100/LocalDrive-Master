import { Router } from 'express'
import { resolveBearerUser } from '../middleware.js'
import { backupUploadStatus, BackupUploadError } from '../../backup-uploads.js'

export const backupRouter = Router()

backupRouter.get('/:jobId', async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store')
  const user = resolveBearerUser(req)
  if (!user) {
    res.status(401).json({ error: 'Bearer authentication required' })
    return
  }
  try {
    res.json(await backupUploadStatus(user, req.params.jobId))
  } catch (error) {
    if (!(error instanceof BackupUploadError)) return next(error)
    res.status(error.status_code).json({
      error: error.message,
      ...(error.code ? { errorCode: error.code, retryable: error.retryable } : {})
    })
  }
})

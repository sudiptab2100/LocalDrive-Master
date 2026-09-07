import { constants, promises as fs } from 'fs'
import { basename, dirname, extname, join } from 'path'
import { createHash, randomBytes } from 'crypto'
import type { IncomingMessage } from 'http'
import type { Readable } from 'stream'
import type { Request } from 'express'
import { FileStore } from '@tus/file-store'
import { Upload } from '@tus/server'
import { getPaths, loadConfig } from './config.js'
import { getUserById, hasPermission } from './auth.js'
import { getDb } from './db/index.js'
import {
  backupByJob, backupByUpload, completeBackup, insertBackup, saveBackup, type BackupUpload
} from './db/backup-uploads.js'
import { privateDriveScope } from './http/scope.js'
import { resolveBearerUser } from './http/middleware.js'
import { driveMountPath, getDriveAppDir, getShareRoot, resolveInDrive } from './drives/registry.js'
import { finalizeUpload } from './files.js'
import { isSafeName, normalizeApiPath, safeResolve } from './util/fs-safe.js'
import { syncDirectory, syncFile } from './util/atomic.js'
import { bus, EVENTS } from './events.js'
import type { User } from '../shared/types.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const uploadsDir = join(getPaths().configDir, 'uploads')
const locks = new Map<string, Promise<void>>()
const requestLocks = new WeakMap<IncomingMessage, () => void>()

const ERRORS: Record<string, [number, string, boolean]> = {
  destination_offline: [503, 'Destination drive is offline; reconnect it to resume.', true],
  destination_unwritable: [503, 'Destination is not writable; restore access to resume.', true],
  destination_full: [507, 'Destination is full; free space to resume.', true],
  destination_unavailable: [503, 'Destination is unavailable; retry to resume.', true],
  destination_atomic_publish_unsupported: [
    503, 'Destination filesystem does not support safe no-replace publication.', true
  ],
  destination_changed: [409, 'The destination share or private space has changed.', false],
  checksum_mismatch: [422, 'Uploaded content does not match backupSha256.', false],
  staging_missing: [410, 'The unfinished upload data is missing; create a new backup job.', false],
  staging_invalid: [422, 'The unfinished upload data has an invalid length or type.', false]
}

export class BackupUploadError extends Error {
  constructor(
    readonly status_code: number,
    message: string,
    readonly code?: string,
    readonly retryable = false
  ) {
    super(message)
  }

  get body(): string { return this.message + '\n' }
}

function errorFor(code: string): BackupUploadError {
  const [status, message, retryable] = ERRORS[code] ?? ERRORS.destination_unavailable
  return new BackupUploadError(status, message, code, retryable)
}

function tryLock(id: string): (() => void) | undefined {
  if (locks.has(id)) return undefined
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  locks.set(id, pending)
  return () => {
    if (locks.get(id) !== pending) return
    locks.delete(id)
    finish()
  }
}

async function lockRequest(req: IncomingMessage, id: string): Promise<void> {
  let release: (() => void) | undefined
  while (!(release = tryLock(id))) await locks.get(id)
  requestLocks.set(req, release)
}

export function releaseBackupRequest(req: IncomingMessage): void {
  requestLocks.get(req)?.()
  requestLocks.delete(req)
}

function stagePath(job: BackupUpload): string {
  return join(uploadsDir, job.upload_id)
}

function metadataFor(job: BackupUpload): Record<string, string> {
  return {
    backupJobId: job.job_id,
    backupSha256: job.sha256,
    filename: job.requested_filename,
    drive: job.drive_uuid,
    path: job.path
  }
}

function requireAccountToken(req: IncomingMessage, caller: User): void {
  const user = resolveBearerUser(req as Request)
  if (!user || user.id !== caller.id) throw new BackupUploadError(401, 'Bearer authentication required')
}

/** Re-read roles, approval, home and ACLs, including after a long background PATCH. */
function authorize(job: BackupUpload, caller: User): User {
  if (job.owner_id !== caller.id) throw new BackupUploadError(404, 'Backup upload not found')
  const user = getUserById(caller.id)
  if (!user || user.status !== 'active') throw new BackupUploadError(401, 'Authentication required')
  const registered = getDb().prepare('SELECT 1 FROM drives WHERE uuid = ? AND registered = 1')
    .get(job.drive_uuid)
  const scope = privateDriveScope(user, job.drive_uuid)
  const full = scope?.in(job.path)
  if (!registered || !scope || full == null || !hasPermission(user, job.drive_uuid, full, 'write')) {
    throw new BackupUploadError(403, 'Permission denied')
  }
  if (scope.home !== job.home || loadConfig().shareRootName !== job.share_root) {
    throw errorFor('destination_changed')
  }
  return user
}

/** Reject symlinks as well as lexical escapes, including links to another user's home. */
async function checkDirectoryTree(root: string, relative: string, create: boolean): Promise<void> {
  const parts = relative ? relative.split('/') : []
  for (let i = 0; i <= parts.length; i++) {
    const path = safeResolve(root, parts.slice(0, i).join('/'))
    if (!path) throw new BackupUploadError(403, 'Invalid destination')
    let stat
    try {
      stat = await fs.lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return
      try {
        await fs.mkdir(path)
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
      stat = await fs.lstat(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new BackupUploadError(403, 'Invalid destination directory')
    }
  }
}

async function destination(job: BackupUpload, create = false) {
  const mount = await driveMountPath(job.drive_uuid)
  if (!mount) throw errorFor('destination_offline')
  const root = await getShareRoot(job.drive_uuid)
  const full = `${job.home}${job.path ? '/' + job.path : ''}`
  const dir = await resolveInDrive(job.drive_uuid, full)
  if (!dir) throw new BackupUploadError(403, 'Invalid destination')
  await checkDirectoryTree(root, full, create)
  await checkDirectoryTree(mount, '.localdrive/tmp', create)
  const part = join(await getDriveAppDir(job.drive_uuid), 'tmp', `backup-${job.upload_id}.part`)
  return { dir, full, part }
}

async function storageError(error: unknown, job: BackupUpload): Promise<BackupUploadError> {
  if (error instanceof BackupUploadError) return error
  if (!await driveMountPath(job.drive_uuid)) return errorFor('destination_offline')
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOSPC' || code === 'EDQUOT') return errorFor('destination_full')
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM') return errorFor('destination_unwritable')
  if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
    return errorFor('destination_atomic_publish_unsupported')
  }
  return errorFor('destination_unavailable')
}

async function contentMatches(path: string, job: BackupUpload): Promise<boolean> {
  let file
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== job.size) return false
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    return before.size === after.size && before.mtimeMs === after.mtimeMs &&
      before.ctimeMs === after.ctimeMs && hash.digest('hex') === job.sha256
  } finally {
    await file.close()
  }
}

async function stageSize(job: BackupUpload): Promise<number | null> {
  try {
    const stat = await fs.lstat(stagePath(job))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > job.size) {
      throw errorFor('staging_invalid')
    }
    return stat.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function initializeStage(job: BackupUpload): Promise<void> {
  if (job.stage_created) return
  await fs.mkdir(uploadsDir, { recursive: true })
  try {
    const file = await fs.open(stagePath(job), 'wx', 0o600)
    try { await file.sync() } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (await stageSize(job) == null) throw errorFor('staging_missing')
  await syncFile(stagePath(job))
  await syncDirectory(uploadsDir)
  job.stage_created = 1
  saveBackup(job)
}

function markError(job: BackupUpload, error: BackupUploadError): void {
  job.error_code = error.code ?? 'destination_unavailable'
  if (!error.retryable) job.state = 'failed'
  saveBackup(job)
}

async function cleanup(job: BackupUpload): Promise<void> {
  // The committed receipt is authoritative; cleanup failures must not undo it.
  await Promise.all([
    fs.rm(stagePath(job), { force: true }).catch(() => {}),
    fs.rm(stagePath(job) + '.json', { force: true }).catch(() => {})
  ])
  try {
    const { part } = await destination(job)
    await fs.rm(part, { force: true })
  } catch { /* an offline drive is cleaned on a later receipt read */ }
}

async function commitReceipt(job: BackupUpload, caller: User, finalPath: string): Promise<void> {
  await syncFile(finalPath)
  await syncDirectory(dirname(finalPath))
  const user = authorize(job, caller)
  const change = completeBackup(job, user)
  job.state = 'complete'
  job.error_code = null
  if (change) {
    try { bus.emit(EVENTS.filesChanged, change) } catch { /* polling still has the durable change */ }
  }
  await cleanup(job)
}

function collisionName(job: BackupUpload): string {
  const rawExtension = extname(job.requested_filename)
  const extension = Buffer.byteLength(rawExtension) <= 32 ? rawExtension : ''
  const suffix = ` (backup-${job.upload_id}-${randomBytes(3).toString('hex')})`
  let stem = basename(job.requested_filename, extension)
  while (Buffer.byteLength(stem + suffix + extension) > 255) stem = [...stem].slice(0, -1).join('')
  return stem + suffix + extension
}

/** Runs under the request-lifetime lock, not tus's shorter datastore lock. */
async function recover(job: BackupUpload, caller: User): Promise<BackupUpload> {
  authorize(job, caller)
  if (job.state === 'complete') {
    await cleanup(job)
    return job
  }
  if (job.state === 'failed') return job
  try {
    await initializeStage(job)
    const offset = await stageSize(job)
    let sourceVerified = false
    if (job.state === 'uploading') {
      if (offset == null) throw errorFor('staging_missing')
      if (offset < job.size) {
        await destination(job)
        if (job.error_code) {
          job.error_code = null
          saveBackup(job)
        }
        return job
      }
      if (!await contentMatches(stagePath(job), job)) throw errorFor('checksum_mismatch')
      sourceVerified = true
      job.state = 'finalizing'
      job.error_code = null
      saveBackup(job)
    }
    let target = await destination(job)
    if (await contentMatches(join(target.dir, job.filename), job)) {
      await commitReceipt(job, caller, join(target.dir, job.filename))
      return job
    }
    if (offset == null) throw errorFor('staging_missing')
    if (offset !== job.size) throw errorFor('staging_invalid')
    if (!sourceVerified && !await contentMatches(stagePath(job), job)) throw errorFor('checksum_mismatch')
    target = await destination(job, true)
    for (let attempt = 0; attempt < 100; attempt++) {
      const finalPath = join(target.dir, job.filename)
      if (await contentMatches(finalPath, job)) {
        await commitReceipt(job, caller, finalPath)
        return job
      }
      try {
        await fs.lstat(finalPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        authorize(job, caller)
        // Recheck physical confinement immediately before publication.
        target = await destination(job, true)
        try {
          await finalizeUpload(job.drive_uuid, target.full, job.filename, stagePath(job), {
            noReplacePart: target.part
          })
          if (!await contentMatches(finalPath, job)) throw errorFor('checksum_mismatch')
          await commitReceipt(job, caller, finalPath)
          return job
        } catch (publishError) {
          if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError
          // Another writer won the no-replace operation. Recheck/adopt it or choose a new name.
          if (await contentMatches(finalPath, job)) {
            await commitReceipt(job, caller, finalPath)
            return job
          }
        }
      }
      job.filename = collisionName(job)
      saveBackup(job)
    }
    throw errorFor('destination_unavailable')
  } catch (error) {
    const mapped = await storageError(error, job)
    if ([401, 403, 404].includes(mapped.status_code)) throw mapped
    // Once committed, neither a cleanup issue nor a replay may revert completion.
    const committed = backupByUpload(job.upload_id)
    if (committed?.state === 'complete') return committed
    markError(job, mapped)
    return job
  }
}

export class BackupFileStore extends FileStore {
  override async create(upload: Upload): Promise<Upload> {
    const job = backupByUpload(upload.id)
    if (!job) {
      if (upload.metadata?.backupJobId || upload.metadata?.backupSha256) {
        throw new BackupUploadError(404, 'Backup upload not found')
      }
      return super.create(upload)
    }
    await initializeStage(job)
    return this.getUpload(upload.id)
  }

  override async getUpload(id: string): Promise<Upload> {
    const job = backupByUpload(id)
    if (!job) {
      const upload = await super.getUpload(id)
      if (upload.metadata?.backupJobId || upload.metadata?.backupSha256) {
        throw new BackupUploadError(404, 'Backup upload not found')
      }
      return upload
    }
    if (job.state === 'complete') throw new BackupUploadError(410, 'Backup complete; read its receipt')
    if (job.state === 'failed') throw errorFor(job.error_code ?? 'staging_invalid')
    const offset = await stageSize(job)
    if (offset == null) throw errorFor('staging_missing')
    return new Upload({
      id, size: job.size, offset, metadata: metadataFor(job),
      creation_date: job.created_at, storage: { type: 'file', path: stagePath(job) }
    })
  }

  override async write(readable: IncomingMessage | Readable, id: string, offset: number): Promise<number> {
    if (!backupByUpload(id)) return super.write(readable, id, offset)
    try {
      return await super.write(readable, id, offset)
    } finally {
      await syncFile(join(uploadsDir, id))
    }
  }
}

export async function createBackupUpload(
  req: IncomingMessage, caller: User, upload: Upload
): Promise<Record<string, string> | undefined> {
  const meta = upload.metadata ?? {}
  if (!('backupJobId' in meta) && !('backupSha256' in meta)) return undefined
  requireAccountToken(req, caller)
  const jobId = meta.backupJobId
  const sha256 = meta.backupSha256
  const filename = meta.filename
  const path = meta.path ?? ''
  if (!jobId || !UUID.test(jobId) || !sha256 || !SHA256.test(sha256) ||
      !Number.isSafeInteger(upload.size) || upload.size! < 0 || !meta.drive ||
      !filename || !isSafeName(filename) || filename.toLowerCase() === '.localdrive' ||
      Buffer.byteLength(filename) > 255 || path.includes('\0') || path.includes('\\') ||
      path.split('/').some((part) => part === '..' || part.toLowerCase() === '.localdrive')) {
    throw new BackupUploadError(400, 'Invalid backup metadata or Upload-Length')
  }
  const scope = privateDriveScope(caller, meta.drive)
  if (!scope || scope.in(path) == null) throw new BackupUploadError(403, 'Permission denied')
  const now = new Date().toISOString()
  const job: BackupUpload = {
    owner_id: caller.id, job_id: jobId.toLowerCase(), upload_id: upload.id,
    drive_uuid: meta.drive, share_root: loadConfig().shareRootName, home: scope.home,
    path: normalizeApiPath(path), requested_filename: filename, filename,
    size: upload.size!, sha256, state: 'uploading', stage_created: 0,
    error_code: null, created_at: now, updated_at: now, completed_at: null
  }
  authorize(job, caller)
  const existing = backupByJob(caller.id, job.job_id)
  if (existing) {
    authorize(existing, caller)
    const same = existing.size === job.size && existing.sha256 === job.sha256 &&
      existing.drive_uuid === job.drive_uuid && existing.home === job.home &&
      existing.share_root === job.share_root && existing.path === job.path &&
      existing.requested_filename === job.requested_filename
    throw new BackupUploadError(409, same
      ? 'Backup job already exists; recover it with GET /api/backup/uploads/' + job.job_id
      : 'Backup job metadata does not match the existing job')
  }
  try { await destination(job) } catch (error) { throw await storageError(error, job) }
  // The scope can change while the destination filesystem is being checked.
  authorize(job, caller)
  const raced = backupByJob(caller.id, job.job_id)
  if (raced) throw new BackupUploadError(409, 'Backup job already exists; read its status')
  try {
    insertBackup(job)
  } catch (error) {
    if (backupByJob(caller.id, job.job_id)) {
      throw new BackupUploadError(409, 'Backup job already exists; read its status')
    }
    throw error
  }
  await lockRequest(req, job.upload_id)
  return metadataFor(job)
}

export async function prepareBackupRequest(
  req: IncomingMessage, caller: User, uploadId: string
): Promise<boolean> {
  let job = backupByUpload(uploadId)
  if (!job) return false
  requireAccountToken(req, caller)
  authorize(job, caller)
  if (req.method !== 'HEAD' && req.method !== 'PATCH') {
    throw new BackupUploadError(405, 'Backup resources support HEAD and PATCH; use the status endpoint')
  }
  await lockRequest(req, uploadId)
  job = backupByUpload(uploadId)
  if (!job) throw new BackupUploadError(404, 'Backup upload not found')
  authorize(job, caller)
  job = await recover(job, caller)
  if (job.state === 'complete') throw new BackupUploadError(410, 'Backup complete; read its receipt')
  if (job.state === 'failed' || (req.method === 'PATCH' && job.error_code)) {
    throw errorFor(job.error_code ?? 'staging_invalid')
  }
  return true
}

export async function finishBackupUpload(caller: User, uploadId: string): Promise<boolean> {
  const job = backupByUpload(uploadId)
  if (!job) return false
  const recovered = await recover(job, caller)
  if (recovered.state !== 'complete') throw errorFor(recovered.error_code ?? 'destination_unavailable')
  return true
}

export async function backupUploadStatus(caller: User, jobId: string) {
  let job = UUID.test(jobId) ? backupByJob(caller.id, jobId.toLowerCase()) : undefined
  if (!job) throw new BackupUploadError(404, 'Backup upload not found')
  authorize(job, caller)
  // A status poll must not abort or wait for a potentially hours-long PATCH.
  const release = tryLock(job.upload_id)
  let offset: number | undefined
  if (release) {
    try {
      job = await recover(job, caller)
      if (job.state === 'complete') offset = job.size
      else {
        try { offset = (await stageSize(job)) ?? undefined } catch { /* failed stage has no usable offset */ }
      }
    } finally { release() }
  }
  authorize(job, caller)
  const error = job.error_code ? errorFor(job.error_code) : undefined
  return {
    jobId: job.job_id, state: job.state, uploadUrl: `/api/upload/${job.upload_id}`,
    size: job.size, sha256: job.sha256, drive: job.drive_uuid, path: job.path,
    filename: job.filename, remotePath: job.path ? `${job.path}/${job.filename}` : job.filename,
    ...(offset === undefined ? {} : { offset }),
    ...(error ? { error: error.message, errorCode: error.code, retryable: error.retryable } : {})
  }
}

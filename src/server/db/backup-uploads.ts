import { bumpStat, getDb, logActivity, recordChange, type ChangeRow } from './index.js'
import type { User } from '../../shared/types.js'

export interface BackupUpload {
  owner_id: number
  job_id: string
  upload_id: string
  drive_uuid: string
  share_root: string
  home: string
  path: string
  requested_filename: string
  filename: string
  size: number
  sha256: string
  state: 'uploading' | 'finalizing' | 'complete' | 'failed'
  stage_created: number
  error_code: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

/** Filesystem intents must reach durable WAL before the corresponding file operation. */
function durable<T>(work: () => T): T {
  const db = getDb()
  const previous = db.pragma('synchronous', { simple: true }) as number
  db.pragma('synchronous = FULL')
  try {
    return db.transaction(work).immediate()
  } finally {
    db.pragma(`synchronous = ${previous}`)
  }
}

export function backupByJob(ownerId: number, jobId: string): BackupUpload | undefined {
  return getDb().prepare('SELECT * FROM backup_uploads WHERE owner_id = ? AND job_id = ?')
    .get(ownerId, jobId) as BackupUpload | undefined
}

export function backupByUpload(uploadId: string): BackupUpload | undefined {
  return getDb().prepare('SELECT * FROM backup_uploads WHERE upload_id = ?')
    .get(uploadId) as BackupUpload | undefined
}

export function insertBackup(job: BackupUpload): void {
  durable(() => {
    getDb().prepare(`
      INSERT INTO backup_uploads
        (owner_id, job_id, upload_id, drive_uuid, share_root, home, path, requested_filename,
         filename, size, sha256, state, stage_created, created_at, updated_at)
      VALUES
        (@owner_id, @job_id, @upload_id, @drive_uuid, @share_root, @home, @path, @requested_filename,
         @filename, @size, @sha256, @state, @stage_created, @created_at, @updated_at)
    `).run(job)
  })
}

export function saveBackup(job: BackupUpload): void {
  durable(() => {
    getDb().prepare(`
      UPDATE backup_uploads SET state = @state, filename = @filename,
        stage_created = @stage_created, error_code = @error_code, updated_at = @updated_at
      WHERE upload_id = @upload_id AND state != 'complete'
    `).run({ ...job, updated_at: new Date().toISOString() })
  })
}

/** The receipt, counters, audit entry and polling-feed change commit exactly once. */
export function completeBackup(job: BackupUpload, user: User): ChangeRow | undefined {
  return durable(() => {
    const updated = getDb().prepare(`
      UPDATE backup_uploads SET state = 'complete', error_code = NULL,
        completed_at = ?, updated_at = ?
      WHERE upload_id = ? AND state != 'complete'
    `).run(new Date().toISOString(), new Date().toISOString(), job.upload_id)
    if (!updated.changes) return undefined
    const relative = job.path ? `${job.path}/${job.filename}` : job.filename
    bumpStat('bytes_in', job.size)
    bumpStat('uploads', 1)
    logActivity('upload', { userId: user.id, username: user.username, detail: relative })
    return recordChange({
      kind: 'file',
      action: 'upload',
      driveUuid: job.drive_uuid,
      path: `${job.home}/${relative}`,
      userId: user.id,
      username: user.username
    })
  })
}

import { getDb, logActivity } from './db/index.js'
import { getUserById, setAcl } from './auth.js'
import { loadConfig } from './config.js'
import { ensureUserHomeDir, writeUsersManifest, userSpaceExists } from './provisioning.js'
import { bus, EVENTS } from './events.js'
import type { User } from '../shared/types.js'

/**
 * Opt-in per-drive access. After login a user sees every registered drive but
 * has access to none until they request it and an admin approves (or
 * auto-approval is on). Approval grants a `write` ACL on the user's own
 * userspace folder and reuses an existing `LocalDrive/<home>/` on the drive if
 * present — so a user's space travels with the drive across serving PCs.
 */

export type AccessStatus = 'pending' | 'approved' | 'denied'

export interface AccessRequestView {
  id: number
  userId: number
  username: string
  driveUuid: string
  driveLabel: string
  requestedAt: string
  /** True when the user's folder already exists on the drive (best-effort). */
  existingSpace?: boolean
}

/** Map of the user's per-drive request states (drive_uuid -> status). */
export function getAccessMap(userId: number): Record<string, AccessStatus> {
  const rows = getDb()
    .prepare('SELECT drive_uuid, status FROM access_requests WHERE user_id = ?')
    .all(userId) as { drive_uuid: string; status: AccessStatus }[]
  const map: Record<string, AccessStatus> = {}
  for (const r of rows) map[r.drive_uuid] = r.status
  return map
}

function driveRow(uuid: string): { registered: number; label: string } | undefined {
  return getDb().prepare('SELECT registered, label FROM drives WHERE uuid = ?').get(uuid) as
    | { registered: number; label: string }
    | undefined
}

function setPending(userId: number, uuid: string): void {
  getDb()
    .prepare(
      `INSERT INTO access_requests (user_id, drive_uuid, status)
       VALUES (?, ?, 'pending')
       ON CONFLICT(user_id, drive_uuid) DO UPDATE SET
         status = 'pending', requested_at = datetime('now'), decided_at = NULL, decided_by = NULL`
    )
    .run(userId, uuid)
}

function setDecided(userId: number, uuid: string, status: AccessStatus, decidedBy?: number): void {
  getDb()
    .prepare(
      `INSERT INTO access_requests (user_id, drive_uuid, status, decided_at, decided_by)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(user_id, drive_uuid) DO UPDATE SET
         status = excluded.status, decided_at = datetime('now'), decided_by = excluded.decided_by`
    )
    .run(userId, uuid, status, decidedBy ?? null)
}

/** Whether the user currently holds a granted (home) ACL on the drive. */
function isGranted(user: User, uuid: string): boolean {
  if (!user.home) return false
  const row = getDb()
    .prepare('SELECT 1 FROM acls WHERE user_id = ? AND drive_uuid = ? AND path_prefix = ? LIMIT 1')
    .get(user.id, uuid, user.home)
  return !!row
}

/**
 * Grant a user access to a drive: write their userspace ACL, reuse-or-create
 * their folder, refresh the drive manifest, and mark the request approved.
 */
export async function grantDriveAccess(
  user: User,
  uuid: string,
  decidedBy?: number
): Promise<void> {
  if (!user.home) {
    // A userspace ACL is keyed on the user's home folder, so without one there
    // is nothing to grant. Fail loudly instead of silently reporting success —
    // callers must never return a false 'granted'.
    throw new Error(`Cannot grant drive access: ${user.username} has no home folder.`)
  }
  setAcl(user.id, uuid, user.home, 'write')
  await ensureUserHomeDir(uuid, user.home)
  await writeUsersManifest(uuid)
  setDecided(user.id, uuid, 'approved', decidedBy)
  logActivity('access_grant', { userId: decidedBy ?? user.id, detail: `${user.username} → ${uuid}` })
}

/**
 * User asks for access to a drive. Auto-approves when enabled, otherwise records
 * a pending request and notifies admins. Returns the resulting access state.
 */
export async function requestAccess(user: User, uuid: string): Promise<'granted' | 'pending'> {
  const drive = driveRow(uuid)
  if (!drive || !drive.registered) throw new Error('Drive not found')
  if (user.role === 'admin' || isGranted(user, uuid)) return 'granted'

  if (loadConfig().autoApproveAccessRequests) {
    await grantDriveAccess(user, uuid)
    bus.emit(EVENTS.accessRequestsChanged, { pending: false, username: user.username })
    return 'granted'
  }

  setPending(user.id, uuid)
  logActivity('access_request', { userId: user.id, username: user.username, detail: drive.label })
  bus.emit(EVENTS.accessRequestsChanged, {
    pending: true,
    username: user.username,
    drive: drive.label
  })
  return 'pending'
}

/** Admin approves a pending request by id. */
export async function approveAccessRequest(id: number, adminId?: number): Promise<AccessRequestView | null> {
  const row = getDb()
    .prepare('SELECT user_id, drive_uuid FROM access_requests WHERE id = ?')
    .get(id) as { user_id: number; drive_uuid: string } | undefined
  if (!row) return null
  const user = getUserById(row.user_id)
  if (!user) return null
  await grantDriveAccess(user, row.drive_uuid, adminId)
  bus.emit(EVENTS.accessRequestsChanged, { pending: false, username: user.username })
  return {
    id,
    userId: user.id,
    username: user.username,
    driveUuid: row.drive_uuid,
    driveLabel: driveRow(row.drive_uuid)?.label ?? row.drive_uuid,
    requestedAt: ''
  }
}

/** Admin denies a request by id (also revokes any existing grant). */
export function denyAccessRequest(id: number, adminId?: number): void {
  const row = getDb()
    .prepare('SELECT user_id, drive_uuid FROM access_requests WHERE id = ?')
    .get(id) as { user_id: number; drive_uuid: string } | undefined
  if (!row) return
  const user = getUserById(row.user_id)
  setDecided(row.user_id, row.drive_uuid, 'denied', adminId)
  // Revoke a previously granted userspace ACL, if any.
  if (user?.home) {
    getDb()
      .prepare('DELETE FROM acls WHERE user_id = ? AND drive_uuid = ? AND path_prefix = ?')
      .run(row.user_id, row.drive_uuid, user.home)
  }
  logActivity('access_deny', { userId: adminId ?? null, detail: `${user?.username ?? row.user_id} → ${row.drive_uuid}` })
  bus.emit(EVENTS.accessRequestsChanged, { pending: false, username: user?.username ?? '' })
}

/** Pending access requests (registered drives only), for the desktop approvals UI. */
export async function listPendingAccessRequests(): Promise<AccessRequestView[]> {
  const rows = getDb()
    .prepare(
      `SELECT ar.id, ar.user_id, ar.drive_uuid, ar.requested_at, u.username, d.label, d.registered
         FROM access_requests ar
         JOIN users u ON u.id = ar.user_id
         JOIN drives d ON d.uuid = ar.drive_uuid
        WHERE ar.status = 'pending' AND d.registered = 1
        ORDER BY ar.requested_at`
    )
    .all() as {
    id: number
    user_id: number
    drive_uuid: string
    requested_at: string
    username: string
    label: string
  }[]
  const out: AccessRequestView[] = []
  for (const r of rows) {
    const user = getUserById(r.user_id)
    out.push({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      driveUuid: r.drive_uuid,
      driveLabel: r.label,
      requestedAt: r.requested_at,
      existingSpace: user?.home ? await userSpaceExists(r.drive_uuid, user.home) : false
    })
  }
  return out
}

/** Count of pending access requests (registered drives only), for the badge. */
export function countPendingAccessRequests(): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM access_requests ar
           JOIN drives d ON d.uuid = ar.drive_uuid
          WHERE ar.status = 'pending' AND d.registered = 1`
      )
      .get() as { c: number }
  ).c
}

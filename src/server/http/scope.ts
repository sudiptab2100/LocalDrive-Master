import type { Request } from 'express'
import * as cookie from 'cookie'
import { getUserHome, homeNameFor, isHomeTaken } from '../auth.js'
import { scopeIn, scopeOut } from '../util/fs-safe.js'
import { ensureUserHomeDir } from '../provisioning.js'
import type { User } from '../../shared/types.js'

/**
 * Confinement scope for the calling user on a drive. Translates between the
 * client's home-relative paths (which always start at "/") and the real
 * drive-relative paths, so a user only ever sees inside their own home.
 */
export interface DriveScope {
  /** '' for admins in "admin" view (whole drive), else a home folder prefix. */
  home: string
  /** Map a client (home-relative) path to a full drive path, or null if it escapes. */
  in: (clientPath: string) => string | null
  /** Map a full drive path back to a client (home-relative) path. */
  out: (fullPath: string) => string
}

export type ViewMode = 'admin' | 'user'

/**
 * The admin's active view mode, carried on a lightweight `ld_view` cookie so it
 * applies uniformly across fetch, downloads, ZIP and tus uploads. It only ever
 * *restricts* an admin (confines them to their own space), so a client-supplied
 * value is safe — it can never widen access. Non-admins are always 'user'.
 */
export function viewModeFor(req: Request, user: User): ViewMode {
  if (user.role !== 'admin') return 'user'
  const cookies = cookie.parse(req.headers.cookie || '')
  return cookies['ld_view'] === 'user' ? 'user' : 'admin'
}

/** Backup destinations always belong to the owner's private space, even for admins. */
export function privateDriveScope(user: User, driveUuid: string): DriveScope | null {
  const home = user.role === 'admin' ? homeNameFor(user.username) : getUserHome(user, driveUuid)
  if (!home || isHomeTaken(home, user.id)) return null
  return {
    home,
    in: (p) => scopeIn(home, p),
    out: (p) => scopeOut(home, p)
  }
}

/**
 * Resolve the calling user's scope for a drive, or null when they have no
 * access. Admins see the whole share in "admin" view and only their own
 * `LocalDrive/<username>/` in "user" view. Non-admins are confined to the home
 * they have an approved ACL for (null ⇒ no access). Lazily ensures the home
 * folder exists so first access always works even on a previously-offline drive.
 */
export async function driveScope(req: Request, driveUuid: string): Promise<DriveScope | null> {
  const user = req.user
  if (!user) return null

  let home: string | null
  if (user.role === 'admin') {
    home = viewModeFor(req, user) === 'user' ? homeNameFor(user.username) : ''
  } else {
    home = getUserHome(user, driveUuid)
  }
  if (home == null) return null
  if (home) await ensureUserHomeDir(driveUuid, home)
  return {
    home,
    in: (p: string) => scopeIn(home!, p),
    out: (p: string) => scopeOut(home!, p)
  }
}

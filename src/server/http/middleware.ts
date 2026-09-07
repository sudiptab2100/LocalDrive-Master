import type { Request, Response, NextFunction } from 'express'
import * as cookie from 'cookie'
import { authenticate, verifyToken, hasPermission } from '../auth.js'
import type { User, Permission } from '../../shared/types.js'

export const AUTH_COOKIE = 'ld_token'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User
    }
  }
}

/** Resolve the user from a Bearer token, session cookie, or Basic auth. */
export function resolveUserRaw(req: Request): User | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    const u = verifyToken(auth.slice(7))
    if (u) return u
  }
  if (auth?.startsWith('Basic ')) {
    try {
      const [username, password] = Buffer.from(auth.slice(6), 'base64').toString().split(':')
      const u = authenticate(username, password)
      if (u) return u
    } catch {
      /* ignore */
    }
  }
  const cookies = cookie.parse(req.headers.cookie || '')
  if (cookies[AUTH_COOKIE]) {
    const u = verifyToken(cookies[AUTH_COOKIE])
    if (u) return u
  }
  return null
}

/**
 * Resolve the request's user, treating non-active (pending) accounts as
 * unauthenticated. This single choke point blocks web sessions, bearer tokens,
 * and WebDAV Basic auth for accounts still awaiting admin approval.
 */
export function resolveUser(req: Request): User | null {
  const u = resolveUserRaw(req)
  return u && u.status === 'active' ? u : null
}

/** Background jobs must never fall back from their account token to another cookie session. */
export function resolveBearerUser(req: Request): User | null {
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return null
  const user = verifyToken(authorization.slice(7))
  return user?.status === 'active' ? user : null
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  req.user = resolveUser(req) ?? undefined
  next()
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  next()
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' })
    return
  }
  next()
}

/**
 * Guard a request that operates on `driveUuid` + `path` (taken from query or
 * body) requiring a minimum permission.
 */
export function requirePermission(need: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const driveUuid = (req.query.drive as string) || req.body?.drive
    const path = ((req.query.path as string) ?? req.body?.path ?? '') as string
    if (!driveUuid) {
      res.status(400).json({ error: 'Missing drive' })
      return
    }
    if (!hasPermission(req.user, driveUuid, path, need)) {
      res.status(403).json({ error: 'Permission denied' })
      return
    }
    next()
  }
}

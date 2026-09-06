import { Router } from 'express'
import type { Response } from 'express'
import { requireAdmin, requireAuth } from '../middleware.js'
import { bus, EVENTS } from '../../events.js'
import { getStatus } from '../../status.js'
import { hasPermission, getUserHome, homeNameFor } from '../../auth.js'
import { viewModeFor } from '../scope.js'
import { scopeOut } from '../../util/fs-safe.js'
import type { ChangeRow } from '../../db/index.js'

/**
 * Server-Sent Events stream of app-wide changes, so the admin web panel stays
 * live (drives, registrations, access requests, server status, config) exactly
 * like the desktop app's IPC push events. Admin-only; the browser's EventSource
 * authenticates via the same-origin `ld_token` cookie.
 */
export const eventsRouter = Router()

eventsRouter.get('/', requireAdmin, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering so events flush immediately.
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`)
  }

  // Prime the client with the current status.
  send('statusChanged', getStatus())

  const onDrives = (): void => send('drivesChanged', {})
  const onReg = (info: unknown): void => send('registrationsChanged', info)
  const onAccess = (info: unknown): void => send('accessRequestsChanged', info)
  const onStatus = (s: unknown): void => send('statusChanged', s)
  const onConfig = (c: unknown): void => send('configChanged', c)

  bus.on(EVENTS.drivesChanged, onDrives)
  bus.on(EVENTS.registrationsChanged, onReg)
  bus.on(EVENTS.accessRequestsChanged, onAccess)
  bus.on(EVENTS.statusChanged, onStatus)
  bus.on(EVENTS.configChanged, onConfig)

  // Keep-alive comment so idle connections aren't dropped by intermediaries.
  const ka = setInterval(() => res.write(': ping\n\n'), 25000)
  ka.unref?.()

  const cleanup = (): void => {
    clearInterval(ka)
    bus.off(EVENTS.drivesChanged, onDrives)
    bus.off(EVENTS.registrationsChanged, onReg)
    bus.off(EVENTS.accessRequestsChanged, onAccess)
    bus.off(EVENTS.statusChanged, onStatus)
    bus.off(EVENTS.configChanged, onConfig)
  }
  req.on('close', cleanup)
  ;(res as Response).on('close', cleanup)
})

/**
 * User-scoped live event stream. Emits `filesChanged` for locations the caller
 * can read (their own home, or a shared folder they have an ACL for — admins in
 * admin view see the whole share), plus lightweight `accessChanged` /
 * `drivesChanged` pings so the app refreshes drive access and listings. Auth is
 * via the same cookie/bearer as every other route.
 */
eventsRouter.get('/user', requireAuth, (req, res) => {
  const user = req.user!
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data ?? {})}\n\n`)
  }

  send('hello', { at: new Date().toISOString() })

  // Home prefix for this viewer on a drive, without creating anything.
  const homeFor = (driveUuid: string): string | null => {
    if (user.role === 'admin') {
      return viewModeFor(req, user) === 'user' ? homeNameFor(user.username) : ''
    }
    return getUserHome(user, driveUuid)
  }

  const onFile = (row: ChangeRow): void => {
    const drive = row.driveUuid
    const full = row.path ?? ''
    if (!drive) return
    const home = homeFor(drive)
    if (home == null) return
    if (!hasPermission(user, drive, full, 'read')) return
    send('filesChanged', {
      drive,
      path: scopeOut(home, full),
      action: row.action,
      by: row.username,
      at: row.ts
    })
  }
  const onAccess = (): void => send('accessChanged', {})
  const onDrives = (): void => send('drivesChanged', {})

  bus.on(EVENTS.filesChanged, onFile)
  bus.on(EVENTS.accessRequestsChanged, onAccess)
  bus.on(EVENTS.drivesChanged, onDrives)

  const ka = setInterval(() => res.write(': ping\n\n'), 25000)
  ka.unref?.()

  const cleanup = (): void => {
    clearInterval(ka)
    bus.off(EVENTS.filesChanged, onFile)
    bus.off(EVENTS.accessRequestsChanged, onAccess)
    bus.off(EVENTS.drivesChanged, onDrives)
  }
  req.on('close', cleanup)
  ;(res as Response).on('close', cleanup)
})

import { Router, type Request, type Response } from 'express'
import { createReadStream, promises as fs } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import archiver from 'archiver'
import mime from 'mime-types'
import sharp from 'sharp'
import {
  listDirectory,
  statEntry,
  makeDir,
  renameEntry,
  moveEntries,
  copyEntries,
  deleteEntries
} from '../../files.js'
import { resolveInDrive, getDriveAppDir } from '../../drives/registry.js'
import { hasPermission } from '../../auth.js'
import { requireAuth } from '../middleware.js'
import { driveScope } from '../scope.js'
import { bumpStat, logActivity } from '../../db/index.js'
import { fileChanged } from '../../changes.js'
import { parentOf } from '../../util/paths.js'

export const filesRouter = Router()

function can(req: Request, drive: string, path: string, need: 'read' | 'write' | 'admin'): boolean {
  return !!req.user && hasPermission(req.user, drive, path, need)
}

// ---- Listing --------------------------------------------------------------
filesRouter.get('/list', requireAuth, async (req, res) => {
  const drive = String(req.query.drive || '')
  const path = String(req.query.path || '')
  const includeHidden = req.query.hidden === '1' || req.query.hidden === 'true'
  if (!drive) return res.status(400).json({ error: 'Missing drive' })
  const scope = await driveScope(req, drive)
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(path)
  if (full == null || !can(req, drive, full, 'read'))
    return res.status(403).json({ error: 'Permission denied' })
  try {
    const entries = await listDirectory(drive, full, includeHidden)
    res.json({ path, entries: entries.map((e) => ({ ...e, path: scope.out(e.path) })) })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ---- Mutations ------------------------------------------------------------
filesRouter.post('/mkdir', requireAuth, async (req, res) => {
  const { drive, path = '', name } = req.body ?? {}
  if (!drive || !name) return res.status(400).json({ error: 'Missing drive or name' })
  const scope = await driveScope(req, String(drive))
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(String(path))
  if (full == null || !can(req, String(drive), full, 'write'))
    return res.status(403).json({ error: 'Permission denied' })
  try {
    await makeDir(String(drive), full, name)
    logActivity('mkdir', { userId: req.user!.id, username: req.user!.username, detail: `${path}/${name}` })
    fileChanged({
      action: 'mkdir',
      driveUuid: String(drive),
      path: full,
      userId: req.user!.id,
      username: req.user!.username
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

filesRouter.post('/rename', requireAuth, async (req, res) => {
  const { drive, path, newName } = req.body ?? {}
  if (!drive || !path || !newName) return res.status(400).json({ error: 'Missing fields' })
  const scope = await driveScope(req, String(drive))
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(String(path))
  if (full == null || full === scope.home || !can(req, String(drive), parentOf(full), 'write'))
    return res.status(403).json({ error: 'Permission denied' })
  try {
    await renameEntry(String(drive), full, newName)
    fileChanged({
      action: 'rename',
      driveUuid: String(drive),
      path: parentOf(full),
      userId: req.user!.id,
      username: req.user!.username
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

filesRouter.post('/move', requireAuth, async (req, res) => {
  const { drive, sources, dest = '' } = req.body ?? {}
  if (!drive || !Array.isArray(sources)) return res.status(400).json({ error: 'Missing fields' })
  const scope = await driveScope(req, String(drive))
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const destFull = scope.in(String(dest))
  if (destFull == null || !can(req, String(drive), destFull, 'write'))
    return res.status(403).json({ error: 'Permission denied' })
  const fullSources: string[] = []
  for (const s of sources) {
    const f = scope.in(String(s))
    if (f == null || f === scope.home || !can(req, String(drive), parentOf(f), 'write'))
      return res.status(403).json({ error: 'Permission denied' })
    fullSources.push(f)
  }
  try {
    await moveEntries(String(drive), fullSources, destFull)
    fileChanged({
      action: 'move',
      driveUuid: String(drive),
      path: destFull,
      userId: req.user!.id,
      username: req.user!.username
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

filesRouter.post('/copy', requireAuth, async (req, res) => {
  const { drive, sources, dest = '' } = req.body ?? {}
  if (!drive || !Array.isArray(sources)) return res.status(400).json({ error: 'Missing fields' })
  const scope = await driveScope(req, String(drive))
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const destFull = scope.in(String(dest))
  if (destFull == null || !can(req, String(drive), destFull, 'write'))
    return res.status(403).json({ error: 'Permission denied' })
  const fullSources: string[] = []
  for (const s of sources) {
    const f = scope.in(String(s))
    if (f == null || !can(req, String(drive), f, 'read'))
      return res.status(403).json({ error: 'Permission denied' })
    fullSources.push(f)
  }
  try {
    await copyEntries(String(drive), fullSources, destFull)
    fileChanged({
      action: 'copy',
      driveUuid: String(drive),
      path: destFull,
      userId: req.user!.id,
      username: req.user!.username
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

filesRouter.post('/delete', requireAuth, async (req, res) => {
  const { drive, paths } = req.body ?? {}
  if (!drive || !Array.isArray(paths)) return res.status(400).json({ error: 'Missing fields' })
  const scope = await driveScope(req, String(drive))
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const fullPaths: string[] = []
  for (const p of paths) {
    const f = scope.in(String(p))
    if (f == null || f === scope.home || !can(req, String(drive), parentOf(f), 'write'))
      return res.status(403).json({ error: 'Permission denied' })
    fullPaths.push(f)
  }
  try {
    await deleteEntries(String(drive), fullPaths)
    logActivity('delete', { userId: req.user!.id, username: req.user!.username, detail: paths.join(', ') })
    fileChanged({
      action: 'delete',
      driveUuid: String(drive),
      path: parentOf(fullPaths[0]),
      userId: req.user!.id,
      username: req.user!.username
    })
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

// ---- Download / stream with HTTP range support ----------------------------
async function streamFile(req: Request, res: Response, absPath: string, inline: boolean) {
  let st
  try {
    st = await fs.stat(absPath)
  } catch {
    return res.status(404).json({ error: 'Not found' })
  }
  if (st.isDirectory()) return res.status(400).json({ error: 'Is a directory' })

  const type = mime.lookup(absPath) || 'application/octet-stream'
  const filename = absPath.split('/').pop() || 'file'
  res.setHeader('Content-Type', type)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader(
    'Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
  )

  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1
      if (start >= st.size || end >= st.size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${st.size}`)
        return res.end()
      }
      res.status(206)
      res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`)
      res.setHeader('Content-Length', end - start + 1)
      const stream = createReadStream(absPath, { start, end })
      stream.on('end', () => bumpStat('bytes_out', end - start + 1))
      return stream.pipe(res)
    }
  }
  res.setHeader('Content-Length', st.size)
  const stream = createReadStream(absPath)
  stream.on('end', () => {
    bumpStat('bytes_out', st.size)
    bumpStat('downloads', 1)
  })
  stream.pipe(res)
}

filesRouter.get('/download', requireAuth, async (req, res) => {
  const drive = String(req.query.drive || '')
  const path = String(req.query.path || '')
  const scope = await driveScope(req, drive)
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(path)
  if (full == null || !can(req, drive, full, 'read'))
    return res.status(403).json({ error: 'Permission denied' })
  const abs = await resolveInDrive(drive, full)
  if (!abs) return res.status(400).json({ error: 'Invalid path' })
  await streamFile(req, res, abs, false)
})

filesRouter.get('/raw', requireAuth, async (req, res) => {
  const drive = String(req.query.drive || '')
  const path = String(req.query.path || '')
  const scope = await driveScope(req, drive)
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(path)
  if (full == null || !can(req, drive, full, 'read'))
    return res.status(403).json({ error: 'Permission denied' })
  const abs = await resolveInDrive(drive, full)
  if (!abs) return res.status(400).json({ error: 'Invalid path' })
  await streamFile(req, res, abs, true)
})

// ---- ZIP download of folders / multiple selections ------------------------
filesRouter.get('/zip', requireAuth, async (req, res) => {
  const drive = String(req.query.drive || '')
  const clientPaths = String(req.query.paths || '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
  if (!drive || clientPaths.length === 0) return res.status(400).json({ error: 'Missing fields' })
  const scope = await driveScope(req, drive)
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const items: { full: string; name: string }[] = []
  for (const p of clientPaths) {
    const full = scope.in(p)
    if (full == null || !can(req, drive, full, 'read'))
      return res.status(403).json({ error: 'Permission denied' })
    items.push({ full, name: p.split('/').pop() || 'item' })
  }

  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="localdrive-${Date.now()}.zip"`)
  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('error', () => res.destroy())
  archive.on('end', () => {
    bumpStat('bytes_out', archive.pointer())
    bumpStat('downloads', 1)
  })
  archive.pipe(res)

  for (const { full, name } of items) {
    const abs = await resolveInDrive(drive, full)
    if (!abs) continue
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) archive.directory(abs, name)
      else archive.file(abs, { name })
    } catch {
      /* skip */
    }
  }
  await archive.finalize()
})

// ---- Image thumbnails (cached under the drive's .localdrive/thumbs) --------
filesRouter.get('/thumb', requireAuth, async (req, res) => {
  const drive = String(req.query.drive || '')
  const path = String(req.query.path || '')
  const size = Math.min(512, Math.max(32, parseInt(String(req.query.size || '256'), 10) || 256))
  const scope = await driveScope(req, drive)
  if (!scope) return res.status(403).json({ error: 'Permission denied' })
  const full = scope.in(path)
  if (full == null || !can(req, drive, full, 'read'))
    return res.status(403).json({ error: 'Permission denied' })
  const abs = await resolveInDrive(drive, full)
  if (!abs) return res.status(400).json({ error: 'Invalid path' })

  const type = mime.lookup(abs) || ''
  if (!type.startsWith('image/')) return res.status(415).json({ error: 'No thumbnail' })

  try {
    const st = await fs.stat(abs)
    const key = createHash('sha1').update(`${full}:${st.mtimeMs}:${size}`).digest('hex')
    const appDir = await getDriveAppDir(drive)
    const cachePath = join(appDir, 'thumbs', key + '.webp')
    res.setHeader('Content-Type', 'image/webp')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    try {
      await fs.access(cachePath)
      return createReadStream(cachePath).pipe(res)
    } catch {
      /* generate below */
    }
    const buf = await sharp(abs).rotate().resize(size, size, { fit: 'inside' }).webp({ quality: 80 }).toBuffer()
    fs.writeFile(cachePath, buf).catch(() => {})
    res.end(buf)
  } catch {
    res.status(500).json({ error: 'Thumbnail failed' })
  }
})

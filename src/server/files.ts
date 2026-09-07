import { promises as fs } from 'fs'
import { join, dirname, basename, extname } from 'path'
import { randomBytes } from 'crypto'
import mime from 'mime-types'
import { getShareRoot, resolveInDrive, getDriveAppDir } from './drives/registry.js'
import { getDb } from './db/index.js'
import { normalizeApiPath, isSafeName } from './util/fs-safe.js'
import { copyAtomicNoReplace, moveAtomic } from './util/atomic.js'
import type { FileEntry } from '../shared/types.js'

/** High-level file operations on a registered drive's share root. */

function mimeOf(name: string): string | null {
  return mime.lookup(name) || null
}

/** List a directory and refresh the search index for its entries. */
export async function listDirectory(
  uuid: string,
  relPath: string,
  includeHidden = false
): Promise<FileEntry[]> {
  const abs = await resolveInDrive(uuid, relPath)
  if (!abs) throw new Error('Invalid path')
  const dirents = await fs.readdir(abs, { withFileTypes: true })
  const base = normalizeApiPath(relPath)

  const entries: FileEntry[] = []
  for (const d of dirents) {
    if (d.name === '.localdrive') continue
    const childPath = base ? `${base}/${d.name}` : d.name
    try {
      const st = await fs.stat(join(abs, d.name))
      entries.push({
        name: d.name,
        path: childPath,
        isDir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtimeMs: st.mtimeMs,
        mime: st.isDirectory() ? null : mimeOf(d.name)
      })
    } catch {
      /* skip unreadable entries */
    }
  }
  // Hidden entries are dotfiles, including macOS AppleDouble "._" sidecars that
  // appear next to every file on exFAT/FAT drives. We index ALL entries so the
  // "show hidden" toggle can reveal them in search too; hidden results are
  // filtered out at query time unless that toggle is on. (.localdrive is
  // excluded above, so it is never indexed or listed.)
  const visible = entries.filter((e) => !e.name.startsWith('.'))
  indexEntries(uuid, entries)
  const result = includeHidden ? entries : visible
  result.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return result
}

export async function statEntry(uuid: string, relPath: string): Promise<FileEntry | null> {
  const abs = await resolveInDrive(uuid, relPath)
  if (!abs) return null
  try {
    const st = await fs.stat(abs)
    const name = basename(abs)
    return {
      name,
      path: normalizeApiPath(relPath),
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
      mime: st.isDirectory() ? null : mimeOf(name)
    }
  } catch {
    return null
  }
}

export async function makeDir(uuid: string, relPath: string, name: string): Promise<void> {
  if (!isSafeName(name)) throw new Error('Invalid folder name')
  const parent = await resolveInDrive(uuid, relPath)
  if (!parent) throw new Error('Invalid path')
  await fs.mkdir(join(parent, name), { recursive: true })
}

export async function renameEntry(uuid: string, relPath: string, newName: string): Promise<void> {
  if (!isSafeName(newName)) throw new Error('Invalid name')
  const abs = await resolveInDrive(uuid, relPath)
  if (!abs) throw new Error('Invalid path')
  const target = join(dirname(abs), newName)
  await fs.rename(abs, target)
  removeFromIndex(uuid, normalizeApiPath(relPath))
}

/** Move a set of source paths into a destination folder (same drive). */
export async function moveEntries(
  uuid: string,
  sources: string[],
  destDir: string
): Promise<void> {
  const dest = await resolveInDrive(uuid, destDir)
  if (!dest) throw new Error('Invalid destination')
  for (const src of sources) {
    const absSrc = await resolveInDrive(uuid, src)
    if (!absSrc) continue
    await fs.rename(absSrc, join(dest, basename(absSrc)))
    removeFromIndex(uuid, normalizeApiPath(src))
  }
}

export async function copyEntries(
  uuid: string,
  sources: string[],
  destDir: string
): Promise<void> {
  const dest = await resolveInDrive(uuid, destDir)
  if (!dest) throw new Error('Invalid destination')
  for (const src of sources) {
    const absSrc = await resolveInDrive(uuid, src)
    if (!absSrc) continue
    await fs.cp(absSrc, join(dest, basename(absSrc)), { recursive: true })
  }
}

export async function deleteEntries(uuid: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const abs = await resolveInDrive(uuid, p)
    if (!abs) continue
    await fs.rm(abs, { recursive: true, force: true })
    removeFromIndex(uuid, normalizeApiPath(p))
  }
}

/**
 * Finalise an uploaded temp file into place atomically. The upload is first
 * written under the drive's `.localdrive/tmp` (same filesystem), then renamed
 * so a crash never leaves a half-written file at the destination.
 */
export async function finalizeUpload(
  uuid: string,
  destDir: string,
  filename: string,
  tmpAbsPath: string,
  options?: { noReplacePart: string }
): Promise<string> {
  if (!isSafeName(filename)) throw new Error('Invalid filename')
  const dir = await resolveInDrive(uuid, destDir)
  if (!dir) throw new Error('Invalid destination')
  await fs.mkdir(dir, { recursive: true })
  const finalPath = join(dir, filename)
  if (options) {
    await copyAtomicNoReplace(tmpAbsPath, finalPath, options.noReplacePart)
  } else {
    await moveAtomic(tmpAbsPath, finalPath)
  }
  return finalPath
}

/** Allocate a temp path on the same filesystem as the drive for atomic writes. */
export async function allocTmp(uuid: string): Promise<string> {
  const appDir = await getDriveAppDir(uuid)
  const tmpDir = join(appDir, 'tmp')
  await fs.mkdir(tmpDir, { recursive: true })
  return join(tmpDir, 'up-' + randomBytes(8).toString('hex'))
}

// ---- Search index ---------------------------------------------------------

function indexEntries(uuid: string, entries: FileEntry[]): void {
  const db = getDb()
  const upsert = db.prepare(`
    INSERT INTO file_index (drive_uuid, path, name, is_dir, size, mtime_ms, mime)
    VALUES (@drive, @path, @name, @isDir, @size, @mtime, @mime)
    ON CONFLICT(drive_uuid, path) DO UPDATE SET
      name=excluded.name, is_dir=excluded.is_dir, size=excluded.size,
      mtime_ms=excluded.mtime_ms, mime=excluded.mime
  `)
  const delFts = db.prepare('DELETE FROM file_fts WHERE drive_uuid = ? AND path = ?')
  const insFts = db.prepare('INSERT INTO file_fts (name, path, drive_uuid) VALUES (?,?,?)')
  const tx = db.transaction(() => {
    for (const e of entries) {
      upsert.run({
        drive: uuid,
        path: e.path,
        name: e.name,
        isDir: e.isDir ? 1 : 0,
        size: e.size,
        mtime: Math.floor(e.mtimeMs),
        mime: e.mime
      })
      delFts.run(uuid, e.path)
      insFts.run(e.name, e.path, uuid)
    }
  })
  tx()
}

function removeFromIndex(uuid: string, path: string): void {
  const db = getDb()
  db.prepare('DELETE FROM file_index WHERE drive_uuid = ? AND (path = ? OR path LIKE ?)').run(
    uuid,
    path,
    path + '/%'
  )
  db.prepare('DELETE FROM file_fts WHERE drive_uuid = ? AND (path = ? OR path LIKE ?)').run(
    uuid,
    path,
    path + '/%'
  )
}

export interface SearchHit {
  drive: string
  name: string
  path: string
  isDir: boolean
}

export function searchFiles(query: string, driveUuid?: string, limit = 100): SearchHit[] {
  const db = getDb()
  const q = query.trim()
  if (!q) return []
  // Match filename tokens as prefixes; fall back to LIKE for short queries.
  const ftsQuery = q
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, '') + '*')
    .join(' ')
  try {
    const rows = driveUuid
      ? db
          .prepare(
            `SELECT f.drive_uuid AS drive, f.name, f.path, i.is_dir AS isDir
             FROM file_fts f JOIN file_index i
               ON i.drive_uuid=f.drive_uuid AND i.path=f.path
             WHERE file_fts MATCH ? AND f.drive_uuid = ? LIMIT ?`
          )
          .all(ftsQuery, driveUuid, limit)
      : db
          .prepare(
            `SELECT f.drive_uuid AS drive, f.name, f.path, i.is_dir AS isDir
             FROM file_fts f JOIN file_index i
               ON i.drive_uuid=f.drive_uuid AND i.path=f.path
             WHERE file_fts MATCH ? LIMIT ?`
          )
          .all(ftsQuery, limit)
    return (rows as any[]).map((r) => ({
      drive: r.drive,
      name: r.name,
      path: r.path,
      isDir: Boolean(r.isDir)
    }))
  } catch {
    return []
  }
}

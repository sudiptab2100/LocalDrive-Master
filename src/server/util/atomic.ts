import { constants, promises as fs } from 'fs'
import { constants as osConstants } from 'os'
import { dirname, join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execute = promisify(execFile)
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'])

async function renameNoReplace(src: string, dest: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw Object.assign(new Error('Atomic no-replace rename is unavailable'), { code: 'ENOTSUP' })
  }
  const packaged = process.versions.electron && !process.defaultApp && !process.env.ELECTRON_RUN_AS_NODE
  const helper = process.env.LOCALDRIVE_ATOMIC_HELPER ||
    (packaged
      ? join(process.resourcesPath, 'native', 'rename-no-replace')
      : join(process.cwd(), 'out/native/rename-no-replace'))
  try {
    await execute(helper, [src, dest], { timeout: 30_000, maxBuffer: 4096 })
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { stderr?: string }
    const errno = Number(result.stderr?.trim())
    const code = Object.entries(osConstants.errno).find(([, value]) => value === errno)?.[0]
    throw Object.assign(new Error('Atomic no-replace publication failed'), {
      code: code ?? (result.code === 'ENOENT' ? 'ENOTSUP' : 'EIO')
    })
  }
}

export async function syncFile(path: string): Promise<void> {
  const file = await fs.open(path, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function syncDirectory(path: string): Promise<void> {
  try {
    await syncFile(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Some removable filesystems do not implement directory fsync.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error
  }
}

/**
 * Publish complete bytes without replacing an existing entry, retaining the
 * source until its caller has committed a receipt. A hard link is an atomic
 * no-replace operation; cross-device/non-linking filesystems first use an owned
 * same-FS part. macOS RENAME_EXCL handles exFAT without check-then-rename races.
 */
export async function copyAtomicNoReplace(src: string, dest: string, part: string): Promise<void> {
  await syncFile(src)
  try {
    await fs.link(src, dest)
  } catch (error) {
    if (!NO_LINK.has((error as NodeJS.ErrnoException).code ?? '')) throw error
    await fs.mkdir(dirname(part), { recursive: true })
    // This name belongs to the persisted upload intent. Remove only that part,
    // and exclusively create its replacement rather than following a symlink.
    await fs.rm(part, { force: true })
    await fs.copyFile(src, part, constants.COPYFILE_EXCL)
    await syncFile(part)
    try {
      await fs.link(part, dest)
    } catch (linkError) {
      if (!NO_LINK.has((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError
      await renameNoReplace(part, dest)
    }
  }
  await syncDirectory(dirname(dest))
}

/**
 * Move a file to `dest` such that `dest` never appears partially written.
 * Fast path: rename (atomic, same filesystem). Cross-device fallback: copy to a
 * temporary sibling of `dest`, then atomically rename into place, then remove
 * the source. This preserves crash-safety at the destination.
 */
export async function moveAtomic(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest)
    return
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'EXDEV') throw err
  }
  const part = dest + '.part-' + Date.now()
  await fs.mkdir(dirname(dest), { recursive: true })
  await fs.copyFile(src, part)
  await fs.rename(part, dest)
  await fs.rm(src, { force: true })
}

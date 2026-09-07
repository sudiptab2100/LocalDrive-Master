import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'darwin') {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const argument = process.argv.indexOf('--output')
  const output = argument < 0
    ? join(root, 'out/native/rename-no-replace')
    : resolve(process.argv[argument + 1])
  mkdirSync(relative(process.cwd(), dirname(output)), { recursive: true })
  const work = join(dirname(output), `.rename-no-replace-build-${process.pid}`)
  mkdirSync(relative(process.cwd(), work))
  try {
    const built = spawnSync('/usr/bin/clang', [
      '-Os', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=11.0',
      '-arch', 'arm64', '-arch', 'x86_64',
      join(root, 'src/server/util/rename-no-replace.c'), '-o', 'rename-no-replace'
    ], { cwd: work, env: { ...process.env, TMPDIR: work }, stdio: 'inherit' })
    if (built.error) throw built.error
    if (built.status !== 0) throw new Error(`Atomic helper compilation failed (${built.status})`)
    renameSync(join(work, 'rename-no-replace'), output)
  } finally {
    rmSync(relative(process.cwd(), work), { recursive: true, force: true })
  }
}

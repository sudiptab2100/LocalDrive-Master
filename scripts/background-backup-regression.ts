import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, request } from 'node:http'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const script = fileURLToPath(import.meta.url)
const project = resolve(dirname(script), '..')
const drive = 'folder:background-backup-regression'
const fixtureArg = process.argv.indexOf('--fixtures')
const childMode = process.argv.includes('--child')
const fixture = resolve(childMode ? process.argv.at(-1)! : process.argv[fixtureArg + 1] ?? '')

if (!basename(fixture).startsWith('background-backup-server-regression-') ||
    (!childMode && fixtureArg < 0)) {
  throw new Error('Pass --fixtures <unused directory named background-backup-server-regression-...>')
}

async function runChild(): Promise<void> {
  process.env.LOCALDRIVE_HOME = join(fixture, 'home')
  process.chdir(fixture)
  await fs.mkdir('home', { recursive: true })
  const config = 'home/config.json'
  try {
    await fs.access(config)
  } catch {
    await fs.writeFile(config, JSON.stringify({
      host: '127.0.0.1', port: 0, httpsEnabled: false,
      jwtSecret: randomBytes(32).toString('hex'), shareRootName: 'LocalDrive'
    }))
  }
  try {
    await fs.access('home/localdrive.db')
  } catch {
    const Database = (await import('better-sqlite3')).default
    const old = new Database('home/localdrive.db')
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('access_model_reset', '1');
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users(username,password_hash) VALUES ('legacy-preserved','preserved-hash');
      CREATE TABLE acls (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, drive_uuid TEXT NOT NULL,
        path_prefix TEXT NOT NULL, permission TEXT NOT NULL,
        UNIQUE(user_id,drive_uuid,path_prefix)
      );
      INSERT INTO acls VALUES (1, 1, 'legacy-drive', 'legacy-home', 'write');
      CREATE TABLE stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0);
      INSERT INTO stats VALUES ('migration_marker', 73);
    `)
    old.close()
  }
  const [{ createApp }, auth, { getDb, getStats }, { BackupFileStore }, { backupByJob }] =
    await Promise.all([
      import('../src/server/http/app.js'),
      import('../src/server/auth.js'),
      import('../src/server/db/index.js'),
      import('../src/server/backup-uploads.js'),
      import('../src/server/db/backup-uploads.js')
    ])
  const db = getDb()
  assert.equal((db.prepare("SELECT password_hash FROM users WHERE username='legacy-preserved'").get() as any).password_hash, 'preserved-hash')
  assert.equal((db.prepare("SELECT count(*) AS count FROM acls WHERE drive_uuid='legacy-drive'").get() as any).count, 1)
  assert.equal(getStats().migration_marker, 73)
  if (!auth.getUserByName('alice')) {
    for (const name of ['alice', 'bob', 'admin', 'pending']) {
      const user = auth.createUser(name, 'isolated-regression-password',
        name === 'admin' ? 'admin' : 'user', name === 'pending' ? 'pending' : 'active')
      if (name !== 'admin') auth.setAcl(user.id, drive, user.home, 'write')
      await fs.mkdir(join('drive', 'LocalDrive', name), { recursive: true })
    }
    await fs.mkdir('drive/.localdrive/tmp', { recursive: true })
    db.prepare(`
      INSERT INTO drives(uuid, label, last_mount_path, filesystem, external, registered)
      VALUES (?, 'Backup regression fixture', ?, 'Folder', 0, 1)
    `).run(drive, join(fixture, 'drive'))
  }

  let fault = ''
  const uploads = join(fixture, 'home', 'uploads')
  const isStage = (path: unknown) =>
    typeof path === 'string' && dirname(path) === uploads && /^[a-f0-9]{32}$/.test(basename(path))
  const originalCreate = BackupFileStore.prototype.create
  BackupFileStore.prototype.create = async function (upload) {
    if (fault === 'create-intent') process.exit(91)
    return originalCreate.call(this, upload)
  }
  const originalOpen = fs.open.bind(fs)
  fs.open = (async (path: any, flags: any, mode: any) => {
    const file = await originalOpen(path, flags, mode)
    if (fault === 'create-file' && flags === 'wx' && isStage(path)) {
      await file.sync()
      process.exit(91)
    }
    return file
  }) as typeof fs.open
  const originalWrite = BackupFileStore.prototype.write
  BackupFileStore.prototype.write = async function (stream, id, offset) {
    const result = await originalWrite.call(this, stream, id, offset)
    if (fault === 'received-before-finish') process.exit(91)
    return result
  }
  const originalLink = fs.link.bind(fs)
  fs.link = async (source, target) => {
    if ((fault === 'cross-device' || fault === 'remote-part-crash') && isStage(source)) {
      if (fault === 'cross-device') fault = ''
      throw Object.assign(new Error('Isolated cross-device publication'), { code: 'EXDEV' })
    }
    if (fault === 'no-space' || fault === 'no-hardlinks' || fault === 'missing-helper') {
      const code = fault === 'no-space' ? 'ENOSPC' : 'ENOTSUP'
      if (fault === 'no-space') fault = ''
      throw Object.assign(new Error('Isolated publication fault'), { code })
    }
    await originalLink(source, target)
    if (fault === 'published' || fault === 'published-without-stage') {
      if (fault === 'published-without-stage') await fs.unlink(source)
      process.exit(91)
    }
  }
  const originalCopyFile = fs.copyFile.bind(fs)
  fs.copyFile = async (source, target, mode) => {
    await originalCopyFile(source, target, mode)
    if (fault === 'remote-part-crash') process.exit(91)
  }
  const originalRm = fs.rm.bind(fs)
  fs.rm = (async (path: any, options: any) => {
    if (fault === 'receipt-before-cleanup' && isStage(path)) process.exit(91)
    return originalRm(path, options)
  }) as typeof fs.rm

  const server = createServer(createApp())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  const identities = Object.fromEntries(['alice', 'bob', 'admin', 'pending'].map((name) => {
    const user = auth.getUserByName(name)!
    return [name, { id: user.id, token: auth.signToken(user) }]
  }))
  process.on('message', async (message: any) => {
    try {
      let result: any
      if (message.command === 'fault') {
        fault = message.fault
        process.env.LOCALDRIVE_ATOMIC_HELPER = join(fixture, 'native',
          fault === 'missing-helper' ? 'not-installed' : 'rename-no-replace')
      }
      else if (message.command === 'acl') {
        const user = auth.getUserByName(message.user ?? 'alice')!
        const path = message.path ?? user.home
        if (message.permission) auth.setAcl(user.id, drive, path, message.permission)
        else db.prepare('DELETE FROM acls WHERE user_id = ? AND drive_uuid = ? AND path_prefix = ?')
          .run(user.id, drive, path)
      } else if (message.command === 'registered') {
        db.prepare('UPDATE drives SET registered = ? WHERE uuid = ?').run(message.value, drive)
      } else if (message.command === 'mount') {
        db.prepare('UPDATE drives SET last_mount_path = ? WHERE uuid = ?')
          .run(join(fixture, message.directory), drive)
      } else if (message.command === 'delete-user') {
        auth.deleteUser(identities[message.user].id)
      } else if (message.command === 'ambiguous-admin') {
        const user = auth.createUser('ALICE!!!', 'isolated-regression-password', 'admin')
        identities.aliasAdmin = { id: user.id, token: auth.signToken(user) }
        result = identities.aliasAdmin
      } else if (message.command === 'row') {
        result = backupByJob(identities[message.user ?? 'alice'].id, message.jobId)
      } else if (message.command === 'snapshot') {
        result = {
          stats: getStats(),
          complete: db.prepare("SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes FROM backup_uploads WHERE state='complete'").get(),
          activity: db.prepare("SELECT count(*) AS count FROM activity WHERE action='upload'").get(),
          changes: db.prepare("SELECT count(*) AS count FROM changes WHERE action='upload'").get(),
          records: db.prepare('SELECT * FROM backup_uploads').all()
        }
      } else if (message.command === 'stage-size') {
        const row = backupByJob(identities.alice.id, message.jobId)
        try { result = (await fs.stat(join(uploads, row!.upload_id))).size } catch { result = null }
      } else throw new Error('Unknown fixture command')
      process.send?.({ requestId: message.requestId, result })
    } catch (error) {
      process.send?.({ requestId: message.requestId, error: String(error) })
    }
  })
  process.send?.({ ready: true, port: address.port, identities })
}

if (childMode) {
  await runChild()
} else {
  let child: ChildProcess | undefined
  let base = ''
  let identities: Record<string, { id: number; token: string }> = {}
  let stderr = ''
  let requestId = 0
  let legacyCompletions = 0
  let legacyBytes = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let created = false
  let imageMounted = false
  const execute = promisify(execFile)
  const imageMount = join(fixture, 'exfat-mount')

  async function start(): Promise<void> {
    stderr = ''
    child = spawn(process.execPath, ['--import', 'tsx', script, '--child', fixture], {
      cwd: project,
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALDRIVE_HOME: join(fixture, 'home'),
        LOCALDRIVE_ATOMIC_HELPER: join(fixture, 'native/rename-no-replace'),
        TSX_DISABLE_CACHE: '1', TMPDIR: join(fixture, 'cache')
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    child.stderr!.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000) })
    await new Promise<void>((done, reject) => {
      child!.once('error', reject)
      child!.once('exit', (code, signal) => {
        const error = new Error(`Isolated server exited (${code ?? signal}) ${stderr}`)
        for (const waiter of pending.values()) waiter.reject(error)
        pending.clear()
        reject(error)
      })
      child!.on('message', (message: any) => {
        if (message.ready) {
          base = `http://127.0.0.1:${message.port}`
          identities = message.identities
          done()
        } else {
          const waiter = pending.get(message.requestId)
          pending.delete(message.requestId)
          if (message.error) waiter?.reject(new Error(message.error))
          else waiter?.resolve(message.result)
        }
      })
    })
    assert.equal((await call('GET', '/api/health', '')).status, 200)
  }

  async function stop(): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }

  function control(command: string, data: Record<string, any> = {}): Promise<any> {
    const id = ++requestId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child!.send({ command, ...data, requestId: id })
    })
  }

  async function call(
    method: string, path: string, user: string | undefined = 'alice',
    body?: Buffer, extra: Record<string, string> = {}
  ) {
    const response = await fetch(new URL(path, base), {
      method, body, headers: {
        ...(user ? { Authorization: `Bearer ${identities[user].token}`, Cookie: 'ld_view=user' } : {}),
        ...(new URL(path, base).pathname.startsWith('/api/upload') ? { 'Tus-Resumable': '1.0.0' } : {}),
        ...extra
      }
    })
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, headers: response.headers, data }
  }

  function metadata(values: Record<string, string>): string {
    return Object.entries(values).map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`).join(',')
  }

  function job(bytes: string | Buffer, filename = `${randomUUID()}.jpg`, user = 'alice', path = 'Backup/Photos') {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    return { id: randomUUID(), data, filename, user, path, url: '', hash: createHash('sha256').update(data).digest('hex') }
  }
  type Job = ReturnType<typeof job>

  async function post(value: Job, extra: Record<string, string> = {}) {
    const result = await call('POST', '/api/upload', value.user, undefined, {
      'Upload-Length': String(value.data.length),
      'Upload-Metadata': metadata({
        filename: value.filename, drive, path: value.path,
        backupJobId: value.id, backupSha256: value.hash, ...extra
      })
    })
    if (result.status === 201) value.url = result.headers.get('location')!
    return result
  }
  async function create(value: Job) {
    const result = await post(value)
    assert.equal(result.status, 201, JSON.stringify(result.data))
    assert.match(value.url, /^\/api\/upload\/[a-f0-9]{32}$/)
    return value
  }
  async function patch(value: Job, offset = 0, bytes = value.data.subarray(offset), user = value.user) {
    return call('PATCH', value.url, user, bytes, {
      'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset)
    })
  }
  async function status(value: Job, user = value.user) {
    return call('GET', '/api/backup/uploads/' + value.id, user)
  }
  async function complete(value: Job) {
    if (value.data.length) {
      const patched = await patch(value)
      assert.equal(patched.status, 204, JSON.stringify(patched.data))
      assert.equal(patched.headers.get('upload-offset'), String(value.data.length))
    }
    const receipt = await status(value)
    assert.equal(receipt.status, 200, JSON.stringify(receipt.data))
    assert.equal(receipt.data.state, 'complete')
    assert.equal(receipt.data.sha256, value.hash)
    assert.equal(receipt.data.size, value.data.length)
    const actual = join(fixture, 'drive', 'LocalDrive', value.user, receipt.data.remotePath)
    assert.deepEqual(await fs.readFile(actual), value.data)
    return receipt.data
  }
  async function crashPost(value: Job, fault: string) {
    await control('fault', { fault })
    await assert.rejects(post(value))
    await stop()
    await start()
    const recovered = await status(value)
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data))
    value.url = recovered.data.uploadUrl
    return recovered.data
  }
  async function crashPatch(value: Job, fault: string) {
    await control('fault', { fault })
    let response: Awaited<ReturnType<typeof patch>> | undefined
    try { response = await patch(value) } catch { /* injected process exit loses the response */ }
    assert.equal(response, undefined, `${fault} did not interrupt PATCH: ${JSON.stringify(response?.data)}`)
    await stop()
    await start()
  }
  function streamingPatch(value: Job) {
    const upload = request(new URL(value.url, base), {
      method: 'PATCH', headers: {
        Authorization: `Bearer ${identities[value.user].token}`, Cookie: 'ld_view=user',
        'Tus-Resumable': '1.0.0', 'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream', 'Content-Length': String(value.data.length)
      }
    })
    const result = new Promise<number>((resolve) => {
      upload.on('error', () => resolve(0))
      upload.on('response', (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode!))
      })
    })
    upload.setTimeout(10_000, () => upload.destroy())
    return { upload, result }
  }
  async function waitForBytes(value: Job, minimum: number) {
    for (let i = 0; i < 150; i++) {
      if (await control('stage-size', { jobId: value.id }) >= minimum) return
      await delay(20)
    }
    throw new Error('Isolated PATCH did not reach its staged offset')
  }
  async function assertCounters() {
    const snapshot = await control('snapshot')
    assert.equal(snapshot.stats.uploads, snapshot.complete.count + legacyCompletions)
    assert.equal(snapshot.stats.bytes_in, snapshot.complete.bytes + legacyBytes)
    assert.equal(snapshot.activity.count, snapshot.stats.uploads)
    assert.equal(snapshot.changes.count, snapshot.stats.uploads)
    return snapshot
  }

  try {
    await fs.mkdir(relative(process.cwd(), fixture))
    created = true
    await fs.mkdir(relative(process.cwd(), join(fixture, 'cache')))
    if (process.platform === 'darwin') {
      const build = spawn(process.execPath, [
        join(project, 'scripts/build-atomic-helper.mjs'), '--output', join(fixture, 'native/rename-no-replace')
      ], {
        cwd: project,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TMPDIR: join(fixture, 'cache') },
        stdio: ['ignore', 'ignore', 'inherit']
      })
      const [code] = await once(build, 'exit')
      assert.equal(code, 0, 'The existing macOS compiler must build the no-replace helper')
    }
    await start()
    const health = await call('GET', '/api/health', '')
    assert.equal(health.data.capabilities.backgroundBackupTus, 1)

    const ordinary = Buffer.from('ordinary tus remains compatible')
    const legacyCookie = `ld_token=${identities.alice.token}; ld_view=user`
    const legacy = await call('POST', '/api/upload', '', undefined, {
      Cookie: legacyCookie,
      'Upload-Length': String(ordinary.length),
      'Upload-Metadata': metadata({ filename: 'legacy.txt', drive, path: '' })
    })
    assert.equal(legacy.status, 201)
    const legacyUrl = legacy.headers.get('location')!
    assert(legacyUrl.startsWith(base + '/api/upload/'))
    assert.equal((await call('PATCH', legacyUrl, '', ordinary, {
      Cookie: legacyCookie,
      'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream'
    })).status, 204)
    assert.deepEqual(await fs.readFile(join(fixture, 'drive/LocalDrive/alice/legacy.txt')), ordinary)
    legacyCompletions++
    legacyBytes += ordinary.length
    const deferredLegacy = await call('POST', '/api/upload', 'alice', undefined, {
      'Upload-Defer-Length': '1',
      'Upload-Metadata': metadata({ filename: 'legacy.txt', drive, path: '' })
    })
    assert.equal(deferredLegacy.status, 201)
    const replacement = Buffer.from('ordinary overwrite and deferred length')
    assert.equal((await call('PATCH', deferredLegacy.headers.get('location')!, 'alice', replacement, {
      'Upload-Length': String(replacement.length), 'Upload-Offset': '0',
      'Content-Type': 'application/offset+octet-stream'
    })).status, 204)
    assert.deepEqual(await fs.readFile(join(fixture, 'drive/LocalDrive/alice/legacy.txt')), replacement)
    legacyCompletions++
    legacyBytes += replacement.length
    const basic = 'Basic ' + Buffer.from('alice:isolated-regression-password').toString('base64')
    const basicBytes = Buffer.from('ordinary Basic authentication')
    const basicLegacy = await call('POST', '/api/upload', '', undefined, {
      Authorization: basic, 'Upload-Length': String(basicBytes.length),
      'Upload-Metadata': metadata({ filename: 'legacy-basic.txt', drive, path: '' })
    })
    assert.equal(basicLegacy.status, 201)
    assert.equal((await call('PATCH', basicLegacy.headers.get('location')!, '', basicBytes, {
      Authorization: basic, 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream'
    })).status, 204)
    legacyCompletions++
    legacyBytes += basicBytes.length
    console.log('PASS additive/idempotent migration, legacy tus/overwrite/deferred length and public capability')

    const scoped = await create(job('private background content', 'private.jpg'))
    assert.equal((await post(scoped)).status, 409)
    assert.equal((await post(scoped, { filename: 'different.jpg' })).status, 409)
    assert.equal((await post(scoped, { backupSha256: '0'.repeat(64) })).status, 409)
    const staleCredentials = {
      Authorization: 'Bearer invalid-or-expired',
      Cookie: `ld_view=user; ld_token=${identities.bob.token}`
    }
    const staleProfile = job('must not become bob upload', 'stale-profile.jpg')
    assert.equal((await call('POST', '/api/upload', 'alice', undefined, {
      ...staleCredentials, 'Upload-Length': String(staleProfile.data.length),
      'Upload-Metadata': metadata({
        filename: staleProfile.filename, drive, path: staleProfile.path,
        backupJobId: staleProfile.id, backupSha256: staleProfile.hash
      })
    })).status, 401)
    assert.equal((await call('GET', '/api/backup/uploads/' + scoped.id, 'alice', undefined, staleCredentials)).status, 401)
    assert.equal((await call('HEAD', scoped.url, 'alice', undefined, staleCredentials)).status, 401)
    assert.equal((await call('GET', '/api/backup/uploads/' + scoped.id, '', undefined, {
      Cookie: `ld_view=user; ld_token=${identities.alice.token}`
    })).status, 401)
    assert.equal((await call('GET', '/api/backup/uploads/' + scoped.id, '')).status, 401)
    assert.equal((await status(scoped, 'bob')).status, 404)
    assert.equal((await status(scoped, 'admin')).status, 404)
    assert.equal((await call('HEAD', scoped.url, 'bob')).status, 404)
    assert.equal((await patch(scoped, 0, scoped.data, 'bob')).status, 404)
    assert.equal((await call('GET', scoped.url, 'alice')).status, 405)
    assert.equal((await call('DELETE', scoped.url, 'alice')).status, 405)
    assert.equal((await call('HEAD', scoped.url, 'pending')).status, 401)
    const otherOwner = job('bob content', 'private.jpg', 'bob')
    otherOwner.id = scoped.id
    await create(otherOwner)
    await complete(otherOwner)
    await complete(scoped)
    assert.equal((await call('HEAD', scoped.url)).status, 410)
    assert.equal((await patch(scoped)).status, 410)
    assert.equal((await post(scoped)).status, 409)
    for (let i = 0; i < 3; i++) assert.equal((await status(scoped)).data.state, 'complete')
    await assertCounters()
    const createRace = job('simultaneous logical job creates', 'create-race.jpg')
    const raceResults = await Promise.all([post(createRace), post(createRace)])
    assert.deepEqual(raceResults.map((result) => result.status).sort(), [201, 409])
    await complete(createRace)
    const adminJob = await create(job('admin personal', 'admin-private.txt', 'admin', ''))
    await complete(adminJob)
    await assert.rejects(fs.stat(join(fixture, 'drive/LocalDrive/admin-private.txt')))
    identities.aliasAdmin = await control('ambiguous-admin')
    assert.equal((await post(job('must not enter alice home', 'alias.jpg', 'aliasAdmin'))).status, 403)
    await control('delete-user', { user: 'aliasAdmin' })
    const bodyOnCreate = job('tus creation with upload body', 'creation-body.txt')
    const postedBody = await call('POST', '/api/upload', bodyOnCreate.user, bodyOnCreate.data, {
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Length': String(bodyOnCreate.data.length),
      'Upload-Metadata': metadata({
        filename: bodyOnCreate.filename, drive, path: bodyOnCreate.path,
        backupJobId: bodyOnCreate.id, backupSha256: bodyOnCreate.hash
      })
    })
    assert.equal(postedBody.status, 201)
    assert.equal(postedBody.headers.get('upload-offset'), String(bodyOnCreate.data.length))
    assert.equal((await status(bodyOnCreate)).data.state, 'complete')
    console.log('PASS owner isolation, duplicate creation, receipt replay and admin private space')

    for (const malformed of [
      { backupJobId: 'bad-id' }, { backupSha256: 'A'.repeat(64) }, { backupSha256: '' },
      { filename: '../escape.jpg' }, { path: '../bob' }, { path: '.localdrive/tmp' }
    ]) {
      assert.equal((await post(job('reject me'), malformed)).status, 400)
    }
    const deferred = await call('POST', '/api/upload', 'alice', undefined, {
      'Upload-Defer-Length': '1',
      'Upload-Metadata': metadata({ filename: 'deferred', drive, path: '', backupJobId: randomUUID(), backupSha256: '0'.repeat(64) })
    })
    assert.equal(deferred.status, 400)
    const secrets = job('whitelisted metadata', 'metadata.jpg')
    assert.equal((await post(secrets, { authorization: 'must-not-persist-in-backup-records', ownerId: '999' })).status, 201)
    await complete(secrets)
    assert(!JSON.stringify((await control('snapshot')).records).includes('must-not-persist'))
    console.log('PASS metadata validation and credential-free owner binding')

    const resumable = await create(job('resume across an actual server process restart', 'resumable.mov'))
    assert.equal((await patch(resumable, 0, resumable.data.subarray(0, 9))).status, 204)
    await stop()
    await start()
    assert.equal((await call('HEAD', resumable.url)).headers.get('upload-offset'), '9')
    assert.equal((await patch(resumable, 0)).status, 409)
    assert.equal((await patch(resumable, 9)).status, 204)
    assert.equal((await status(resumable)).data.state, 'complete')
    await assertCounters()
    console.log('PASS partial offsets and restart resume')

    const cancelled = await create(job(randomBytes(96 * 1024), 'cancelled-transfer.mov'))
    const transfer = streamingPatch(cancelled)
    transfer.upload.write(cancelled.data.subarray(0, 4096))
    await waitForBytes(cancelled, 4096)
    const liveStatus = await status(cancelled)
    assert.equal(liveStatus.data.state, 'uploading')
    transfer.upload.destroy()
    assert.equal(await transfer.result, 0)
    const cancelledHead = await call('HEAD', cancelled.url)
    assert.equal(cancelledHead.status, 200)
    const cancelledOffset = Number(cancelledHead.headers.get('upload-offset'))
    assert(cancelledOffset > 0 && cancelledOffset < cancelled.data.length)
    assert.equal((await patch(cancelled, cancelledOffset)).status, 204)
    assert.equal((await status(cancelled)).data.state, 'complete')
    console.log('PASS cancelled file-backed PATCH, non-disruptive status polling and suffix resume')

    for (const fault of ['create-intent', 'create-file']) {
      const interrupted = job(`repair ${fault}`, `${fault}.jpg`)
      const state = await crashPost(interrupted, fault)
      assert.equal(state.state, 'uploading')
      assert.equal((await post(interrupted)).status, 409)
      assert.equal((await call('HEAD', interrupted.url)).headers.get('upload-offset'), '0')
      await complete(interrupted)
    }
    for (const fault of ['received-before-finish', 'published', 'published-without-stage', 'receipt-before-cleanup', 'remote-part-crash']) {
      const interrupted = await create(job(`repair ${fault}`, `${fault}.jpg`))
      await crashPatch(interrupted, fault)
      const recovered = await status(interrupted)
      assert.equal(recovered.data.state, 'complete', JSON.stringify(recovered.data))
      assert.equal((await status(interrupted)).data.state, 'complete')
      await assertCounters()
    }
    console.log('PASS creation, finish, publication and receipt crash boundaries / lost responses')

    const folder = join(fixture, 'drive/LocalDrive/alice/Backup/Photos')
    await fs.writeFile(join(folder, 'collision.jpg'), 'unrelated existing bytes')
    const collision = await create(job('new backup asset', 'collision.jpg'))
    const collisionReceipt = await complete(collision)
    assert.notEqual(collisionReceipt.filename, 'collision.jpg')
    assert.equal(await fs.readFile(join(folder, 'collision.jpg'), 'utf8'), 'unrelated existing bytes')
    const exact = await create(job('unrelated existing bytes', 'collision.jpg'))
    assert.equal((await complete(exact)).filename, 'collision.jpg')
    const concurrentA = await create(job('one', 'concurrent.jpg'))
    const concurrentB = await create(job('two', 'concurrent.jpg'))
    const [a, b] = await Promise.all([complete(concurrentA), complete(concurrentB)])
    assert.notEqual(a.remotePath, b.remotePath)
    await complete(await create(job('', 'empty.txt')))
    await fs.writeFile(join(folder, 'collision-crash.jpg'), 'preserve through crash')
    const collisionCrash = await create(job('new collision crash asset', 'collision-crash.jpg'))
    await crashPatch(collisionCrash, 'published-without-stage')
    const collisionRecovered = await status(collisionCrash)
    assert.equal(collisionRecovered.data.state, 'complete')
    assert.notEqual(collisionRecovered.data.filename, collisionCrash.filename)
    assert.equal(await fs.readFile(join(folder, 'collision-crash.jpg'), 'utf8'), 'preserve through crash')
    const crossDevice = await create(job('cross filesystem copy', 'cross-device.jpg'))
    await control('fault', { fault: 'cross-device' })
    await complete(crossDevice)
    assert.equal((await fs.readdir(join(fixture, 'drive/.localdrive/tmp'))).length, 0)
    if (process.platform === 'darwin') {
      const noLinksA = await create(job('no-hardlinks first', 'no-links.jpg'))
      const noLinksB = await create(job('no-hardlinks second', 'no-links.jpg'))
      await control('fault', { fault: 'no-hardlinks' })
      const [first, second] = await Promise.all([complete(noLinksA), complete(noLinksB)])
      assert.notEqual(first.remotePath, second.remotePath)
      await control('fault', { fault: '' })
      assert.equal((await fs.readdir(join(fixture, 'drive/.localdrive/tmp'))).length, 0)
      console.log('PASS native macOS atomic no-replace fallback without hardlinks')
    }
    const longExtension = 'a.' + 'b'.repeat(240)
    await fs.writeFile(join(folder, longExtension), 'existing long name')
    assert.notEqual((await complete(await create(job('new long name', longExtension)))).filename, longExtension)
    console.log('PASS non-overwriting collisions, concurrent publication, verified adoption and empty files')

    const wrongHash = await create(job('expected bytes', 'hash-mismatch.jpg'))
    const altered = Buffer.from(wrongHash.data)
    altered[0] ^= 1
    assert.equal((await patch(wrongHash, 0, altered)).status, 422)
    const failed = await status(wrongHash)
    assert.equal(failed.data.state, 'failed')
    assert.equal(failed.data.errorCode, 'checksum_mismatch')
    await assert.rejects(fs.stat(join(folder, wrongHash.filename)))
    const falseReceipt = await create(job('intended content', 'no-false-receipt.jpg'))
    await crashPatch(falseReceipt, 'published-without-stage')
    await fs.writeFile(join(folder, 'replacement.part'), 'arbitrary file!!')
    await fs.rename(join(folder, 'replacement.part'), join(folder, falseReceipt.filename))
    const notComplete = await status(falseReceipt)
    assert.equal(notComplete.data.state, 'failed')
    assert.equal(notComplete.data.errorCode, 'staging_missing')
    assert.equal(await fs.readFile(join(folder, falseReceipt.filename), 'utf8'), 'arbitrary file!!')
    await assertCounters()
    console.log('PASS hash mismatch and rejection of arbitrary same-named recovery files')

    const access = await create(job('permissions are current', 'access.jpg'))
    await control('acl', { permission: 'read', path: 'alice/Backup/Photos' })
    assert.equal((await status(access)).status, 403)
    assert.equal((await call('HEAD', access.url)).status, 403)
    assert.equal((await patch(access)).status, 403)
    await control('acl', { path: 'alice/Backup/Photos' })
    await control('registered', { value: 0 })
    assert.equal((await call('HEAD', access.url)).status, 403)
    await control('registered', { value: 1 })
    await complete(access)
    const revokedDuringPatch = await create(job('permission revoked while body arrives', 'revoke-mid-patch.jpg'))
    const revoking = streamingPatch(revokedDuringPatch)
    revoking.upload.write(revokedDuringPatch.data.subarray(0, 4))
    await waitForBytes(revokedDuringPatch, 4)
    await control('acl', { permission: 'read', path: 'alice/Backup/Photos' })
    revoking.upload.end(revokedDuringPatch.data.subarray(4))
    assert.equal(await revoking.result, 403)
    await assert.rejects(fs.stat(join(folder, revokedDuringPatch.filename)))
    assert.equal((await status(revokedDuringPatch)).status, 403)
    await control('acl', { path: 'alice/Backup/Photos' })
    assert.equal((await status(revokedDuringPatch)).data.state, 'complete')
    await fs.symlink(join(fixture, 'drive/LocalDrive/bob'), join(folder, 'peer-link'))
    assert.equal((await post(job('do not escape', 'escape.jpg', 'alice', 'Backup/Photos/peer-link'))).status, 403)
    await fs.symlink(join(folder, 'collision.jpg'), join(folder, 'linked.jpg'))
    assert.notEqual((await complete(await create(job('unrelated existing bytes', 'linked.jpg')))).filename, 'linked.jpg')
    console.log('PASS current nested ACLs, registration and symlink confinement')

    const offline = await create(job('offline destination resume', 'offline.jpg'))
    assert.equal((await patch(offline, 0, offline.data.subarray(0, 4))).status, 204)
    await fs.rename(join(fixture, 'drive'), join(fixture, 'drive-offline'))
    const waiting = await status(offline)
    assert.equal(waiting.data.state, 'uploading')
    assert.equal(waiting.data.errorCode, 'destination_offline')
    assert.equal(waiting.data.retryable, true)
    assert.equal((await call('HEAD', offline.url)).headers.get('upload-offset'), '4')
    assert.equal((await patch(offline, 4)).status, 503)
    await control('mount', { directory: 'drive-offline' })
    assert.equal((await patch(offline, 4)).status, 204)
    assert.equal((await status(offline)).data.state, 'complete')
    await fs.rename(join(fixture, 'drive-offline'), join(fixture, 'drive'))
    await control('mount', { directory: 'drive' })
    const offlineDuringPatch = await create(job('drive unplugged while body arrives', 'unplug-mid-patch.jpg'))
    const unplugging = streamingPatch(offlineDuringPatch)
    unplugging.upload.write(offlineDuringPatch.data.subarray(0, 5))
    await waitForBytes(offlineDuringPatch, 5)
    await fs.rename(join(fixture, 'drive'), join(fixture, 'drive-offline'))
    unplugging.upload.end(offlineDuringPatch.data.subarray(5))
    assert.equal(await unplugging.result, 503)
    const finalizingOffline = await status(offlineDuringPatch)
    assert.equal(finalizingOffline.data.state, 'finalizing')
    assert.equal(finalizingOffline.data.errorCode, 'destination_offline')
    assert.equal(finalizingOffline.data.offset, offlineDuringPatch.data.length)
    await stop()
    await start()
    assert.equal((await status(offlineDuringPatch)).data.state, 'finalizing')
    await control('mount', { directory: 'drive-offline' })
    assert.equal((await status(offlineDuringPatch)).data.state, 'complete')
    await fs.rename(join(fixture, 'drive-offline'), join(fixture, 'drive'))
    await control('mount', { directory: 'drive' })
    const offlineAfterPublish = await create(job('published before unplugging', 'published-offline.jpg'))
    await crashPatch(offlineAfterPublish, 'published-without-stage')
    await fs.rename(join(fixture, 'drive'), join(fixture, 'drive-offline'))
    assert.equal((await status(offlineAfterPublish)).data.state, 'finalizing')
    await control('mount', { directory: 'drive-offline' })
    assert.equal((await status(offlineAfterPublish)).data.state, 'complete')
    await fs.rename(join(fixture, 'drive-offline'), join(fixture, 'drive'))
    await control('mount', { directory: 'drive' })
    for (const [fault, errorCode] of [['no-space', 'destination_full'], ['missing-helper', 'destination_atomic_publish_unsupported']]) {
      const retryable = await create(job(`retry ${fault}`, `${fault}.jpg`))
      await control('fault', { fault })
      const result = await patch(retryable)
      assert.equal(result.status, fault === 'no-space' ? 507 : 503)
      const row = await control('row', { jobId: retryable.id })
      assert.equal(row.state, 'finalizing')
      assert.equal(row.error_code, errorCode)
      assert.equal(await control('stage-size', { jobId: retryable.id }), retryable.data.length)
      await control('fault', { fault: '' })
      assert.equal((await status(retryable)).data.state, 'complete')
    }
    await assertCounters()
    console.log('PASS offline/remounted destinations and retryable publication failures')
    if (process.platform === 'darwin' && process.argv.includes('--exfat')) {
      const image = join(fixture, 'exfat.dmg')
      await fs.mkdir(relative(process.cwd(), imageMount))
      const environment = { ...process.env, TMPDIR: join(fixture, 'cache') }
      let canMount = true
      try {
        await execute('/usr/bin/hdiutil', [
          'create', '-size', '64m', '-type', 'UDIF', '-layout', 'NONE', '-fs', 'ExFAT',
          '-volname', 'LDBackupRegression', image
        ], { env: environment })
      } catch (error) {
        if (!(error as { stderr?: string }).stderr?.includes('Operation not permitted')) throw error
        canMount = false
        console.log('SKIP real exFAT: macOS denied isolated disk-image creation (no privilege escalation).')
      }
      if (canMount) {
        await execute('/usr/bin/hdiutil', [
          'attach', '-quiet', '-nobrowse', '-mountpoint', imageMount, image
        ], { env: environment })
        imageMounted = true
        await control('mount', { directory: 'exfat-mount' })
        const exfatA = await create(job('real exfat first', 'exfat.jpg'))
        const exfatB = await create(job('real exfat second', 'exfat.jpg'))
        const results = await Promise.all([patch(exfatA), patch(exfatB)])
        assert(results.every((result) => result.status === 204), JSON.stringify(results.map((result) => result.data)))
        const receipts = await Promise.all([status(exfatA), status(exfatB)])
        assert(receipts.every((receipt) => receipt.data.state === 'complete'))
        assert.notEqual(receipts[0].data.remotePath, receipts[1].data.remotePath)
        for (const [index, value] of [exfatA, exfatB].entries()) {
          assert.deepEqual(await fs.readFile(join(imageMount, 'LocalDrive/alice', receipts[index].data.remotePath)), value.data)
        }
        await assertCounters()
        await control('mount', { directory: 'drive' })
        await execute('/usr/bin/hdiutil', ['detach', '-quiet', imageMount], { env: environment })
        imageMounted = false
        console.log('PASS actual exFAT disk-image transfers and non-overwriting concurrent finalization')
      }
    }
    const deletedOwner = await create(job('deleted owners cannot expose staged bytes', 'deleted-owner.jpg', 'bob'))
    await control('delete-user', { user: 'bob' })
    assert.equal((await status(deletedOwner, 'alice')).status, 404)
    assert.equal((await call('HEAD', deletedOwner.url, 'alice')).status, 404)
    assert.equal((await call('GET', deletedOwner.url, 'alice')).status, 404)
    assert.equal((await patch(deletedOwner, 0, deletedOwner.data, 'alice')).status, 404)
    console.log('PASS deleted-owner staging remains inaccessible')
    console.log('All isolated background-backup server regressions passed.')
  } finally {
    await stop()
    if (imageMounted) {
      await execute('/usr/bin/hdiutil', ['detach', '-quiet', imageMount], {
        env: { ...process.env, TMPDIR: join(fixture, 'cache') }
      })
      imageMounted = false
    }
    if (created) await fs.rm(relative(process.cwd(), fixture), { recursive: true, force: true })
  }
}

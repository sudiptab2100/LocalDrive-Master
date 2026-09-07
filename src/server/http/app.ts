import express, { type Express, type RequestHandler } from 'express'
import { existsSync } from 'fs'
import { join } from 'path'
import { attachUser, requireAuth } from './middleware.js'
import { authRouter } from './routes/auth.js'
import { drivesRouter } from './routes/drives.js'
import { filesRouter } from './routes/files.js'
import { uploadRouter } from './routes/uploads.js'
import { backupRouter } from './routes/backup.js'
import { searchRouter } from './routes/search.js'
import { statsRouter } from './routes/stats.js'
import { usersRouter } from './routes/users.js'
import { accessRouter } from './routes/access.js'
import { configRouter } from './routes/config.js'
import { serverRouter } from './routes/server.js'
import { eventsRouter } from './routes/events.js'
import { changesRouter } from './routes/changes.js'
import { getStatus } from '../status.js'
import { getCaCertPem } from '../tls.js'
import { qrDataUrl } from '../discovery.js'
import { pickQrUrl, lanAddresses } from '../util/net.js'

/** Holder allowing the WebDAV handler to be swapped when drives change. */
let webdavHandler: RequestHandler | null = null
export function setWebdavHandler(h: RequestHandler | null): void {
  webdavHandler = h
}

export interface AppOptions {
  webuiDir?: string
  /** Directory of the built admin control panel, served under `/admin`. */
  adminDir?: string
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  // Identify the user early (cookie / bearer / basic) for all routes.
  app.use(attachUser)

  // Raw-body routes must come before the JSON parser.
  app.use('/api/upload', uploadRouter)
  // WebDAV must see the full `/dav/...` URL, so mount at root and gate by prefix.
  app.use((req, res, next) => {
    if (!req.path.startsWith('/dav')) return next()
    if (webdavHandler) return webdavHandler(req, res, next)
    res.status(503).json({ error: 'WebDAV not available (no registered drives)' })
  })

  app.use(express.json({ limit: '5mb' }))

  // Health check (unauthenticated).
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, status: getStatus(), capabilities: { backgroundBackupTus: 1 } })
  })

  // Download the root CA certificate for client trust installation. The CA
  // certificate is public (holds no secret), and devices need it before they
  // can trust the server, so this endpoint is intentionally unauthenticated.
  app.get('/api/cert', (_req, res) => {
    const pem = getCaCertPem()
    if (!pem) {
      res.status(404).json({ error: 'No certificate available (enable HTTPS first)' })
      return
    }
    res.setHeader('Content-Type', 'application/x-x509-ca-cert')
    res.setHeader('Content-Disposition', 'attachment; filename="LocalDrive-CA.crt"')
    res.send(pem)
  })

  app.use('/api/auth', authRouter)
  app.use('/api/drives', drivesRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/backup/uploads', backupRouter)
  app.use('/api/search', searchRouter)
  app.use('/api/stats', statsRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/access', accessRouter)
  app.use('/api/config', configRouter)
  app.use('/api/server', serverRouter)
  app.use('/api/events', eventsRouter)
  app.use('/api/changes', changesRouter)

  // Connection info + QR code for easy device onboarding.
  app.get('/api/connect', requireAuth, async (_req, res) => {
    const status = getStatus()
    const primary = pickQrUrl(status.urls, status.port)
    res.json({
      urls: status.urls,
      hostname: status.hostname,
      qr: await qrDataUrl(primary),
      addresses: lanAddresses(),
      httpsEnabled: status.https,
      port: status.port,
      httpsPort: status.httpsPort
    })
  })

  // Serve the admin control panel (mounted before the webui catch-all so its
  // deep links resolve to the admin bundle, not the client PWA).
  const adminDir = opts.adminDir
  if (adminDir && existsSync(adminDir)) {
    app.use('/admin', express.static(adminDir))
    app.get('/admin/*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/dav')) return next()
      const index = join(adminDir, 'index.html')
      if (existsSync(index)) return res.sendFile(index)
      next()
    })
  }

  // Serve the client PWA and fall back to index.html for client-side routing.
  const webuiDir = opts.webuiDir
  if (webuiDir && existsSync(webuiDir)) {
    app.use(express.static(webuiDir))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/dav')) return next()
      const index = join(webuiDir, 'index.html')
      if (existsSync(index)) return res.sendFile(index)
      next()
    })
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(
        '<h1>LocalDrive server is running</h1><p>The web UI has not been built yet. Run <code>npm run build:webui</code>.</p>'
      )
    })
  }

  // JSON error handler.
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message || 'Internal error' })
  })

  return app
}

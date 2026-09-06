import { Bonjour, type Service } from 'bonjour-service'
import QRCode from 'qrcode'

/** Advertises the server on the LAN via mDNS so it appears as MacName.local. */

let bonjour: Bonjour | null = null
let services: Service[] = []

export function startDiscovery(port: number, opts: { httpsPort?: number } = {}): void {
  stopDiscovery()
  try {
    bonjour = new Bonjour()
    // Dedicated LocalDrive service type. Native clients (the mobile app) browse
    // `_localdrive._tcp` for a reliable, unambiguous match instead of scanning
    // every `_http._tcp` host on the LAN. TXT records let a client connect
    // without an extra round-trip: whether HTTPS is available and on which port.
    services.push(
      bonjour.publish({
        name: 'LocalDrive',
        type: 'localdrive',
        port,
        txt: {
          path: '/',
          api: '/api',
          https: opts.httpsPort ? '1' : '0',
          httpsPort: opts.httpsPort ? String(opts.httpsPort) : '',
        },
      })
    )
    services.push(
      bonjour.publish({ name: 'LocalDrive', type: 'http', port, txt: { path: '/' } })
    )
    services.push(bonjour.publish({ name: 'LocalDrive WebDAV', type: 'webdav', port, txt: { path: '/dav' } }))
    // When HTTPS is enabled, advertise the secure endpoints too so capable
    // clients can prefer the encrypted service.
    if (opts.httpsPort) {
      services.push(
        bonjour.publish({ name: 'LocalDrive (HTTPS)', type: 'https', port: opts.httpsPort, txt: { path: '/' } })
      )
      services.push(
        bonjour.publish({
          name: 'LocalDrive WebDAV (HTTPS)',
          type: 'webdavs',
          port: opts.httpsPort,
          txt: { path: '/dav' }
        })
      )
    }
  } catch {
    /* mDNS is best-effort; ignore failures */
  }
}

export function stopDiscovery(): void {
  try {
    for (const s of services) s.stop?.()
    services = []
    bonjour?.destroy()
  } catch {
    /* ignore */
  }
  bonjour = null
}

export async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 1, width: 240 })
}

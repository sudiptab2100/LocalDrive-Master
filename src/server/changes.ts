import { recordChange } from './db/index.js'
import { bus, EVENTS } from './events.js'

/**
 * Record a file/folder mutation and broadcast it on the bus. The user-facing
 * SSE stream (`/api/events/user`) filters these per-viewer by read permission,
 * and the `/api/changes` polling feed reads them back from the database.
 *
 * `path` must be the full drive-relative path of the affected location so
 * consumers can permission-check it and map it into each viewer's own scope.
 */
export function fileChanged(opts: {
  action: string
  driveUuid: string
  path: string
  userId?: number | null
  username?: string | null
}): void {
  try {
    const row = recordChange({
      kind: 'file',
      action: opts.action,
      driveUuid: opts.driveUuid,
      path: opts.path,
      userId: opts.userId ?? null,
      username: opts.username ?? null
    })
    bus.emit(EVENTS.filesChanged, row)
  } catch {
    /* change tracking is best-effort; never fail the originating request */
  }
}

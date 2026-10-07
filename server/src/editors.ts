import type { NextFunction, Request, Response } from 'express'

/**
 * Who may change things (upload, delete, regenerate meshes, save a volume's
 * default look or crop box): "editors". Everyone else views.
 *
 * EDITORS=local (the default): requests from this machine -- the person
 * running the server -- and no one else. A request counts as local when its
 * connection and every hop it was forwarded through (X-Forwarded-For, which
 * the dev/preview proxy adds) are loopback addresses.
 * EDITORS=all: everyone (a trusted network). EDITORS=none: no one.
 */
const mode = (process.env.EDITORS ?? 'local').toLowerCase()

const isLoopback = (address: string | undefined) => {
  const a = (address ?? '').trim().replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.')
}

export function isEditor<P>(req: Request<P>): boolean {
  if (mode === 'all') return true
  if (mode === 'none') return false
  const forwarded = req.headers['x-forwarded-for']
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').filter((h) => h.trim())
  return isLoopback(req.socket.remoteAddress) && hops.every(isLoopback)
}

/** Express middleware: 403 for anyone who isn't an editor. */
export function requireEditor<P>(req: Request<P>, res: Response, next: NextFunction): void {
  if (isEditor(req)) {
    next()
    return
  }
  res.status(403).json({ error: 'Only editors can change this (see EDITORS on the server)' })
}

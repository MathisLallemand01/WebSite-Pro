import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReviewsStore } from './reviewsStore.js'

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST_DIR = resolve(ROOT_DIR, 'dist')

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fallback
  }

  return parsed
}

const MAX_BODY_SIZE = readPositiveIntEnv('MAX_BODY_SIZE', 100_000)
const REQUEST_TIMEOUT_MS = readPositiveIntEnv('REQUEST_TIMEOUT_MS', 10_000)
const RATE_LIMIT_WINDOW_MS = readPositiveIntEnv('RATE_LIMIT_WINDOW_MS', 10 * 60_000)
const RATE_LIMIT_MAX_POSTS = readPositiveIntEnv('RATE_LIMIT_MAX_POSTS', 20)
const PORT = readPositiveIntEnv('PORT', 3001)

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const corsOriginEnv = process.env.CORS_ORIGIN || ''
const allowAnyCorsOrigin = corsOriginEnv.trim() === '*'
const allowedCorsOrigins = new Set(
  corsOriginEnv
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value !== '*'),
)

const postRateLimitStore = new Map()
const rateLimitSweepTimer = setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of postRateLimitStore.entries()) {
    if (entry.resetAt <= now) {
      postRateLimitStore.delete(ip)
    }
  }
}, Math.max(30_000, Math.floor(RATE_LIMIT_WINDOW_MS / 2)))
rateLimitSweepTimer.unref?.()

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('X-DNS-Prefetch-Control', 'off')
}

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary')
  if (!current) {
    res.setHeader('Vary', value)
    return
  }

  const parts = String(current)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  if (!parts.includes(value)) {
    parts.push(value)
    res.setHeader('Vary', parts.join(', '))
  }
}

function getRequestOrigin(req) {
  return typeof req.headers.origin === 'string' ? req.headers.origin.trim() : ''
}

function getRequestHost(req) {
  if (typeof req.headers['x-forwarded-host'] === 'string') {
    const forwardedHost = req.headers['x-forwarded-host'].split(',')[0]?.trim()
    if (forwardedHost) return forwardedHost
  }

  return typeof req.headers.host === 'string' ? req.headers.host.trim() : ''
}

function isSameOriginRequest(req, origin) {
  if (!origin) return true

  try {
    return new URL(origin).host === getRequestHost(req)
  } catch {
    return false
  }
}

function setApiCorsHeaders(req, res) {
  const origin = getRequestOrigin(req)
  if (!origin || isSameOriginRequest(req, origin)) {
    return true
  }

  if (allowAnyCorsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else if (allowedCorsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    appendVaryHeader(res, 'Origin')
  } else {
    return false
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Max-Age', '600')
  return true
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  Object.entries(JSON_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value)
  })
  res.end(JSON.stringify(payload))
}

function hasJsonContentType(req) {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string') return false
  return contentType.toLowerCase().includes('application/json')
}

async function readJsonBody(req) {
  const contentLength = Number(req.headers['content-length'] || 0)
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return { error: 'payload_too_large' }
  }

  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_SIZE) {
      return { error: 'payload_too_large' }
    }
  }

  try {
    return { data: JSON.parse(body || '{}') }
  } catch {
    return { error: 'invalid_json' }
  }
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim()
  }

  return req.socket.remoteAddress || 'unknown'
}

function enforcePostRateLimit(req, res) {
  const ip = getClientIp(req)
  const now = Date.now()
  const existing = postRateLimitStore.get(ip)

  if (!existing || existing.resetAt <= now) {
    postRateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return true
  }

  existing.count += 1

  const remaining = Math.max(0, RATE_LIMIT_MAX_POSTS - existing.count)
  const resetAtSeconds = Math.ceil(existing.resetAt / 1000)
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_POSTS))
  res.setHeader('X-RateLimit-Remaining', String(remaining))
  res.setHeader('X-RateLimit-Reset', String(resetAtSeconds))

  if (existing.count > RATE_LIMIT_MAX_POSTS) {
    const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retryAfter))
    sendJson(res, 429, { error: 'Trop de requetes. Reessayez plus tard.' })
    return false
  }

  return true
}

function resolveStaticFilePath(pathname) {
  let decodedPath = pathname

  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  const normalizedPath = posix.normalize(decodedPath).replace(/^\/+/, '')
  const candidatePath = resolve(DIST_DIR, normalizedPath || 'index.html')
  const distPrefix = DIST_DIR.endsWith(sep) ? DIST_DIR : `${DIST_DIR}${sep}`

  if (candidatePath !== DIST_DIR && !candidatePath.startsWith(distPrefix)) {
    return null
  }

  return candidatePath
}

async function fileExists(pathname) {
  try {
    await access(pathname)
    return true
  } catch {
    return false
  }
}

async function sendFile(req, res, pathname) {
  const extension = extname(pathname).toLowerCase()
  const contentType = MIME_TYPES[extension] || 'application/octet-stream'
  const isHeadRequest = req.method === 'HEAD'

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  res.setHeader('Cache-Control', extension === '.html' ? 'no-store' : 'public, max-age=31536000, immutable')

  if (isHeadRequest) {
    res.end()
    return
  }

  createReadStream(pathname).pipe(res)
}

async function handleApi(req, res, store) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname !== '/api/reviews') return false

  if (!setApiCorsHeaders(req, res)) {
    sendJson(res, 403, { error: 'Origine non autorisee.' })
    return true
  }

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }

  if (req.method === 'HEAD') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end()
    return true
  }

  if (req.method === 'GET') {
    sendJson(res, 200, { reviews: store.list() })
    return true
  }

  if (req.method === 'POST') {
    if (!hasJsonContentType(req)) {
      sendJson(res, 415, { error: 'Content-Type application/json requis.' })
      return true
    }

    if (!enforcePostRateLimit(req, res)) {
      return true
    }

    const body = await readJsonBody(req)
    if (body.error === 'payload_too_large') {
      sendJson(res, 413, { error: 'Payload trop volumineux.' })
      return true
    }

    if (body.error === 'invalid_json') {
      sendJson(res, 400, { error: 'Corps JSON invalide.' })
      return true
    }

    const created = store.add(body.data)
    if (!created) {
      sendJson(res, 400, { error: 'Donnees invalides.' })
      return true
    }

    sendJson(res, 201, { review: created })
    return true
  }

  res.setHeader('Allow', 'GET,HEAD,POST,OPTIONS')
  sendJson(res, 405, { error: 'Methode non autorisee.' })
  return true
}

async function handleStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET,HEAD')
    sendJson(res, 405, { error: 'Methode non autorisee.' })
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  let filePath = resolveStaticFilePath(url.pathname)
  if (!filePath) {
    sendJson(res, 400, { error: 'Chemin invalide.' })
    return
  }

  const requestedExtension = extname(url.pathname)

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
  } catch {
    if (!requestedExtension) {
      filePath = resolve(DIST_DIR, 'index.html')
    } else {
      sendJson(res, 404, { error: 'Ressource introuvable.' })
      return
    }
  }

  if (!(await fileExists(filePath))) {
    sendJson(res, 500, { error: 'Build manquant. Lancez npm run build.' })
    return
  }

  await sendFile(req, res, filePath)
}

const store = createReviewsStore()

const server = createServer(async (req, res) => {
  setSecurityHeaders(res)

  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      sendJson(res, 408, { error: 'Delai de requete depasse.' })
    } else {
      res.destroy()
    }
  })

  try {
    if (await handleApi(req, res, store)) {
      return
    }

    await handleStatic(req, res)
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Erreur serveur.' })
      return
    }

    res.destroy()
  }
})

server.requestTimeout = REQUEST_TIMEOUT_MS
server.headersTimeout = REQUEST_TIMEOUT_MS + 5_000

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})

function shutdown() {
  clearInterval(rateLimitSweepTimer)

  try {
    store.close()
  } catch {
    // ignore close errors during shutdown
  }

  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

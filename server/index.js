import { createReadStream } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReviewsStore } from './reviewsStore.js'

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DIST_DIR = resolve(ROOT_DIR, 'dist')
const MAX_BODY_SIZE = 100_000
const PORT = Number(process.env.PORT || 3001)

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

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function setCorsHeaders(res) {
  const allowedOrigin = process.env.CORS_ORIGIN || '*'
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res)
  res.statusCode = statusCode

  Object.entries(JSON_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  let body = ''

  for await (const chunk of req) {
    body += chunk
    if (body.length > MAX_BODY_SIZE) return null
  }

  try {
    return JSON.parse(body || '{}')
  } catch {
    return null
  }
}

function getSafeFilePath(pathname) {
  const normalizedPath = normalize(pathname).replace(/^([.][.][/\\])+/, '')
  const safePath = normalizedPath === '/' ? '/index.html' : normalizedPath
  return resolve(DIST_DIR, `.${safePath}`)
}

async function fileExists(pathname) {
  try {
    await access(pathname)
    return true
  } catch {
    return false
  }
}

async function sendFile(res, pathname) {
  const extension = extname(pathname).toLowerCase()
  const contentType = MIME_TYPES[extension] || 'application/octet-stream'

  res.statusCode = 200
  res.setHeader('Content-Type', contentType)
  createReadStream(pathname).pipe(res)
}

async function handleApi(req, res, store) {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  if (pathname !== '/api/reviews') return false

  if (req.method === 'OPTIONS') {
    setCorsHeaders(res)
    res.statusCode = 204
    res.end()
    return true
  }

  if (req.method === 'GET') {
    sendJson(res, 200, { reviews: store.list() })
    return true
  }

  if (req.method === 'POST') {
    const body = await readJsonBody(req)
    if (!body) {
      sendJson(res, 400, { error: 'Corps JSON invalide.' })
      return true
    }

    const created = store.add(body)
    if (!created) {
      sendJson(res, 400, { error: 'Donnees invalides.' })
      return true
    }

    sendJson(res, 201, { review: created })
    return true
  }

  sendJson(res, 405, { error: 'Methode non autorisee.' })
  return true
}

async function handleStatic(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  let filePath = getSafeFilePath(url.pathname)

  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html')
    }
  } catch {
    filePath = resolve(DIST_DIR, 'index.html')
  }

  if (!(await fileExists(filePath))) {
    sendJson(res, 500, { error: 'Build manquant. Lancez npm run build.' })
    return
  }

  await sendFile(res, filePath)
}

const store = createReviewsStore()

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res, store)) {
      return
    }

    await handleStatic(req, res)
  } catch {
    sendJson(res, 500, { error: 'Erreur serveur.' })
  }
})

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`)
})

function shutdown() {
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


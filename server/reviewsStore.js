import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_DB_PATH = resolve(ROOT_DIR, 'data', 'reviews.sqlite')
const DB_PATH = process.env.REVIEWS_DB_PATH
  ? resolve(process.env.REVIEWS_DB_PATH)
  : DEFAULT_DB_PATH

function ensureDir(pathname) {
  mkdirSync(dirname(pathname), { recursive: true })
}

function createDb() {
  ensureDir(DB_PATH)
  const db = new DatabaseSync(DB_PATH)

  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  return db
}

function normalizeReview(input) {
  const name = String(input?.name ?? '').trim()
  const role = String(input?.role ?? '').trim() || 'Client'
  const text = String(input?.text ?? '').trim()
  const rating = Number(input?.rating ?? 0)

  if (!name || !text || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return null
  }

  return {
    name: name.slice(0, 80),
    role: role.slice(0, 90),
    text: text.slice(0, 800),
    rating,
  }
}

function toRowReview(row) {
  const payload = JSON.parse(row.payload)
  return {
    id: row.id,
    name: payload.name,
    role: payload.role,
    rating: payload.rating,
    text: payload.text,
    createdAt: row.created_at,
  }
}

export function createReviewsStore() {
  const db = createDb()

  const selectStmt = db.prepare('SELECT id, payload, created_at FROM reviews ORDER BY id DESC LIMIT 200')
  const insertStmt = db.prepare('INSERT INTO reviews (payload, created_at) VALUES (?, ?)')

  return {
    list() {
      return selectStmt.all().map(toRowReview)
    },
    add(input) {
      const normalized = normalizeReview(input)
      if (!normalized) return null

      const createdAt = new Date().toISOString()
      const result = insertStmt.run(JSON.stringify(normalized), createdAt)
      return {
        id: Number(result.lastInsertRowid),
        ...normalized,
        createdAt,
      }
    },
    close() {
      db.close()
    },
  }
}

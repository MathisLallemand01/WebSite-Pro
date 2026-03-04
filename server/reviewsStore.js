const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '')
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
const SUPABASE_REVIEWS_TABLE = (process.env.SUPABASE_REVIEWS_TABLE || 'reviews').trim()
const SUPABASE_SCHEMA = (process.env.SUPABASE_SCHEMA || 'public').trim()
const SUPABASE_TIMEOUT_MS = readPositiveIntEnv('SUPABASE_TIMEOUT_MS', 8_000)

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return fallback
  }

  return parsed
}

function getMissingSupabaseEnvVars() {
  const missing = []
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_REVIEWS_TABLE) missing.push('SUPABASE_REVIEWS_TABLE')
  return missing
}

function createStoreNotConfiguredError() {
  const missingEnv = getMissingSupabaseEnvVars()
  const error = new Error('Supabase reviews store is not configured.')
  error.code = 'reviews_store_not_configured'
  error.missingEnv = missingEnv
  return error
}

function createSupabaseHttpError(status, details) {
  const error = new Error('Supabase request failed.')
  error.code = 'supabase_http_error'
  error.status = status
  error.details = details
  return error
}

function createSupabaseTimeoutError() {
  const error = new Error('Supabase request timed out.')
  error.code = 'supabase_timeout'
  return error
}

async function readResponseBody(response) {
  const raw = await response.text()
  if (!raw) return null

  try {
    return JSON.parse(raw)
  } catch {
    return { raw }
  }
}

function createReviewsTableUrl(queryParams) {
  const endpoint = new URL(`/rest/v1/${encodeURIComponent(SUPABASE_REVIEWS_TABLE)}`, `${SUPABASE_URL}/`)
  if (!queryParams) {
    return endpoint
  }

  Object.entries(queryParams).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    endpoint.searchParams.set(key, String(value))
  })
  return endpoint
}

async function supabaseRequest({ method, query, body, prefer }) {
  if (getMissingSupabaseEnvVars().length > 0) {
    throw createStoreNotConfiguredError()
  }

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS)

  try {
    const response = await fetch(createReviewsTableUrl(query), {
      method,
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
        ...(SUPABASE_SCHEMA ? { 'Accept-Profile': SUPABASE_SCHEMA } : {}),
        ...(SUPABASE_SCHEMA ? { 'Content-Profile': SUPABASE_SCHEMA } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    const parsedBody = await readResponseBody(response)
    if (!response.ok) {
      throw createSupabaseHttpError(response.status, parsedBody)
    }

    return parsedBody
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createSupabaseTimeoutError()
    }
    throw error
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function stripControlChars(value, { keepNewLines = false } = {}) {
  let output = ''

  for (const char of value) {
    const code = char.charCodeAt(0)
    const isControl = (code >= 0 && code <= 31) || code === 127

    if (!isControl) {
      output += char
      continue
    }

    if (keepNewLines && (char === '\n' || char === '\t')) {
      output += char
    }
  }

  return output
}

function sanitizeSingleLine(value, maxLength) {
  return stripControlChars(String(value ?? '').normalize('NFKC').replace(/\r\n?/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function sanitizeMultiline(value, maxLength) {
  return stripControlChars(String(value ?? '').normalize('NFKC').replace(/\r\n?/g, '\n'), {
    keepNewLines: true,
  })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

function normalizeReview(input) {
  const name = sanitizeSingleLine(input?.name, 80)
  const role = sanitizeSingleLine(input?.role, 90) || 'Client'
  const text = sanitizeMultiline(input?.text, 800)
  const rating = Number(input?.rating ?? 0)

  if (!name || !text || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return null
  }

  return {
    name,
    role,
    text,
    rating,
  }
}

function toRowReview(row) {
  if (!row || typeof row !== 'object') return null

  const id = Number(row.id)
  const rating = Number(row.rating)
  const createdAt =
    typeof row.created_at === 'string'
      ? row.created_at
      : typeof row.createdAt === 'string'
        ? row.createdAt
        : ''

  if (!Number.isInteger(id) || id <= 0) return null
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null

  const name = typeof row.name === 'string' ? row.name : ''
  const role = typeof row.role === 'string' ? row.role : 'Client'
  const text = typeof row.text === 'string' ? row.text : ''
  if (!name || !text) return null

  return {
    id,
    name,
    role: role || 'Client',
    text,
    rating,
    createdAt: createdAt || new Date(0).toISOString(),
  }
}

export function createReviewsStore() {
  return {
    isConfigured() {
      return getMissingSupabaseEnvVars().length === 0
    },
    getMissingEnvVars() {
      return getMissingSupabaseEnvVars()
    },
    async list() {
      const rows = await supabaseRequest({
        method: 'GET',
        query: {
          select: 'id,name,role,rating,text,created_at',
          order: 'id.desc',
          limit: '200',
        },
      })

      if (!Array.isArray(rows)) return []
      return rows.map(toRowReview).filter(Boolean)
    },
    async add(input) {
      const normalized = normalizeReview(input)
      if (!normalized) return null

      const rows = await supabaseRequest({
        method: 'POST',
        prefer: 'return=representation',
        query: {
          select: 'id,name,role,rating,text,created_at',
        },
        body: {
          ...normalized,
          created_at: new Date().toISOString(),
        },
      })

      const created = Array.isArray(rows) ? rows[0] : null
      return toRowReview(created)
    },
    async update(id, input) {
      const numericId = Number(id)
      if (!Number.isInteger(numericId) || numericId <= 0) return null

      const existingRows = await supabaseRequest({
        method: 'GET',
        query: {
          select: 'id,name,role,rating,text,created_at',
          id: `eq.${numericId}`,
          limit: '1',
        },
      })

      const current = Array.isArray(existingRows) ? toRowReview(existingRows[0]) : null
      if (!current) return null

      const mergedInput = {
        name: input?.name ?? current.name,
        role: input?.role ?? current.role,
        text: input?.text ?? current.text,
        rating: input?.rating ?? current.rating,
      }
      const normalized = normalizeReview(mergedInput)
      if (!normalized) return false

      const rows = await supabaseRequest({
        method: 'PATCH',
        prefer: 'return=representation',
        query: {
          select: 'id,name,role,rating,text,created_at',
          id: `eq.${numericId}`,
        },
        body: normalized,
      })

      const updated = Array.isArray(rows) ? rows[0] : null
      return toRowReview(updated)
    },
    async remove(id) {
      const numericId = Number(id)
      if (!Number.isInteger(numericId) || numericId <= 0) return false

      const rows = await supabaseRequest({
        method: 'DELETE',
        prefer: 'return=representation',
        query: {
          select: 'id',
          id: `eq.${numericId}`,
        },
      })

      return Array.isArray(rows) && rows.length > 0
    },
    close() {
      // no-op for Supabase HTTP client
    },
  }
}

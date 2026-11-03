/**
 * `dsh-seesion-copy-enhance` — host half.
 *
 * The browser half cannot reach Host services (installed client modules have no
 * RPC surface), so this half exposes a tiny same-origin HTTP bridge:
 *
 *   GET  /dsh-seesion-copy-enhance/health   liveness probe
 *   GET  /dsh-seesion-copy-enhance/inspect  live user messages at shape level
 *   POST /dsh-seesion-copy-enhance/capture  { sessionId, seq?, fromEnd?, text? }
 *                                           -> { token, text, attachments[] }
 *   POST /dsh-seesion-copy-enhance/resolve  { token? , text? }
 *                                           -> the same payload, for paste
 *
 * Every route answers only to the page that hosts DSH: a request carrying a
 * foreign `Origin` header is refused before it can read a session.
 *
 * `capture` reads one user message out of the live session log through
 * `ctx.sessions` / `ctx.attachments` and returns its text plus every image and
 * file as base64, so the browser half can put the complete message on the
 * clipboard and rebuild real `File` objects when it is pasted into any
 * composer (same session or another one).
 *
 * @module dsh-seesion-copy-enhance
 */

const ROUTE_BASE = '/dsh-seesion-copy-enhance'

/** Reported by `/health` so a host-version mismatch is diagnosable in one call. */
const PLUGIN_VERSION = '0.2.0'

/** Hard cap for one request body (the browser only sends ids and short text). */
const MAX_REQUEST_BYTES = 512 * 1024

/** Default per-attachment ceiling; larger attachments are reported as skipped. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024

/** Default ceiling for the whole captured message. */
const DEFAULT_MAX_BUNDLE_BYTES = 24 * 1024 * 1024

/** How many captured messages stay resolvable in memory. */
const DEFAULT_HISTORY = 32

const MIME_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  yml: 'application/yaml',
  yaml: 'application/yaml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  svg: 'image/svg+xml',
})

/**
 * Plugin dependencies: the session store is required, the Web carrier and the
 * attachment store are resolved lazily so the plugin still loads without them.
 */
export const inject = ['sessions']

/**
 * Register the bridge routes.
 * @param ctx - Host context.
 * @param config - Optional tuning (`maxAttachmentBytes`, `maxBundleBytes`, `history`).
 */
export function apply(ctx, config = {}) {
  const options = {
    maxAttachmentBytes: positive(config.maxAttachmentBytes, DEFAULT_MAX_ATTACHMENT_BYTES),
    maxBundleBytes: positive(config.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES),
    history: positive(config.history, DEFAULT_HISTORY),
  }

  /** token -> captured bundle; insertion order doubles as the eviction queue. */
  const bundles = new Map()

  /** Quick synchronous digest: stable per normalized message text. */
  const tokenOf = (text) => digest(normalizeText(text))

  function remember(bundle) {
    bundles.delete(bundle.token)
    bundles.set(bundle.token, bundle)
    while (bundles.size > options.history) {
      const oldest = bundles.keys().next()
      if (oldest.done === true) break
      bundles.delete(oldest.value)
    }
  }

  ctx.inject(['webServer', 'attachments'], (scope) => {
    const { webServer, attachments } = scope
    scope.effect(() => {
      const disposers = [
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/health`,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { ok: false, error: 'cross-origin' })
              return
            }
            sendJson(res, 200, {
              ok: true,
              version: PLUGIN_VERSION,
              bundles: bundles.size,
              sessions: ctx.sessions.list().length,
              capabilities: describeCapabilities(attachments),
            })
          },
        }),
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/inspect`,
          handler: (req, res) => {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { ok: false, error: 'cross-origin' })
              return
            }
            // Shape only: enough to pick a copy target while diagnosing, without
            // lifting message text out of the session.
            const sessions = []
            for (const session of ctx.sessions.list()) {
              const entries = listUserMessages(session)
              sessions.push({
                id: session.id,
                title: typeof session.header?.title === 'string' ? session.header.title : '',
                messages: entries.map((entry) => ({
                  seq: entry.seq,
                  textLength: entry.text.length,
                  blocks: entry.content.map((block) => block?.type ?? 'unknown'),
                })),
              })
            }
            sendJson(res, 200, { ok: true, sessions })
          },
        }),
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/capture`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { ok: false, error: 'cross-origin' })
              return
            }
            try {
              const input = await readJson(req)
              const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
              const session = sessionId === '' ? undefined : ctx.sessions.get(sessionId)
              if (session === undefined) {
                sendJson(res, 404, { ok: false, error: 'session-not-found', sessionId })
                return
              }
              const entries = listUserMessages(session)
              if (entries.length === 0) {
                sendJson(res, 404, { ok: false, error: 'no-user-message' })
                return
              }
              const picked = pickMessage(entries, input)
              if (picked === undefined) {
                sendJson(res, 404, { ok: false, error: 'message-not-found' })
                return
              }
              const warnings = []
              const captured = await readAttachments(attachments, picked.content, options, warnings)
              const bundle = {
                token: tokenOf(picked.text),
                text: picked.text,
                seq: picked.seq,
                sessionId,
                attachments: captured,
                warnings,
                time: Date.now(),
              }
              remember(bundle)
              sendJson(res, 200, {
                ok: true,
                token: bundle.token,
                text: bundle.text,
                attachments: bundle.attachments,
                warnings: bundle.warnings,
              })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: describe(error) })
            }
          },
        }),
        webServer.register({
          kind: 'exact',
          path: `${ROUTE_BASE}/resolve`,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            if (!sameOrigin(req)) {
              sendJson(res, 403, { ok: false, error: 'cross-origin' })
              return
            }
            try {
              const input = await readJson(req)
              const byToken = typeof input.token === 'string' ? bundles.get(input.token) : undefined
              const byText =
                byToken === undefined && typeof input.text === 'string' ? bundles.get(tokenOf(input.text)) : undefined
              const bundle = byToken ?? byText
              if (bundle === undefined) {
                sendJson(res, 404, { ok: false, error: 'bundle-not-found' })
                return
              }
              sendJson(res, 200, {
                ok: true,
                token: bundle.token,
                text: bundle.text,
                attachments: bundle.attachments,
                warnings: bundle.warnings,
              })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: describe(error) })
            }
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-seesion-copy-enhance: bridge routes')
  })
}

/** Clamp one optional numeric configuration value. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Probe the attachment service instead of assuming one Host version's shape.
 *
 * DSH's attachment service grew `readImage`/`readFileStream` over time; on an
 * older Host one of them may be absent. Reporting the probe lets the browser
 * half explain a text-only copy instead of silently dropping media.
 */
function describeCapabilities(attachments) {
  const service = attachments ?? {}
  return {
    readImage: typeof service.readImage === 'function',
    readFileStream: typeof service.readFileStream === 'function',
    imageHostPath: typeof service.imageHostPath === 'function',
    fileHostPath: typeof service.fileHostPath === 'function',
  }
}

/**
 * Refuse a request that another origin initiated.
 *
 * The bridge carries conversation content, so it must never be readable by a
 * page that is not the DSH shell. Requests without an `Origin` header (same-tab
 * GETs, `curl` on the loopback interface) are allowed: only a browser sends
 * that header for cross-origin traffic.
 */
function sameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** Stable short digest of one string. */
function digest(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `b${hash.toString(16)}-${text.length.toString(36)}`
}

/** Collapse whitespace so DOM text and log text compare on equal footing. */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Project every live `user/message` event of one session into a comparable entry. */
function listUserMessages(session) {
  const entries = []
  const events = sessionEvents(session)
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    const message = messageOfEvent(session, event)
    if (message === undefined || message === null || message.role !== 'user') continue
    const content = Array.isArray(message.content) ? message.content : []
    entries.push({ seq: event.seq, content, text: textOf(content) })
  }
  return entries
}

/**
 * Read a session's own event log across Host versions.
 *
 * `ownEvents()` is the current seam; `snapshotEvents()` and a plain event list
 * cover builds where the getter is named differently, so a copy still works.
 */
function sessionEvents(session) {
  try {
    if (typeof session.ownEvents === 'function') return session.ownEvents() ?? []
    if (typeof session.snapshotEvents === 'function') {
      const end = Number.isFinite(session.seq) ? session.seq : Number.MAX_SAFE_INTEGER
      return session.snapshotEvents(0, end) ?? []
    }
    if (Array.isArray(session.events)) return session.events
  } catch {
    return []
  }
  return []
}

/** Derive the message an event carries, falling back to the raw event payload. */
function messageOfEvent(session, event) {
  try {
    if (typeof session.deriveEventMessage === 'function') {
      const derived = session.deriveEventMessage(event)
      if (derived !== undefined && derived !== null) return derived
    }
  } catch {
    // Fall through to the raw payload below.
  }
  const data = event?.data
  if (data !== null && typeof data === 'object') {
    if (typeof data.role === 'string') return data
    if (data.message !== null && typeof data.message === 'object') return data.message
  }
  return undefined
}

/** Join the text blocks of one message; media blocks are represented by nothing. */
function textOf(content) {
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n')
}

/**
 * Choose the message the browser clicked.
 * Preference order: the exact event seq when it also resembles the visible text
 * (the DOM key is a hint, not a promise), best text similarity, position from
 * the end.
 */
function pickMessage(entries, input) {
  const needle = normalizeText(input.text)
  const seq = Number(input.seq)
  if (Number.isInteger(seq) && seq >= 0) {
    const exact = entries.find((entry) => Number(entry.seq) === seq)
    if (exact !== undefined) {
      const hay = normalizeText(exact.text)
      if (needle === '' || hay === '' || similarity(needle, hay) >= 0.55) return exact
    }
  }
  if (needle !== '') {
    let best
    let bestScore = 0
    for (const entry of entries) {
      const hay = normalizeText(entry.text)
      if (hay === '') continue
      const score = similarity(needle, hay)
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    if (best !== undefined && bestScore >= 0.55) return best
  }
  const fromEnd = Number(input.fromEnd)
  if (Number.isInteger(fromEnd) && fromEnd >= 0 && fromEnd < entries.length) {
    return entries[entries.length - 1 - fromEnd]
  }
  return entries.length === 0 ? undefined : entries[entries.length - 1]
}

/** 1 for identical text, otherwise containment ratio or bigram overlap. */
function similarity(left, right) {
  if (left === right) return 1
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (short.length === 0) return 0
  const index = long.indexOf(short)
  if (index >= 0) return 0.5 + (0.5 * short.length) / long.length
  const a = bigrams(short)
  const b = bigrams(long)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

/** Character bigram set of one string. */
function bigrams(text) {
  const grams = new Set()
  for (let index = 0; index + 1 < text.length; index += 1) grams.add(text.slice(index, index + 2))
  return grams
}

/** Read every media block of one message into base64 payloads. */
async function readAttachments(attachments, content, options, warnings) {
  const captured = []
  const canReadImage = typeof attachments?.readImage === 'function'
  const canReadFile = typeof attachments?.readFileStream === 'function'
  let total = 0
  let images = 0
  let toldAboutImages = false
  let toldAboutFiles = false
  for (const block of content) {
    if (block?.type !== 'image' && block?.type !== 'file') continue
    if (block.type === 'image' && !canReadImage) {
      if (!toldAboutImages) {
        warned(warnings, 'this DSH build cannot read image attachments; images were left out')
        toldAboutImages = true
      }
      continue
    }
    if (block.type === 'file' && !canReadFile) {
      if (!toldAboutFiles) {
        warned(warnings, 'this DSH build cannot read file attachments; files were left out')
        toldAboutFiles = true
      }
      continue
    }
    const ref = block.attachment
    if (ref === undefined || ref === null) continue
    const bytes = Number(ref.bytes)
    const name = typeof ref.name === 'string' && ref.name !== '' ? ref.name : undefined
    if (Number.isFinite(bytes) && bytes > options.maxAttachmentBytes) {
      warnings.push(`skipped ${name ?? 'attachment'}: larger than ${options.maxAttachmentBytes} bytes`)
      continue
    }
    if (total + (Number.isFinite(bytes) ? bytes : 0) > options.maxBundleBytes) {
      warnings.push('skipped remaining attachments: message exceeds the bundle size limit')
      break
    }
    try {
      if (block.type === 'image') {
        images += 1
        const stored = await attachments.readImage(ref)
        const data = stored?.data ?? new Uint8Array()
        captured.push({
          kind: 'image',
          name: name ?? imageName(ref, images),
          mediaType: ref.mediaType ?? 'image/png',
          bytes: data.byteLength,
          data: toBase64(data),
        })
        total += data.byteLength
      } else {
        const chunks = []
        let size = 0
        for await (const chunk of attachments.readFileStream(ref)) {
          chunks.push(chunk)
          size += chunk.byteLength
        }
        if (size > options.maxAttachmentBytes) {
          warnings.push(`skipped ${name ?? 'file'}: larger than ${options.maxAttachmentBytes} bytes`)
          continue
        }
        const data = concat(chunks)
        captured.push({
          kind: 'file',
          name: name ?? 'file.bin',
          mediaType: mimeOf(name),
          bytes: data.byteLength,
          data: toBase64(data),
        })
        total += data.byteLength
      }
    } catch (error) {
      warnings.push(`skipped ${name ?? 'attachment'}: ${describe(error)}`)
    }
  }
  return captured
}

/** Append one warning without repeating it. */
function warned(warnings, message) {
  if (!warnings.includes(message)) warnings.push(message)
}

/** Fallback display name for an unnamed image attachment. */
function imageName(ref, ordinal) {
  const extension = String(ref.mediaType ?? 'image/png').split('/')[1] ?? 'png'
  return `image-${ordinal}.${extension}`
}

/** Best-effort media type from a file name. */
function mimeOf(name) {
  if (typeof name !== 'string') return 'application/octet-stream'
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Encode bytes as base64 without copying through a string of code units. */
function toBase64(bytes) {
  return Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length).toString('base64')
}

/** Concatenate ordered byte chunks. */
function concat(chunks) {
  let length = 0
  for (const chunk of chunks) length += chunk.byteLength
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Read one JSON request body. */
async function readJson(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_REQUEST_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Render an unknown thrown value as a short message. */
function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

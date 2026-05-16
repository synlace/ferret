// ---------------------------------------------------------------------------
// Ferret History Query Language — Parser
//
// Syntax:  [free text] [qualifier:value] [-qualifier:value] ...
//
// Qualifiers (case-insensitive):
//   method: / m:      GET,POST,PUT,DELETE,PATCH
//   status: / s:      2xx,3xx,4xx,5xx  or exact codes like 200,404
//   host:   / h:      glob pattern (* wildcard)
//   path:   / p:      glob pattern (* wildcard)
//   mime:             json,html,xml,css,js,image,plain
//   ext:              js,css,html,json,php,png,jpg,svg,none
//   source: / src:    human,proxy,test
//   has:              annotation,body,params
//   size:             >1kb, <500, =0  (bytes; supports kb/mb suffix)
//   time:   / ms:     >200, <50, =0   (milliseconds)
//
// Multi-value: comma-separate  →  method:GET,POST
// Negation:    prefix with -   →  -method:GET
// Quoting:     "path:/api/v2"  for values with spaces
// ---------------------------------------------------------------------------

export interface SizeConstraint {
  op: ">" | "<" | "="
  bytes: number
}

export interface TimeConstraint {
  op: ">" | "<" | "="
  ms: number
}

export interface ParsedQuery {
  text: string[]
  method: string[] | null
  status: string[] | null
  host: string | null
  path: string | null
  mime: string[] | null
  ext: string[] | null
  source: string[] | null
  has: string[] | null
  size: SizeConstraint | null
  time: TimeConstraint | null
  /** Set of qualifier names that are negated (e.g. "method", "mime") */
  negated: Set<string>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBytes(raw: string): number {
  const lower = raw.toLowerCase()
  if (lower.endsWith("mb")) return parseFloat(lower) * 1024 * 1024
  if (lower.endsWith("kb")) return parseFloat(lower) * 1024
  return parseFloat(lower)
}

function parseConstraint(value: string): { op: ">" | "<" | "="; raw: string } | null {
  const m = value.match(/^([><]?=?)(.+)$/)
  if (!m) return null
  const opStr = m[1] || "="
  const op = opStr === ">" ? ">" : opStr === "<" ? "<" : "="
  return { op, raw: m[2] }
}

/** Simple glob match: only * wildcard supported */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return value.toLowerCase().includes(pattern.toLowerCase())
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(value)
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

interface Token {
  negated: boolean
  qualifier: string | null  // null = free text
  value: string
}

function tokenise(input: string): Token[] {
  const tokens: Token[] = []
  // Match: optional -, optional qualifier:, then quoted or unquoted value
  const re = /(-?)(?:([a-zA-Z]+):)?("(?:[^"\\]|\\.)*"|[^\s]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const negated = m[1] === "-"
    const qualifier = m[2]?.toLowerCase() ?? null
    const rawValue = m[3].startsWith('"') ? m[3].slice(1, -1).replace(/\\"/g, '"') : m[3]
    tokens.push({ negated, qualifier, value: rawValue })
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Qualifier aliases
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  m: "method",
  s: "status",
  h: "host",
  p: "path",
  src: "source",
  ms: "time",
}

function resolveQualifier(q: string): string {
  return ALIASES[q] ?? q
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseQuery(input: string): ParsedQuery {
  const result: ParsedQuery = {
    text: [],
    method: null,
    status: null,
    host: null,
    path: null,
    mime: null,
    ext: null,
    source: null,
    has: null,
    size: null,
    time: null,
    negated: new Set(),
  }

  const tokens = tokenise(input.trim())

  for (const token of tokens) {
    if (token.qualifier === null) {
      // Free text
      result.text.push(token.value)
      continue
    }

    const qualifier = resolveQualifier(token.qualifier)
    if (token.negated) result.negated.add(qualifier)

    const values = token.value.split(",").map(v => v.trim()).filter(Boolean)

    switch (qualifier) {
      case "method":
        result.method = (result.method ?? []).concat(values.map(v => v.toUpperCase()))
        break
      case "status":
        result.status = (result.status ?? []).concat(values.map(v => v.toLowerCase()))
        break
      case "host":
        result.host = token.value
        break
      case "path":
        result.path = token.value
        break
      case "mime":
        result.mime = (result.mime ?? []).concat(values.map(v => v.toLowerCase()))
        break
      case "ext":
        result.ext = (result.ext ?? []).concat(values.map(v => v.toLowerCase().replace(/^\./, "")))
        break
      case "source":
        result.source = (result.source ?? []).concat(values.map(v => v.toLowerCase()))
        break
      case "has":
        result.has = (result.has ?? []).concat(values.map(v => v.toLowerCase()))
        break
      case "size": {
        const c = parseConstraint(token.value)
        if (c) result.size = { op: c.op, bytes: parseBytes(c.raw) }
        break
      }
      case "time": {
        const c = parseConstraint(token.value)
        if (c) result.time = { op: c.op, ms: parseFloat(c.raw) }
        break
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Predicate — apply a ParsedQuery against an ApiRequest-shaped object
// ---------------------------------------------------------------------------

import type { ApiRequest } from "./DetailPanel"

export function matchesQuery(req: ApiRequest, pq: ParsedQuery): boolean {
  const neg = pq.negated

  // Free text — match against all meaningful string fields
  for (const term of pq.text) {
    const lower = term.toLowerCase()

    // Build a flat list of searchable strings from the request
    const searchable: string[] = [
      req.url,
      req.host,
      req.path,
      req.method,
      req.annotation ?? "",
      req.body ?? "",
      req.response_body ?? "",
    ]

    // Include all request header keys + values
    if (req.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        searchable.push(k, v)
      }
    }

    // Include all response header keys + values
    if (req.response_headers) {
      for (const [k, v] of Object.entries(req.response_headers)) {
        searchable.push(k, v)
      }
    }

    const hit = searchable.some(s => s.toLowerCase().includes(lower))
    if (!hit) return false
  }

  // method
  if (pq.method && pq.method.length > 0) {
    const hit = pq.method.includes(req.method.toUpperCase())
    if (neg.has("method") ? hit : !hit) return false
  }

  // status
  if (pq.status && pq.status.length > 0) {
    const sc = req.status_code ?? 0
    const hit = pq.status.some(s => {
      if (s === "2xx") return sc >= 200 && sc < 300
      if (s === "3xx") return sc >= 300 && sc < 400
      if (s === "4xx") return sc >= 400 && sc < 500
      if (s === "5xx") return sc >= 500
      return sc === parseInt(s, 10)
    })
    if (neg.has("status") ? hit : !hit) return false
  }

  // host
  if (pq.host) {
    const hit = globMatch(pq.host, req.host)
    if (neg.has("host") ? hit : !hit) return false
  }

  // path
  if (pq.path) {
    const hit = globMatch(pq.path, req.path)
    if (neg.has("path") ? hit : !hit) return false
  }

  // mime
  if (pq.mime && pq.mime.length > 0) {
    const ct = (
      req.response_headers?.["content-type"] ??
      req.response_headers?.["Content-Type"] ??
      ""
    ).toLowerCase()
    const hit = pq.mime.some(m => {
      if (m === "json")  return ct.includes("json")
      if (m === "html")  return ct.includes("html")
      if (m === "xml")   return ct.includes("xml")
      if (m === "css")   return ct.includes("css")
      if (m === "js")    return ct.includes("javascript") || ct.includes("ecmascript")
      if (m === "image") return ct.includes("image/")
      if (m === "plain") return ct.includes("text/plain")
      return false
    })
    if (neg.has("mime") ? hit : !hit) return false
  }

  // ext
  if (pq.ext && pq.ext.length > 0) {
    const pathLower = req.path.toLowerCase().split("?")[0]
    const ext = pathLower.includes(".") ? pathLower.split(".").pop() ?? "" : ""
    const hit = pq.ext.some(e => {
      if (e === "none") return !pathLower.includes(".")
      if (e === "html") return ext === "html" || ext === "htm"
      if (e === "jpg")  return ext === "jpg" || ext === "jpeg"
      return ext === e
    })
    if (neg.has("ext") ? hit : !hit) return false
  }

  // source — "human" maps to "proxy" in the data model
  if (pq.source && pq.source.length > 0) {
    const src = req.source.toLowerCase()
    const hit = pq.source.some(s => {
      if (s === "human") return src === "proxy" || src === "human"
      return src === s
    })
    if (neg.has("source") ? hit : !hit) return false
  }

  // has
  if (pq.has && pq.has.length > 0) {
    for (const h of pq.has) {
      let present = false
      if (h === "annotation") present = !!(req.annotation && req.annotation.trim())
      else if (h === "body")  present = !!(req.body && req.body.trim())
      else if (h === "params") {
        const hasQuery = (() => { try { return new URL(req.url).search.length > 1 } catch { return false } })()
        present = hasQuery || !!(req.body && req.body.trim())
      }
      if (neg.has("has") ? present : !present) return false
    }
  }

  // size
  if (pq.size) {
    const sz = req.response_size ?? 0
    const { op, bytes } = pq.size
    const hit = op === ">" ? sz > bytes : op === "<" ? sz < bytes : sz === bytes
    if (!hit) return false
  }

  // time
  if (pq.time) {
    const rt = req.response_time ?? 0
    const { op, ms } = pq.time
    const hit = op === ">" ? rt > ms : op === "<" ? rt < ms : rt === ms
    if (!hit) return false
  }

  return true
}

// Wire helpers — Source: dsh-better-sidebar@0.17.1 src/wire.ts (BSD-equivalent permissive)
// and trust-fence.ts, html-route.ts where noted. Kept dependency-free for client reuse.
// Explicit "controlled inline" per docs/compatibility.md §4.3.

export type SidebarErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'fs-error'
  | 'git-error'
  | 'pty-error'
  | 'pty-deps-missing'
  | 'job-error'
  | 'sidechat-error'
  | 'subagents-unavailable'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = code === 'not-found' ? 404 : code === 'forbidden' ? 403 : code === 'too-large' ? 413 : 400,
  ) {
    super(message)
    this.name = 'SidebarError'
  }
}

export interface SidebarOk<T> { ok: true; value: T }
export interface SidebarErr { ok: false; error: { code: SidebarErrorCode; message: string } }

const MAX_BODY_BYTES = 1 << 20

export async function readJsonBody(req: { [Symbol.asyncIterator](): AsyncIterator<Buffer | string | Uint8Array> }): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as never)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new SidebarError('bad-request', 'request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new SidebarError('bad-request', 'request body is not valid JSON') }
}

export function writeJson(res: { writeHead(n: number, h: Record<string, string>): void; end(s: string): void }, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
export function writeOk(res: { writeHead(n: number, h: Record<string, string>): void; end(s: string): void }, value: unknown) {
  writeJson(res, 200, { ok: true, value })
}
export function writeError(res: { writeHead(n: number, h: Record<string, string>): void; end(s: string): void }, error: unknown) {
  if (error instanceof SidebarError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  writeJson(res, 500, { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
}
export function requireString(payload: unknown, key: string): string {
  const v = (payload as Record<string, unknown> | null)?.[key]
  if (typeof v !== 'string' || v === '') throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  return v
}

// trust-fence — Source: dsh-better-sidebar@0.17.1 src/trust-fence.ts
function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name]
  return typeof v === 'string' ? v : undefined
}
function parseAuthority(a: string): URL | undefined { try { return new URL(`http://${a}`) } catch { return undefined } }
export function isLoopbackHostname(h: string): boolean {
  if (h === 'localhost' || h === '[::1]') return true
  const parts = h.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(entry => {
    const eu = parseAuthority(entry)
    if (eu === undefined) return false
    return canonicalAuthority(entry, eu) === eu.hostname ? eu.hostname === hostUrl.hostname : eu.host === hostUrl.host
  })
}
export function isTrustedApiRequest(request: { headers: Record<string, unknown> }, trustedHosts: readonly string[]): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
}

// html-route — Source: dsh-better-sidebar@0.17.1 src/html-route.ts
export interface HtmlRouteRef { sessionId: string; path: string }
export type HtmlDecodeResult = { ok: true; ref: HtmlRouteRef } | { ok: false; status: 400 | 404; message: string }
export const HTML_ROUTE_PREFIX = '/sidebar/html/'
export function encodeHtmlUrl(sessionId: string, path: string): string {
  const unc = /^[\\/]{2}[^\\/]/.test(path)
  const segments = path.split(/[\\/]+/).filter(s => s !== '')
  return `${HTML_ROUTE_PREFIX}${encodeURIComponent(sessionId)}/${unc ? '/' : ''}${segments.map(encodeURIComponent).join('/')}`
}
export function decodeHtmlUrl(pathname: string): HtmlDecodeResult {
  if (!pathname.startsWith(HTML_ROUTE_PREFIX)) return { ok: false, status: 404, message: 'not an html route' }
  const rest = pathname.slice(HTML_ROUTE_PREFIX.length)
  if (rest === '') return { ok: false, status: 400, message: 'invalid html route path' }
  let segments: string[]
  try { segments = rest.split('/').map(s => decodeURIComponent(s)) } catch { return { ok: false, status: 400, message: 'malformed URL encoding' } }
  const [sessionId, ...pathSegments] = segments
  if (!sessionId) return { ok: false, status: 400, message: 'sessionId and file path are required' }
  const unc = pathSegments[0] === ''
  const tail = unc ? pathSegments.slice(1) : pathSegments
  if (tail.length === 0 || tail.some(s => s === '')) return { ok: false, status: 400, message: 'sessionId and file path are required' }
  let path: string
  if (unc) path = `//${tail.join('/')}`
  else if (/^[A-Za-z]:$/.test(tail[0] ?? '')) path = tail.join('/')
  else path = `/${tail.join('/')}`
  return { ok: true, ref: { sessionId, path } }
}

// media + encoding helpers
export function mediaTypeForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', htm: 'text/html', json: 'application/json',
    css: 'text/css', js: 'text/javascript', ts: 'text/javascript', mjs: 'text/javascript',
    mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', zip: 'application/zip',
    md: 'text/markdown', yaml: 'text/yaml', yml: 'text/yaml', xml: 'application/xml',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function messageOf(e: unknown): string { return e instanceof Error ? e.message : String(e) }

export function compareEntries(a: { isDir: boolean; name: string }, b: { isDir: boolean; name: string }): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

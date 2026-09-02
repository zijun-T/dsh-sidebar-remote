// dsh-sidebar-remote — Client half — real wiring for remote sessions.
// Wires Better Sidebar's Explorer/editor/upload/download/preview/terminal/Git
// behind /sidebar/remote/* for remote sessions by routeByCwd(sessionCwd).
// Decision is sessionId-grained; fetch + WebSocket + media/html are all covered.
// Uses only stable Cordis client services: ctx.sessions.list.getSnapshot(), ctx.get('betterSidebar').

import { routeByCwd, routeByPlaceholderTail } from '../shared/router.js'

export const inject = ['sessions']

// --- placeholder-root discovery --------------------------------------------
// routeByCwd() has to agree with the host about where the placeholder workspace
// lives. Upstream derives it from remoteRoot(env):
//     DSH_SSH_REMOTE_ROOT > $DSH_HOME/remote > os.homedir()/.dsh/remote
// None of those three inputs are available to a browser bundle: esbuild compiles
// `process.env` away to {}, and os.homedir() comes from scripts/shim-os.mjs, a
// build-time value. So a bundle built on machine A and served by machine B
// computes a different root, mapLocalToRemote() returns null because
// relative(rootA, pathUnderRootB) starts with '..', and every remote session
// silently degrades to { kind: 'local' } — the sidebar then renders the empty
// local placeholder directory with no error anywhere. That failure is
// indistinguishable from the plugin not being loaded at all.
//
// The host is the only party that knows the real root, so we ask it once
// (/sidebar/remote/root) and feed the answer back through the `env` parameter
// routeByCwd() already accepts. DSH_SSH_REMOTE_ROOT has top precedence in
// remoteRoot(), which makes the build-time shim irrelevant at runtime.
let remoteRootOverride: string | null = null
let remoteRootProbe: Promise<void> | null = null
let remoteRootSettled = false
let remoteRootRetryTimer: ReturnType<typeof setTimeout> | null = null

// Long enough to cover a cold loopback request; short enough that a host which
// does not serve the endpoint (older bundle, blocked route) cannot stall the
// sidebar — routing then falls back to the build-time root, which is correct
// whenever the bundle is served by the machine it was built on.
const ROOT_PROBE_TIMEOUT_MS = 1500
// The retry is never awaited, so it adds no latency; it only exists because a
// late-correct root still beats a permanently wrong build-time one.
const ROOT_PROBE_RETRY_MS = 1000

function routeOf(cwd: string) {
  if (remoteRootOverride) return routeByCwd(cwd, { DSH_SSH_REMOTE_ROOT: remoteRootOverride })
  const r = routeByCwd(cwd)
  if (r.kind === 'remote') return r
  // No authoritative root (probe in flight, failed, or host too old to serve
  // it): the build-time root may belong to a different machine, so fall back to
  // the root-independent shape check. Synchronous, which is what the WebSocket
  // constructor needs.
  return routeByPlaceholderTail(cwd)
}

function startRemoteRootProbe(
  doFetch: typeof fetch,
  logger?: { info(s: string): void; warn(s: string): void },
): Promise<void> {
  if (remoteRootProbe) return remoteRootProbe

  const attempt = async (): Promise<void> => {
    // Must be the *original* fetch. Going through patchedFetch would be safe
    // only because it excludes /sidebar/remote/*, and awaitRemoteRoot() below
    // would otherwise deadlock: the probe waiting on itself.
    const res = await doFetch('/sidebar/remote/root', { headers: { accept: 'application/json' } })
    if (!res.ok) { logger?.warn?.(`[remote-sidebar] root probe HTTP ${res.status}`); return }
    const j = await res.json() as { value?: { root?: unknown }; root?: unknown } | null
    // Accept both the { ok, value } envelope and a bare { root }.
    const root = j && typeof j === 'object' ? (j.value?.root ?? j.root) : null
    if (typeof root === 'string' && root.length) {
      remoteRootOverride = root
      logger?.info?.(`[remote-sidebar] placeholder root: ${root}`)
    } else {
      logger?.warn?.('[remote-sidebar] root probe returned no usable root')
    }
  }

  remoteRootProbe = (async () => {
    try {
      await attempt()
    } catch (e) {
      logger?.warn?.(`[remote-sidebar] root probe failed: ${(e as Error)?.message ?? String(e)}`)
    } finally {
      // Settle even on failure so awaitRemoteRoot() cannot stall the sidebar.
      remoteRootSettled = true
    }
    if (!remoteRootOverride) {
      try {
        remoteRootRetryTimer = setTimeout(() => {
          remoteRootRetryTimer = null
          attempt().catch((e) => logger?.warn?.(`[remote-sidebar] root probe retry failed: ${(e as Error)?.message ?? String(e)}`))
        }, ROOT_PROBE_RETRY_MS)
        // A browser has no unref; Node must not be held open by a probe retry.
        const t = remoteRootRetryTimer as unknown as { unref?: () => void }
        t.unref?.()
      } catch {}
    }
  })()
  return remoteRootProbe
}

function stopRemoteRootProbe(): void {
  if (remoteRootRetryTimer) {
    try { clearTimeout(remoteRootRetryTimer) } catch {}
    remoteRootRetryTimer = null
  }
}

// Block briefly so first-paint requests route on the authoritative root rather
// than the build-time fallback. Resolves immediately once the probe has settled.
async function awaitRemoteRoot(timeoutMs = ROOT_PROBE_TIMEOUT_MS): Promise<void> {
  if (remoteRootSettled || !remoteRootProbe) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      remoteRootProbe,
      new Promise<void>((r) => { timer = setTimeout(r, timeoutMs) }),
    ])
  } catch {
    // The probe never rejects; guard anyway so a routing decision is never lost.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Lightweight helpers for unit reuse (no window fetch needed)
function pickApiPrefix(sessionCwd: string | null): string {
  if (!sessionCwd) return '/sidebar/api'
  const r = routeOf(sessionCwd)
  return r.kind === 'remote' ? '/sidebar/remote/api' : '/sidebar/api'
}
function pickWsUrl(sessionCwd: string | null, tabId: string, cols: number, rows: number, sessionId: string): string {
  const proto = (typeof location !== 'undefined' && location.protocol === 'https:') ? 'wss:' : 'ws:'
  const host = (typeof location !== 'undefined' ? location.host : '')
  if (sessionCwd && routeOf(sessionCwd).kind === 'remote') {
    return `${proto}//${host}/sidebar/ws/remote-terminal?sessionId=${encodeURIComponent(sessionId)}&tabId=${encodeURIComponent(tabId)}&cols=${cols}&rows=${rows}&cwd=${encodeURIComponent(sessionCwd)}`
  }
  return `${proto}//${host}/sidebar/ws/terminal?sessionId=${encodeURIComponent(sessionId)}&tabId=${encodeURIComponent(tabId)}&cols=${cols}&rows=${rows}`
}

function cwdOfSessionId(ctx: unknown, sessionId: string | undefined): string | null {
  if (!sessionId) return null
  try {
    const c = ctx as any
    const snap = c?.sessions?.list?.getSnapshot?.()
    const entry = snap?.byId?.[sessionId]
    if (entry && typeof entry.cwd === 'string' && entry.cwd.length) return entry.cwd
  } catch {}
  // Fallback: try raw sessionId lookup from any sessions map
  try {
    const c = ctx as unknown as { sessions?: { get?(id:string): { header?: { cwd?: string } } } }
    const s = (c.sessions as unknown as { get?: (id:string)=>{ header?: { cwd?: string } } })?.get?.(sessionId)
    // @ts-ignore
    if (s?.header?.cwd) return s.header.cwd as string
  } catch {}
  return null
}

// The sessions snapshot is not always populated when a request fires (early
// boot, restored tabs, or a ctx that has not been wired yet), so fall back to
// the cwd the caller already put on the wire. Both sources yield decoded
// strings: URLSearchParams.get() decodes percent-escapes and JSON.parse()
// decodes the body, so no extra decodeURIComponent() is needed (double-decoding
// would corrupt paths containing '%' or '+').
function cwdFromRequest(u: URL, bodyText: string | null): string | null {
  const q = u.searchParams.get('cwd')
  if (q && q.length) return q
  if (bodyText) {
    try {
      const j = JSON.parse(bodyText) as Record<string, unknown>
      if (typeof j.cwd === 'string' && j.cwd.length) return j.cwd
    } catch {}
  }
  return null
}

function sessionIdFromUrl(u: URL, bodyText: string | null): string | undefined {
  // JSON /sidebar/api/*: { sessionId, cwd? }
  if (bodyText) {
    try {
      const j = JSON.parse(bodyText) as Record<string, unknown>
      const sid = j.sessionId
      if (typeof sid === 'string' && sid.length) return sid
    } catch {}
  }
  // Query: /sidebar/upload?sessionId=... / /sidebar/file?sessionId=...&cwd=...
  // /sidebar/html/<sessionId>/<path...> — sessionId is second segment after prefix
  // WS: /sidebar/ws/terminal?sessionId=... or ?uuid=...?terminal uses ?sessionId&tab=&
  const q = u.searchParams.get('sessionId')
  if (q) return q
  // HTML path fallback
  if (u.pathname.startsWith('/sidebar/html/')) {
    const rest = u.pathname.slice('/sidebar/html/'.length)
    const first = rest.split('/')[0]
    if (first) {
      try { const d = decodeURIComponent(first); if (d.length) return d } catch { return first }
    }
  }
  return undefined
}

// Map any /sidebar/* path to its /sidebar/remote/* sibling when the session is remote.
// Covers: /sidebar/api/*, /sidebar/upload, /sidebar/file, /sidebar/html/...
function mapToRemote(pathname: string): string | null {
  if (pathname === '/sidebar/api' || pathname.startsWith('/sidebar/api/')) return pathname.replace('/sidebar/api', '/sidebar/remote/api')
  if (pathname === '/sidebar/upload' || pathname.startsWith('/sidebar/upload')) return pathname.replace('/sidebar/upload', '/sidebar/remote/upload')
  if (pathname === '/sidebar/file' || pathname.startsWith('/sidebar/file')) return pathname.replace('/sidebar/file', '/sidebar/remote/file')
  if (pathname.startsWith('/sidebar/html/')) return pathname.replace('/sidebar/html/', '/sidebar/remote/html/')
  return null
}

function isSidebarRoute(pathname: string): boolean {
  return pathname.startsWith('/sidebar/')
}

function installFetchPatch(ctx: unknown, logger?: { info(s:string):void; warn(s:string):void }) {
  const g = globalThis as unknown as { fetch?: typeof fetch; WebSocket?: typeof WebSocket }
  // Guard: client may not have fetch (jsdom) — degrade without crash
  if (typeof g.fetch !== 'function') return { dispose(){} }
  const origFetch: typeof fetch = (g.fetch as unknown as typeof fetch).bind(g as unknown)
  const origWS: typeof WebSocket | undefined = g.WebSocket as unknown as typeof WebSocket | undefined

  // Kick off root discovery before the global patch is installed, so the probe
  // is bound to the original fetch for certain rather than by exclusion order.
  void startRemoteRootProbe(origFetch, logger)

  const patchedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      let urlStr: string
      let bodyText: string | null = null
      let method = init?.method
      if (typeof input === 'string') {
        urlStr = input
        bodyText = typeof init?.body === 'string' ? init.body as string : null
      } else if (input instanceof URL) {
        urlStr = input.toString()
        bodyText = typeof init?.body === 'string' ? init.body as string : null
      } else {
        const req = input as Request
        urlStr = req.url
        method = req.method
        try { bodyText = await req.clone().text() } catch { bodyText = null }
        if (!bodyText && typeof init?.body === 'string') bodyText = init.body as string
      }
      // Only handle same-origin /sidebar/* (absolute or relative)
      let u: URL
      try {
        u = new URL(urlStr, typeof location !== 'undefined' ? location.href : 'http://127.0.0.1:3080/')
      } catch { return origFetch(input as never, init as never) }
      // Ignore cross-origin
      if (typeof location !== 'undefined' && u.origin !== location.origin) return origFetch(input as never, init as never)
      if (!isSidebarRoute(u.pathname)) return origFetch(input as never, init as never)
      // Exclude /sidebar/bundle/*, /sidebar/remote/* already, metrics etc — only rewrite base routes
      if (u.pathname.startsWith('/sidebar/remote/')) return origFetch(input as never, init as never)
      if (u.pathname.startsWith('/sidebar/bundle/')) return origFetch(input as never, init as never)
      const sid = sessionIdFromUrl(u, bodyText)
      // Sessions first (authoritative), then the cwd already on the wire.
      const cwd = cwdOfSessionId(ctx, sid) ?? cwdFromRequest(u, bodyText)
      if (!cwd) {
        // Nothing to route on — leave the request alone so local stays local.
        return origFetch(input as never, init as never)
      }
      // Placed after the exclusions above so the probe's own request never waits
      // on itself, and after cwd resolution so only workspace requests pay for
      // it. Returns immediately once settled, which is the steady state.
      await awaitRemoteRoot()
      if (routeOf(cwd).kind !== 'remote') return origFetch(input as never, init as never)
      const mapped = mapToRemote(u.pathname)
      if (!mapped) return origFetch(input as never, init as never)
      const remoteUrl = `${mapped}${u.search}`
      // Keep method/headers/body faithfully; reconstruct minimal RequestInit
      const reqInit: RequestInit = {}
      // Preserve method + body for POST/PUT; for GET just path
      if (method) reqInit.method = method
      if (init?.headers) reqInit.headers = init.headers as HeadersInit
      if (bodyText !== null) { reqInit.body = bodyText; if (!reqInit.method) reqInit.method = 'POST' }
      else if (init?.body != null) { (reqInit as unknown as Record<string,unknown>).body = init.body as unknown }
      if (init?.signal) (reqInit as unknown as Record<string,unknown>).signal = init.signal as unknown
      void logger
      return origFetch(remoteUrl, reqInit)
    } catch {
      return origFetch(input as never, init as never)
    }
  }) as unknown as typeof fetch

  let didPatchWS = false
  if (origWS) {
    const OrigWS = origWS as unknown as new (url: string | URL, protos?: string | string[])=>WebSocket
    // Returns the URL to construct instead, or null to leave the call alone.
    const rewriteTerminalWsUrl = (url: string | URL): string | null => {
      const s = String(url)
      let u: URL
      try { u = new URL(s, typeof location !== 'undefined' ? location.href : 'http://127.0.0.1:3080/') } catch { return null }
      // Ignore cross-origin
      if (typeof location !== 'undefined' && u.host !== location.host) return null
      // Only the UI-tab terminal. '/sidebar/ws/agent-terminals' used to be
      // listed alongside it but never matched the rewrite condition below, so
      // it fell through unchanged — dropping it here is behaviour-preserving.
      if (u.pathname !== '/sidebar/ws/terminal') return null
      const sid = u.searchParams.get('sessionId') ?? u.searchParams.get('session') ?? undefined
      // Sessions first, then the cwd query param the caller supplied.
      const cwd = cwdOfSessionId(ctx, sid) ?? cwdFromRequest(u, null)
      if (!cwd || routeOf(cwd).kind !== 'remote') return null
      const next = new URL(u.toString())
      next.pathname = '/sidebar/ws/remote-terminal'
      // Pass cwd so host can verify route without re-reading header (host prefers header but supports query)
      if (!next.searchParams.has('cwd')) next.searchParams.set('cwd', cwd)
      return next.toString()
    }
    const openWs = (url: string | URL, protos?: string | string[]): WebSocket => {
      let target: string | URL = url
      // Routing is best-effort: a failure here must not block the socket.
      try { const rewritten = rewriteTerminalWsUrl(url); if (rewritten) target = rewritten } catch {}
      return new OrigWS(target, protos)
    }
    // A Proxy rather than a wrapper function, because the wrapper copied
    // `prototype` but NOT WebSocket's static CONNECTING/OPEN/CLOSING/CLOSED.
    // better-sidebar gates *every* keystroke on
    //   if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(data)
    // in its `term.onData` subscription, and gates resize/close/park the same
    // way. With those statics undefined the comparison was permanently false,
    // so a remote pane rendered output and the correct cwd yet never sent a
    // single character — and never released its host-side pty handle either.
    // A Proxy forwards all statics (and `prototype`), so nothing else on the
    // constructor can silently go missing the same way.
    const PatchedWS = new Proxy(OrigWS as unknown as object, {
      construct: (_t, args) => openWs(args[0] as string | URL, args[1] as string | string[] | undefined) as object,
      // A browser's WebSocket is not [[Call]]able, so this trap is normally
      // unreachable. It is here for the case where the global we captured was
      // already some other patch's plain function: without the trap the proxy
      // would be callable and forward the *unrewritten* arguments, silently
      // bypassing our own routing.
      apply: (_t, _thisArg, args) => openWs(args[0] as string | URL, args[1] as string | string[] | undefined) as object,
    })
    try { (g as unknown as Record<string, unknown>).WebSocket = PatchedWS as unknown } catch {}
    didPatchWS = true
  }

  // Install fetch
  try { (g as unknown as Record<string, unknown>).fetch = patchedFetch as unknown } catch {}

  return {
    dispose() {
      try { if ((g as unknown as Record<string, unknown>).fetch === (patchedFetch as unknown)) (g as unknown as Record<string, unknown>).fetch = origFetch as unknown } catch {}
      if (didPatchWS && origWS) {
        try { (g as unknown as Record<string, unknown>).WebSocket = origWS as unknown } catch {}
      }
      stopRemoteRootProbe()
    }
  }
}

export function apply(ctx: unknown) {
  const c = ctx as { logger?: { info(s:string):void; warn(s:string):void }; effect?(fn:()=>(()=>void)|void, label?: string): void }
  c.logger?.info?.('[remote-sidebar] client overlay mounted (fetch + WS remote routing active)')
  let handle: { dispose():void } | undefined
  try { handle = installFetchPatch(ctx, c.logger) } catch (e) { c.logger?.warn?.(`[remote-sidebar] fetch patch failed: ${(e as Error)?.message ?? String(e)}`) }

  // Wrap in cordis effect so dispose is auto on reload
  try { c.effect?.(() => () => { try { handle?.dispose() } catch {} }, 'remote-sidebar: client patch teardown') } catch {}

  return {
    dispose() { try { handle?.dispose() } catch {} },
  }
}

// Unit-test visible helpers (no window needed)
export { pickApiPrefix, pickWsUrl, routeOf }

export function routeForUpload(sessionCwd: string | null): string {
  return sessionCwd && routeOf(sessionCwd).kind === 'remote' ? '/sidebar/remote/upload' : '/sidebar/upload'
}
export function routeForFile(sessionCwd: string | null, path: string): string {
  const r = sessionCwd ? routeOf(sessionCwd) : { kind: 'local' as const }
  if (r.kind === 'remote') return `/sidebar/remote/file?path=${encodeURIComponent(path)}`
  return `/sidebar/file?path=${encodeURIComponent(path)}`
}
export function routeForHtml(sessionId: string, path: string, sessionCwd: string | null): string {
  const { encodeHtmlUrl } = { encodeHtmlUrl: (sid:string,p:string)=> `/sidebar/html/${encodeURIComponent(sid)}/${String(p).split(/[\\/]+/).filter(s=>s!=='').map(encodeURIComponent).join('/')}` } as const
  const url = encodeHtmlUrl(sessionId, path)
  if (sessionCwd && routeOf(sessionCwd).kind === 'remote') return url.replace('/sidebar/html/', '/sidebar/remote/html/')
  return url
}

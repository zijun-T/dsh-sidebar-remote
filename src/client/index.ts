// dsh-sidebar-remote — Client half — real wiring for remote sessions.
// Wires Better Sidebar's Explorer/editor/upload/download/preview/terminal/Git
// behind /sidebar/remote/* for remote sessions by routeByCwd(sessionCwd).
// Decision is sessionId-grained; fetch + WebSocket + media/html are all covered.
// Uses only stable Cordis client services: ctx.sessions.list.getSnapshot(), ctx.get('betterSidebar').

import { routeByCwd, routeByPlaceholderTail, remoteDisplayName } from '../shared/router.js'

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

// --- Files-panel root label -------------------------------------------------
//
// better-sidebar renders the Files panel's root row from the session cwd alone:
//     const root = cwd;                 // client-registry.js:11993
//     children: baseName$1(root)        // client-registry.js:12114
// For a remote session `cwd` is the *placeholder* path <root>/<hostId>/<b64>,
// so basename() yields the encoded segment: the row reads
// "L2hvbWUvcmVtb3RlL3dz" while the workspace row, the breadcrumb and
// the shell prompt all say "ws". The tree *contents* are right — they
// come from our fs.tree, which returns real remote paths — only the label is
// derived locally from the routing key.
//
// There is no wire-level fix. The host's own session.cwd handler does return a
// `root` label, but no client code in 0.17.1 (or 0.18.0-alpha.0) reads that
// field, and `cwd` itself must stay the placeholder because that is what every
// route decision keys on. dsh-ssh ships the correct helper and even documents
// this trap, but FileTree never calls it. So we correct the rendered text.

/** Mirror of better-sidebar's baseName$1(): the placeholder is a native local
 *  path, which uses '\' on Windows. */
function pathBasename(p: string): string {
  const trimmed = String(p).replace(/[\\/]+$/, '')
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

export interface RootLabelFix {
  /** What the row currently renders: the placeholder's encoded tail. */
  encoded: string
  /** What it should render: basename of the real remote path. */
  label: string
  /** The real remote path, kept for the row's title tooltip. */
  remotePath: string
}

// Built from the sessions snapshot and routed through the same routeOf()
// everything else uses, rather than by asking "does this rendered text decode to
// an absolute path?". Two reasons:
//   1. Text-matching would rewrite any local folder whose name happens to be
//      canonical base64url ("L2E" → "/a") — something routing never calls
//      remote, so it would break the local-zero-regression invariant.
//   2. The label must not contradict where the row's data comes from. If
//      routeOf() says remote, fs.tree is being served over SSH and the decoded
//      remote name is correct by construction; if it says local, the text on
//      screen is a real local directory name and must be left alone.
// So the false-positive surface of the root-independent shape fallback (already
// documented at routeByPlaceholderTail) is inherited exactly, not widened.
export function rootLabelFixes(ctx: unknown): RootLabelFix[] {
  const out: RootLabelFix[] = []
  try {
    const c = ctx as { sessions?: { list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: unknown }> } } } }
    const byId = c?.sessions?.list?.getSnapshot?.()?.byId
    if (!byId) return out
    for (const id of Object.keys(byId)) {
      const cwd = byId[id]?.cwd
      if (typeof cwd !== 'string' || !cwd.length) continue
      const r = routeOf(cwd)
      if (r.kind !== 'remote') continue
      const encoded = pathBasename(cwd)
      if (!encoded) continue
      out.push({ encoded, label: remoteDisplayName(r.remoteCwd), remotePath: r.remoteCwd })
    }
  } catch {}
  return out
}

// Class names are CSS-module hashed ("nArs4W_explorerName") and the hash prefix
// is a better-sidebar build artefact, so match on the stable suffix.
const SEL_BODY = '[class*="explorerBody"]'
const SEL_ROW = '[class*="explorerRow"]'
const SEL_NAME = '[class*="explorerName"]'

// The narrowest DOM surface this uses, so it stays drivable from a test stub.
interface DomNode {
  textContent?: unknown
  setAttribute?: (n: string, v: string) => void
  querySelector?: (sel: string) => DomNode | null
}
interface LabelDoc { body?: unknown; querySelectorAll?: (sel: string) => ArrayLike<DomNode> }

// Only the *first* row inside an explorer body is the root row — querySelector
// returns the first match in document order, and better-sidebar renders the root
// row before renderLevel(root, 0). Child rows carry real remote names from
// fs.tree and are never touched.
export function fixExplorerRootLabels(doc: LabelDoc | undefined | null, fixes: RootLabelFix[]): number {
  if (!doc || typeof doc.querySelectorAll !== 'function' || !fixes.length) return 0
  const byEncoded = new Map<string, RootLabelFix>()
  for (const f of fixes) byEncoded.set(f.encoded, f)
  let fixed = 0
  let bodies: ArrayLike<DomNode>
  try { bodies = doc.querySelectorAll(SEL_BODY) ?? [] } catch { return 0 }
  for (let i = 0; i < bodies.length; i++) {
    try {
      const row = bodies[i]?.querySelector?.(SEL_ROW)
      const label = row?.querySelector?.(SEL_NAME)
      if (!label) continue
      const text = typeof label.textContent === 'string' ? label.textContent : ''
      const hit = byEncoded.get(text)
      // Idempotent: once rewritten the text no longer matches any encoded tail,
      // so the MutationObserver-driven re-scan settles after one pass.
      if (!hit || hit.label === text) continue
      label.textContent = hit.label
      // That encoded string was the only place the real path surfaced on the
      // root row; child rows expose theirs through title, so do the same rather
      // than dropping the information.
      try { row?.setAttribute?.('title', hit.remotePath) } catch {}
      fixed++
    } catch {}
  }
  return fixed
}

// React owns that text, so a one-shot rewrite is not enough: the encoded label
// returns on every re-render (session switch, tree reload, restored tab). Watch
// the document and re-apply.
//
// Coalesced on a timer rather than per mutation record, because an xterm pane is
// a continuous mutation stream and a full re-scan per record would be
// measurable. 120 ms of staleness on a folder name is not visible.
const LABEL_FIX_COALESCE_MS = 120
// Bounded retries for the boot race: the sessions snapshot can still be empty
// when the tree first paints, and nothing may mutate afterwards to wake the
// observer.
const LABEL_FIX_RETRY_MS = [250, 1000]

function installRootLabelFix(
  ctx: unknown,
  logger?: { info(s: string): void; warn(s: string): void },
): { dispose(): void } {
  const g = globalThis as unknown as {
    document?: LabelDoc
    MutationObserver?: new (cb: () => void) => { observe(t: unknown, o: unknown): void; disconnect(): void }
  }
  const doc = g.document
  // No DOM (Node unit tests, SSR): routing still works, there is simply nothing
  // to relabel.
  if (!doc || typeof g.MutationObserver !== 'function') return { dispose() {} }

  let announced = false
  // Dispose must be authoritative on its own. A real browser stops delivering
  // records after disconnect(), but the retry timers and the post-probe pass are
  // already in flight, and a disposed overlay must not reach into the DOM again
  // no matter what still calls it.
  let disposed = false
  const run = () => {
    if (disposed) return
    const n = fixExplorerRootLabels(doc, rootLabelFixes(ctx))
    if (n && !announced) {
      announced = true
      logger?.info?.(`[remote-sidebar] corrected ${n} Files-panel root label(s) from the base64url placeholder tail`)
    }
  }

  let coalesce: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (disposed || coalesce) return
    coalesce = setTimeout(() => { coalesce = null; try { run() } catch {} }, LABEL_FIX_COALESCE_MS)
    ;(coalesce as unknown as { unref?: () => void }).unref?.()
  }

  let observer: { observe(t: unknown, o: unknown): void; disconnect(): void } | null = null
  try {
    observer = new g.MutationObserver(() => schedule())
    // document.body, not the panel layer: better-sidebar appends
    // [data-dsh-panel-host] after plugins mount, so observing it would miss the
    // first paint entirely.
    if (doc.body) observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  } catch (e) {
    logger?.warn?.(`[remote-sidebar] root-label observer failed: ${(e as Error)?.message ?? String(e)}`)
    observer = null
  }

  // Immediate pass, then after root discovery (a foreign-home placeholder needs
  // the authoritative root before routeOf() can see it as remote), then the
  // bounded retries.
  try { run() } catch {}
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const later = (ms: number, fn: () => void) => {
    try {
      const t = setTimeout(fn, ms)
      ;(t as unknown as { unref?: () => void }).unref?.()
      timers.push(t)
    } catch {}
  }
  for (const ms of LABEL_FIX_RETRY_MS) later(ms, () => { try { run() } catch {} })
  void awaitRemoteRoot().then(() => { try { run() } catch {} }).catch(() => {})

  return {
    dispose() {
      disposed = true
      try { observer?.disconnect() } catch {}
      observer = null
      if (coalesce) { try { clearTimeout(coalesce) } catch {} ; coalesce = null }
      for (const t of timers) { try { clearTimeout(t) } catch {} }
      timers.length = 0
    },
  }
}

export function apply(ctx: unknown) {
  const c = ctx as { logger?: { info(s:string):void; warn(s:string):void }; effect?(fn:()=>(()=>void)|void, label?: string): void }
  c.logger?.info?.('[remote-sidebar] client overlay mounted (fetch + WS remote routing active)')
  let handle: { dispose():void } | undefined
  let labelFix: { dispose():void } | undefined
  try { handle = installFetchPatch(ctx, c.logger) } catch (e) { c.logger?.warn?.(`[remote-sidebar] fetch patch failed: ${(e as Error)?.message ?? String(e)}`) }
  try { labelFix = installRootLabelFix(ctx, c.logger) } catch (e) { c.logger?.warn?.(`[remote-sidebar] root-label fix failed: ${(e as Error)?.message ?? String(e)}`) }

  // Wrap in cordis effect so dispose is auto on reload
  try {
    c.effect?.(() => () => {
      try { handle?.dispose() } catch {}
      try { labelFix?.dispose() } catch {}
    }, 'remote-sidebar: client patch teardown')
  } catch {}

  return {
    dispose() {
      try { handle?.dispose() } catch {}
      try { labelFix?.dispose() } catch {}
    },
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

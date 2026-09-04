// dsh-sidebar-remote — Host half.
// Aggregates dsh-better-sidebar + @dsh-ssh/dsh-ssh. Preferred path is delegation
// to upstream where possible; remote branches use sshPool + router + policy.

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, posix, isAbsolute, resolve, relative } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { SidebarError, writeOk, writeError, writeJson, readJsonBody, requireString, isTrustedApiRequest, decodeHtmlUrl, mediaTypeForPath, messageOf } from '../shared/wire.js'
import { routeByCwd, resolveRemotePath, remoteRoot } from '../shared/router.js'
import { displayAddress } from '../shared/router.js'
import { remoteListDirectory, remoteReadText, remoteWriteAtomic, applyLiteralEdit, remoteStat } from './remote-fs.js'
import { remoteRunGit, remoteIsGitRepo, remoteRepoRoots, parsePorcelainZ, parseWorktreeList, parseLogLines } from './remote-git.js'
import { RemotePtyManager, classifyTerminalFrame, clampDims } from './remote-pty.js'
import { isPathInsideWorkspace, mutationDenialMode, sandboxDenialError } from '@dsh-ssh/dsh-ssh/src/policy.js'
import { SshError, shellQuoteSingle, buildRemoteCommand, SshConn as SshConnClass } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'
import { HOSTS_NAMESPACE, readHostsDoc } from '@dsh-ssh/dsh-ssh/src/settings.js'
import { ExecFs } from '@dsh-ssh/dsh-ssh/src/exec-fs.js'
import { assertCompat } from './compat.js'
import { patchSshConnShell, ensureShellOnConn } from './ssh-shell-patch.js'

// This string is the DSH plugin id, not just a label: it becomes the boot
// manifest `id` and the client bundle path `/plugins/<id>/client.js`. Renaming
// it therefore invalidates any profile that still lists the old name in
// `dependencies` or `dsh.profile.bundles`, and any browser holding a cached
// bundle URL. Was `@remote/sidebar-remote` until the 0.2.0 rename; neither name
// has ever been published, so no installed deployment carries the old id.
export const name = 'dsh-sidebar-remote'
export const inject = ['webServer', 'sessions', 'webRuntime', 'settings']

type Ctx = {
  logger?: { info(s:string):void; warn(s:string|Error):void; error(s:string|Error):void }
  webServer: { register(r: { kind?: string; path: string; handler: (req: unknown, res: unknown)=>Promise<void>|void }): ()=>void; registerUpgrade(r: { path: string; handler: (req: unknown, socket: unknown, head: Buffer)=>void }): ()=>void; [k:string]: unknown }
  webRuntime: { trustedHosts: string[] }
  sessions: { get(id: string): { header: { cwd: string } } | undefined; all?(): unknown[] }
  settings: { get(ns: string): unknown; register?(ns: string, schema: unknown, opts: unknown): unknown }
  get?(name: string): unknown
  effect(fn: ()=>(()=>void)|void, label?: string): void
  on?(event: string, handler: (e: unknown)=>void): ()=>void
}

function sessionCwdOf(ctx: Ctx, sessionId: string, overrideCwd?: string): string {
  if (overrideCwd && typeof overrideCwd === 'string' && overrideCwd.length) return overrideCwd
  const s = ctx.sessions.get(sessionId)
  if (!s) throw new SidebarError('not-found', `session "${sessionId}" not found`, 404)
  return s.header.cwd
}

async function resolveRemoteConn(ctx: Ctx, cwd: string) {
  const r = routeByCwd(cwd)
  if (r.kind !== 'remote') return null
  const pool = ctx.get?.('sshPool') as { acquire(cfg: unknown): Promise<unknown> } | undefined
  if (!pool) throw new SidebarError('fs-error', `sshPool unavailable for host "${r.hostId}"`, 500)
  const hostsDoc = readHostsDoc((ns: string)=>ctx.settings.get(ns) as never)
  const cfg = (hostsDoc.hosts as Record<string, unknown>)[r.hostId]
  if (!cfg) throw new SidebarError('fs-error', `host "${r.hostId}" not configured in dsh-ssh-hosts`, 400)
  try {
    const conn = await pool.acquire(cfg)
    // The pool hands back a SshConn built by the dsh-ssh copy that owns the
    // sshPool service, which is a different ESM module instance from the one we
    // import — so the prototype patch in apply() cannot reach it. Install shell()
    // on the live connection here, at the single choke point every remote route
    // (fs, upload, html, terminal) already funnels through.
    ensureShellOnConn(conn)
    return { conn, hostId: r.hostId, remoteCwd: r.remoteCwd, cwd }
  } catch (e: unknown) {
    if (e instanceof SshError) throw new SidebarError('fs-error', `${(e as SshError).stage}: ${(e as SshError).message}`, (e as SshError).isHostKeyUnknown ? 403 : 400)
    throw new SidebarError('fs-error', messageOf(e), 400)
  }
}

function badRoute(target: string) { throw new SidebarError('bad-request', `not a ${target} route`, 400) }

function getSandboxMode(ctx: Ctx, sessionId?: string): string {
  // Try to read real sandbox mode from session or settings — never hardcode workspace-write
  try {
    if (sessionId) {
      const s = ctx.sessions.get(sessionId) as unknown as { sandboxMode?: string; header?: { sandboxMode?: string } } | undefined
      if (s && typeof (s as { sandboxMode?: string }).sandboxMode === 'string') return (s as { sandboxMode: string }).sandboxMode
      if (s?.header && typeof (s.header as { sandboxMode?: string }).sandboxMode === 'string') return (s.header as { sandboxMode: string }).sandboxMode
    }
  } catch {}
  // Settings-level sandboxMode (dsh-fs-sandbox / dsh-tools policy id)
  try {
    const g = (ctx.settings as unknown as { get?: (ns: string)=>unknown })?.get
    if (g) {
      const doc = g('dsh-fs-sandbox') as unknown as { mode?: string; sandboxMode?: string } | undefined
      if (doc && typeof doc.mode === 'string') return doc.mode
      if (doc && typeof (doc as { sandboxMode?: string }).sandboxMode === 'string') return (doc as { sandboxMode: string }).sandboxMode!
    }
  } catch {}
  return 'workspace-write'
}

export function apply(ctx: Ctx, config: { readLimit?: number; mediaLimit?: number; uploadLimit?: number; listLimit?: number; terminalsPerSession?: number; reconnectGraceMs?: number } = {}) {
  assertCompat(ctx)
  // F-00: ensure pooled SshConn gains shell() even though upstream 0.1.3 ships without it.
  // This covers our own copy; resolveRemoteConn additionally patches whatever
  // instance the pool actually returns (see ensureShellOnConn).
  try { patchSshConnShell(SshConnClass as unknown) } catch {}
  const resolved = {
    readLimit: config.readLimit ?? 524288,
    mediaLimit: config.mediaLimit ?? 20971520,
    uploadLimit: config.uploadLimit ?? 134217728,
    listLimit: config.listLimit ?? 1000,
    terminalsPerSession: config.terminalsPerSession ?? 3,
    reconnectGraceMs: config.reconnectGraceMs ?? 30000,
  }

  const fence = (req: { headers: Record<string, unknown> }) => isTrustedApiRequest(req as never, ctx.webRuntime.trustedHosts)

  // Remote PTY manager — one instance for all remote sessions
  const remotePty = new RemotePtyManager(resolved.terminalsPerSession, resolved.reconnectGraceMs)
  // wss: reserved for potential future local WS bridging; currently unused but retained so teardown covers both
  // servers. If removed, ensure the teardown below is updated to only close remoteWss.
  const wss = new WebSocketServer({ noServer: true })
  const remoteWss = new WebSocketServer({ noServer: true })

  // Helper: get display address without leaking placeholder encoding to UI errors
  const getHosts = (): Record<string, { name?: string }> => {
    try { return (readHostsDoc((ns: string)=>ctx.settings.get(ns) as never).hosts as Record<string, { name?: string }>) ?? {} } catch { return {} }
  }

  // Build a tiny JSON API shim that mirrors the shape of dsh-better-sidebar's /sidebar/api
  // but routes each method to local or remote accordingly. We DO NOT re-register
  // /sidebar/api — that would collide with better-sidebar. Instead we register
  // /sidebar/remote/* as our remote-aware overlay, and rely on the client to
  // call it for remote sessions. However to keep local behavior untouched, the
  // client will still call /sidebar/api for local sessions.
  //
  // Strategy: register /sidebar/remote/api + /sidebar/remote/file + /sidebar/remote/html
  // plus a status probe /sidebar/remote/address. The client wrapper (src/client)
  // decides at call time.

  async function withRemote<T>(sessionId: string, cwdOverride: string | undefined, fn: (conn: unknown, remoteCwd: string, hostId: string, placeholderCwd: string) => Promise<T>): Promise<{ remote: true; value: T } | { remote: false }> {
    const placeholderCwd = sessionCwdOf(ctx, sessionId, cwdOverride)
    const r = routeByCwd(placeholderCwd)
    if (r.kind !== 'remote') return { remote: false }
    const pooled = await resolveRemoteConn(ctx, placeholderCwd)
    if (!pooled) return { remote: false }
    const value = await fn(pooled.conn, pooled.remoteCwd, pooled.hostId, placeholderCwd)
    return { remote: true, value }
  }

  // ---- /sidebar/remote/api -----------------------------------------------
  ctx.effect(()=>ctx.webServer.register({
    kind: 'prefix', path: '/sidebar/remote/api',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown>; [Symbol.asyncIterator](): AsyncIterator<Buffer> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
      if (!fence(r)) { writeJson(w, 403, { ok:false, error:{ code:'forbidden', message:'forbidden' }}); return }
      if (r.method !== 'POST') { writeJson(w, 405, { ok:false, error:{ code:'method-error', message:'method not allowed' }}); return }
      const pathname = new URL(r.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/sidebar/remote/api/') ? pathname.slice('/sidebar/remote/api/'.length) : undefined
      if (!method || method.includes('/')) { writeError(w, new SidebarError('not-found', 'unknown sidebar API method', 404)); return }
      try {
        const payload = await readJsonBody(r as never) as Record<string, unknown>
        const sessionId = (payload.sessionId as string) ?? (payload.cwd as string ? '' : undefined)
        // Most methods carry sessionId; some like terminal.deps don't
        const cwdOverride = payload.cwd as string | undefined
        const sid = (payload.sessionId as string) ?? ''

        // Dispatch with remote awareness
        if (sid) {
          const route = routeByCwd(sessionCwdOf(ctx, sid, cwdOverride))
          if (route.kind === 'remote') {
            // Methods that only touch local state must not pay for (or fail
            // because of) an SSH connection: a tab closed while the socket was
            // down still has to release its quota even if the host is unreachable.
            if (method === 'pty.close') {
              const tab = requireString(payload, 'tab')
              remotePty.close(`${sid}:${tab}`)
              writeOk(w, { ok: true }); return
            }
            // Remote branch: DO NOT fall back to local on error
            const pooled = await resolveRemoteConn(ctx, sessionCwdOf(ctx, sid, cwdOverride))
            const conn = pooled!.conn as { exec(cmd: string, o?: unknown): Promise<{code:number; stdout:string; stderr:string}>; sftp(): Promise<unknown> }
            const remoteCwd = pooled!.remoteCwd
            const placeholderCwd = sessionCwdOf(ctx, sid, cwdOverride)

            const result = await dispatchRemote(method, payload, conn, remoteCwd, placeholderCwd, resolved, ctx, remotePty)
            writeOk(w, result); return
          }
        }
        // Local branch: proxy to better-sidebar's local handlers would require
        // importing them, but we simply reply with a hint that the client should
        // call the local /sidebar/api instead. To keep proxy minimal, we
        // attempt to delegate via dynamic import of the installed plugin's handlers
        // where feasible: for now, instruct client to use local route.
        writeError(w, new SidebarError('not-found', `method "${method}" not handled for local session; use /sidebar/api`, 404))
      } catch (e) { writeError(w, e) }
    }
  }), 'remote-sidebar: /sidebar/remote/api')

  // ---- /sidebar/remote/root -----------------------------------------------
  // Authoritative placeholder-root discovery for the client half.
  //
  // routeByCwd() must agree on both sides about where the placeholder workspace
  // lives, because upstream derives it from remoteRoot(env) =
  // DSH_SSH_REMOTE_ROOT > $DSH_HOME/remote > os.homedir()/.dsh/remote. In the
  // browser bundle process.env is compiled away to {} and os.homedir() is a
  // build-time shim, so a bundle built on one machine and served on another
  // computes a *different* root: mapLocalToRemote() then returns null and every
  // remote session silently degrades to { kind: 'local' } — no error anywhere,
  // the file tree just shows the empty placeholder directory.
  //
  // The host is the only party that knows the real value, so it is served here
  // and fed back through the `env` parameter routeByCwd() already accepts.
  // No sessionId is required: the client probes this once at boot, before any
  // session is known. The value is not sensitive beyond what /sidebar/api and
  // /sidebar/remote/address already disclose, and the trust fence still applies.
  ctx.effect(()=>ctx.webServer.register({
    kind: 'exact', path: '/sidebar/remote/root',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
      if (!fence(r)) { writeJson(w, 403, { ok:false, error:{ code:'forbidden', message:'forbidden' }}); return }
      try {
        // Read the real environment, not the compiled-away browser copy.
        writeOk(w, { root: remoteRoot(process.env) })
      } catch (e) { writeError(w, e) }
    }
  }), 'remote-sidebar: /sidebar/remote/root')

  ctx.effect(()=>ctx.webServer.register({
    kind: 'exact', path: '/sidebar/remote/address',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
      if (!fence(r)) { writeJson(w, 403, { ok:false, error:{ code:'forbidden', message:'forbidden' }}); return }
      try {
        const url = new URL(r.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) throw new SidebarError('bad-request', 'sessionId is required')
        // The session registry is populated lazily, so a probe fired before the
        // session is hydrated would 404 even though the caller already knows the
        // cwd. Accept it as an override, exactly like /sidebar/remote/file and
        // the git endpoint do.
        const cwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const addr = displayAddress(cwd, getHosts())
        const route = routeByCwd(cwd)
        writeOk(w, { address: addr, kind: route.kind, hostId: (route as { hostId?: string }).hostId ?? null, remoteCwd: (route as { remoteCwd?: string }).remoteCwd ?? null })
      } catch (e) { writeError(w, e) }
    }
  }), 'remote-sidebar: /sidebar/remote/address')

  // ---- /sidebar/remote/file -----------------------------------------------
  ctx.effect(()=>ctx.webServer.register({
    kind: 'prefix', path: '/sidebar/remote/file',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(c: Buffer|string):void }
      if (!fence(r)) { (w as unknown as { writeHead(n:number):void; end(s:string):void }).writeHead(403); (w as unknown as { end(s:string):void }).end('forbidden'); return }
      if (r.method !== 'GET') { (w as unknown as { writeHead(n:number):void; end():void }).writeHead(405); (w as unknown as { end():void }).end(); return }
      try {
        const url = new URL((r as { url?: string }).url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (!sessionId || !raw) throw new SidebarError('bad-request', 'sessionId and path are required')
        const placeholderCwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const route = routeByCwd(placeholderCwd)
        if (route.kind !== 'remote') throw new SidebarError('bad-request', 'not a remote session')
        const resolvedPath = resolveRemotePath(raw, route.remoteCwd, placeholderCwd)
        const pooled = await resolveRemoteConn(ctx, placeholderCwd)
        const conn = pooled!.conn as { sftp(): Promise<{ readFile(p:string):Promise<Buffer>; stat(p:string):Promise<unknown> }>; exec(cmd:string):Promise<{code:number; stdout:string}> }
        // try sftp read, fallback to exec base64
        let buf: Buffer
        try {
          const sftp = await conn.sftp() as { readFile(p:string):Promise<Buffer>; stat?(p:string):Promise<{size?:number}|undefined> }
          if (sftp.stat) {
            const st = await sftp.stat(resolvedPath) as { size?: number } | undefined
            if (st && typeof st.size === 'number' && st.size > resolved.mediaLimit) throw new SidebarError('too-large', 'file too large', 413)
          }
          buf = await sftp.readFile(resolvedPath)
        } catch (e) {
          if (e instanceof SidebarError) throw e
          // exec fallback
          const fs = new ExecFs(conn as never) as unknown as { readBytes(p:string): Promise<Buffer> }
          buf = await fs.readBytes(resolvedPath)
        }
        if (buf.length > resolved.mediaLimit) throw new SidebarError('too-large', 'file too large', 413)
        const type = mediaTypeForPath(resolvedPath)
        const headers: Record<string,string> = { 'content-type': type, 'cache-control': 'no-cache' }
        if (url.searchParams.get('download') === '1') headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(basename(resolvedPath))}`
        // minimal compat for testability
        const wr = w as { writeHead(n:number,h:Record<string,string>):void; end(b: Buffer):void }
        wr.writeHead(200, headers); wr.end(buf)
      } catch (e) {
        const w2 = w as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
        if (e instanceof SidebarError) { writeJson(w2 as never, (e as SidebarError).status, { ok:false, error:{ code:(e as SidebarError).code, message:(e as SidebarError).message }}); return }
        writeJson(w2 as never, 500, { ok:false, error:{ code:'internal', message: messageOf(e) }})
      }
    }
  }), 'remote-sidebar: /sidebar/remote/file')

  // ---- /sidebar/remote/html ------------------------------------------------
  ctx.effect(()=>ctx.webServer.register({
    kind: 'prefix', path: '/sidebar/remote/html',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(c: Buffer|string):void }
      if (!fence(r)) { (w as unknown as { writeHead(n:number):void; end(s:string):void }).writeHead(403); (w as unknown as { end(s:string):void }).end('forbidden'); return }
      if (r.method !== 'GET') { (w as unknown as { writeHead(n:number):void; end():void }).writeHead(405); (w as unknown as { end():void }).end(); return }
      try {
        const url = new URL((r as { url?: string }).url ?? '/', 'http://dsh.internal')
        // Decode /sidebar/remote/html/<sessionId>/<path segments>
        const prefix = '/sidebar/remote/html/'
        const pathname = url.pathname
        if (!pathname.startsWith(prefix)) throw new SidebarError('bad-request', 'not an html route', 400)
        const rest = pathname.slice(prefix.length)
        const segs = rest.split('/').map(s=>{ try{return decodeURIComponent(s)}catch{throw new SidebarError('bad-request','malformed URL encoding',400)} })
        const sessionId = segs[0]
        if (!sessionId) throw new SidebarError('bad-request', 'sessionId and file path are required', 400)
        const tail = segs.slice(1)
        if (tail.length===0 || tail.some(s=>s==='')) throw new SidebarError('bad-request', 'sessionId and file path are required', 400)
        const rawPath = `/${tail.join('/')}`
        const placeholderCwd = sessionCwdOf(ctx, sessionId)
        const route = routeByCwd(placeholderCwd)
        if (route.kind !== 'remote') throw new SidebarError('bad-request', 'not a remote session')
        const resolvedPath = resolveRemotePath(rawPath, route.remoteCwd, placeholderCwd)
        const pooled = await resolveRemoteConn(ctx, placeholderCwd)
        const conn = pooled!.conn as { sftp(): Promise<{ readFile(p:string):Promise<Buffer> }> }
        let buf: Buffer
        try {
          const sftp = await conn.sftp() as { readFile(p:string):Promise<Buffer> }
          buf = await sftp.readFile(resolvedPath)
        } catch {
          const fs = new ExecFs(conn as never) as unknown as { readBytes(p:string): Promise<Buffer> }
          buf = await fs.readBytes(resolvedPath)
        }
        if (buf.length > resolved.mediaLimit) throw new SidebarError('too-large', 'file too large', 413)
        const type = mediaTypeForPath(resolvedPath)
        w.writeHead(200, {
          'content-type': type === 'text/html' ? 'text/html; charset=utf-8' : type,
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "sandbox allow-scripts allow-popups allow-downloads allow-modals; object-src 'none'",
        })
        w.end(buf)
      } catch (e) {
        const w2 = w as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
        if (e instanceof SidebarError) { writeJson(w2 as never, e.status, { ok:false, error:{ code:e.code, message:e.message }}); return }
        writeJson(w2 as never, 500, { ok:false, error:{ code:'internal', message: messageOf(e) }})
      }
    }
  }), 'remote-sidebar: /sidebar/remote/html')

  // ---- /sidebar/remote/upload ----------------------------------------------
  ctx.effect(()=>ctx.webServer.register({
    kind: 'exact', path: '/sidebar/remote/upload',
    handler: async (req: unknown, res: unknown) => {
      const r = req as { method?: string; url?: string; headers: Record<string,unknown>; [Symbol.asyncIterator](): AsyncIterator<Buffer> }
      const w = res as { writeHead(n:number,h:Record<string,string>):void; end(s:string):void }
      if (!fence(r)) { writeJson(w, 403, { ok:false, error:{ code:'forbidden', message:'forbidden' }}); return }
      if (r.method !== 'POST') { writeJson(w, 405, { ok:false, error:{ code:'method-error', message:'method not allowed' }}); return }
      try {
        const url = new URL(r.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const dir = url.searchParams.get('dir')
        const relativePath = url.searchParams.get('relativePath')
        if (!sessionId || !dir || !relativePath || !relativePath.trim()) throw new SidebarError('bad-request', 'sessionId, dir, and relativePath are required')
        if (relativePath === '' || relativePath.startsWith('/') || relativePath.startsWith('\\')) throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
        const segs = relativePath.split(/[\\/]+/)
        if (segs.some(p=>p===''||p==='.'||p==='..')) throw new SidebarError('bad-request', 'relativePath must stay below the upload directory', 400)
        const placeholderCwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
        const route = routeByCwd(placeholderCwd)
        if (route.kind !== 'remote') throw new SidebarError('bad-request', 'not a remote session')
        const pooled = await resolveRemoteConn(ctx, placeholderCwd)
        const conn = pooled!.conn as { sftp(): Promise<{ createWriteStream(p:string): NodeJS.WritableStream }>; exec(cmd:string):Promise<{code:number; stdout:string; stderr:string}> }
        // Collect body
        const chunks: Buffer[] = []; let total = 0
        for await (const c of r) { const b = Buffer.from(c as never); total+=b.length; if (total>resolved.uploadLimit) throw new SidebarError('too-large', `upload exceeds the ${resolved.uploadLimit} byte limit`, 413); chunks.push(b) }
        const body = Buffer.concat(chunks)
        const remoteDir = resolveRemotePath(dir, route.remoteCwd, placeholderCwd)
        const target = posix.join(remoteDir, relativePath.split(/[\\/]+/).join(posix.sep))
        const sandboxMode = getSandboxMode(ctx, sessionId)
        const denial = mutationDenialMode(sandboxMode as never, posix.normalize(target), route.remoteCwd)
        // Real sandboxMode: read-only denies all, danger-full-access passes, workspace-write checks containment
        if (denial) throw sandboxDenialError(denial, 'upload')

        // Write via SFTP stream or exec — only finish/close/error settle; no preemptive setTimeout
        try {
          const sftp = await conn.sftp() as unknown as { createWriteStream(p:string): NodeJS.WritableStream & { on(e:string,fn:(err?:Error)=>void):unknown } }
          if (sftp.createWriteStream) {
            // Ensure parent dir
            await conn.exec(`mkdir -p ${shellQuoteSingle(posix.dirname(target))}`).catch(()=>null)
            await new Promise<void>((resolveP, reject) => {
              const ws = sftp.createWriteStream(target)
              const onError = (err: Error) => reject(err)
              ws.on('error', onError); ws.on('close', resolveP); ws.on('finish', resolveP)
              ws.write(body); (ws as unknown as { end():void }).end()
            })
            writeOk(w, { path: target, size: body.length }); return
          }
        } catch {}
        // exec fallback: base64 chunked
        const dirQ = shellQuoteSingle(posix.dirname(target))
        await conn.exec(`mkdir -p ${dirQ}`)
        const b64 = body.toString('base64')
        const rExec = await conn.exec(`printf %s ${shellQuoteSingle(b64)} | base64 -d > ${shellQuoteSingle(target)}`)
        if (rExec.code !== 0) throw new SidebarError('fs-error', `upload failed: ${rExec.stderr}`, 400)
        writeOk(w, { path: target, size: body.length })
      } catch (e) { writeError(w, e) }
    }
  }), 'remote-sidebar: /sidebar/remote/upload')

  // ---- WebSocket: /sidebar/ws/remote-terminal --------------------------------
  // Separate from better-sidebar's /sidebar/ws/terminal so we don't collide.
  // Client chooses local vs remote WS by session route.
  ctx.effect(()=>ctx.webServer.registerUpgrade({
    path: '/sidebar/ws/remote-terminal',
    handler: (req: unknown, socket: unknown, head: Buffer) => {
      const r = req as { headers: Record<string,unknown>; url?: string }
      if (!fence(r)) { (socket as { destroy():void }).destroy(); return }
      const wss2 = remoteWss
      wss2.handleUpgrade(r as never, socket as never, head, (ws: WebSocket) => {
        attachRemoteTerminal(ctx, remotePty, ws, r).catch(e=>{
          try { ws.close(1011, messageOf(e)) } catch {}
        })
      })
    }
  }), 'remote-sidebar: remote-terminal WS')

  // Cleanup
  ctx.effect(()=>()=>{
    try { remotePty.disposeAll() } catch {}
    try { wss.close() } catch {}
    try { remoteWss.close() } catch {}
  }, 'remote-sidebar: teardown')

  ctx.logger?.info('[remote-sidebar] host routes mounted (/sidebar/remote/*)')
}

function poolRef(ctx: Ctx) {
  return ctx.get?.('sshPool') as { acquire(c: unknown): Promise<unknown> } | undefined
}

async function dispatchRemote(
  method: string, payload: Record<string,unknown>,
  conn: { exec(cmd:string,o?:unknown):Promise<{code:number; stdout:string; stderr:string}>; sftp():Promise<unknown> },
  remoteCwd: string, placeholderCwd: string, resolved: { readLimit:number; mediaLimit:number; listLimit:number },
  ctx: Ctx,
  remotePtyRef?: RemotePtyManager,
): Promise<unknown> {
  const sessionId = payload.sessionId as string
  const resolve = (p: string) => resolveRemotePath(p, remoteCwd, placeholderCwd)
  const dispatchSandbox = getSandboxMode(ctx, sessionId)
  switch (method) {
    case 'fs.tree':
    case 'fsTree': {
      const p = resolve((payload.path as string) ?? remoteCwd)
      return remoteListDirectory(conn, p, resolved.listLimit)
    }
    case 'fs.read':
    case 'fsRead': {
      const p = resolve(payload.path as string)
      const { text } = await remoteReadText(conn, p, 10*1024*1024)
      // Window chunking like better-sidebar's buildWindow (line/length/bytes caps)
      const { window: w, truncated } = buildWindow(text, resolved.readLimit)
      // better-sidebar's client gates content on `result.kind === "text"`:
      //   content: result.kind === "text" ? result.content : ""
      // Without `kind: "text"` the editor opens the tab but renders empty.
      return { kind: 'text', path: p, content: w, truncated, size: Buffer.byteLength(text,'utf8') }
    }
    case 'fs.write':
    case 'fsWrite': {
      const p = resolve(payload.path as string)
      const content = payload.content as string
      if (typeof content !== 'string') throw new SidebarError('bad-request', 'content is required')
      // readMode-aware sandbox
      { const d = mutationDenialMode(dispatchSandbox as never, posix.normalize(p), remoteCwd); if (d) throw sandboxDenialError(d, 'write') }
      await remoteWriteAtomic(conn, p, content, remoteCwd, dispatchSandbox)
      return { path: p }
    }
    case 'fs.edit':
    case 'fsEdit': {
      const p = resolve(payload.path as string)
      const old_string = payload.old_string as string
      const new_string = payload.new_string as string
      const replace_all = payload.replace_all as boolean | undefined
      if (typeof old_string !== 'string' || typeof new_string !== 'string') throw new SidebarError('bad-request', 'old_string and new_string are required')
      { const d = mutationDenialMode(dispatchSandbox as never, posix.normalize(p), remoteCwd); if (d) throw sandboxDenialError(d, 'edit') }
      const { text: before } = await remoteReadText(conn, p)
      const after = applyLiteralEdit(before, { old_string, new_string, replace_all })
      await remoteWriteAtomic(conn, p, after, remoteCwd, dispatchSandbox)
      return { path: p }
    }
    case 'fs.delete':
    case 'fsDelete': {
      const p = resolve(payload.path as string)
      { const d = mutationDenialMode(dispatchSandbox as never, posix.normalize(p), remoteCwd); if (d) throw sandboxDenialError(d, 'delete') }
      const r = await conn.exec(`rm -rf ${shellQuoteSingle(p)}`)
      if (r.code !== 0) throw new SidebarError('fs-error', r.stderr || r.stdout, 400)
      return { path: p }
    }
    case 'fs.rename':
    case 'fsRename': {
      const from = resolve(payload.from as string)
      const to = resolve(payload.to as string)
      for (const q of [from,to]) {
        const d = mutationDenialMode(dispatchSandbox as never, posix.normalize(q), remoteCwd); if (d) throw sandboxDenialError(d, 'rename')
      }
      const r = await conn.exec(`mv -f ${shellQuoteSingle(from)} ${shellQuoteSingle(to)}`)
      if (r.code !== 0) throw new SidebarError('fs-error', r.stderr || r.stdout, 400)
      return { from, to }
    }
    case 'git.status': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const selected = payload.selected ? resolve(payload.selected as string) : undefined
      const roots = await remoteRepoRoots(conn, cwd)
      if (roots.length===0) return { isRepo:false, entries:[], truncated:false }
      const root = selected ? (roots.find(r=>r===selected) ?? roots[0]!) : roots[0]!
      const isRepo = await remoteIsGitRepo(conn, root)
      if (!isRepo) return { isRepo:false, entries:[], truncated:false }
      const out = await remoteRunGit(conn as never, root, ['status','--porcelain=v1','-z','--untracked-files=all'])
      const all = parsePorcelainZ(out)
      const truncated = all.length > 2000
      const entries = truncated ? all.slice(0,2000) : all
      const branch = await remoteRunGit(conn as never, root, ['rev-parse','--abbrev-ref','HEAD']).then(s=>s.trim()).catch(()=>'HEAD')
      return { isRepo:true, branch, entries, truncated, root, repositories: roots.length>1?roots:undefined }
    }
    case 'git.diff': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const file = payload.file as string | undefined
      const staged = !!payload.staged
      const args = ['diff', '--no-color', ...(staged?['--staged']:[]), ...(file?[file]:[])]
      const diff = await remoteRunGit(conn as never, cwd, args)
      return { diff }
    }
    case 'git.log': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const n = Math.min(200, Math.max(1, Number(payload.limit ?? 50)))
      const out = await remoteRunGit(conn as never, cwd, ['log', `--max-count=${n}`, '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D', '--decorate=short'])
      return { entries: parseLogLines(out) }
    }
    case 'git.worktrees': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const out = await remoteRunGit(conn as never, cwd, ['worktree','list','--porcelain','-z'])
      return { worktrees: parseWorktreeList(out) }
    }
    case 'git.commit': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const message = payload.message as string
      if (!message) throw new SidebarError('bad-request','message is required')
      const out = await remoteRunGit(conn as never, cwd, ['commit','-m', message])
      return { output: out }
    }
    case 'git.branch': {
      const cwd = resolve((payload.cwd as string) ?? remoteCwd)
      const name = payload.name as string
      if (!name) throw new SidebarError('bad-request','name is required')
      const out = await remoteRunGit(conn as never, cwd, ['checkout','-b', name])
      return { output: out }
    }
    case 'pty.close': {
      // Reached only when a caller routes here with a live connection; the
      // connectionless fast path above handles the normal client call.
      const tab = requireString(payload, 'tab')
      remotePtyRef?.close(`${sessionId}:${tab}`)
      return { ok: true }
    }
    default:
      throw new SidebarError('not-found', `unknown remote method "${method}"`, 404)
  }
}

function buildWindow(text: string, readLimit: number): { window: string; truncated: boolean } {
  // Like better-sidebar's buildWindow: split lines, bound by readLimit chars
  if (text.length <= readLimit) return { window: text, truncated: false }
  return { window: text.slice(0, readLimit), truncated: true }
}

// Wire protocol is byte-for-byte the one dsh-better-sidebar's client speaks on
// /sidebar/ws/terminal, because that client is what connects here once the
// overlay rewrites the URL:
//   server -> client : RAW terminal text (the view does term.write(event.data))
//   client -> server : RAW keystrokes, plus JSON control frames
//                      {type:'resize',cols,rows} / {type:'close'} / {type:'park'}
// Wrapping output in {type:'data',...} made xterm render the JSON envelope
// itself, and expecting {type:'input'} for keystrokes made JSON.parse fail on
// every real keypress, so the pane was read-only garbage. Frame classification
// lives in classifyTerminalFrame() (remote-pty.ts) so it is unit-testable.
async function attachRemoteTerminal(ctx: Ctx, manager: RemotePtyManager, ws: WebSocket, req: { url?: string }) {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const sessionId = url.searchParams.get('sessionId')
    // The client sends ?tab=<tabId>; ?tabId is accepted for direct callers.
    const tabId = url.searchParams.get('tab') ?? url.searchParams.get('tabId')
    if (!sessionId || !tabId) { ws.close(1008, 'sessionId and tab are required'); return }
    // Honour a per-tab cwd override exactly like the local route does.
    const placeholderCwd = sessionCwdOf(ctx, sessionId, url.searchParams.get('cwd') ?? undefined)
    const route = routeByCwd(placeholderCwd)
    if (route.kind !== 'remote') { ws.close(1008, 'not a remote session'); return }
    const pooled = await resolveRemoteConn(ctx, placeholderCwd)
    const conn = pooled!.conn as Parameters<RemotePtyManager['open']>[5]

    const key = `${sessionId}:${tabId}`
    const start = clampDims(Number(url.searchParams.get('cols') ?? 80), Number(url.searchParams.get('rows') ?? 24))
    const handle = await manager.open(sessionId, tabId, pooled!.remoteCwd, start.cols, start.rows, conn as never)

    // Raw text both for the transcript replay and for live output, with the
    // same backpressure guard the local pump uses.
    const send = (data: string): void => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4 * 1024 * 1024) ws.send(data)
    }
    if (handle.transcript) send(handle.transcript)
    const toText = (d: Buffer|string) => typeof d === 'string' ? d : d.toString('utf8')
    const onData = (d: Buffer|string) => send(toText(d))
    const onStderr = (d: Buffer|string) => send(toText(d))
    const onClose = () => send(`\r\n[process exited with code ${String(handle.exitCode ?? 0)}]\r\n`)
    handle.shell.on('data', onData)
    handle.shell.on('close', onClose)
    if (handle.shell.stderr) handle.shell.stderr.on('data', onStderr)

    ws.on('message', (raw: Buffer) => {
      const frame = classifyTerminalFrame(raw.toString('utf8'))
      if (frame.kind === 'close') { manager.scheduleClose(key, 0); return }
      if (frame.kind === 'park') { manager.park(key); return }
      if (handle.exited) return
      if (frame.kind === 'resize') {
        try { handle.shell.setWindow(frame.rows, frame.cols) } catch {}
        return
      }
      try { handle.shell.write(frame.text) }
      catch (e) {
        // A throwing write means the SSH channel is gone even though no 'close'
        // ever arrived (half-open TCP after a VPN drop or a server-side idle
        // kill), so `handle.exited` is still false and nothing else would
        // notice. Swallowing it left the pane frozen with zero diagnostics and
        // the socket open, which the client reads as "still connected" and so
        // never reconnects. Say what happened and drop the socket instead.
        send(`\r\n[remote shell is gone: ${messageOf(e)}]\r\n`)
        try { ws.close(1011, 'remote shell write failed') } catch {}
      }
    })
    ws.on('close', () => {
      // Detach this view's own listeners instead of stacking a no-op on top of
      // them, then apply the same park/grace contract as the local manager.
      try { handle.shell.removeListener('data', onData) } catch {}
      try { handle.shell.removeListener('close', onClose) } catch {}
      if (handle.shell.stderr) { try { handle.shell.stderr.removeListener('data', onStderr) } catch {} }
      if (!manager.isParked(key)) manager.scheduleClose(key, 30000)
    })
    ws.on('error', () => { try { ws.close() } catch {} })
  } catch (e) {
    try { ws.close(1011, messageOf(e)) } catch {}
  }
}

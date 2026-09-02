// Remote PTY via SSH shell channel.
// Source: dsh-better-sidebar@0.17.1 src/pty-manager.ts (PtyManager lifecycle, transcript ring, park/reconnectGrace)
//        @dsh-ssh/dsh-ssh@0.1.3 src/ssh-core.ts (shellQuoteSingle/buildRemoteCommand)
// Keeps a map sessionId:tabId → Ssh shell + transcript ring.
// WebSocket upgrade path: /sidebar/ws/remote-terminal — fence checked before upgrade.

import { SidebarError } from '../shared/wire.js'
import { shellQuoteSingle, buildRemoteCommand, SshConn } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'

// ssh2 ChannelStream is an EventEmitter; removeListener is required so a
// reconnecting view can detach its own pump instead of stacking a new listener
// on every attach (which duplicated output and leaked per refresh).
interface ShellStream {
  write(d: string): void
  setWindow(rows: number, cols: number, w?: number, h?: number): void
  signal(sig: string): void
  close(): void
  on(e: 'data', fn: (d: Buffer|string)=>void): void
  on(e: 'close', fn: ()=>void): void
  removeListener(e: 'data', fn: (d: Buffer|string)=>void): void
  removeListener(e: 'close', fn: ()=>void): void
  stderr?: { on(e: 'data', fn: (d: Buffer|string)=>void): void; removeListener(e: 'data', fn: (d: Buffer|string)=>void): void }
}

// Must be a real SshConn subset — RemotePtyManager.open is only called with
// a pooled SshConn after patchSshConnShell has ensured .shell exists.
// Self-declaring a brand-new SshLikeConn would fake the typecheck; keep the
// bound tight so missing shell is a real type error until patched.
type SshPtyConn = Pick<SshConn, 'hostId' | 'exec' | 'shell' | 'sftp'>

const TRANSCRIPT_LIMIT = 1 << 20

// Terminal dims are clamped exactly like better-sidebar (TERMINAL_DIM_MIN/MAX),
// so a remote pane cannot be resized into a degenerate or absurd geometry.
export const TERMINAL_DIM_MIN = 2
export const TERMINAL_DIM_MAX = 1024
export function clampDims(cols: number, rows: number): { cols: number; rows: number } {
  const clamp = (v: number) => Math.min(TERMINAL_DIM_MAX, Math.max(TERMINAL_DIM_MIN, Math.floor(v)))
  return { cols: clamp(Number.isFinite(cols) ? cols : 80), rows: clamp(Number.isFinite(rows) ? rows : 24) }
}

export type TerminalFrame =
  | { kind: 'close' }
  | { kind: 'park' }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'input'; text: string }

/**
 * Classify one client->server terminal frame using dsh-better-sidebar's wire
 * contract: control frames are JSON objects with a recognized `type`, and
 * EVERYTHING else is terminal input verbatim — including text that happens to
 * be JSON but is not a recognized control (a user may legitimately paste
 * `{"type":"data"}` into the shell).
 *
 * Treating input as `{type:'input',data}` instead (the previous shape) made
 * JSON.parse throw on every real keypress, so the pane was read-only.
 */
export function classifyTerminalFrame(text: string): TerminalFrame {
  let control: { type?: unknown; cols?: unknown; rows?: unknown } | null = null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') control = parsed as { type?: unknown; cols?: unknown; rows?: unknown }
  } catch { /* not JSON: terminal input */ }
  if (control?.type === 'close') return { kind: 'close' }
  if (control?.type === 'park') return { kind: 'park' }
  if (control?.type === 'resize' && typeof control.cols === 'number' && typeof control.rows === 'number') {
    const dims = clampDims(control.cols, control.rows)
    return { kind: 'resize', cols: dims.cols, rows: dims.rows }
  }
  return { kind: 'input', text }
}

export interface RemotePtyHandle {
  key: string
  sessionId: string
  tabId: string
  cwd: string
  transcript: string
  exited: boolean
  exitCode?: number | null
  shell: ShellStream
}

export class RemotePtyManager {
  private sessions = new Map<string, RemotePtyHandle>()
  private pendingCloses = new Map<string, ReturnType<typeof setTimeout>>()
  private parked = new Set<string>()
  constructor(private maxPerSession: number, private reconnectGraceMs: number) {}

  keysOf(sessionId: string): string[] {
    return [...this.sessions.values()].filter(h=>h.sessionId===sessionId).map(h=>h.key)
  }
  get(key: string): RemotePtyHandle | undefined { return this.sessions.get(key) }

  async open(sessionId: string, tabId: string, cwd: string, cols: number, rows: number, conn: SshPtyConn): Promise<RemotePtyHandle> {
    const key = `${sessionId}:${tabId}`
    this.cancelClose(key)
    const existing = this.sessions.get(key)
    if (existing && !existing.exited && existing.cwd === cwd) return existing
    if (existing) this.close(key)
    for (const [k, h] of [...this.sessions]) if (h.sessionId===sessionId && h.exited) this.close(k)
    if (this.keysOf(sessionId).length >= this.maxPerSession) throw new SidebarError('pty-error', `terminal limit reached (${this.maxPerSession})`, 400)

    // Probe cwd liveness with a quoted probe so paths containing ' " $ ` \ etc. are safe.
    const probe = buildRemoteCommand(`test -d ${shellQuoteSingle(cwd)} || mkdir -p ${shellQuoteSingle(cwd)}`, undefined)
    try { await conn.exec(probe, { timeoutMs: 8000 }) } catch {}
    const shellFn = conn.shell as unknown as ((o: { term: string; cols: number; rows: number })=>Promise<ShellStream>) | undefined
    if (typeof shellFn !== 'function') throw new SidebarError('pty-error', 'remote shell not available (apply SshConn patch first)', 500)
    const shell = await shellFn.call(conn, { term: 'xterm-256color', cols: Math.max(2, Math.floor(cols)), rows: Math.max(2, Math.floor(rows)) })
    const handle: RemotePtyHandle = { key, sessionId, tabId, cwd, transcript: '', exited: false, shell: shell as ShellStream }
    // Ensure cwd — use single-quote escaping (not JSON.stringify) so single quotes become '\'' .
    try { shell.write(`cd ${shellQuoteSingle(cwd)} 2>/dev/null; clear 2>/dev/null\r`) } catch {}
    shell.on('data', (d: Buffer|string) => {
      const s = typeof d === 'string' ? d : d.toString('utf8')
      handle.transcript += s
      if (handle.transcript.length > TRANSCRIPT_LIMIT) handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
    })
    if (shell.stderr) shell.stderr.on('data', (d: Buffer|string) => {
      const s = typeof d === 'string' ? d : d.toString('utf8')
      handle.transcript += s
      if (handle.transcript.length > TRANSCRIPT_LIMIT) handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT)
    })
    shell.on('close', () => { handle.exited = true })
    this.sessions.set(key, handle)
    return handle
  }

  scheduleClose(key: string, delayMs: number) {
    if (!this.sessions.has(key)) return
    this.cancelClose(key)
    const t = setTimeout(()=>this.close(key), delayMs)
    this.pendingCloses.set(key, t)
  }
  cancelClose(key: string) {
    const t = this.pendingCloses.get(key)
    if (t) { clearTimeout(t); this.pendingCloses.delete(key) }
    this.parked.delete(key)
  }
  park(key: string) { this.cancelClose(key); this.parked.add(key) }
  /** Public so callers never reach into the private set to read parked state. */
  isParked(key: string): boolean { return this.parked.has(key) }
  close(key: string) {
    const h = this.sessions.get(key)
    if (!h) return
    this.cancelClose(key); this.parked.delete(key)
    try { h.shell.close() } catch {}
    this.sessions.delete(key)
  }
  disposeAll() {
    for (const k of [...this.sessions.keys()]) this.close(k)
    for (const t of this.pendingCloses.values()) clearTimeout(t)
    this.pendingCloses.clear()
  }
}

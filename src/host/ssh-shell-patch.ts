// Patch @dsh-ssh/dsh-ssh SshConn to add shell() for PTY, mirroring real ssh2.client.shell.
// Source: ssh2 lib/client.js shell(wndopts, opts, cb) + @dsh-ssh SshConn _execChannel pattern.
// This is a controlled runtime patch (docs/compatibility.md §4.3): SshConn@sftp is missing shell,
// so we extend the prototype in host apply instead of forking the dependency.
import { SshError } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'

type ShellOpts = { term: string; cols: number; rows: number }

function isNotConnectedError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err)
  return msg.includes('Not connected')
}

type ConnLike = Record<string, unknown> & {
  connect(): Promise<unknown>
  _dead?: boolean
  _resetDeadState(): void
  _ensureOpen(): void
  client: { shell(w: unknown, o: unknown, cb: (err: unknown, stream: unknown)=>void): unknown } | null
  id: string
}

// The shell implementation itself, shared by every install target below.
function makeShell(): (this: ConnLike, opts: ShellOpts) => Promise<unknown> {
  const NewSshError: unknown = SshError
  const MakeErr = (o: Record<string, unknown>) => new (NewSshError as unknown as new (o: Record<string, unknown>)=>Error)(o)
  return async function shell(this: ConnLike, opts: ShellOpts) {
    const self = this
    const doShell = () => new Promise<unknown>((resolve, reject) => {
      try {
        self._ensureOpen()
      } catch (e) { reject(e); return }
      const client = self.client!
      const wndopts = { term: opts?.term ?? 'xterm-256color', cols: Math.max(2, Math.floor(opts?.cols ?? 80)), rows: Math.max(2, Math.floor(opts?.rows ?? 24)) }
      try {
        client.shell(wndopts, {}, (err: unknown, stream: unknown) => {
          if (err) {
            reject(MakeErr({ hostId: self.id, stage: 'shell-open', message: (err as { message?: string })?.message ?? String(err), cause: err }))
            return
          }
          resolve(stream)
        })
      } catch (err) {
        reject(MakeErr({ hostId: self.id, stage: 'shell-open', message: (err as { message?: string })?.message ?? String(err), cause: err }))
      }
    })

    try {
      await self.connect()
      return await doShell()
    } catch (err) {
      if (!isNotConnectedError(err)) throw err
      self._dead = true
      try { self._resetDeadState() } catch {}
      try {
        await self.connect()
        return await doShell()
      } catch (err2) {
        throw MakeErr({ hostId: self.id, stage: 'shell-open', message: 'reconnect failed after disconnect: ' + ((err2 as { message?: string })?.message ?? String(err2)), cause: err2 })
      }
    }
  }
}

/** Install shell() onto a constructor's prototype (or a bare prototype object). */
export function patchSshConnShell(target: unknown): boolean {
  if (!target) return false
  const t = target as { prototype?: unknown }
  // Accept either a constructor or an already-resolved prototype.
  const proto = (t.prototype && typeof t.prototype === 'object' ? t.prototype : target) as Record<string, unknown>
  if (!proto || typeof proto !== 'object') return false
  if (typeof proto.shell === 'function') return true // already present (upstream fixed)
  try { proto.shell = makeShell(); return true } catch { return false }
}

/**
 * Ensure a *live pooled connection* can open a shell.
 *
 * Patching the SshConn class we imported is not enough: the sshPool service is
 * created by the dsh-ssh copy installed in the DSH profile, which is a distinct
 * ESM module instance, so its SshConn is a different class object
 * (import('@dsh-ssh/.../ssh-core.js') !== import('<profile>/node_modules/...')).
 * The prototype patch therefore never reached the pooled connections and every
 * remote terminal died with "remote shell not available (apply SshConn patch
 * first)". Walking the instance's own prototype chain is copy-agnostic, and the
 * instance itself is the final fallback for plain-object connections.
 */
export function ensureShellOnConn(conn: unknown): boolean {
  if (!conn || typeof conn !== 'object') return false
  const c = conn as Record<string, unknown>
  if (typeof c.shell === 'function') return true
  const proto = Object.getPrototypeOf(c) as Record<string, unknown> | null
  // Never mutate Object.prototype — that would put shell() on every object in
  // the process. Only a real class prototype that looks like SshConn qualifies.
  const patchable = !!proto && proto !== Object.prototype
    && typeof (proto as Record<string, unknown>).connect === 'function'
    && typeof (proto as Record<string, unknown>).exec === 'function'
  if (patchable && patchSshConnShell(proto)) return true
  try { c.shell = makeShell(); return true } catch { return false }
}

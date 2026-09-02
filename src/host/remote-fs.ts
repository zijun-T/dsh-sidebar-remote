// Source: dsh-better-sidebar@0.17.1 src/fs-tree.ts (compareEntries), src/fs-operations.ts, src/wire.ts
//        @dsh-ssh/dsh-ssh@0.1.3 src/ssh-core.ts (shellQuoteSingle/buildRemoteCommand), src/exec-fs.ts (ExecFs), src/policy.ts (mutationDenialMode)
// Remote file ops via SshConn + Sftp/ExecFs. Controlled inline per docs/compatibility.md §4.3.
// Uses sshPool.acquire(hostCfg) for every op; no per-request Client.
// Note: compareEntries converges to shared/wire.ts canonical impl — this file imports it (not duplicated).

import { posix } from 'node:path'
import { SidebarError, compareEntries, messageOf } from '../shared/wire.js'
import { resolveRemotePath } from '../shared/router.js'
import { isPathInsideWorkspace, mutationDenialMode, sandboxDenialError } from '@dsh-ssh/dsh-ssh/src/policy.js'
import { SshError, shellQuoteSingle, buildRemoteCommand } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'
import { ExecFs } from '@dsh-ssh/dsh-ssh/src/exec-fs.js'

export interface RemoteFsListingEntry { name: string; path: string; isDir: boolean; hidden: boolean; isSymlink: boolean; broken: boolean }
export interface RemoteFsListing { path: string; entries: RemoteFsListingEntry[]; truncated: boolean }

/* helpers to obtain an fs-like handle from a connection */
async function getFs(conn: { sftp(): Promise<unknown>; exec(cmd: string, o?: unknown): Promise<{code:number; stdout:string; stderr:string}>; hostId: string }, opts: { timeoutMs?: number } = {}) {
  try {
    const sftp = await (conn as { sftp(): Promise<unknown> }).sftp()
    // Validate shape — ssh2 SFTP wrapper vs ExecFs fallback both expose stat/readText
    if (sftp && typeof (sftp as { stat?: unknown }).stat === 'function') return sftp as SftpLike
  } catch {}
  // SFTP disabled → ExecFs fallback (exec+base64)
  return new ExecFs(conn as never, { timeoutMs: opts.timeoutMs ?? 30_000 }) as unknown as SftpLike
}

interface SftpLike {
  stat?(p: string): Promise<{ type?: string; isDirectory?(): boolean; isFile?(): boolean; size?: number; mtime?: number } | undefined>
  readdir?(p: string): Promise<{ filename: string; longname: string; attrs: unknown }[] | string[]>
  readFile?(p: string): Promise<Buffer>
  readText?(p: string): Promise<string>
  writeFileAtomic?(p: string, data: string | Buffer): Promise<void>
  createReadStream?(p: string): NodeJS.ReadableStream
  createWriteStream?(p: string): NodeJS.WritableStream
  // ExecFs compat
  listDir?(p: string): Promise<{ name: string; type: string }[]>
  exists?(p: string): Promise<boolean>
  readBytes?(p: string): Promise<Buffer>
}

function toFsError(e: unknown, path: string): never {
  if (e instanceof SidebarError) throw e
  if (e instanceof SshError) throw new SidebarError('fs-error', `${e.stage}: ${e.message}`, 400)
  throw new SidebarError('fs-error', `cannot access "${path}": ${messageOf(e)}`, 400)
}

// One normalized row per backend, so the type hints are read where they exist
// instead of being looked up after the fact:
//   ssh2 SFTP readdir -> { filename, longname, attrs }, longname is an `ls -l`
//                        line whose first char carries the type ('d', 'l', ...)
//   ExecFs listDir    -> { name, type: 'dir'|'file'|'link'|'other' }, no longname
// Reading only `.filename`/`.longname` made the ExecFs fallback miss on every
// entry, so directories (including the workspace root's own children) came back
// as isDir:false and the tree could not be expanded.
interface RawRow { name: string; isDir: boolean; isSymlink: boolean }

function rowFromSftp(r: unknown): RawRow | null {
  if (typeof r === 'string') return r.length ? { name: r, isDir: false, isSymlink: false } : null
  const e = r as { filename?: unknown; longname?: unknown }
  if (typeof e.filename !== 'string' || !e.filename) return null
  const longname = typeof e.longname === 'string' ? e.longname : ''
  return { name: e.filename, isDir: longname.startsWith('d'), isSymlink: longname.startsWith('l') }
}

function rowFromExec(r: { name: string; type: string }): RawRow | null {
  if (!r || typeof r.name !== 'string' || !r.name) return null
  return { name: r.name, isDir: r.type === 'dir', isSymlink: r.type === 'link' }
}

export async function remoteListDirectory(conn: unknown, remotePath: string, maxEntries = 1000): Promise<RemoteFsListing> {
  const c = conn as Parameters<typeof getFs>[0]
  let fs: SftpLike
  try { fs = await getFs(c) } catch (e: unknown) { toFsError(e, remotePath) }

  // Try Sftp readdir first, then ExecFs listDir
  let rawRows: RawRow[] = []
  if (typeof fs.readdir === 'function') {
    try {
      const res = await fs.readdir(remotePath) as unknown[]
      // ssh2 returns { filename, longname, attrs }; string[] is also tolerated.
      rawRows = res.map(rowFromSftp).filter((r): r is RawRow => r !== null)
    } catch (e) { toFsError(e, remotePath) }
  } else if (typeof (fs as SftpLike).listDir === 'function') {
    try {
      const list = await (fs as SftpLike).listDir!(remotePath)
      rawRows = list.map(rowFromExec).filter((r): r is RawRow => r !== null)
    } catch (e) { toFsError(e, remotePath) }
  } else {
    throw new SidebarError('fs-error', `cannot list "${remotePath}": no directory reader`, 400)
  }

  const rows: RemoteFsListingEntry[] = []
  let overflow = 0
  for (const item of rawRows) {
    const name = item.name
    if (!name) continue
    if (rows.length >= maxEntries) { overflow += 1; continue }
    rows.push({ name, path: posix.join(remotePath, name), isDir: item.isDir, hidden: name.startsWith('.'), isSymlink: item.isSymlink, broken: false })
  }

  // Symlink probe — best effort, bounded concurrency
  const CONC = 16
  let idx = 0
  const workers = Array.from({ length: Math.min(CONC, rows.length) }, async () => {
    for (;;) {
      const i = idx++
      if (i >= rows.length) return
      const row = rows[i]!
      if (!row.isSymlink) continue
      try {
        const st = await fs.stat!(row.path)
        if (st) {
          const isDir = typeof (st as { isDirectory?: ()=>boolean }).isDirectory === 'function'
            ? (st as { isDirectory: ()=>boolean }).isDirectory()
            : st.type === 'directory'
          row.isDir = isDir
          row.broken = false
        } else row.broken = true
      } catch { row.broken = true }
    }
  })
  await Promise.all(workers)
  rows.sort(compareEntries)
  return { path: remotePath, entries: rows, truncated: overflow > 0 }
}

export async function remoteReadText(conn: unknown, remotePath: string, limitBytes = 10 * 1024 * 1024): Promise<{ text: string; size?: number }> {
  const c = conn as Parameters<typeof getFs>[0]
  let fs: SftpLike
  try { fs = await getFs(c) } catch (e: unknown) { toFsError(e, remotePath) }
  try {
    if (typeof fs.readText === 'function') {
      // ExecFs.readText or Sftp readText
      const txt = await fs.readText(remotePath)
      if (Buffer.byteLength(txt, 'utf8') > limitBytes) throw new SidebarError('too-large', `file exceeds ${limitBytes} byte limit`, 413)
      return { text: txt }
    }
    if (typeof fs.readFile === 'function') {
      const buf = await fs.readFile(remotePath)
      if (buf.length > limitBytes) throw new SidebarError('too-large', `file exceeds ${limitBytes} byte limit`, 413)
      return { text: buf.toString('utf8'), size: buf.length }
    }
    if (typeof (fs as SftpLike).readBytes === 'function') {
      const buf = await (fs as SftpLike).readBytes!(remotePath)
      if (buf.length > limitBytes) throw new SidebarError('too-large', `file exceeds ${limitBytes} byte limit`, 413)
      return { text: buf.toString('utf8'), size: buf.length }
    }
    throw new SidebarError('fs-error', `cannot read "${remotePath}"`, 400)
  } catch (e) {
    if (e instanceof SidebarError) throw e
    toFsError(e, remotePath)
  }
}

/**
 * Execute a remote command with optional timeout/AbortSignal, rejecting with SidebarError exec-timeout.
 * No preemptive setTimeout — only finish/close/error settle the promise.
 */
async function execWithTimeout(
  sc: { exec(cmd: string, o?: unknown): Promise<{code:number; stdout:string; stderr:string}> },
  cmd: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{code:number; stdout:string; stderr:string}> {
  let onAbort: (()=>void) | undefined
  const abortPromise = opts.signal ? new Promise<never>((_, rej) => {
    if (opts.signal!.aborted) { rej(new SidebarError('fs-error', 'exec-timeout: aborted', 504)); return }
    onAbort = () => rej(new SidebarError('fs-error', 'exec-timeout: aborted', 504))
    opts.signal!.addEventListener('abort', onAbort, { once: true })
  }) : null
  const execPromise = sc.exec(cmd, opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined)
  try {
    if (abortPromise) return await Promise.race([execPromise, abortPromise])
    if (!opts.timeoutMs) return await execPromise
    // timeoutMs handled by SshConn.exec itself; we add explicit rejection if it hangs without SshConn support
    const timeout = new Promise<never>((_, rej) => {
      const t = setTimeout(()=>rej(new SidebarError('fs-error', `exec-timeout after ${opts.timeoutMs}ms`, 504)), opts.timeoutMs!)
      execPromise.finally(()=>clearTimeout(t))
    })
    return await Promise.race([execPromise, timeout])
  } finally {
    if (onAbort) try { opts.signal!.removeEventListener('abort', onAbort) } catch {}
  }
}

export async function remoteWriteAtomic(conn: unknown, remotePath: string, content: string, remoteCwd: string, sandboxMode: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  // sandbox check — read-only denies all, danger-full-access passes
  const denial = mutationDenialMode(sandboxMode as never, posix.normalize(remotePath), remoteCwd)
  if (denial) throw sandboxDenialError(denial, 'write')
  const c = conn as Parameters<typeof getFs>[0]
  let fs: SftpLike
  try { fs = await getFs(c) } catch (e: unknown) { toFsError(e, remotePath) }
  let tmpCreated = false
  const needsAbortableExec = !!(opts.signal || opts.timeoutMs)
  try {
    if (typeof fs.writeFileAtomic === 'function' && !needsAbortableExec) {
      await fs.writeFileAtomic(remotePath, content)
      return
    }
    // When abort/timeout requested, fall through to abortable exec path (don't use fs.writeFileAtomic which ignores signal)
    // Fallback: exec base64 write
    const sc = c as { exec(cmd: string, o?: unknown): Promise<{code:number; stdout:string; stderr:string}> }
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    // chunk to stay under exec command limit
    const CHUNK = 48 * 1024 // source bytes per chunk, same as ExecFs
    if (b64.length <= 130_000) {
      const dir = posix.dirname(remotePath)
      const cmd = `mkdir -p ${shellQuoteSingle(dir)} && printf %s ${shellQuoteSingle(b64)} | base64 -d > ${shellQuoteSingle(remotePath)}.tmp && mv -f ${shellQuoteSingle(remotePath + '.tmp')} ${shellQuoteSingle(remotePath)}`
      const r = await execWithTimeout(sc, cmd, opts)
      if (r.code !== 0) throw new SidebarError('fs-error', `write failed: ${r.stderr || r.stdout}`, 400)
      return
    }
    // chunked
    const buf = Buffer.from(content, 'utf8')
    const dir = posix.dirname(remotePath)
    await execWithTimeout(sc, `mkdir -p ${shellQuoteSingle(dir)}`, opts)
    // truncate/create tmp
    const tmp = remotePath + '.tmp'
    await execWithTimeout(sc, `: > ${shellQuoteSingle(tmp)}`, opts)
    tmpCreated = true
    for (let off = 0; off < buf.length; off += CHUNK) {
      const slice = buf.subarray(off, Math.min(off + CHUNK, buf.length))
      const cb64 = slice.toString('base64')
      const r = await execWithTimeout(sc, `printf %s ${shellQuoteSingle(cb64)} | base64 -d >> ${shellQuoteSingle(tmp)}`, opts)
      if (r.code !== 0) throw new SidebarError('fs-error', `write chunk failed: ${r.stderr}`, 400)
    }
    const mv = await execWithTimeout(sc, `mv -f ${shellQuoteSingle(tmp)} ${shellQuoteSingle(remotePath)}`, opts)
    if (mv.code !== 0) throw new SidebarError('fs-error', `atomic rename failed: ${mv.stderr}`, 400)
    tmpCreated = false
  } catch (e) {
    if (e instanceof SidebarError || (e as { code?: string })?.code === 'FS_SANDBOX_DENIED') {
      // best-effort tmp cleanup on failure (timeout/abort/error) — fire-and-forget, never await hanging exec
      if (tmpCreated) {
        try {
          const sc2 = c as { exec(cmd: string): Promise<unknown> }
          sc2.exec(`rm -f ${shellQuoteSingle(remotePath + '.tmp')}`).catch(()=>null)
        } catch {}
      }
      throw e
    }
    if (tmpCreated) {
      try { (c as { exec(cmd: string): Promise<unknown> }).exec(`rm -f ${shellQuoteSingle(remotePath + '.tmp')}`).catch(()=>null) } catch {}
    }
    toFsError(e, remotePath)
  }
}

export function applyLiteralEdit(before: string, patch: { old_string: string; new_string: string; replace_all?: boolean }): string {
  // LF normalization like dsh-better-sidebar: applyLiteralEdit
  const norm = (s: string) => s.replace(/\r\n/g, '\n')
  const b = norm(before)
  const oldN = norm(patch.old_string)
  const newN = norm(patch.new_string)
  if (!patch.replace_all) {
    const count = b.split(oldN).length - 1
    if (count === 0) throw new SidebarError('bad-request', 'old_string not found', 400)
    if (count > 1) throw new SidebarError('bad-request', 'old_string appears multiple times; use replace_all', 400)
    return b.replace(oldN, newN)
  }
  return b.split(oldN).join(newN)
}

export async function remoteStat(conn: unknown, remotePath: string): Promise<{ isFile: boolean; isDir: boolean; size: number } | null> {
  const c = conn as Parameters<typeof getFs>[0]
  let fs: SftpLike
  try { fs = await getFs(c) } catch { return null }
  try {
    const st = await fs.stat?.(remotePath)
    if (!st) return null
    const isDir = typeof (st as { isDirectory?: ()=>boolean }).isDirectory === 'function' ? (st as { isDirectory: ()=>boolean }).isDirectory() : st.type === 'directory'
    const isFile = typeof (st as { isFile?: ()=>boolean }).isFile === 'function' ? (st as { isFile: ()=>boolean }).isFile() : st.type === 'file'
    return { isDir: !!isDir, isFile: !!isFile, size: st.size ?? 0 }
  } catch { return null }
}

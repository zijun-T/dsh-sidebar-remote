// Remote git — all commands via SshConn.exec git -C <cwd>

import { SshError, shellQuoteSingle, buildRemoteCommand } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'
import { SidebarError, messageOf } from '../shared/wire.js'

export class GitCommandError extends Error {
  constructor(message: string, readonly code = 'git-error', readonly command: string = '') { super(message); this.name = 'GitCommandError' }
}

// Minimal porcelain parsers — Source: dsh-better-sidebar@0.17.1 src/git.ts (controlled inline)
export function parsePorcelainZ(output: string) {
  const tokens = output.split('\0')
  const entries: { path: string; xy: string }[] = []
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!; i++
    if (token === '') continue
    const xy = token.slice(0, 2)
    const rest = token.slice(3)
    entries.push({ path: rest, xy })
    if ((xy[0] === 'R' || xy[0] === 'C') && tokens[i] !== undefined && tokens[i] !== '') i++
  }
  return entries
}
export function parseWorktreeList(output: string) {
  const rows: { path: string; branch: string; locked: boolean; prunable: boolean }[] = []
  let path: string | undefined; let branch = 'HEAD'; let locked = false; let prunable = false
  const flush = () => { if (path !== undefined) rows.push({ path, branch, locked, prunable }); path = undefined; branch = 'HEAD'; locked = false; prunable = false }
  const sep = output.includes('\0') ? '\0' : '\n'
  const framed = output.endsWith(sep) ? output : `${output}${sep}`
  for (const line of framed.split(sep)) {
    if (line === '') flush()
    else if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    else if (line === 'locked' || line.startsWith('locked ')) locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true
  }
  return rows
}
export function parseLogLines(output: string) {
  const rows: { hash: string; hashFull: string; subject: string; author: string; date: string; refs: string }[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, author, date, hashFull, refs] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({ hash, subject, author: author ?? '', date: date ?? '', hashFull: hashFull ?? hash, refs: refs ?? '' })
  }
  return rows
}

function buildGitArgs(cwd: string, args: string[]): string {
  // git -C <cwd> --no-pager -c color.ui=false <args...>
  const parts = ['-C', shellQuoteSingle(cwd), '--no-pager', '-c', 'color.ui=false', ...args.map(shellQuoteSingle)]
  return 'git ' + parts.join(' ')
}

export async function remoteRunGit(conn: { exec(cmd: string, o?: { timeoutMs?: number }): Promise<{code:number; stdout:string; stderr:string}> }, cwd: string, args: string[], timeoutMs = 30000): Promise<string> {
  const cmd = buildGitArgs(cwd, args)
  const r = await conn.exec(cmd, { timeoutMs })
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout || '').trim() || `git exited with ${r.code}`
    throw new GitCommandError(msg, 'git-error', args.join(' '))
  }
  return r.stdout
}

export async function remoteIsGitRepo(conn: unknown, cwd: string): Promise<boolean> {
  try { const out = await remoteRunGit(conn as never, cwd, ['rev-parse', '--is-inside-work-tree'], 5000); return out.trim() === 'true' } catch { return false }
}
export async function remoteRepoRoots(conn: unknown, cwd: string): Promise<string[]> {
  try {
    const out = await remoteRunGit(conn as never, cwd, ['rev-parse', '--show-toplevel'], 5000)
    return [out.trim()]
  } catch {
    // container fallback: list children via exec ls -1 and probe
    const c = conn as { exec(cmd: string): Promise<{code:number; stdout:string}> }
    const ls = await c.exec(`ls -1 ${shellQuoteSingle(cwd)} 2>/dev/null`).catch(()=>({ code: 1, stdout: '' }))
    if (ls.code !== 0) return []
    const names = ls.stdout.split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('.') && s !== 'node_modules').slice(0, 50)
    const roots: string[] = []
    for (const n of names) {
      try {
        const out = await remoteRunGit(conn as never, `${cwd.replace(/\/$/, '')}/${n}`, ['rev-parse', '--show-toplevel'], 3000)
        const root = out.trim(); if (root && !roots.includes(root)) roots.push(root)
      } catch {}
    }
    return roots
  }
}

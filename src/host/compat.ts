// Compat checks — Source: docs/compatibility §3-4 controlled inline
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { SidebarError } from '../shared/wire.js'

function satisfies(installed: string, range: string): boolean {
  // minimal ^x.y.z support
  const clean = (s: string) => s.replace(/^[^\d]*/, '').split('.').map(n => parseInt(n, 10) || 0) as [number, number, number]
  const req = range.replace(/^\^/, '')
  const [rmaj, rmin] = clean(req)
  const [imaj, imin] = clean(installed)
  if (imaj !== rmaj) return imaj > rmaj
  return imin >= rmin
}

function readPkgVersion(pkg: string): string | null {
  try {
    const p = resolve('node_modules', pkg, 'package.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return typeof j.version === 'string' ? j.version : null
  } catch { return null }
}

export function assertCompat(ctx: { get?: (name: string)=>unknown; settings?: unknown; webServer?: unknown; sessions?: unknown }) {
  // Service existence
  const need = ['webServer','sessions','webRuntime','settings']
  for (const n of need) {
    const has = (ctx as unknown as Record<string,unknown>)[n] ?? ctx.get?.(n)
    if (!has) throw new SidebarError('fs-error', `remote-sidebar: missing required Service "${n}" — ensure DSH 0.1.1-rc.2 profile and update trustedHosts`, 500)
  }
  if (!ctx.get?.('sshPool')) {
    // sshPool comes from @dsh-ssh/dsh-ssh
    throw new SidebarError('fs-error', 'remote-sidebar: sshPool Service not mounted — ensure @dsh-ssh/dsh-ssh@0.1.3 is installed before this bundle. Fix: dsh plugin --profile <name> add @dsh-ssh/dsh-ssh@0.1.3', 500)
  }
  // peer version checks (warn via throw so apply fails fast with guidance)
  const checks: [string,string][] = [
    ['dsh-better-sidebar','^0.17.1'],
    ['@dsh-ssh/dsh-ssh','^0.1.3'],
  ]
  for (const [pkg, range] of checks) {
    const v = readPkgVersion(pkg)
    if (v && !satisfies(v, range)) {
      throw new SidebarError('fs-error', `remote-sidebar: ${pkg}@${v} does not satisfy ${range} — run pnpm install and republish lockfile`, 500)
    }
  }
  // Node
  const major = parseInt(process.versions.node.split('.')[0]!,10)
  if (major < 22) throw new SidebarError('fs-error', `remote-sidebar: Node >=22 required, got ${process.versions.node}`, 500)
}

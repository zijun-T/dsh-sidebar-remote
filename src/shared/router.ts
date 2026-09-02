// Shared router — thin re-export + display label helpers.
// Source of truth for routing is @dsh-ssh/dsh-ssh/src/router.js (pure fns).
// This file only adds display-identity separation.

export {
  remoteRoot,
  isValidHostId,
  encodeRemotePath,
  decodeRemotePath,
  mapRemoteToLocal,
  mapLocalToRemote,
  routeByCwd,
} from '@dsh-ssh/dsh-ssh/src/router.js'

import path from 'node:path'
import { posix } from 'node:path'
import { decodeRemotePath, encodeRemotePath, isValidHostId, mapLocalToRemote, mapRemoteToLocal, routeByCwd, resolveRemotePath as resolveRemotePathUpstream } from '@dsh-ssh/dsh-ssh/src/router.js'

export type Route = { kind: 'local' } | { kind: 'remote'; hostId: string; remoteCwd: string }

// Upstream resolveRemotePath() re-anchors absolute paths that sit inside the
// placeholder workspace, but its `rel !== ''` guard drops the exact-root case:
// relative(p, p) is '', so a request for the placeholder cwd itself falls
// through to posix.normalize() and is handed to SSH verbatim, where that path
// does not exist. The sidebar sends exactly that for the file-tree root, so
// every remote workspace rendered as an empty tree with "No such file".
//
// A sibling placeholder path for the same host (a second remote workspace
// referenced by absolute path) is decoded as well — it is equally meaningless
// on the remote. Everything else keeps upstream semantics unchanged.
export function resolveRemotePath(requestedPath: string, remoteCwd: string, placeholderCwd?: string): string {
  if (typeof requestedPath === 'string' && requestedPath.length && placeholderCwd
      && (posix.isAbsolute(requestedPath) || path.isAbsolute(requestedPath))) {
    // Both spellings are checked because the placeholder cwd is a native local
    // path on Windows, where posix.relative() cannot see the containment.
    if (posix.relative(placeholderCwd, requestedPath) === '' || path.relative(placeholderCwd, requestedPath) === '') {
      return remoteCwd
    }
    const mapped = mapLocalToRemote(requestedPath)
    const self = mapped ? mapLocalToRemote(placeholderCwd) : null
    if (mapped && self && mapped.hostId === self.hostId) return mapped.remotePath
  }
  return resolveRemotePathUpstream(requestedPath, remoteCwd, placeholderCwd)
}

// Root-independent placeholder detection.
//
// routeByCwd() anchors on remoteRoot(env), and the browser bundle cannot know
// that value: esbuild compiles `process.env` away to {} and os.homedir() comes
// from a build-time shim, so a bundle built on one machine and served by another
// computes a different root and every remote session degrades to local with no
// error anywhere. The host serves the real root at /sidebar/remote/root, but a
// WebSocket constructor is synchronous and cannot await that probe — a terminal
// tab restored during boot would connect before the answer arrives.
//
// This applies the same two-segment shape upstream applies, to the tail of the
// path instead of relative to a root, so it answers correctly no matter which
// machine produced the placeholder path. It is a fallback, never a replacement:
// callers must prefer routeByCwd() once the authoritative root is known.
//
// A false positive needs a real local directory named exactly as the canonical
// base64url of an absolute path — which always begins with 'L', because '/' is
// 0x2F and its top six bits select base64 index 11 — sitting inside a directory
// with a host-id-shaped name. That is the same coincidence upstream already
// discounts ("a coincidentally matching real local directory is never
// misdetected"), so this does not weaken the local-zero-regression invariant in
// any case that can occur in practice.
export function routeByPlaceholderTail(cwd: string): Route {
  if (typeof cwd !== 'string' || !cwd.length) return { kind: 'local' }
  // Split on both separators: the placeholder cwd is a native local path on
  // Windows, where posix semantics cannot see the segments.
  const segments = cwd.split(/[\\/]+/).filter((s) => s.length)
  if (segments.length < 2) return { kind: 'local' }
  const hostId = segments[segments.length - 2]
  const encoded = segments[segments.length - 1]
  if (!isValidHostId(hostId)) return { kind: 'local' }
  const remotePath = decodeRemotePath(encoded)
  if (remotePath === null || !remotePath.startsWith('/')) return { kind: 'local' }
  return { kind: 'remote', hostId, remoteCwd: remotePath }
}

/** Build the human-readable address line for a cwd. */
export function displayAddress(cwd: string, hosts: Record<string, { name?: string }>): string {
  const mapped = mapLocalToRemote(cwd)
  if (mapped) {
    const label = hosts[mapped.hostId]?.name?.trim() || mapped.hostId
    return `${label}:${mapped.remotePath}`
  }
  return cwd
}

/** Structured remote identity — never derived by parsing displayAddress. */
export interface RemoteIdentity {
  hostId: string
  remotePath: string
  remoteCwd: string
}

export function remoteIdentityOf(cwd: string): RemoteIdentity | null {
  const r = routeByCwd(cwd)
  if (r.kind !== 'remote') return null
  return { hostId: r.hostId, remotePath: r.remoteCwd, remoteCwd: r.remoteCwd }
}

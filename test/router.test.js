import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { routeByCwd, mapLocalToRemote, mapRemoteToLocal, resolveRemotePath, encodeRemotePath, decodeRemotePath, displayAddress, routeByPlaceholderTail } from '../lib/shared/router.js'

describe('router', () => {
  it('local route for ordinary cwd', () => {
    const r = routeByCwd('/home/build/proj')
    assert.equal(r.kind, 'local')
  })
  it('encode/decode roundtrip', () => {
    const enc = encodeRemotePath('/home/alice/proj')
    assert.equal(decodeRemotePath(enc), '/home/alice/proj')
  })
  it('mapRemoteToLocal + mapLocalToRemote roundtrip', () => {
    const local = mapRemoteToLocal('myhost', '/home/alice/proj')
    assert.ok(local)
    const back = mapLocalToRemote(local)
    assert.equal(back.hostId, 'myhost')
    assert.equal(back.remotePath, '/home/alice/proj')
  })
  it('resolveRemotePath relative against remoteCwd', () => {
    assert.equal(resolveRemotePath('./a', '/home/alice', '/tmp/placeholder'), '/home/alice/a')
    assert.equal(resolveRemotePath('/etc/hosts', '/home/alice', '/tmp/placeholder'), '/etc/hosts')
  })
  it('displayAddress for remote cwd shows hostLabel:/path', () => {
    const remote = '/home/alice/proj'
    const local = mapRemoteToLocal('srv1', remote)
    const addr = displayAddress(local, { srv1: { name: 'My Server' } })
    assert.equal(addr, 'My Server:/home/alice/proj')
  })
  it('displayAddress for local cwd shows cwd itself', () => {
    assert.equal(displayAddress('/tmp/local', {}), '/tmp/local')
  })
  it('display identity not derived from display text', () => {
    const local = mapRemoteToLocal('h1', '/a/b')
    const addr = displayAddress(local, { h1: { name: 'X' } })
    // addr parsing must not be used as identity
    assert.ok(addr.includes('X:'))
    const mapped = mapLocalToRemote(local)
    assert.equal(mapped.remotePath, '/a/b')
  })
})

// routeByPlaceholderTail() is the root-independent half of client routing: the
// browser cannot compute remoteRoot(), and a WebSocket constructor cannot await
// the host's answer, so the placeholder shape has to be recognisable from the
// path alone.
describe('routeByPlaceholderTail: root-independent placeholder detection', () => {
  const enc = encodeRemotePath('/home/remote/ws')

  it('detects a placeholder under a root this machine never computed', () => {
    // routeByCwd() anchors on the local root and therefore misses this one;
    // that miss is precisely the cross-machine silent failure.
    const foreign = `/home/alice/.dsh/remote/myhost/${enc}`
    assert.equal(routeByCwd(foreign, { DSH_SSH_REMOTE_ROOT: '/home/build/.dsh/remote' }).kind, 'local')
    const r = routeByPlaceholderTail(foreign)
    assert.equal(r.kind, 'remote')
    assert.equal(r.hostId, 'myhost')
    assert.equal(r.remoteCwd, '/home/remote/ws')
  })

  it('agrees with routeByCwd() on a real placeholder under the local root', () => {
    const local = mapRemoteToLocal('srv1', '/home/remote/ws')
    const a = routeByCwd(local)
    const b = routeByPlaceholderTail(local)
    assert.equal(a.kind, 'remote')
    assert.deepEqual({ kind: b.kind, hostId: b.hostId, remoteCwd: b.remoteCwd },
      { kind: 'remote', hostId: 'srv1', remoteCwd: '/home/remote/ws' })
  })

  it('leaves ordinary local paths alone', () => {
    for (const p of ['/home/build/proj', '/tmp', '/', '', '/home/build/proj/src/shared']) {
      assert.equal(routeByPlaceholderTail(p).kind, 'local', `${p} must stay local`)
    }
  })

  it('rejects an encoded segment that does not decode to an absolute path', () => {
    // 'proj' is valid base64url but decodes to bytes, not to a path.
    // The fixture's last segment has to stay a *legal* base64url length
    // (len % 4 !== 1) or the case would pass for the wrong reason — an
    // undecodable length rather than a non-path decoding.
    assert.equal(routeByPlaceholderTail('/home/build/proj').kind, 'local')
    // A relative remote path is not a placeholder either.
    assert.equal(routeByPlaceholderTail(`/srv1/${encodeRemotePath('home/remote')}`).kind, 'local')
  })

  it('rejects host ids that could traverse', () => {
    assert.equal(routeByPlaceholderTail(`/.dsh/../${enc}`).kind, 'local')
    assert.equal(routeByPlaceholderTail(`/home/x/-lead/${enc}`).kind, 'local')
  })

  it('needs both segments: a lone encoded name is not a placeholder', () => {
    // Any path with two or more segments has a tail; the guard is that the tail
    // must be hostId + encoded, so a single segment can never qualify.
    assert.equal(routeByPlaceholderTail(`/${enc}`).kind, 'local')
    assert.equal(routeByPlaceholderTail(enc).kind, 'local')
  })

  it('reads the tail through Windows separators too', () => {
    // The placeholder cwd is a native local path on Windows, where posix
    // semantics cannot see the segments.
    const r = routeByPlaceholderTail(`C:\\Users\\bob\\.dsh\\remote\\srv1\\${enc}`)
    assert.equal(r.kind, 'remote')
    assert.equal(r.hostId, 'srv1')
    assert.equal(r.remoteCwd, '/home/remote/ws')
  })

  it('never throws on non-string input', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      assert.equal(routeByPlaceholderTail(bad).kind, 'local')
    }
  })
})

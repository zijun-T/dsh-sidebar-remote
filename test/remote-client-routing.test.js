import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { pickApiPrefix, pickWsUrl, routeForUpload, routeForFile } from '../lib/client/index.js'
import { routeByCwd, displayAddress, mapRemoteToLocal } from '../lib/shared/router.js'

describe('remote-client-routing', () => {
  const localCwd = '/home/build/proj'
  const remoteLocal = mapRemoteToLocal('myhost', '/home/alice/proj')
  assert.ok(remoteLocal, 'placeholder mapping should exist')
  const remoteSessionId = 'sess-remote-1'
  const localSessionId = 'sess-local-1'

  beforeEach(() => {
    globalThis.location = { protocol: 'http:', host: '127.0.0.1:3080', href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' }
  })

  it('local session -> /sidebar/api and ws/terminal', () => {
    assert.equal(pickApiPrefix(localCwd), '/sidebar/api')
    // location must be present for pickWsUrl
    globalThis.location = { protocol: 'http:', host: '127.0.0.1:3080', href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' }
    const url = pickWsUrl(localCwd, 't1', 80, 24, 'S1')
    assert.match(url, /\/sidebar\/ws\/terminal\?/)
  })
  it('remote session -> /sidebar/remote/api and ws/remote-terminal', () => {
    assert.equal(pickApiPrefix(remoteLocal), '/sidebar/remote/api')
    globalThis.location = { protocol: 'http:', host: '127.0.0.1:3080', href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' }
    const url = pickWsUrl(remoteLocal, 't1', 80, 24, 'S1')
    assert.match(url, /\/sidebar\/ws\/remote-terminal\?/)
  })
  it('displayAddress not used for routing — routeByCwd decides', () => {
    const addr = displayAddress(remoteLocal, { myhost: { name: 'My Server' } })
    assert.equal(addr, 'My Server:/home/alice/proj')
    assert.equal(routeByCwd(remoteLocal).kind, 'remote')
    assert.equal(routeByCwd(addr).kind, 'local', 'display string is not a workspace path')
  })
  it('upload/file helpers respect route', () => {
    assert.equal(routeForUpload(localCwd), '/sidebar/upload')
    assert.equal(routeForUpload(remoteLocal), '/sidebar/remote/upload')
    assert.match(routeForFile(localCwd, '/a/b.txt'), /\/sidebar\/file\?/)
    assert.match(routeForFile(remoteLocal, '/home/alice/a.txt'), /\/sidebar\/remote\/file\?/)
  })
  it('null cwd falls back to local', () => {
    assert.equal(pickApiPrefix(null), '/sidebar/api')
  })

  // Full patch contract: real ctx.sessions.list.getSnapshot byId -> fetch/WS actually hit /remote/*
  it('fetch patch rewrites /sidebar/api|upload|file|html + WS to remote when cwd is remote', async () => {
    const { apply } = await import('../lib/client/index.js')
    const fetchCalls = []
    const fakeFetch = async (url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null })
      return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
    }
    const g = globalThis
    const prevFetch = g.fetch
    const prevWS = g.WebSocket
    // Mock WebSocket constructor: capture url
    const wsUrls = []
    class FakeWS { constructor(url){ wsUrls.push(String(url)); this.url = String(url); this.readyState = 1; this.onopen=null; this.onmessage=null; this.close=()=>{}; this.send=()=>{} } }
    // Mock ctx.sessions
    const ctx = {
      logger: { info(){} },
      effect: undefined,
      sessions: {
        list: {
          getSnapshot() {
            return {
              byId: {
                [remoteSessionId]: { cwd: remoteLocal },
                [localSessionId]: { cwd: localCwd },
              }
            }
          }
        }
      }
    }
    g.fetch = fakeFetch
    // @ts-ignore
    g.WebSocket = FakeWS
    g.location = { protocol: 'http:', host: '127.0.0.1:3080', href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080' }
    const handle = apply(ctx)
    // Remote api call body carries sessionId -> must go to /sidebar/remote/api
    await g.fetch('/sidebar/api/fs.tree', { method: 'POST', body: JSON.stringify({ sessionId: remoteSessionId, path: '/proj' }) })
    assert.ok(fetchCalls.some(c => c.url.includes('/sidebar/remote/api/fs.tree')), `api not remapped: ${JSON.stringify(fetchCalls)}`)
    // Local api must stay /sidebar/api
    fetchCalls.length = 0
    await g.fetch('/sidebar/api/fs.tree', { method: 'POST', body: JSON.stringify({ sessionId: localSessionId, path: '/proj' }) })
    assert.ok(!fetchCalls.some(c => c.url.includes('/sidebar/remote/')), `local leaked to remote: ${JSON.stringify(fetchCalls)}`)

    // Remote upload query has sessionId -> /sidebar/remote/upload
    fetchCalls.length = 0
    await g.fetch(`/sidebar/upload?sessionId=${remoteSessionId}&dir=/proj&relativePath=a/b.txt&cwd=${encodeURIComponent(remoteLocal)}`, { method: 'POST', body: new Uint8Array([1]) })
    assert.ok(fetchCalls.some(c => c.url.includes('/sidebar/remote/upload')), `upload not remapped: ${JSON.stringify(fetchCalls)}`)
    // Remote download/file
    fetchCalls.length = 0
    await g.fetch(`/sidebar/file?sessionId=${remoteSessionId}&path=/proj/a.txt&cwd=${encodeURIComponent(remoteLocal)}`)
    assert.ok(fetchCalls.some(c => c.url.includes('/sidebar/remote/file')), `file not remapped: ${JSON.stringify(fetchCalls)}`)
    // Remote html iframe: path-encoded /sidebar/html/<sid>/<segments>
    fetchCalls.length = 0
    await g.fetch(`/sidebar/html/${encodeURIComponent(remoteSessionId)}/home/alice/proj/index.html`)
    assert.ok(fetchCalls.some(c => c.url.includes('/sidebar/remote/html/')), `html not remapped: ${JSON.stringify(fetchCalls)}`)

    // Remote WS: terminal -> remote-terminal
    const ws = new g.WebSocket(`ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=${remoteSessionId}&tabId=t1&cols=80&rows=24`)
    assert.match(ws.url, /\/sidebar\/ws\/remote-terminal/, `WS not remapped: ${ws.url}`)
    // Local WS must stay /terminal
    const ws2 = new g.WebSocket(`ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=${localSessionId}&tabId=t1&cols=80&rows=24`)
    assert.match(ws2.url, /\/sidebar\/ws\/terminal/, `local WS incorrectly remapped: ${ws2.url}`)
    assert.ok(!ws2.url.includes('remote-terminal'))

    try { handle.dispose() } catch {}
    g.fetch = prevFetch
    g.WebSocket = prevWS
  })
})

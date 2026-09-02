// Browser-bundle integration test.
//
// lib/client.js is what the DSH web page actually loads, so the routing logic
// must be exercised *as bundled*, not as TypeScript. The historical failure was
// invisible to the Node unit tests: the `buffer` polyfill has no 'base64url'
// encoding, so decodeRemotePath() threw, was swallowed, and every remote
// placeholder cwd degraded to { kind: 'local' } only in the browser.
//
// We therefore run the real bundle inside a vm sandbox that deliberately has NO
// Node Buffer, forcing the bundled polyfill (and its base64url patch) to run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(root, 'lib/client.js')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const HOST_ID = '11111111-2222-3333-4444-555555555555'
const REMOTE_PATH = '/home/remote/ws'
// base64url(REMOTE_PATH), unpadded — same encoding @dsh-ssh/dsh-ssh emits.
const ENCODED = 'L2hvbWUvcmVtb3RlL3dz'
const REMOTE_CWD = `/home/build/.dsh/remote/${HOST_ID}/${ENCODED}`
const LOCAL_CWD = '/home/build/proj'
const ORIGIN = 'http://127.0.0.1:3080'

// The bundle bakes the *building* machine's home into scripts/shim-os.mjs, so
// this placeholder sits under a root the bundle cannot derive on its own. It is
// the cross-machine deployment shape: before root discovery existed, every
// session like this silently degraded to { kind: 'local' } and the sidebar
// rendered the empty placeholder directory with no error anywhere.
const FOREIGN_ROOT = '/home/alice/.dsh/remote'
const FOREIGN_CWD = `${FOREIGN_ROOT}/${HOST_ID}/${ENCODED}`

// Load the bundle in a browser-ish sandbox and return { exports, sandbox, registered }.
function loadBundle(opts = {}) {
  const code = readFileSync(bundlePath, 'utf8')

  const registered = []
  const fetchCalls = []
  const probeCalls = []
  const wsCalls = []

  // What GET /sidebar/remote/root answers. The default is "no usable root",
  // i.e. what a host too old to serve the endpoint returns; routing then has to
  // fall back to the root-independent shape check.
  const rootReply = opts.rootReply ?? { ok: true, status: 200, json: async () => ({}) }

  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Int8Array,
    setTimeout,
    clearTimeout,
    location: {
      protocol: 'http:',
      host: '127.0.0.1:3080',
      origin: ORIGIN,
      href: `${ORIGIN}/`,
    },
    // Captures what the bundle registers with the DSH client module loader.
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry)
      },
    },
    // Records rewritten requests instead of performing them.
    fetch(url, init) {
      const s = String(url)
      // Keep the discovery probe out of fetchCalls: routing assertions should
      // not have to know that discovery happens, and the probe is asserted on
      // its own below. Strips any origin so both spellings are recognised.
      if (s.replace(/^https?:\/\/[^/]+/, '') === '/sidebar/remote/root') {
        probeCalls.push({ url: s, init })
        return Promise.resolve(rootReply)
      }
      fetchCalls.push({ url: s, init })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    },
  }
  // A WebSocket stub that records the URL it was constructed with.
  sandbox.WebSocket = function FakeWebSocket(url, protos) {
    wsCalls.push({ url: String(url), protos })
    this.readyState = 1
    this.close = () => {}
    this.send = () => {}
    this.on = () => {}
  }
  sandbox.WebSocket.OPEN = 1

  // `window`/`self`/`globalThis` all point at the sandbox global, matching a
  // browser where they are the same object.
  sandbox.window = sandbox
  sandbox.self = sandbox
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  // Sanity: Node's Buffer must NOT leak in, or the polyfill bug stays hidden.
  assert.equal(typeof sandbox.Buffer, 'undefined', 'sandbox must start without Buffer')
  vm.runInContext(code, context, { filename: 'client.js' })

  assert.equal(registered.length, 1, 'bundle must register exactly one loader entry')
  const entry = registered[0]
  // Two assertions on purpose, neither tautological on its own:
  //  - the literal catches an unintended rename of the package;
  //  - the derivation catches the build registering the bundle under anything
  //    other than package.json#name, which is what DSH resolves plugins by.
  assert.equal(pkg.name, 'dsh-sidebar-remote')
  assert.equal(entry.id, pkg.name, 'loader entry id must be derived from package.json#name')
  assert.equal(typeof entry.factory, 'function')

  // The DSH ClientModuleSystem calls factory(require) and uses the return value.
  const exports = entry.factory(() => {
    throw new Error('client bundle must not require() external modules')
  })

  return { exports, sandbox, fetchCalls, probeCalls, wsCalls }
}

test('bundle registers via __ModuleLoader__ and exports apply/inject', () => {
  const { exports, sandbox } = loadBundle()
  assert.equal(typeof exports.apply, 'function', 'exports.apply missing')
  assert.equal(Array.isArray(exports.inject), true, 'exports.inject must be an array')
  // The array lives in the vm realm, so compare by value, not by prototype.
  assert.deepEqual(Array.from(exports.inject), ['sessions'])
  // The polyfill patch must be the Buffer that ran (not Node's).
  assert.equal(sandbox.Buffer?._isBase64UrlPatched, true, 'base64url patch not installed')
})

test('bundled Buffer polyfill round-trips base64url', () => {
  const { sandbox } = loadBundle()
  const B = sandbox.Buffer
  const enc = B.from(REMOTE_PATH, 'utf8').toString('base64url')
  assert.equal(enc, ENCODED)
  const dec = B.from(ENCODED, 'base64url').toString('utf8')
  assert.equal(dec, REMOTE_PATH)
  // Other encodings must keep working through the wrapper.
  assert.equal(B.from('hello', 'utf8').toString('base64'), 'aGVsbG8=')
  assert.equal(B.from('aGVsbG8=', 'base64').toString('utf8'), 'hello')
})

// Build a ctx whose sessions snapshot mirrors what DSH exposes to client modules.
function makeCtx(sandbox, cwd) {
  const logs = []
  return {
    logs,
    logger: {
      info: (s) => logs.push(['info', s]),
      warn: (s) => logs.push(['warn', s]),
    },
    effect: () => {},
    sessions: {
      list: { getSnapshot: () => ({ byId: { 'session-remote': { cwd } } }) },
      get: (id) => (id === 'session-remote' ? { header: { cwd } } : undefined),
    },
  }
}

test('apply() patches fetch and WebSocket, dispose() unwinds them', () => {
  const { exports, sandbox } = loadBundle()
  const origFetch = sandbox.fetch
  const origWS = sandbox.WebSocket

  const handle = exports.apply(makeCtx(sandbox, REMOTE_CWD))
  const patchedFetch = sandbox.fetch
  const patchedWS = sandbox.WebSocket
  assert.notEqual(patchedFetch, origFetch, 'fetch was not patched')
  assert.notEqual(patchedWS, origWS, 'WebSocket was not patched')

  handle.dispose()
  // The bundle restores a *bound* copy of the original fetch, so reference
  // identity differs from the pre-patch value; what matters is that the patched
  // function is gone and WebSocket is the original constructor again.
  assert.notEqual(sandbox.fetch, patchedFetch, 'dispose did not restore fetch')
  assert.equal(sandbox.WebSocket, origWS, 'dispose did not restore WebSocket')
})

test('remote session: /sidebar/api/* is rewritten to /sidebar/remote/api/*', async () => {
  const { exports, sandbox, fetchCalls } = loadBundle()
  exports.apply(makeCtx(sandbox, REMOTE_CWD))
  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/sidebar/remote/api/fs.tree')
  assert.equal(fetchCalls[0].init.method, 'POST')
  assert.equal(
    fetchCalls[0].init.body,
    JSON.stringify({ sessionId: 'session-remote', path: '.' }),
    'body must be forwarded verbatim',
  )
})

test('remote session: cwd falls back to the URL query when sessions is empty', async () => {
  const { exports, sandbox, fetchCalls } = loadBundle()
  // ctx with no sessions at all — the query-string cwd must still route remote.
  exports.apply({ logger: { info() {}, warn() {} }, effect: () => {}, sessions: undefined })
  await sandbox.fetch(
    `${ORIGIN}/sidebar/file?sessionId=session-remote&path=x.txt&cwd=${encodeURIComponent(REMOTE_CWD)}`,
  )
  assert.equal(fetchCalls.length, 1)
  assert.ok(
    fetchCalls[0].url.startsWith('/sidebar/remote/file?'),
    `expected remote rewrite, got ${fetchCalls[0].url}`,
  )
})

test('remote session: terminal WebSocket is rewritten to /sidebar/ws/remote-terminal', () => {
  const { exports, sandbox, wsCalls } = loadBundle()
  // No sessions in ctx: the WS URL carries cwd, which must be enough.
  exports.apply({ logger: { info() {}, warn() {} }, effect: () => {}, sessions: undefined })
  const url =
    `ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=session-remote` +
    `&tab=terminal%3A80f31c43&cwd=${encodeURIComponent(REMOTE_CWD)}`
  new sandbox.WebSocket(url)
  assert.equal(wsCalls.length, 1)
  const got = new URL(wsCalls[0].url, ORIGIN)
  assert.equal(got.pathname, '/sidebar/ws/remote-terminal')
  assert.equal(got.searchParams.get('sessionId'), 'session-remote')
  assert.equal(got.searchParams.get('cwd'), REMOTE_CWD)
})

test('remote session: WS resolves cwd from the sessions snapshot too', () => {
  const { exports, sandbox, wsCalls } = loadBundle()
  exports.apply(makeCtx(sandbox, REMOTE_CWD))
  new sandbox.WebSocket(
    `ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=session-remote&tab=terminal%3A1`,
  )
  assert.equal(wsCalls.length, 1)
  assert.equal(new URL(wsCalls[0].url, ORIGIN).pathname, '/sidebar/ws/remote-terminal')
})

test('local session: requests are left untouched (no rewrite)', async () => {
  const { exports, sandbox, fetchCalls, wsCalls } = loadBundle()
  exports.apply(makeCtx(sandbox, LOCAL_CWD))

  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, `${ORIGIN}/sidebar/api/fs.tree`, 'local API must not be rewritten')

  const wsUrl = `ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=session-remote&cwd=${encodeURIComponent(LOCAL_CWD)}`
  new sandbox.WebSocket(wsUrl)
  assert.equal(wsCalls.length, 1)
  assert.equal(wsCalls[0].url, wsUrl, 'local terminal WS must not be rewritten')
})

test('non-sidebar routes and already-remote routes pass through', async () => {
  const { exports, sandbox, fetchCalls } = loadBundle()
  exports.apply(makeCtx(sandbox, REMOTE_CWD))

  await sandbox.fetch(`${ORIGIN}/api/host.describe`)
  await sandbox.fetch(`${ORIGIN}/sidebar/remote/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote' }),
  })
  await sandbox.fetch(`${ORIGIN}/sidebar/bundle/x.js`)

  assert.deepEqual(
    fetchCalls.map((c) => c.url),
    [`${ORIGIN}/api/host.describe`, `${ORIGIN}/sidebar/remote/api/fs.tree`, `${ORIGIN}/sidebar/bundle/x.js`],
    'these routes must be forwarded unchanged',
  )
})

// --- placeholder-root discovery ---------------------------------------------
//
// The browser cannot compute remoteRoot() on its own: esbuild compiles
// `process.env` away to {} and os.homedir() is a build-time shim, so a bundle
// built on one machine and served by another derives a different root and every
// remote session silently degrades to local. The host now serves the real value
// at /sidebar/remote/root and the client asks for it once at boot.

test('root probe fires once, on the original fetch, and stays out of the routed stream', async () => {
  const { exports, sandbox, fetchCalls, probeCalls } = loadBundle()
  exports.apply(makeCtx(sandbox, REMOTE_CWD))
  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(probeCalls.length, 1, 'probe must fire exactly once per mount')
  assert.equal(probeCalls[0].url, '/sidebar/remote/root')
  // The probe goes through the *original* fetch. If it went through the patched
  // one it would appear here, and awaitRemoteRoot() would wait on itself.
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/sidebar/remote/api/fs.tree')
})

test('a foreign-home placeholder routes remote once the host reports its root', async () => {
  const { exports, sandbox, fetchCalls } = loadBundle({
    rootReply: { ok: true, status: 200, json: async () => ({ ok: true, value: { root: FOREIGN_ROOT } }) },
  })
  exports.apply(makeCtx(sandbox, FOREIGN_CWD))
  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    '/sidebar/remote/api/fs.tree',
    'the host-reported root must make a foreign-home placeholder route remote',
  )
})

test('an authoritative root is final: it suppresses the root-independent fallback', async () => {
  // Shaped exactly like a placeholder — valid host id, then the base64url of an
  // absolute path — but *not* under the real root, so it is an ordinary local
  // directory. The shape check alone cannot tell the difference; only the
  // authoritative root can. This is the local-zero-regression guarantee.
  const tailShapedLocal = `/home/build/proj/myhost/${ENCODED}`
  const { exports, sandbox, fetchCalls } = loadBundle({
    rootReply: { ok: true, status: 200, json: async () => ({ ok: true, value: { root: '/home/build/.dsh/remote' } }) },
  })
  exports.apply(makeCtx(sandbox, tailShapedLocal))
  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    `${ORIGIN}/sidebar/api/fs.tree`,
    'once the root is known, a placeholder-shaped path outside it must stay local',
  )
})

test('WebSocket routes a foreign-home placeholder even when the probe never answers', () => {
  // A WebSocket constructor is synchronous and cannot await discovery, so a
  // terminal tab restored during boot has only the root-independent shape check
  // to go on. Without it the pane opened on the empty local placeholder, which
  // is the bug that was originally reported.
  const { exports, sandbox, wsCalls, probeCalls } = loadBundle({
    // json() never resolves: the authoritative root provably cannot have been
    // adopted by the time the WebSocket below is constructed.
    rootReply: { ok: true, status: 200, json: () => new Promise(() => {}) },
  })
  exports.apply(makeCtx(sandbox, FOREIGN_CWD))
  assert.equal(probeCalls.length, 1, 'probe must be in flight')
  new sandbox.WebSocket(
    `ws://127.0.0.1:3080/sidebar/ws/terminal?sessionId=session-remote&tab=terminal%3A1`,
  )
  assert.equal(wsCalls.length, 1)
  assert.equal(new URL(wsCalls[0].url, ORIGIN).pathname, '/sidebar/ws/remote-terminal')
})

test('a host that does not serve the endpoint degrades without stalling', async () => {
  // 404 from an older host: the probe must settle rather than hang, and routing
  // must still work off the shape check.
  const { exports, sandbox, fetchCalls, probeCalls } = loadBundle({
    rootReply: { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not-found' } }) },
  })
  const warns = []
  const ctx = makeCtx(sandbox, FOREIGN_CWD)
  ctx.logger.warn = (s) => warns.push(s)
  exports.apply(ctx)
  await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'session-remote', path: '.' }),
  })
  assert.equal(probeCalls.length, 1)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/sidebar/remote/api/fs.tree')
  assert.ok(
    warns.some((w) => w.includes('root probe HTTP 404')),
    `a failed probe must be reported, got ${JSON.stringify(warns)}`,
  )
})

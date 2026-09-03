#!/usr/bin/env node
// Live end-to-end verification against a running DSH web server.
//
// The unit suite can only prove the halves in isolation. This drives the whole
// chain: it fetches the *exact* bundle the server hands to browsers, runs it in
// a vm sandbox with no Node Buffer (so the bundled polyfill has to carry
// base64url, as in a browser), and wires its fetch/WebSocket to the live origin
// — which in turn drives real SSH to the remote host.
//
// It is deliberately root-agnostic: the placeholder cwd is built from the root
// the host itself reports, so the script needs no edit when run against a
// different machine.
//
//   node scripts/verify-live.mjs
//
// Environment:
//   DSH_ORIGIN        default http://127.0.0.1:3080
//   DSH_HOST_ID       remote host id as configured in ~/.dsh/settings.yaml
//   DSH_REMOTE_PATH   remote workspace directory to open
//   DSH_EXPECT_ENTRY  a name that must appear in that directory (proves the
//                     content is remote: the local placeholder dir is empty)

import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { WebSocket as NodeWebSocket } from 'ws'
import { encodeRemotePath } from '../lib/shared/router.js'

const env = process.env
const ORIGIN = (env.DSH_ORIGIN ?? 'http://127.0.0.1:3080').replace(/\/$/, '')
const HOST_ID = env.DSH_HOST_ID ?? '11111111-2222-3333-4444-555555555555'
const REMOTE_PATH = env.DSH_REMOTE_PATH ?? '/home/remote/ws'
const EXPECT_ENTRY = env.DSH_EXPECT_ENTRY ?? 'diag1'
const SESSION_ID = `verify-live-${process.pid}`
const TAB = 'verify-live-tab'

// The DSH plugin id is `export const name` in src/host/index.ts, kept equal to
// package.json#name. Derived rather than hardcoded so a rename cannot leave this
// script fetching a stale bundle path; step 1 fails loudly if they diverge.
const PLUGIN_ID = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}
function fatal(msg) { console.log(`FATAL: ${msg}`); process.exit(2) }

// --- 1. the bundle a browser would load -------------------------------------
const page = await (await fetch(`${ORIGIN}/`)).text()
const rev = page.match(new RegExp(`${escRe(PLUGIN_ID)}/client\\.js\\?rev=([a-f0-9]+)`))?.[1]
if (!rev) fatal(`no ${PLUGIN_ID} bundle in the served page — is the plugin installed in this profile under that name? A stale profile entry under the pre-0.2.0 name @remote/sidebar-remote is the usual cause.`)
const bundleUrl = `${ORIGIN}/plugins/${PLUGIN_ID}/client.js?rev=${rev}`
const bundleRes = await fetch(bundleUrl)
if (!bundleRes.ok) fatal(`GET ${bundleUrl} -> HTTP ${bundleRes.status}`)
const code = await bundleRes.text()
console.log(`bundle rev ${rev}, ${code.length} bytes`)

// --- 2. the authoritative placeholder root ----------------------------------
// Asked for directly, before the bundle is mounted, so the value the client
// later reports can be compared against an independent observation.
const rootRes = await fetch(`${ORIGIN}/sidebar/remote/root`)
const rootBody = await rootRes.text()
check('host serves GET /sidebar/remote/root', rootRes.status === 200, `HTTP ${rootRes.status} ${rootBody}`)
const ROOT = (() => { try { return JSON.parse(rootBody).value.root } catch { return null } })()
if (typeof ROOT !== 'string' || !ROOT.length) fatal(`unusable root in response: ${rootBody}`)
const PLACEHOLDER_CWD = `${ROOT}/${HOST_ID}/${encodeRemotePath(REMOTE_PATH)}`
console.log(`host root ${ROOT}\nplaceholder cwd ${PLACEHOLDER_CWD}`)

// --- 3. sandbox --------------------------------------------------------------
const requests = []
const logs = []

// Emulates a browser's relative-URL resolution: the patch rewrites to a
// path-only URL, which Node's fetch would reject but a browser accepts.
const browserFetch = (input, init) => {
  const url = typeof input === 'string' ? new URL(input, ORIGIN).toString() : input
  requests.push(String(url))
  return fetch(url, init)
}

const sandbox = {
  console, URL, URLSearchParams, TextEncoder, TextDecoder,
  Uint8Array, Int8Array, setTimeout, clearTimeout,
  location: { protocol: 'http:', host: new URL(ORIGIN).host, origin: ORIGIN, href: `${ORIGIN}/` },
  fetch: browserFetch,
  WebSocket: NodeWebSocket,
  __ModuleLoader__: { load(entry) { sandbox.__entry = entry } },
}
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.globalThis = sandbox

// A DOM stub shaped like better-sidebar's Files panel. The root row is the one
// place better-sidebar captions from the cwd itself:
//     const root = cwd;            // client-registry.js:11993
//     children: baseName$1(root)   // client-registry.js:12114
// With a placeholder cwd that renders the base64url tail. The workspace row, the
// breadcrumb and the shell prompt all showed the real folder name, which is
// exactly why this went unnoticed for so long.
//
// Only the surface the fix touches is implemented, and querySelectorAll mirrors
// document order (depth-first) — that is what makes "the first explorerRow in a
// body is the root row" true here as it is in a browser.
function stubEl(className, textContent = '', children = []) {
  return {
    className,
    textContent,
    children,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value },
    getAttribute(name) { return this.attrs[name] ?? null },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
    querySelectorAll(sel) {
      const want = /^\[class\*="([^"]+)"\]$/.exec(sel)?.[1]
      if (!want) throw new Error(`stub only supports [class*="…"], got ${sel}`)
      const out = []
      const walk = (n) => {
        for (const c of n.children) {
          if (String(c.className).includes(want)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
  }
}
const ENCODED_TAIL = encodeRemotePath(REMOTE_PATH)
// Derived independently of the plugin's own helper, so this also cross-checks it.
const EXPECTED_LABEL = REMOTE_PATH.split('/').filter(Boolean).pop() || 'root'
const rootLabel = stubEl('nArs4W_explorerName', ENCODED_TAIL)
const rootRow = stubEl('nArs4W_explorerRow', '', [stubEl('svg'), rootLabel, stubEl('nArs4W_explorerRef')])
const childLabel = stubEl('nArs4W_explorerName', EXPECT_ENTRY)
const childRow = stubEl('nArs4W_explorerRow', '', [stubEl('svg'), childLabel])
const explorerBody = stubEl('nArs4W_explorerBody', '', [rootRow, childRow])
const domRoot = stubEl('#document', '', [explorerBody])
sandbox.document = { body: domRoot, querySelectorAll: (sel) => domRoot.querySelectorAll(sel) }
let observerCb = null
sandbox.MutationObserver = class {
  constructor(cb) { observerCb = cb; this.disconnected = 0 }
  observe() {}
  disconnect() { this.disconnected++ }
}

const context = vm.createContext(sandbox)
if (typeof sandbox.Buffer !== 'undefined') fatal('Node Buffer leaked into the sandbox; the polyfill would go untested')
vm.runInContext(code, context, { filename: 'client.js' })
const exports = sandbox.__entry.factory(() => { throw new Error('client bundle must not require() external modules') })
check('bundled Buffer polyfill carries base64url', sandbox.Buffer?._isBase64UrlPatched === true)

// --- 4. mount the overlay ----------------------------------------------------
const ctx = {
  logger: { info: (s) => logs.push(['info', s]), warn: (s) => logs.push(['warn', s]) },
  effect: () => {},
  sessions: {
    list: { getSnapshot: () => ({ byId: { [SESSION_ID]: { cwd: PLACEHOLDER_CWD } } }) },
    get: (id) => (id === SESSION_ID ? { header: { cwd: PLACEHOLDER_CWD } } : undefined),
  },
}
requests.length = 0
const handle = exports.apply(ctx)
await new Promise((r) => setTimeout(r, 1200))

// --- 5. root discovery -------------------------------------------------------
const probeHits = requests.filter((u) => u.includes('/sidebar/remote/root'))
check('client probed /sidebar/remote/root exactly once, on the original fetch',
  probeHits.length === 1, `hits=${probeHits.length} ${JSON.stringify(probeHits)}`)
const rootLine = logs.find(([, m]) => m.includes('placeholder root:'))
check('client adopted the host-reported root',
  !!rootLine && rootLine[1].includes(ROOT),
  rootLine ? rootLine[1] : `no such line; logs=${JSON.stringify(logs.map((l) => l[1]))}`)

// --- 6. file tree over real SSH ----------------------------------------------
// The body carries `cwd` exactly as better-sidebar's own client does. The fetch
// patch forwards bodies verbatim and must not inject anything, so a caller that
// omits cwd against an unregistered sessionId would legitimately 404 on the
// host. The WS path differs only because the patch appends cwd to the URL.
requests.length = 0
const treeRes = await sandbox.fetch(`${ORIGIN}/sidebar/api/fs.tree`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: SESSION_ID, cwd: PLACEHOLDER_CWD, path: '.' }),
})
const treeBody = await treeRes.text()
check('a local-shaped /sidebar/api call was rewritten to /sidebar/remote/api',
  requests.every((u) => u.includes('/sidebar/remote/api/')), `recorded=${JSON.stringify(requests)}`)
check(`file tree returned real remote content ("${EXPECT_ENTRY}")`,
  treeRes.status === 200 && treeBody.includes(`"name":"${EXPECT_ENTRY}"`),
  `HTTP ${treeRes.status} ${treeBody.slice(0, 300)}`)

// --- 6b. Files-panel root label ----------------------------------------------
check(`Files-panel root row reads "${EXPECTED_LABEL}", not the base64url tail`,
  rootLabel.textContent === EXPECTED_LABEL && rootRow.getAttribute('title') === REMOTE_PATH,
  `label=${JSON.stringify(rootLabel.textContent)} title=${JSON.stringify(rootRow.getAttribute('title'))} (encoded tail was ${ENCODED_TAIL})`)
check('child rows keep the real remote names fs.tree returned',
  childLabel.textContent === EXPECT_ENTRY, `label=${JSON.stringify(childLabel.textContent)}`)

// React owns that caption, so a session switch or tree reload puts the encoded
// tail straight back. The observer has to undo it again — that is the difference
// between a fix and a one-shot repaint.
rootLabel.textContent = ENCODED_TAIL
rootRow.attrs = {}
if (observerCb) observerCb()
await new Promise((r) => setTimeout(r, 400))
check('a re-render is relabelled again by the observer',
  rootLabel.textContent === EXPECTED_LABEL && rootRow.getAttribute('title') === REMOTE_PATH,
  `label=${JSON.stringify(rootLabel.textContent)} title=${JSON.stringify(rootRow.getAttribute('title'))}`)

// --- 7. terminal over real SSH -----------------------------------------------
const ws = new sandbox.WebSocket(
  `${ORIGIN.replace(/^http/, 'ws')}/sidebar/ws/terminal?sessionId=${SESSION_ID}&tab=${TAB}&cols=100&rows=30`,
)
const frames = []
let closeInfo = null
const opened = await new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), 20000)
  ws.onopen = () => { clearTimeout(t); resolve(true) }
  ws.onerror = (e) => console.log(`      ws error: ${e?.message ?? e}`)
  ws.onclose = (e) => { closeInfo = { code: e.code, reason: e.reason } }
})
check('the local terminal WS URL was rewritten to /sidebar/ws/remote-terminal',
  opened && String(ws.url).includes('/sidebar/ws/remote-terminal'),
  `opened=${opened} url=${ws.url} close=${JSON.stringify(closeInfo)}`)

if (opened) {
  ws.onmessage = (ev) => frames.push(typeof ev.data === 'string' ? ev.data : String(ev.data))
  const type = async (text, waitMs) => { ws.send(text); await new Promise((r) => setTimeout(r, waitMs)) }
  await type(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }), 1500)
  await type('pwd\r', 2500)
  await type('hostname\r', 2500)
  await type('ls -l\r', 2500)
  const text = frames.join('')
  console.log('------ terminal transcript (raw) ------')
  console.log(text.replace(/\r\n/g, '\n').slice(0, 2500))
  console.log('------ end transcript ------')
  check(`remote shell cwd is ${REMOTE_PATH}, not the local placeholder`,
    text.includes(REMOTE_PATH) && !text.includes('.dsh/remote'), `frames=${frames.length}`)
  check(`remote shell lists ${EXPECT_ENTRY}`, text.includes(EXPECT_ENTRY))
  check('no 1011 / abnormal close on the remote terminal WS',
    closeInfo === null || closeInfo.code === 1000 || closeInfo.code === 1005,
    `close=${JSON.stringify(closeInfo)}`)
  await type(JSON.stringify({ type: 'close' }), 600)
  try { ws.close() } catch {}
}

// --- 8. no degradation -------------------------------------------------------
const warns = logs.filter(([lvl]) => lvl === 'warn').map(([, m]) => m)
check('no warn-level plugin logs (probe succeeded, nothing degraded)',
  warns.length === 0, JSON.stringify(warns))

try { handle.dispose() } catch {}
await new Promise((r) => setTimeout(r, 300))

const failed = results.filter((r) => !r.ok).length
console.log(`\n=== ${results.length - failed}/${results.length} checks passed ===`)
process.exit(failed ? 1 : 0)

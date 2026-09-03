// Files-panel root label.
//
// better-sidebar computes the root row's label client-side:
//     const root = cwd;            // client-registry.js:11993
//     children: baseName$1(root)   // client-registry.js:12114
// For a remote session `cwd` is the placeholder path <root>/<hostId>/<b64url>,
// so the row rendered the encoded segment ("L2hvbWUvcmVtb3RlL3dz") while the
// workspace row, the breadcrumb and the shell prompt all showed the real folder
// name. Tree *contents* were correct all along — they come from our fs.tree.
//
// Nothing on the wire can fix it (no client code reads the host's `root` field,
// and `cwd` is the routing key so it must stay the placeholder), so the overlay
// rewrites the rendered text. These tests pin both halves: that the remote root
// row is corrected, and that nothing else — especially a *local* folder whose
// name happens to be canonical base64url — is ever touched.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rootLabelFixes, fixExplorerRootLabels } from '../lib/client/index.js'
import { remoteDisplayName, encodeRemotePath, decodeRemotePath, mapRemoteToLocal } from '../lib/shared/router.js'

const HOST_ID = '11111111-2222-3333-4444-555555555555'
const REMOTE_PATH = '/home/remote/ws'
const ENCODED = encodeRemotePath(REMOTE_PATH)
// Built through the real mapper so the placeholder shape is whatever upstream
// produces, not a hand-spelled approximation.
const REMOTE_CWD = mapRemoteToLocal(HOST_ID, REMOTE_PATH)
assert.ok(REMOTE_CWD, 'placeholder mapping must exist')

// --- a DOM stub covering exactly the surface the fix uses ---------------------
//
// Deliberately tiny: if fixExplorerRootLabels() ever reaches for another DOM
// API, these tests fail loudly instead of silently passing over a browser-only
// code path. querySelectorAll mirrors document order (depth-first), which is
// what makes "the first explorerRow in the body is the root row" hold.
function el(className, textContent = '', children = []) {
  const node = {
    className,
    textContent,
    children,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value },
    getAttribute(name) { return this.attrs[name] ?? null },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
    querySelectorAll(sel) {
      const want = /^\[class\*="([^"]+)"\]$/.exec(sel)?.[1]
      assert.ok(want, `stub only supports [class*="…"], got ${sel}`)
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
  return node
}

// The Files panel, shaped like better-sidebar renders it: the root row first,
// then the depth-0 child rows from renderLevel(root, 0).
function explorerPanel(rootText, childNames) {
  const rootRow = el('nArs4W_explorerRow', '', [
    el('svg'),
    el('nArs4W_explorerName', rootText),
    el('nArs4W_explorerRef'),
  ])
  const body = el('nArs4W_explorerBody', '', [
    rootRow,
    ...childNames.map((name) => el('nArs4W_explorerRow', '', [
      el('svg'),
      el('nArs4W_explorerName', name),
    ])),
  ])
  return { body, rootRow, label: rootRow.children[1], childLabels: childNames.map((_, i) => body.children[i + 1].children[1]) }
}

function docOf(...trees) {
  const root = el('#document-fragment', '', trees)
  return { body: root, querySelectorAll: (sel) => root.querySelectorAll(sel) }
}

function ctxWith(byId) {
  const logs = []
  return {
    logs,
    logger: { info: (s) => logs.push(['info', s]), warn: (s) => logs.push(['warn', s]) },
    effect: () => {},
    sessions: { list: { getSnapshot: () => ({ byId }) } },
  }
}

describe('remoteDisplayName (mirror of dsh-ssh placeholderDisplayName)', () => {
  it('takes the last non-empty segment', () => {
    assert.equal(remoteDisplayName('/home/remote/ws'), 'ws')
    assert.equal(remoteDisplayName('/a/b/c'), 'c')
  })
  it('drops trailing slashes, like upstream', () => {
    assert.equal(remoteDisplayName('/home/remote/ws/'), 'ws')
    assert.equal(remoteDisplayName('/home/remote/ws///'), 'ws')
  })
  it('falls back to "root" for the filesystem root and for junk', () => {
    assert.equal(remoteDisplayName('/'), 'root')
    assert.equal(remoteDisplayName(''), 'root')
    assert.equal(remoteDisplayName(undefined), 'root')
    assert.equal(remoteDisplayName(42), 'root')
  })
})

describe('rootLabelFixes', () => {
  it('maps a remote session placeholder tail to the real folder name', () => {
    const fixes = rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD } }))
    assert.deepEqual(fixes, [{ encoded: ENCODED, label: 'ws', remotePath: REMOTE_PATH }])
  })

  it('produces nothing for a local session', () => {
    assert.deepEqual(rootLabelFixes(ctxWith({ s1: { cwd: '/home/build/proj' } })), [])
  })

  it('produces nothing for a local folder whose name decodes, when routing says local', () => {
    // The false positive a text-matching fix would have committed: "L2E" decodes
    // to "/a" and re-encodes to itself, so "rewrite anything that decodes" would
    // relabel this local workspace to "a". Routing says local, so no entry.
    // The parent segment starts with '_', which isValidHostId rejects, so the
    // root-independent shape fallback agrees.
    const encodedName = encodeRemotePath('/a')
    assert.equal(encodedName, 'L2E')
    assert.equal(decodeRemotePath(encodedName), '/a', 'premise: that folder name really does decode')
    const fixes = rootLabelFixes(ctxWith({ s1: { cwd: `/home/build/_local/${encodedName}` } }))
    assert.deepEqual(fixes, [])
  })

  it('follows routing on the shape fallback’s documented coincidence, rather than diverging from it', () => {
    // `/home/build/L2E` *is* placeholder-shaped: 'build' is a valid host id and
    // 'L2E' decodes to an absolute path, so routeByPlaceholderTail() — and hence
    // every fetch and WebSocket in this session — already treats it as remote.
    // That coincidence is pre-existing and documented at routeByPlaceholderTail;
    // what matters here is that the label agrees with it instead of introducing a
    // second, contradicting opinion (a row whose data arrives over SSH must not
    // be captioned as a local folder).
    const encodedName = encodeRemotePath('/a')
    const fixes = rootLabelFixes(ctxWith({ s1: { cwd: `/home/build/${encodedName}` } }))
    assert.deepEqual(fixes, [{ encoded: encodedName, label: 'a', remotePath: '/a' }])
  })

  it('keeps two remote sessions apart', () => {
    const other = mapRemoteToLocal(HOST_ID, '/srv/data')
    const fixes = rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD }, s2: { cwd: other } }))
    assert.equal(fixes.length, 2)
    assert.deepEqual(fixes.map((f) => f.label).sort(), ['data', 'ws'])
    assert.notEqual(fixes[0].encoded, fixes[1].encoded)
  })

  it('survives a missing or throwing sessions snapshot', () => {
    assert.deepEqual(rootLabelFixes({}), [])
    assert.deepEqual(rootLabelFixes(undefined), [])
    assert.deepEqual(rootLabelFixes({ sessions: { list: { getSnapshot: () => { throw new Error('boom') } } } }), [])
    // A session entry without a cwd, and a non-string cwd, are both skipped.
    assert.deepEqual(rootLabelFixes(ctxWith({ s1: {}, s2: { cwd: 7 } })), [])
  })
})

describe('fixExplorerRootLabels', () => {
  it('rewrites only the root row, and records the real path as its title', () => {
    const panel = explorerPanel(ENCODED, ['references.bib', 'src'])
    const n = fixExplorerRootLabels(docOf(panel.body), rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD } })))
    assert.equal(n, 1)
    assert.equal(panel.label.textContent, 'ws')
    // The encoded string was the only place the real path surfaced on that row;
    // child rows expose theirs through title, so the root row now does too.
    assert.equal(panel.rootRow.getAttribute('title'), REMOTE_PATH)
    assert.deepEqual(panel.childLabels.map((c) => c.textContent), ['references.bib', 'src'])
  })

  it('is idempotent — a second pass changes nothing', () => {
    const panel = explorerPanel(ENCODED, ['a.txt'])
    const doc = docOf(panel.body)
    const fixes = rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD } }))
    assert.equal(fixExplorerRootLabels(doc, fixes), 1)
    assert.equal(fixExplorerRootLabels(doc, fixes), 0, 'the rewritten text must not match any encoded tail')
    assert.equal(panel.label.textContent, 'ws')
  })

  it('leaves a local workspace root alone even when its name decodes', () => {
    const encodedName = encodeRemotePath('/a')
    assert.equal(decodeRemotePath(encodedName), '/a', 'premise: that folder name really does decode')
    const panel = explorerPanel(encodedName, ['keep.txt'])
    const cwd = `/home/build/_local/${encodedName}`
    const n = fixExplorerRootLabels(docOf(panel.body), rootLabelFixes(ctxWith({ s1: { cwd } })))
    assert.equal(n, 0)
    assert.equal(panel.label.textContent, encodedName)
    assert.equal(panel.rootRow.getAttribute('title'), null, 'no title may be invented for a local row')
  })

  it('leaves a child row alone even when a child is named like the encoded tail', () => {
    // A remote file genuinely called ENCODED sits one row below the root. Only
    // the first explorerRow of a body is eligible, so it must survive.
    const panel = explorerPanel('ws', [ENCODED])
    const n = fixExplorerRootLabels(docOf(panel.body), rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD } })))
    assert.equal(n, 0)
    assert.equal(panel.childLabels[0].textContent, ENCODED)
  })

  it('fixes each of several panels to its own session', () => {
    const other = mapRemoteToLocal(HOST_ID, '/srv/data')
    const a = explorerPanel(ENCODED, ['x'])
    const b = explorerPanel(encodeRemotePath('/srv/data'), ['y'])
    const n = fixExplorerRootLabels(docOf(a.body, b.body), rootLabelFixes(ctxWith({ s1: { cwd: REMOTE_CWD }, s2: { cwd: other } })))
    assert.equal(n, 2)
    assert.equal(a.label.textContent, 'ws')
    assert.equal(b.label.textContent, 'data')
  })

  it('handles the remote filesystem root', () => {
    const rootCwd = mapRemoteToLocal(HOST_ID, '/')
    const panel = explorerPanel(encodeRemotePath('/'), [])
    const n = fixExplorerRootLabels(docOf(panel.body), rootLabelFixes(ctxWith({ s1: { cwd: rootCwd } })))
    assert.equal(n, 1)
    assert.equal(panel.label.textContent, 'root')
    assert.equal(panel.rootRow.getAttribute('title'), '/')
  })

  it('is inert without a document, without bodies, or without fixes', () => {
    const fixes = [{ encoded: ENCODED, label: 'ws', remotePath: REMOTE_PATH }]
    assert.equal(fixExplorerRootLabels(undefined, fixes), 0)
    assert.equal(fixExplorerRootLabels(null, fixes), 0)
    assert.equal(fixExplorerRootLabels({}, fixes), 0, 'no querySelectorAll → nothing to do')
    assert.equal(fixExplorerRootLabels(docOf(explorerPanel(ENCODED, []).body), []), 0)
  })

  it('does not throw when the DOM throws', () => {
    const hostile = {
      body: {},
      querySelectorAll() { throw new Error('detached document') },
    }
    assert.equal(fixExplorerRootLabels(hostile, [{ encoded: ENCODED, label: 'ws', remotePath: REMOTE_PATH }]), 0)
    const halfBroken = {
      body: {},
      querySelectorAll: () => [{ querySelector() { throw new Error('nope') } }],
    }
    assert.equal(fixExplorerRootLabels(halfBroken, [{ encoded: ENCODED, label: 'ws', remotePath: REMOTE_PATH }]), 0)
  })
})

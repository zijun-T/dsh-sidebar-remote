// Host-side regressions found by driving the real UI in a browser.
//
// All three were invisible to the previous suites because each one only shows up
// at the seam between our code and the *other* copy of @dsh-ssh/dsh-ssh that the
// DSH profile loads:
//
//  1. resolveRemotePath() dropped the exact-root case, so the file tree — which
//     asks for the workspace root itself — was handed the local placeholder path
//     and SSH answered "No such file". The tree rendered permanently empty.
//  2. patchSshConnShell() patched the SshConn class from our own module copy.
//     sshPool is created by the profile's copy, a distinct ESM instance, so the
//     pooled connections never gained shell() and every remote terminal died
//     with "remote shell not available (apply SshConn patch first)".
//  3. remoteListDirectory() read type hints only from SFTP `.filename`/`.longname`.
//     On the ExecFs fallback (SFTP disabled) entries are `{name, type}`, the
//     lookup always missed, and directories came back as isDir:false.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRemotePath, mapRemoteToLocal } from '../lib/shared/router.js'
import { ensureShellOnConn, patchSshConnShell } from '../lib/host/ssh-shell-patch.js'
import { remoteListDirectory } from '../lib/host/remote-fs.js'
import { classifyTerminalFrame, clampDims, TERMINAL_DIM_MIN, TERMINAL_DIM_MAX } from '../lib/host/remote-pty.js'

const HOST_ID = '11111111-2222-3333-4444-555555555555'
const REMOTE_CWD = '/home/remote/ws'
const PLACEHOLDER = mapRemoteToLocal(HOST_ID, REMOTE_CWD)

describe('resolveRemotePath: placeholder root re-anchoring', () => {
  it('maps the placeholder cwd itself back to remoteCwd', () => {
    // This is exactly what the sidebar sends for the file-tree root.
    assert.equal(resolveRemotePath(PLACEHOLDER, REMOTE_CWD, PLACEHOLDER), REMOTE_CWD)
  })

  it('tolerates a trailing separator and ./ suffixes on the root', () => {
    assert.equal(resolveRemotePath(PLACEHOLDER + '/', REMOTE_CWD, PLACEHOLDER), REMOTE_CWD)
    assert.equal(resolveRemotePath(PLACEHOLDER + '/.', REMOTE_CWD, PLACEHOLDER), REMOTE_CWD)
  })

  it('still re-anchors children of the placeholder (upstream behaviour)', () => {
    assert.equal(resolveRemotePath(PLACEHOLDER + '/diag1', REMOTE_CWD, PLACEHOLDER), '/home/remote/ws/diag1')
  })

  it('decodes a sibling placeholder path for the same host', () => {
    const sibling = mapRemoteToLocal(HOST_ID, '/home/remote/other-proj')
    assert.equal(resolveRemotePath(sibling, REMOTE_CWD, PLACEHOLDER), '/home/remote/other-proj')
  })

  it('leaves relative paths and unrelated absolute paths alone', () => {
    assert.equal(resolveRemotePath('./a', REMOTE_CWD, PLACEHOLDER), '/home/remote/ws/a')
    assert.equal(resolveRemotePath('/etc/hosts', REMOTE_CWD, PLACEHOLDER), '/etc/hosts')
  })

  it('does not rewrite when there is no placeholder context', () => {
    assert.equal(resolveRemotePath(PLACEHOLDER, REMOTE_CWD, undefined), PLACEHOLDER)
  })
})

// A stand-in for the SshConn class as loaded by the *other* module copy: same
// shape, different class object. Patching our copy must not be what makes this
// one work.
class ForeignSshConn {
  constructor(id) {
    this.id = id
    this.client = null
    this._dead = false
    this.connected = 0
  }
  get hostId() { return this.id }
  async connect() {
    this.connected += 1
    // Must not clobber a client a test installed beforehand — shell() calls
    // connect() first, so overwriting here would drop the fixture's callback
    // and hang the test forever.
    if (!this.client) this.client = { shell(_w, _o, cb) { cb(null, { default: true }) } }
    return this
  }
  _ensureOpen() { if (!this.client) throw new Error('Not connected') }
  _resetDeadState() { this._dead = false; this.client = null }
  async exec() { return { code: 0, stdout: '', stderr: '' } }
}

describe('ensureShellOnConn: copy-agnostic shell installation', () => {
  it('installs shell() on a connection from a foreign module copy', () => {
    const conn = new ForeignSshConn(HOST_ID)
    assert.equal(typeof conn.shell, 'undefined', 'fixture must start unpatched')
    assert.equal(ensureShellOnConn(conn), true)
    assert.equal(typeof conn.shell, 'function')
    // It landed on the real prototype, so sibling connections benefit too.
    assert.equal(typeof new ForeignSshConn('x').shell, 'function')
  })

  it('never pollutes Object.prototype', () => {
    const before = Object.prototype.shell
    ensureShellOnConn({ id: 'plain', client: null })
    assert.equal(Object.prototype.shell, before, 'Object.prototype was mutated')
    assert.equal({}.shell, undefined)
  })

  it('is idempotent and keeps an existing shell()', () => {
    const conn = new ForeignSshConn(HOST_ID)
    const own = async function shell() { return 'mine' }
    conn.shell = own
    assert.equal(ensureShellOnConn(conn), true)
    assert.equal(conn.shell, own, 'a working shell() must not be replaced')
  })

  it('rejects unusable targets instead of throwing', () => {
    assert.equal(ensureShellOnConn(null), false)
    assert.equal(ensureShellOnConn(undefined), false)
    assert.equal(ensureShellOnConn('nope'), false)
    assert.equal(patchSshConnShell(null), false)
  })

  it('the installed shell() drives connect + client.shell', async () => {
    const conn = new ForeignSshConn(HOST_ID)
    ensureShellOnConn(conn)
    let seen = null
    conn.client = {
      shell(wndopts, _opts, cb) { seen = wndopts; cb(null, { fake: 'stream' }) },
    }
    const stream = await conn.shell({ term: 'xterm-256color', cols: 120, rows: 40 })
    assert.deepEqual(stream, { fake: 'stream' })
    assert.equal(seen.cols, 120)
    assert.equal(seen.rows, 40)
    assert.equal(seen.term, 'xterm-256color')
    assert.equal(conn.connected, 1, 'shell() must (re)connect through the conn')
  })

  it('clamps degenerate terminal geometry', async () => {
    const conn = new ForeignSshConn(HOST_ID)
    ensureShellOnConn(conn)
    let seen = null
    conn.client = { shell(w, _o, cb) { seen = w; cb(null, {}) } }
    await conn.shell({ term: undefined, cols: 0, rows: -5 })
    assert.equal(seen.cols, 2)
    assert.equal(seen.rows, 2)
    assert.equal(seen.term, 'xterm-256color')
  })
})

// ssh2 SFTP backend: entries carry an `ls -l` longname.
function sftpConn(entries) {
  return {
    hostId: HOST_ID,
    async sftp() {
      return {
        async stat() { return undefined },
        async readdir() { return entries },
      }
    },
    async exec() { return { code: 0, stdout: '', stderr: '' } },
  }
}

// ExecFs backend: SFTP unavailable, so getFs() builds an ExecFs that shells out
// to `find -printf '%y\t%s\t%T@\t%f\n'`.
function execFsConn(stdout) {
  return {
    hostId: HOST_ID,
    async sftp() { throw new Error('SFTP disabled') },
    async exec() { return { code: 0, stdout, stderr: '' } },
  }
}

describe('remoteListDirectory: isDir across both backends', () => {
  it('reads isDir from the SFTP longname', async () => {
    const conn = sftpConn([
      { filename: 'diag1', longname: 'drwxr-xr-x 2 remote remote 4096 Sep  1 12:00 diag1' },
      { filename: 'notes.txt', longname: '-rw-r--r-- 1 remote remote 12 Sep  1 12:00 notes.txt' },
      { filename: 'link', longname: 'lrwxrwxrwx 1 remote remote 5 Sep  1 12:00 link -> diag1' },
    ])
    const res = await remoteListDirectory(conn, REMOTE_CWD)
    const by = Object.fromEntries(res.entries.map(e => [e.name, e]))
    assert.equal(res.path, REMOTE_CWD)
    assert.equal(by.diag1.isDir, true)
    assert.equal(by['notes.txt'].isDir, false)
    assert.equal(by.link.isSymlink, true)
    assert.equal(by.diag1.path, '/home/remote/ws/diag1')
  })

  it('reads isDir from the ExecFs type field', async () => {
    // The exact `find -printf` line shape ExecFs parses.
    const stdout = [
      'd\t4096\t1756700000.0000000000\tdiag1',
      'f\t12\t1756700000.0000000000\tnotes.txt',
      'l\t5\t1756700000.0000000000\tlink',
    ].join('\n') + '\n'
    const res = await remoteListDirectory(execFsConn(stdout), REMOTE_CWD)
    const by = Object.fromEntries(res.entries.map(e => [e.name, e]))
    assert.equal(by.diag1.isDir, true, 'ExecFs directory must be isDir:true')
    assert.equal(by['notes.txt'].isDir, false)
    assert.equal(by.link.isSymlink, true)
  })

  it('tolerates a plain string[] readdir and drops empty names', async () => {
    const conn = sftpConn(['a', '', 'b'])
    const res = await remoteListDirectory(conn, REMOTE_CWD)
    assert.deepEqual(res.entries.map(e => e.name).sort(), ['a', 'b'])
  })

  it('reports truncation once maxEntries is hit', async () => {
    const conn = sftpConn([
      { filename: 'x1', longname: 'drwxr-xr-x 2 t t 1 x x1' },
      { filename: 'x2', longname: 'drwxr-xr-x 2 t t 1 x x2' },
      { filename: 'x3', longname: 'drwxr-xr-x 2 t t 1 x x3' },
    ])
    const res = await remoteListDirectory(conn, REMOTE_CWD, 2)
    assert.equal(res.entries.length, 2)
    assert.equal(res.truncated, true)
  })
})

// dsh-better-sidebar's terminal client is what actually connects to
// /sidebar/ws/remote-terminal once the overlay rewrites the URL, so the wire
// contract has to match it exactly:
//   server -> client : RAW text (the view does term.write(event.data))
//   client -> server : RAW keystrokes + JSON control frames
// The previous {type:'data'}/{type:'input'} envelope made xterm render JSON and
// made every real keypress fail JSON.parse, leaving the pane read-only.
describe('terminal wire protocol (better-sidebar compatible)', () => {
  it('recognizes the three JSON control frames', () => {
    assert.deepEqual(classifyTerminalFrame('{"type":"close"}'), { kind: 'close' })
    assert.deepEqual(classifyTerminalFrame('{"type":"park"}'), { kind: 'park' })
    assert.deepEqual(classifyTerminalFrame('{"type":"resize","cols":100,"rows":30}'),
      { kind: 'resize', cols: 100, rows: 30 })
  })

  it('treats raw keystrokes as input verbatim', () => {
    assert.deepEqual(classifyTerminalFrame('pwd\r'), { kind: 'input', text: 'pwd\r' })
    assert.deepEqual(classifyTerminalFrame('l'), { kind: 'input', text: 'l' })
    assert.deepEqual(classifyTerminalFrame('\x03'), { kind: 'input', text: '\x03' })
  })

  it('treats unrecognized JSON as input, not as a control frame', () => {
    // A user may legitimately paste JSON into the shell.
    const text = '{"type":"data","data":"ls"}'
    assert.deepEqual(classifyTerminalFrame(text), { kind: 'input', text })
    assert.deepEqual(classifyTerminalFrame('{"type":"resize"}'), { kind: 'input', text: '{"type":"resize"}' })
    assert.deepEqual(classifyTerminalFrame('{"type":"resize","cols":"100","rows":30}'),
      { kind: 'input', text: '{"type":"resize","cols":"100","rows":30}' })
    assert.deepEqual(classifyTerminalFrame('42'), { kind: 'input', text: '42' })
    assert.deepEqual(classifyTerminalFrame('null'), { kind: 'input', text: 'null' })
  })

  it('clamps resize geometry to the same bounds as better-sidebar', () => {
    assert.deepEqual(clampDims(0, -5), { cols: TERMINAL_DIM_MIN, rows: TERMINAL_DIM_MIN })
    assert.deepEqual(clampDims(5000, 9000), { cols: TERMINAL_DIM_MAX, rows: TERMINAL_DIM_MAX })
    assert.deepEqual(clampDims(80.9, 24.1), { cols: 80, rows: 24 })
    assert.deepEqual(clampDims(NaN, NaN), { cols: 80, rows: 24 })
    assert.equal(TERMINAL_DIM_MIN, 2)
    assert.equal(TERMINAL_DIM_MAX, 1024)
  })

  it('clamps dims carried inside a resize control frame', () => {
    assert.deepEqual(classifyTerminalFrame('{"type":"resize","cols":0,"rows":0}'),
      { kind: 'resize', cols: TERMINAL_DIM_MIN, rows: TERMINAL_DIM_MIN })
  })
})

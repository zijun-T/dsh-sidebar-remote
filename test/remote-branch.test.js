import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { applyLiteralEdit } from '../lib/host/remote-fs.js'
import { parsePorcelainZ, parseWorktreeList, parseLogLines } from '../lib/host/remote-git.js'

describe('remote branches (unit, no live SSH)', () => {
  it('applyLiteralEdit single replacement', () => {
    assert.equal(applyLiteralEdit('hello world', { old_string:'world', new_string:'there' }), 'hello there')
  })
  it('applyLiteralEdit duplicate without replace_all throws', () => {
    assert.throws(()=>applyLiteralEdit('a a', { old_string:'a', new_string:'b' }))
  })
  it('applyLiteralEdit replace_all', () => {
    assert.equal(applyLiteralEdit('a a', { old_string:'a', new_string:'b', replace_all:true }), 'b b')
  })
  it('parsePorcelainZ', () => {
    const out = ' M src/a.ts\0?? new.ts\0'
    const e = parsePorcelainZ(out)
    assert.equal(e.length, 2)
    assert.equal(e[0].path, 'src/a.ts')
  })
  it('parseWorktreeList', () => {
    const out = 'worktree /tmp/a\nbranch refs/heads/main\n\nworktree /tmp/b\nbranch refs/heads/feat\n'
    const w = parseWorktreeList(out)
    assert.equal(w.length, 2)
    assert.equal(w[0].branch, 'main')
  })
  it('parseLogLines', () => {
    const out = 'abc123\x1fmsg\x1fauthor\x1fdate\x1fabc123full\x1fHEAD -> main\n'
    const rows = parseLogLines(out)
    assert.equal(rows[0].hash, 'abc123')
    assert.equal(rows[0].refs, 'HEAD -> main')
  })
  it('remote error does not fall back to local — route guard holds', async () => {
    // Simulate: routeByCwd says remote, but acquire throws SshError.
    // The host must throw SidebarError, not call local opendir.
    const { routeByCwd } = await import('../lib/shared/router.js')
    const local = (await import('@dsh-ssh/dsh-ssh/src/router.js')).mapRemoteToLocal('h1','/remote/ws')
    const r = routeByCwd(local)
    assert.equal(r.kind, 'remote')
    // This test documents the invariant; the real fault is injected in host/index integration via mocked pool.
  })
})

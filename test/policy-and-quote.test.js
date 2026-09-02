import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shellQuoteSingle, buildRemoteCommand } from '@dsh-ssh/dsh-ssh/src/ssh-core.js'
import { mutationDenialMode, sandboxDenialError, isPathInsideWorkspace } from '@dsh-ssh/dsh-ssh/src/policy.js'
import { SidebarError } from '../lib/shared/wire.js'

describe('policy + shellQuoteSingle cwd', () => {
  it("shellQuoteSingle escapes tricky cwd containing ' \" $ ` \\", () => {
    const tricky = "/tmp/a b/'c \"d $e `f"
    const q = shellQuoteSingle(tricky)
    // must be single-quoted and internal ' is escaped
    assert.equal(q[0], "'")
    assert.equal(q[q.length-1], "'")
    assert.ok(q.includes("'\\''"), 'single quote escaped as ' + q)
    // probe command with tricky cwd is safe to embed
    const cmd = `cd ${q} 2>/dev/null`
    assert.ok(cmd.includes(q))
  })
  it('buildRemoteCommand embeds quoted cwd safely', () => {
    const cwd = `/a b/c$d 'e`
    const cmd = buildRemoteCommand('ls -1', cwd)
    assert.ok(cmd.includes(shellQuoteSingle(cwd)))
  })
  it('mutationDenial tri-state: read-only denies all', () => {
    for (const p of ['/ws/a', '/outside']) {
      assert.equal(mutationDenialMode('read-only', p, '/ws'), 'read-only')
    }
    // sandboxDenialError produces SidebarError-like
    const e = sandboxDenialError('read-only', 'write')
    assert.match(e.message, /sandbox/)
  })
  it('mutationDenial danger-full-access allows all', () => {
    assert.equal(mutationDenialMode('danger-full-access', '/anywhere', '/ws'), null)
    assert.equal(mutationDenialMode('danger-full-access', '/ws/a', '/ws'), null)
  })
  it('mutationDenial workspace-write containment', () => {
    assert.equal(mutationDenialMode('workspace-write', '/ws/a/b', '/ws'), null)
    assert.equal(mutationDenialMode('workspace-write', '/ws', '/ws'), null)
    assert.equal(mutationDenialMode('workspace-write', '/other/x', '/ws'), 'workspace-write')
    assert.equal(isPathInsideWorkspace('/ws/a', '/ws'), true)
    assert.equal(isPathInsideWorkspace('/ws', '/ws'), true)
    assert.equal(isPathInsideWorkspace('/other', '/ws'), false)
  })
  it('delete/rename/write/edit denied vs allowed across modes', () => {
    const cases = [
      ['/ws/a', 'workspace-write', null],
      ['/other', 'workspace-write', 'workspace-write'],
      ['/ws/a', 'read-only', 'read-only'],
      ['/ws/a', 'danger-full-access', null],
    ]
    for (const [p, mode, expected] of cases) {
      assert.equal(mutationDenialMode(mode, p, '/ws'), expected)
    }
  })
  it('sandboxDenialError thrown for read-only upload/write/delete', () => {
    const denial = mutationDenialMode('read-only', '/ws/a', '/ws')
    assert.equal(denial, 'read-only')
    const err = sandboxDenialError(denial, 'upload')
    assert.ok(err)
  })
})

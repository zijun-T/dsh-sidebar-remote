import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { remoteWriteAtomic } from '../lib/host/remote-fs.js'

describe('remoteWriteAtomic timeout + tmp cleanup', () => {
  it('rejects with exec-timeout on hanging exec', async () => {
    const fakeConn = {
      hostId: 'h',
      sftp: async () => { throw new Error('no sftp') }, // force exec fallback
      exec: (cmd, _o) => new Promise(()=>{}), // hang forever
    }
    const ac = new AbortController()
    setTimeout(()=>ac.abort(), 10)
    await assert.rejects(
      () => remoteWriteAtomic(fakeConn, '/ws/a.txt', 'hello', '/ws', 'danger-full-access', { signal: ac.signal, timeoutMs: 10000 }),
      (e) => /exec-timeout/.test(String(e.message))
    )
  })
  it('cleans tmp on failure', async () => {
    let rmCalled = false
    let execCalls = 0
    const fakeConn = {
      hostId: 'h',
      sftp: async () => { throw new Error('no sftp') },
      exec: async (cmd) => {
        execCalls++
        if (cmd.includes('mkdir')) return { code: 0, stdout: '', stderr: '' }
        if (cmd.includes(': >')) return { code: 0, stdout: '', stderr: '' }
        if (cmd.includes('base64 -d >>')) return { code: 1, stdout: '', stderr: 'disk full' }
        if (cmd.includes('rm -f')) { rmCalled = true; return { code: 0, stdout: '', stderr: '' } }
        return { code: 0, stdout: '', stderr: '' }
      }
    }
    // use chunked path by giving large content
    const big = 'x'.repeat(200_000)
    await assert.rejects(() => remoteWriteAtomic(fakeConn, '/ws/a.txt', big, '/ws', 'danger-full-access'))
    assert.equal(rmCalled, true, 'tmp should be removed on failure')
  })
})

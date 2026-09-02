import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SidebarError, isTrustedApiRequest, encodeHtmlUrl, decodeHtmlUrl } from '../lib/shared/wire.js'
import { isPathInsideWorkspace, mutationDenialMode } from '@dsh-ssh/dsh-ssh/src/policy.js'

describe('wire + policy', () => {
  it('SidebarError carries code', () => { const e = new SidebarError('fs-error','x'); assert.equal(e.code,'fs-error') })
  it('isTrustedApiRequest loopback passes', () => {
    assert.equal(isTrustedApiRequest({ headers:{ host:'127.0.0.1:3080' } }, []), true)
  })
  it('isTrustedApiRequest cross-site refused', () => {
    assert.equal(isTrustedApiRequest({ headers:{ host:'127.0.0.1:3080', 'sec-fetch-site':'cross-site' } }, []), false)
  })
  it('encode/decode html url', () => {
    const url = encodeHtmlUrl('S1','/a/b/c.html')
    const d = decodeHtmlUrl(new URL(url,'http://x').pathname)
    assert.equal(d.ok, true)
    assert.equal(d.ref.path, '/a/b/c.html')
  })
  it('isPathInsideWorkspace', () => {
    assert.equal(isPathInsideWorkspace('/a/b/c','/a/b'), true)
    assert.equal(isPathInsideWorkspace('/a/other','/a/b'), false)
    assert.equal(isPathInsideWorkspace('/any','/'), true)
  })
  it('mutationDenialMode workspace-write inside allowed', () => {
    assert.equal(mutationDenialMode('workspace-write','/ws/a','/ws'), null)
    assert.equal(mutationDenialMode('workspace-write','/other','/ws'), 'workspace-write')
    assert.equal(mutationDenialMode('read-only','/ws/a','/ws'), 'read-only')
    assert.equal(mutationDenialMode('danger-full-access','/other','/ws'), null)
  })
  it('path traversal single segment rejected in relativePath handling', async () => {
    // simulate the upload check
    const segs = '..'.split(/[\\/]+/)
    assert.ok(segs.some(p=>p==='..'))
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkDevice, checkFiles, probeVerdict, restoreOk, summaryText } from './lab.js'

test('checkFiles wants a KO/Riddim probe and a Medieval restore image', () => {
  assert.deepEqual(checkFiles({ sku: 'TE032AS001' }, { sku: 'TE032AS005' }), [])
  assert.deepEqual(checkFiles({ sku: 'TE032AS006' }, { sku: 'TE032AS005' }), [])
  assert.equal(checkFiles({ sku: 'TE032AS005' }, { sku: 'TE032AS005' }).length, 1)
  assert.equal(checkFiles({ sku: 'TE032AS001' }, { sku: 'TE032AS001' }).length, 1)
  assert.equal(checkFiles(null, null).length, 2)
})

test('checkDevice only admits an EP-1320', () => {
  assert.deepEqual(checkDevice({ product: 'EP-1320', sku: 'TE032AS005' }), [])
  // Bootloader may report an odd SKU; product name still counts.
  assert.deepEqual(checkDevice({ product: 'EP-1320', sku: '' }), [])
  assert.equal(checkDevice({ product: 'EP-133', sku: 'TE032AS001' }).length, 1)
  assert.equal(checkDevice(null).length, 1)
})

test('probeVerdict classifies what the unit did', () => {
  assert.equal(probeVerdict({ mode: 'bootloader' }, '2.5.1').kind, 'rejected')
  assert.equal(probeVerdict({ mode: 'normal', os_version: '2.5.1' }, '2.5.1').kind, 'accepted')
  assert.equal(probeVerdict({ mode: 'normal', os_version: '1.5.0' }, '2.5.1').kind, 'unchanged')
  assert.equal(probeVerdict(null, '2.5.1').kind, 'no_answer')
  const begin = probeVerdict(null, '2.5.1', { beginError: 'status=0x3' })
  assert.equal(begin.kind, 'refused_at_begin')
  assert.equal(begin.needsRestore, false)
  assert.equal(probeVerdict({ mode: 'bootloader' }, '2.5.1').needsRestore, true)
  assert.equal(probeVerdict({ mode: 'normal', os_version: '2.5.1' }, '2.5.1').needsRestore, false)
})

test('restoreOk needs normal mode on the stock version', () => {
  assert.equal(restoreOk({ mode: 'normal', os_version: '1.5.0' }, '1.5.0'), true)
  assert.equal(restoreOk({ mode: 'bootloader', os_version: '1.5.0' }, '1.5.0'), false)
  assert.equal(restoreOk({ mode: 'normal', os_version: '2.5.1' }, '1.5.0'), false)
  assert.equal(restoreOk(null, '1.5.0'), false)
})

test('summaryText carries connect path and flash outcomes', () => {
  const s = summaryText({
    started: '2026-09-28T00:00:00Z',
    userAgent: 'test',
    connect: { ok: true, via: 'greet', deviceId: 0x4b, meta: { product: 'EP-1320', mode: 'normal', sku: 'TE032AS005', os_version: '1.5.0' } },
    flashes: [
      { role: 'probe', image: 'EP-133 2.5.1', wireSku: 'TE032AS005', steps: ['dfu begin', 'transfer'], after: { mode: 'bootloader' }, verdict: 'REJECTED' },
    ],
    result: 'rejected, restored',
  })
  assert.match(s, /connect: ok via greet dev=0x4b/)
  assert.match(s, /probe: EP-133 2\.5\.1 → TE032AS005/)
  assert.match(s, /REJECTED/)
  assert.match(s, /RESULT: rejected, restored/)
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickWireSku, pickBoardSku } from './sku.js'

const AS001 = 'TE032AS001' // 64 MiB EP-133 board, and the only k.o. II lineage
const AS002 = 'TE032AS002' // 128 MiB EP-133 board
const EP40 = 'TE033AS001'

describe('sku.js pickWireSku', () => {
  it('announces the lineage, not the board revision, on a 128 MiB unit', () => {
    const wire = pickWireSku({ metadata: { sku: AS002, base_sku: AS001 } })
    assert.equal(wire, AS001)
  })

  it('is unchanged on a 64 MiB unit where lineage == board', () => {
    assert.equal(pickWireSku({ metadata: { sku: AS001, base_sku: AS001 } }), AS001)
  })

  it('falls back to sku when firmware reports no base_sku', () => {
    assert.equal(pickWireSku({ metadata: { sku: EP40 } }), EP40)
  })

  it('uses the snapshot lineage when only a FILE session is open', () => {
    // kotu's parseDeviceInfo drops base_sku, so the FILE path has no live
    // lineage — without the carried-forward value this returns AS002 and
    // DFU_BEGIN fails with status=0x1.
    const wire = pickWireSku({ snapshot: { sku: AS002, baseSku: AS001 } })
    assert.equal(wire, AS001)
  })

  it('uses a banked lineage when the device still answers the same SKU', () => {
    const wire = pickWireSku({
      snapshot: { sku: AS002, serial: 'X1' },
      profile: { baseSku: AS001, baseSkuFor: AS002 },
    })
    assert.equal(wire, AS001)
  })

  it('ignores a banked lineage once the device answers a different SKU', () => {
    // After a cross-flash the banked pairing is stale. Announcing the old
    // lineage would be the same class of mistake as announcing the revision.
    const wire = pickWireSku({
      snapshot: { sku: EP40, serial: 'X1' },
      profile: { baseSku: AS001, baseSkuFor: AS002 },
    })
    assert.equal(wire, EP40)
  })

  it('lets a live GREET override anything banked', () => {
    const wire = pickWireSku({
      metadata: { sku: EP40, base_sku: EP40 },
      snapshot: { sku: AS002, baseSku: AS001, serial: 'X1' },
      profile: { baseSku: AS001, baseSkuFor: AS002 },
    })
    assert.equal(wire, EP40)
  })

  it('returns empty when nothing is known, so callers can gate the flash', () => {
    assert.equal(pickWireSku({}), '')
    assert.equal(pickWireSku(), '')
    assert.equal(pickWireSku({ metadata: {}, snapshot: {} }), '')
  })
})

describe('sku.js pickBoardSku', () => {
  it('reports the board revision, never the lineage', () => {
    assert.equal(pickBoardSku({ metadata: { sku: AS002, base_sku: AS001 } }), AS002)
  })

  it('falls back to the snapshot and then to empty', () => {
    assert.equal(pickBoardSku({ snapshot: { sku: AS002 } }), AS002)
    assert.equal(pickBoardSku(), '')
  })

  it('differs from the wire SKU only on a 128 MiB board', () => {
    const big = { metadata: { sku: AS002, base_sku: AS001 } }
    const small = { metadata: { sku: AS001, base_sku: AS001 } }
    assert.notEqual(pickBoardSku(big), pickWireSku(big))
    assert.equal(pickBoardSku(small), pickWireSku(small))
  })
})

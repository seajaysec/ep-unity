import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseTfw, rewriteSku, skuBytesToString, skuStringToBytes } from './tfw.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

test('sku round-trip TE032AS001 / TE032AS006', () => {
  assert.equal(skuBytesToString(skuStringToBytes('TE032AS001')), 'TE032AS001')
  assert.equal(skuBytesToString(skuStringToBytes('TE032AS006')), 'TE032AS006')
  assert.deepEqual([...skuStringToBytes('TE032AS001')], [0x00, 0x08, 0x00, 0x01])
  assert.deepEqual([...skuStringToBytes('TE032AS006')], [0x00, 0x08, 0x00, 0x06])
})

test('parse EP-40 fixture and rewrite to EP-133 SKU', () => {
  const path = join(root, 'fw/ep-40_firmware_2_5_1.tfw')
  const data = new Uint8Array(readFileSync(path))
  const before = parseTfw(data)
  assert.equal(before.sku, 'TE032AS006')
  assert.equal(before.version, '2.5.1')
  assert.ok(before.beefcafe)

  const out = rewriteSku(data, 'TE032AS001')
  const after = parseTfw(out)
  assert.equal(after.sku, 'TE032AS001')
  assert.equal(after.version, before.version)
  assert.equal(after.size, before.size)
  // Body / type unchanged
  assert.equal(out[4], data[4])
  assert.deepEqual([...out.subarray(5, 7)], [...data.subarray(5, 7)])
  assert.notDeepEqual([...out.subarray(15, 19)], [...data.subarray(15, 19)])
})

test('parse EP-133 fixture', () => {
  const path = join(root, 'fw/ep-133_firmware_2_5_1.tfw')
  const data = new Uint8Array(readFileSync(path))
  const info = parseTfw(data)
  assert.equal(info.sku, 'TE032AS001')
})

test('rejects non-tfw', () => {
  assert.throws(() => parseTfw(new Uint8Array(64)), /babecafe/)
})

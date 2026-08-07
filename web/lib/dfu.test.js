import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { beginPayload, prepareImage } from './dfu.js'
import { parseTfw } from './tfw.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Firmware images are TE's, so they are not in this repo. Tests needing one skip
 * rather than fail — a fresh clone goes green; anyone with the files gets the
 * full suite.
 */
function fixture(path) {
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
}

test('beginPayload matches Firmware DFU_BEGIN layout', (t) => {
  const data = fixture(join(root, 'fw/ep-40_firmware_2_5_1.tfw'))
  if (!data) return t.skip('fw/ep-40_firmware_2_5_1.tfw not present')
  const p = beginPayload(data)
  assert.equal(p[0], 2) // DFU_BEGIN
  assert.deepEqual([...p.subarray(1, 9)], [...data.subarray(7, 15)]) // version
  assert.equal(p[9], 176) // BEGIN_APP
  assert.deepEqual([...p.subarray(10, 14)], [...data.subarray(15, 19)]) // sku
  const transfer = data.length - 64
  assert.equal((p[14] << 24) | (p[15] << 16) | (p[16] << 8) | p[17], transfer)
  assert.equal(p[18], data[4])
})

test('prepareImage rewrites to device SKU', (t) => {
  const data = fixture(join(root, 'fw/ep-40_firmware_2_5_1.tfw'))
  if (!data) return t.skip('fw/ep-40_firmware_2_5_1.tfw not present')
  const prep = prepareImage(data, 'TE032AS001')
  assert.equal(prep.rewritten, true)
  assert.equal(prep.fromSku, 'TE032AS006')
  assert.equal(prep.info.sku, 'TE032AS001')
  assert.equal(parseTfw(prep.bytes).version, parseTfw(data).version)
})

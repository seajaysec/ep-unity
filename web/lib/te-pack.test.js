import assert from 'node:assert/strict'
import test from 'node:test'
import { packToBuffer, packedLength, unpack } from './te-pack.js'

test('pack/unpack round-trip short and long payloads', () => {
  for (const len of [0, 1, 6, 7, 8, 15, 16, 64, 200, 500]) {
    const raw = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 0x81) & 0xff)
    const out = new Uint8Array(packedLength(len))
    packToBuffer(raw, out)
    const back = unpack(out)
    assert.deepEqual([...back], [...raw], `len=${len}`)
  }
})

test('DFU_BEGIN-shaped payload packs', () => {
  // [2, ...version(8), 176, ...sku(4), ...size(4), type]
  const payload = Uint8Array.of(
    2,
    0, 2, 0, 5, 0, 1, 0, 0,
    176,
    0, 8, 0, 1,
    0, 7, 0x53, 0x58,
    0,
  )
  const out = new Uint8Array(packedLength(payload.length))
  packToBuffer(payload, out)
  assert.deepEqual([...unpack(out)], [...payload])
})

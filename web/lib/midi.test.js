import { test } from 'node:test'
import assert from 'node:assert/strict'

import { TeDfuSession, frameHex, greetCandidates, parseIdentity } from './midi.js'
import { packToBuffer, packedLength } from './te-pack.js'

const hex = (s) => Uint8Array.from(s.match(/../g).map((b) => parseInt(b, 16)))

test('parseIdentity reads the captured EP-40 reply', () => {
  // docs/research/dfu-captures/01-ep40-same-sku.jsonl
  const r = parseIdentity(hex('f07e3c06020020762000060000000000f7'))
  assert.deepEqual(r, { deviceId: 0x3c, sku: 'TE032AS006' })
})

test('parseIdentity tolerates a shorter version tail', () => {
  const r = parseIdentity(hex('f07e4b0602002076200005000000f7'))
  assert.deepEqual(r, { deviceId: 0x4b, sku: 'TE032AS005' })
})

test('parseIdentity rejects non-TE and non-reply frames', () => {
  assert.equal(parseIdentity(hex('f07e3c06020041762000060000000000f7')), null)
  assert.equal(parseIdentity(hex('f07e7f0601f7')), null)
})

test('greetCandidates covers every device byte once, known ones first', () => {
  const c = greetCandidates()
  assert.deepEqual(c.slice(0, 3), [0x7f, 0x33, 0x3c])
  assert.equal(c.length, 128)
  assert.equal(new Set(c).size, 128)
})

test('frameHex truncates long frames', () => {
  assert.equal(frameHex([0xf0, 0xf7]), 'f0f7')
  assert.equal(frameHex(new Uint8Array(70), 2), '0000…(+68)')
})

/** Fake unit that ignores identity and answers GREET only on its own device byte. */
function fakeAccess({ dev, answerIdentity = false, name = 'EP-1320' }) {
  const input = { name, onmidimessage: null }
  const reply = (bytes) =>
    queueMicrotask(() => input.onmidimessage?.({ data: bytes, target: input }))
  const output = {
    name,
    send(data) {
      const f = Uint8Array.from(data)
      if (f[1] === 0x7e) {
        if (answerIdentity) reply(hex(`f07e${dev.toString(16).padStart(2, '0')}06020020762000050000000000f7`))
        return
      }
      if (f[4] !== dev || f[8] !== 1) return
      const text = new TextEncoder().encode(
        'product:EP-1320;mode:normal;sku:TE032AS005;os_version:1.5.0;serial:TEST0001',
      )
      const packed = new Uint8Array(packedLength(text.length))
      packToBuffer(text, packed)
      const out = new Uint8Array(11 + packed.length)
      out.set([0xf0, 0x00, 0x20, 0x76, dev, 0x40, 0x20 | (f[6] & 31), f[7], 1, 0])
      out.set(packed, 10)
      out[out.length - 1] = 0xf7
      reply(out)
    },
  }
  const map = (p) => new Map([[p.name, p]])
  return { inputs: map(input), outputs: map(output) }
}

test('connect falls back to a GREET sweep when identity is silent', async () => {
  const frames = []
  const s = new TeDfuSession(fakeAccess({ dev: 0x4b }), { tap: (dir) => frames.push(dir) })
  s._identify = () => Promise.reject(new Error('identity timeout')) // skip the 2.5 s wait
  const d = await s.connect()
  assert.equal(d.deviceId, 0x4b)
  assert.equal(d.metadata.product, 'EP-1320')
  assert.equal(d.metadata.sku, 'TE032AS005')
  assert.equal(d.via, 'greet')
  assert.ok(frames.includes('tx') && frames.includes('rx'))
  s.close()
})

test('connect still uses identity when it answers', async () => {
  const s = new TeDfuSession(fakeAccess({ dev: 0x33, answerIdentity: true, name: 'EP-133' }))
  const d = await s.connect()
  assert.equal(d.deviceId, 0x33)
  assert.equal(d.identitySku, 'TE032AS005')
  s.close()
})

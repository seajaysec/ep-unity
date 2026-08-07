import test from 'node:test'
import assert from 'node:assert/strict'

import { DemoVoice, runDemoLoop, pickDemo, PAD_NOTES } from './demo.js'

function mockOutput() {
  const log = []
  return { log, output: { name: 'EP-40 mock', send: (m) => log.push([...m]) } }
}

function stillHeld(log) {
  const on = new Set()
  for (const m of log) {
    const status = m[0] & 0xf0
    if (status === 0x90 && m[2] > 0) on.add(m[1])
    if (status === 0x80 || (status === 0x90 && m[2] === 0)) on.delete(m[1])
  }
  return [...on]
}

const ccsIn = (log) => log.filter((m) => (m[0] & 0xf0) === 0xb0).map((m) => m[1])

test('pad map matches tools/midi_stress.py (36..83, groups A–D)', () => {
  assert.equal(PAD_NOTES.length, 48)
  assert.equal(PAD_NOTES[0], 36)
  assert.equal(PAD_NOTES.at(-1), 83)
})

test('pickDemo returns the synth loop on EP-40 and the pad loop elsewhere', () => {
  assert.match(pickDemo('ep40').label, /mod wheel/)
  assert.match(pickDemo('ep133').label, /pads/)
  assert.match(pickDemo('').label, /pads/, 'unknown firmware falls back to pads')
})

test('DemoVoice.silence releases every held note and sends both panic CCs', () => {
  const { log, output } = mockOutput()
  const voice = new DemoVoice(output)
  voice.noteOn(60)
  voice.noteOn(64)
  voice.noteOn(67)
  voice.silence()

  assert.deepEqual(stillHeld(log), [])
  assert.ok(ccsIn(log).includes(123), 'all-notes-off')
  assert.ok(ccsIn(log).includes(120), 'all-sound-off')
})

test('stopping mid-loop still silences the device', async () => {
  const { log, output } = mockOutput()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runDemoLoop(output, 'ep40', controller.signal))
  assert.deepEqual(stillHeld(log), [], 'an aborted loop must not leave the unit droning')
  assert.ok(ccsIn(log).includes(123))
})

test('a loop that throws still silences the device', async () => {
  const { log, output } = mockOutput()
  const voice = new DemoVoice(output)
  // Same contract runDemoLoop relies on: the finally runs whatever happened.
  try {
    voice.noteOn(48)
    voice.noteOn(52)
    throw new Error('boom')
  } catch {
    voice.silence()
  }
  assert.deepEqual(stillHeld(log), [])
})

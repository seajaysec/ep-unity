/**
 * One ~10 second demo loop, picked by whichever firmware is running.
 *
 * Notes and CC only — no SysEx, no FILE session, no writes. That is what keeps
 * it a button rather than a workflow: nothing changes on the device, so there is
 * nothing to back up, gate, or restore. `docs/research/midi-stress-checklist.md`
 * drove all 48 pads, velocity sweeps, CC1/12/13, sustain and clock against a
 * cross-flashed EP-40 with the identity bytes unchanged before and after.
 */

/** Groups A–D, 12 pads each. Same map as tools/midi_stress.py. */
export const PAD_NOTES = Array.from({ length: 48 }, (_, i) => 36 + i)

const CC_MOD = 1
const CC_ALL_NOTES_OFF = 123
const CC_ALL_SOUND_OFF = 120

/**
 * Wraps a MIDIOutput and remembers every note it turns on, so stopping always
 * silences the device even if the loop is cut off mid-chord.
 */
export class DemoVoice {
  /** @param {MIDIOutput} output */
  constructor(output, channel = 0) {
    this.output = output
    this.channel = channel & 0x0f
    /** @type {Set<number>} */
    this.held = new Set()
  }

  noteOn(note, velocity = 100) {
    this.held.add(note)
    this.output.send([0x90 | this.channel, note & 0x7f, velocity & 0x7f])
  }

  noteOff(note) {
    this.held.delete(note)
    this.output.send([0x80 | this.channel, note & 0x7f, 0])
  }

  cc(controller, value) {
    this.output.send([0xb0 | this.channel, controller & 0x7f, value & 0x7f])
  }

  /** Belt and braces: explicit note-offs, then the two panic CCs. */
  silence() {
    for (const note of [...this.held]) this.noteOff(note)
    this.cc(CC_MOD, 0)
    this.cc(CC_ALL_NOTES_OFF, 0)
    this.cc(CC_ALL_SOUND_OFF, 0)
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/** Riddim: sustained chord under the mod wheel — a Supertone pad if one is loaded. */
async function synthLoop(voice, signal) {
  const chord = [48, 52, 55, 59]
  for (let round = 0; round < 2; round++) {
    for (const note of chord) voice.noteOn(note, 96)
    for (let v = 0; v <= 127; v += 6) {
      voice.cc(CC_MOD, v)
      await wait(18, signal)
    }
    for (let v = 127; v >= 0; v -= 6) {
      voice.cc(CC_MOD, v)
      await wait(18, signal)
    }
    for (const note of chord) voice.noteOff(note)
    await wait(300, signal)
  }
  voice.cc(CC_MOD, 0)
}

/** KO: one group of pads, then the same pad soft to hard. */
async function padLoop(voice, signal) {
  for (const note of PAD_NOTES.slice(0, 12)) {
    voice.noteOn(note, 100)
    await wait(90, signal)
    voice.noteOff(note)
    await wait(60, signal)
  }
  await wait(250, signal)
  for (let v = 20; v <= 127; v += 15) {
    voice.noteOn(36, v)
    await wait(180, signal)
    voice.noteOff(36)
    await wait(80, signal)
  }
}

/**
 * @param {'ep40' | 'ep133' | 'ep1320' | ''} productFlag
 * @returns {{ label: string, run: (voice: DemoVoice, signal: AbortSignal) => Promise<void> }}
 */
export function pickDemo(productFlag) {
  if (productFlag === 'ep40') {
    return {
      label: 'held chord + mod wheel — Supertone if this project has synth pads',
      run: synthLoop,
    }
  }
  return { label: 'pads A1–A12, then one pad soft to hard', run: padLoop }
}

/**
 * Find the EP output port. Takes an existing MIDIAccess so this never triggers a
 * second permission prompt.
 * @param {MIDIAccess} access
 */
export function findOutput(access) {
  for (const output of access.outputs.values()) {
    if (/EP-133|EP-40|EP-1320/i.test(output.name || '')) return output
  }
  return null
}

/**
 * @param {MIDIOutput} output
 * @param {'ep40' | 'ep133' | 'ep1320' | ''} productFlag
 * @param {AbortSignal} signal
 */
export async function runDemoLoop(output, productFlag, signal) {
  const voice = new DemoVoice(output)
  try {
    await pickDemo(productFlag).run(voice, signal)
  } finally {
    // Stopped, thrown or finished, the device must not be left holding notes.
    voice.silence()
  }
}

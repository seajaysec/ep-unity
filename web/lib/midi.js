/**
 * Minimal TE DFU SysEx client over WebMIDI (interop; not TE's updater).
 */

import { packToBuffer, packedLength, unpack } from './te-pack.js'

export const TE_MFG = [0x00, 0x20, 0x76]
export const MIDI_SYSEX_TE = 0x40
export const BIT_IS_REQUEST = 64
export const BIT_REQUEST_ID_AVAILABLE = 32

export const CMD = {
  GREET: 1,
  ECHO: 2,
  DFU: 3,
}

export const DFU = {
  ENTER: 1,
  ENTER_MIDI: 1,
  BEGIN: 2,
  BEGIN_APP: 176,
  CHUNK: 3,
  PERFORM: 4,
  EXIT: 5,
  ENTER_RESPONSE_READY: 64,
}

export const STATUS = {
  OK: 0,
  ERROR: 1,
  NOT_FOUND: 2,
  BAD_REQUEST: 3,
  SPECIFIC_SUCCESS: 64,
}

const EP_PORT_RE = /EP-133|EP-40|EP-1320/i

export class TeError extends Error {
  constructor(message, { status, command } = {}) {
    super(message)
    this.name = 'TeError'
    this.status = status
    this.command = command
  }
}

export function parseMetadata(text) {
  const out = {
    chip_id: '',
    mode: '',
    os_version: '',
    product: '',
    serial: '',
    sku: '',
    sw_version: '',
    base_sku: '',
  }
  for (const part of text.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const k = part.slice(0, i)
    const v = part.slice(i + 1)
    if (k in out) out[k] = v
  }
  return out
}

function parseIdentity(data) {
  if (data.length !== 17) return null
  if (data[0] !== 0xf0 || data[1] !== 0x7e) return null
  if (data[5] !== TE_MFG[0] || data[6] !== TE_MFG[1] || data[7] !== TE_MFG[2]) return null
  const model = data[8] ^ (data[9] << 7)
  const variant = data[10] ^ (data[11] << 7)
  const sku =
    `TE${String(model).padStart(3, '0')}AS${String(variant).padStart(3, '0')}`
  return { deviceId: data[2], sku }
}

/**
 * Firmware debug/log SysEx: F0 00 20 76 <product> 33 <ascii…> F7
 * (byte 5 is 0x33 where normal frames carry 0x40). Seen as err sound loops.
 */
export function parseDebugFrame(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data)
  if (data.length < 8 || data[0] !== 0xf0 || data[data.length - 1] !== 0xf7) return null
  if (data[1] !== TE_MFG[0] || data[2] !== TE_MFG[1] || data[3] !== TE_MFG[2]) return null
  if (data[5] !== 0x33) return null
  const text = new TextDecoder().decode(data.subarray(6, data.length - 1)).replace(/\0/g, '').trim()
  return { product: data[4], text }
}

function parseTeSysex(data) {
  if (
    data.length < 9 ||
    data[0] !== 0xf0 ||
    data[1] !== TE_MFG[0] ||
    data[2] !== TE_MFG[1] ||
    data[3] !== TE_MFG[2] ||
    data[5] !== MIDI_SYSEX_TE ||
    data[data.length - 1] !== 0xf7
  ) {
    return null
  }
  const isRequest = !!(data[6] & BIT_IS_REQUEST)
  const hasRequestId = !!(data[6] & BIT_REQUEST_ID_AVAILABLE)
  const requestId = hasRequestId ? ((data[6] & 31) << 7) | (data[7] & 127) : -1
  const command = data[8]
  let i = 9
  let status = -1
  if (!isRequest) status = data[i++]
  const packed = data.subarray(i, data.length - 1)
  const payload = packed.length ? unpack(packed) : new Uint8Array()
  const text = new TextDecoder().decode(payload)
  return { isRequest, requestId, command, status, payload, text }
}

/**
 * @typedef {{
 *   input: MIDIInput,
 *   output: MIDIOutput,
 *   deviceId: number,
 *   identitySku: string,
 *   metadata: ReturnType<typeof parseMetadata>,
 * }} TeDevice
 */

export class TeDfuSession {
  /** @param {MIDIAccess} access */
  constructor(access) {
    this.access = access
    /** @type {TeDevice | null} */
    this.device = null
    this._requestId = Math.floor(Math.random() * 4095)
    /** @type {Map<number, { resolve: Function, reject: Function, onProgress?: Function, timer: any }>} */
    this._waiters = new Map()
    this._onMessage = (e) => this._dispatch(e)
  }

  static async open() {
    if (!navigator.requestMIDIAccess) {
      throw new TeError('WebMIDI is not available in this browser')
    }
    const access = await navigator.requestMIDIAccess({ sysex: true })
    return new TeDfuSession(access)
  }

  listEpPorts() {
    const inputs = []
    const outputs = []
    this.access.inputs.forEach((p) => {
      if (EP_PORT_RE.test(p.name ?? '')) inputs.push(p)
    })
    this.access.outputs.forEach((p) => {
      if (EP_PORT_RE.test(p.name ?? '')) outputs.push(p)
    })
    return { inputs, outputs }
  }

  _nextRequestId() {
    this._requestId = (this._requestId + 1) % 4096
    return this._requestId
  }

  _attachInput(input) {
    input.onmidimessage = this._onMessage
  }

  _dispatch(event) {
    const data = new Uint8Array(event.data)
    const identity = parseIdentity(data)
    if (identity && this._identityWaiter) {
      const w = this._identityWaiter
      this._identityWaiter = null
      clearTimeout(w.timer)
      w.resolve({ input: event.target, ...identity })
      return
    }

    const msg = parseTeSysex(data)
    if (!msg || msg.isRequest || msg.requestId < 0) return
    const waiter = this._waiters.get(msg.requestId)
    if (!waiter) return

    if (msg.status === STATUS.OK) {
      clearTimeout(waiter.timer)
      this._waiters.delete(msg.requestId)
      waiter.resolve(msg)
      return
    }
    if (msg.status === STATUS.SPECIFIC_SUCCESS) {
      // Intermediate DFU progress — keep waiting, reset timeout.
      clearTimeout(waiter.timer)
      waiter.timer = setTimeout(() => {
        this._waiters.delete(msg.requestId)
        waiter.reject(new TeError(`timeout waiting for cmd 0x${msg.command.toString(16)}`))
      }, waiter.timeoutMs)
      waiter.onProgress?.(msg)
      return
    }
    clearTimeout(waiter.timer)
    this._waiters.delete(msg.requestId)
    waiter.reject(
      new TeError(
        `device status=0x${msg.status.toString(16)} cmd=0x${msg.command.toString(16)}: ${msg.text || ''}`.trim(),
        { status: msg.status, command: msg.command },
      ),
    )
  }

  /**
   * @param {MIDIOutput} output
   * @param {number} deviceId
   * @param {number} command
   * @param {number[] | Uint8Array} payload
   */
  _send(output, deviceId, command, payload) {
    const raw = payload instanceof Uint8Array ? payload : Uint8Array.from(payload)
    const packedLen = packedLength(raw.length)
    const frame = new Uint8Array(10 + packedLen)
    const id = this._nextRequestId()
    frame[0] = 0xf0
    frame[1] = TE_MFG[0]
    frame[2] = TE_MFG[1]
    frame[3] = TE_MFG[2]
    frame[4] = deviceId & 0x7f
    frame[5] = MIDI_SYSEX_TE
    frame[6] = BIT_IS_REQUEST | BIT_REQUEST_ID_AVAILABLE | ((id >> 7) & 31)
    frame[7] = id & 127
    frame[8] = command
    frame[frame.length - 1] = 0xf7
    if (packedLen) packToBuffer(raw, frame.subarray(9, 9 + packedLen))
    output.send(frame)
    return id
  }

  request(output, deviceId, command, payload = [], { timeoutMs = 20000, onProgress } = {}) {
    const id = this._send(output, deviceId, command, payload)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id)
        reject(new TeError(`timeout waiting for cmd 0x${command.toString(16)}`))
      }, timeoutMs)
      this._waiters.set(id, { resolve, reject, onProgress, timer, timeoutMs })
    })
  }

  async connect() {
    const { inputs, outputs } = this.listEpPorts()
    if (!outputs.length || !inputs.length) {
      throw new TeError('No EP-133 / EP-40 / EP-1320 MIDI ports found. Plug in over USB-C.')
    }

    for (const input of inputs) this._attachInput(input)

    // Try each output until identity answers.
    let identified = null
    for (const output of outputs) {
      identified = await this._identify(output, inputs).catch(() => null)
      if (identified) break
    }
    if (!identified) throw new TeError('device did not answer MIDI identity')

    const greet = await this.request(identified.output, identified.deviceId, CMD.GREET, [], {
      timeoutMs: 5000,
    })
    let metadata = parseMetadata(greet.text)
    if (!metadata.os_version || metadata.sku.length !== 10) {
      const greet2 = await this.request(identified.output, identified.deviceId, CMD.GREET, [], {
        timeoutMs: 5000,
      })
      metadata = parseMetadata(greet2.text)
    }

    this.device = {
      input: identified.input,
      output: identified.output,
      deviceId: identified.deviceId,
      identitySku: identified.sku,
      metadata,
    }
    return this.device
  }

  _identify(output, inputs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._identityWaiter = null
        reject(new TeError('identity timeout'))
      }, 2500)
      this._identityWaiter = {
        timer,
        resolve: (info) => {
          resolve({ output, input: info.input, deviceId: info.deviceId, sku: info.sku })
        },
      }
      output.send([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7])
    })
  }

  /**
   * Detach MIDI listeners so a FILE session (kotu WebMidiTransport) can claim the port.
   * Kotu refuses to open if input.onmidimessage is already set.
   */
  close() {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer)
      w.reject(new TeError('session closed'))
    }
    this._waiters.clear()
    if (this._identityWaiter) {
      clearTimeout(this._identityWaiter.timer)
      this._identityWaiter = null
    }
    const { inputs } = this.listEpPorts()
    for (const input of inputs) {
      if (input.onmidimessage === this._onMessage) input.onmidimessage = null
    }
    if (this.device?.input?.onmidimessage === this._onMessage) {
      this.device.input.onmidimessage = null
    }
    this.device = null
  }
}

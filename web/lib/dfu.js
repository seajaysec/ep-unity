/**
 * Clean-room TE DFU flash. Speaks the public MIDI SysEx DFU sequence;
 * does not use Teenage Engineering's update utility.
 */

import { parseTfw, rewriteSku } from './tfw.js'
import { CMD, DFU, STATUS, TeError } from './midi.js'

/**
 * Build DFU_BEGIN payload from a .tfw image (SKU already as intended on the wire).
 * @param {Uint8Array} data
 */
export function beginPayload(data) {
  const info = parseTfw(data)
  const version = data.subarray(7, 15)
  const sku = data.subarray(15, 19)
  const transfer = data.length - 64
  const size = Uint8Array.of(
    (transfer >> 24) & 255,
    (transfer >> 16) & 255,
    (transfer >> 8) & 255,
    transfer & 255,
  )
  return Uint8Array.of(
    DFU.BEGIN,
    ...version,
    DFU.BEGIN_APP,
    ...sku,
    ...size,
    data[4],
  )
}

/**
 * Prepare image for the connected device: rewrite header SKU to the live device SKU
 * so DFU_BEGIN matches what TE's own host check would have required.
 */
export function prepareImage(data, deviceSku) {
  const info = parseTfw(data)
  if (info.sku === deviceSku) return { bytes: data, info, rewritten: false }
  const bytes = rewriteSku(data, deviceSku)
  return { bytes, info: parseTfw(bytes), rewritten: true, fromSku: info.sku }
}

function chunkSizeFromBeginAck(payload) {
  if (payload.length < 2) return 235
  const advertised = (payload[0] << 8) | payload[1]
  return Math.max(16, Math.ceil(advertised * (7 / 8)) - 12)
}

/**
 * @param {import('./midi.js').TeDfuSession} session
 * @param {Uint8Array} image  prepared .tfw bytes
 * @param {{ onProgress?: (p: { pct: number, step: string }) => void }} [opts]
 */
export async function flashFirmware(session, image, opts = {}) {
  const device = session.device
  if (!device) throw new TeError('not connected')
  const { output, deviceId } = device
  const onProgress = opts.onProgress ?? (() => {})

  parseTfw(image) // validate
  const begin = beginPayload(image)
  onProgress({ pct: 0, step: 'dfu begin' })

  let beginAck
  try {
    beginAck = await session.request(output, deviceId, CMD.DFU, begin, { timeoutMs: 20000 })
  } catch (err) {
    if (err instanceof TeError && err.status === STATUS.BAD_REQUEST) {
      onProgress({ pct: 0, step: 'entering bootloader' })
      await session.request(output, deviceId, CMD.DFU, [DFU.ENTER, DFU.ENTER_MIDI, 0, 200], {
        timeoutMs: 20000,
      })
      // Device reboots into bootloader — caller must reconnect and retry.
      throw new TeError('device is rebooting into bootloader — reconnect and flash again', {
        status: STATUS.BAD_REQUEST,
        command: CMD.DFU,
      })
    }
    throw err
  }

  let maxChunk = chunkSizeFromBeginAck(beginAck.payload)
  if (beginAck.payload[0] === DFU.ENTER_RESPONSE_READY) {
    onProgress({ pct: 0, step: 'in-app dfu' })
  }

  let offset = 64
  let chunkNumber = 0
  const total = image.length
  onProgress({ pct: Math.floor((offset / total) * 100), step: 'transfer' })

  while (offset < total) {
    const end = Math.min(offset + maxChunk, total)
    const slice = image.subarray(offset, end)
    const payload = new Uint8Array(2 + slice.length)
    payload[0] = DFU.CHUNK
    payload[1] = chunkNumber++ % 256
    payload.set(slice, 2)
    await session.request(output, deviceId, CMD.DFU, payload, { timeoutMs: 5000 })
    offset = end
    onProgress({ pct: Math.floor((offset / total) * 100), step: 'transfer' })
  }

  onProgress({ pct: 100, step: 'perform' })
  await session.request(output, deviceId, CMD.DFU, [DFU.PERFORM], {
    timeoutMs: 120000,
    onProgress: (msg) => {
      if (msg.payload.length > 1) {
        const label = new TextDecoder().decode(msg.payload.subarray(1))
        onProgress({ pct: msg.payload[0] ?? 100, step: label || 'perform' })
      }
    },
  })

  onProgress({ pct: 100, step: 'exit' })
  try {
    await session.request(output, deviceId, CMD.DFU, [DFU.EXIT], { timeoutMs: 1000 })
  } catch {
    // TE's client tolerates DFU_EXIT timeout — device may already be rebooting.
  }

  onProgress({ pct: 100, step: 'rebooting' })
}

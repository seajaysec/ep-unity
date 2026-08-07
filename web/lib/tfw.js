/**
 * Teenage Engineering .tfw header parse / SKU rewrite (babecafe layout).
 * Port of tools/tfw.py — no TE updater code.
 */

export const BABECAFE = [0xba, 0xbe, 0xca, 0xfe]
export const BEEFCAFE = [0xbe, 0xef, 0xca, 0xfe]

export function skuBytesToString(sku) {
  if (sku.length !== 4) throw new Error('sku must be 4 bytes')
  const e = (sku[0] << 24) | (sku[1] << 16) | (sku[2] << 8) | sku[3]
  const model = (e >>> 14) & 1023
  const mid = (e >>> 10) & 15 ? '??' : 'AS'
  const variant = e & 1023
  return `TE${String(model).padStart(3, '0')}${mid}${String(variant).padStart(3, '0')}`
}

export function skuStringToBytes(sku) {
  if (!sku.startsWith('TE') || !sku.includes('AS')) {
    throw new Error(`unsupported sku format: ${sku}`)
  }
  const body = sku.slice(2)
  const [modelS, variantS] = body.split('AS')
  const model = Number(modelS)
  const variant = Number(variantS)
  if (!Number.isInteger(model) || !Number.isInteger(variant)) {
    throw new Error(`unsupported sku format: ${sku}`)
  }
  const e = (model << 14) | variant
  return Uint8Array.of((e >>> 24) & 255, (e >>> 16) & 255, (e >>> 8) & 255, e & 255)
}

export function versionString(ver) {
  const majors = (ver[0] << 8) | ver[1]
  const minors = (ver[2] << 8) | ver[3]
  const patch = (ver[4] << 8) | ver[5]
  const build = (ver[6] << 8) | ver[7]
  const s = `${majors}.${minors}.${patch}`
  return build ? `${s}+${build}` : s
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function parseTfw(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (u8.length < 64) throw new Error('truncated header')
  if (u8[0] !== 0xba || u8[1] !== 0xbe || u8[2] !== 0xca || u8[3] !== 0xfe) {
    throw new Error('missing babecafe magic — not a .tfw')
  }
  const version = u8.subarray(7, 15)
  const sku = u8.subarray(15, 19)
  const info = {
    size: u8.length,
    firmwareType: u8[4],
    checksum: hex(u8.subarray(5, 7)),
    version: versionString(version),
    versionBytes: hex(version),
    sku: skuBytesToString(sku),
    skuBytes: hex(sku),
    beefcafe:
      u8.length >= 0x44 &&
      u8[0x40] === 0xbe &&
      u8[0x41] === 0xef &&
      u8[0x42] === 0xca &&
      u8[0x43] === 0xfe,
    transferOffset: 64,
    transferLen: u8.length - 64,
    header: u8.subarray(0, 64),
  }
  return info
}

/**
 * Rewrite SKU at bytes 15–18. Checksum @5–6 is left as-is (TE's Firmware class
 * stores it but DFU_BEGIN sends version + sku + size + type, not that field).
 */
export function rewriteSku(data, newSku) {
  const out = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data))
  out.set(skuStringToBytes(newSku), 15)
  return out
}

/** Suggested output filename after a rewrite. */
export function rewrittenFilename(originalName, newSku) {
  const base = (originalName || 'firmware.tfw').replace(/\.tfw$/i, '')
  return `${base}_as_${newSku}.tfw`
}

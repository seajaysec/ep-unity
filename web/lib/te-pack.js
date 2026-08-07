/**
 * TE DFU SysEx 7-bit pack (from Teenage Engineering's update utility packToBuffer /
 * unpackInPlace). Independent of kotu FILE packed7.
 */

/** Packed length needed for `rawLen` payload bytes (flag + 7 data groups). */
export function packedLength(rawLen) {
  if (rawLen <= 0) return 0
  return rawLen + Math.ceil(rawLen / 7)
}

/**
 * Pack raw bytes into TE SysEx data region. `out` must be zero-filled and at least
 * packedLength(raw.length) bytes.
 */
export function packToBuffer(raw, out) {
  let r = 1
  let s = 0
  for (let o = 0; o < raw.length; ++o) {
    const a = o % 7
    const u = raw[o] >> 7
    out[s] |= u << a
    out[r++] = raw[o] & 127
    if (a === 6 && o < raw.length - 1) {
      s += 8
      r++
    }
  }
}

/** Unpack a copy of packed SysEx data (does not mutate the input buffer). */
export function unpack(packed) {
  const e = new Uint8Array(packed)
  let t = 0
  let r = 0
  let s = 0
  let o = 1
  let a = e[r]
  while (o < e.length) {
    const u = ((a & (1 << s) ? 1 : 0) << 7)
    const h = e[o] & 127
    e[t] = u | h
    ++s
    ++o
    ++t
    if (s > 6) {
      ++o
      s = 0
      r += 8
      a = e[r]
    }
  }
  return e.subarray(0, t)
}

/**
 * Client-side .pak (ZIP) inspect + thin. Uses kotu writeZip/readZip (CompressionStream).
 */

import { readZip, writeZip } from './kotu.bundle.js'

const SOUND_RE = /(?:^|\/)sounds\/(\d+)\s+(.+)\.wav$/i
const PROJECT_RE = /(?:^|\/)projects\/P(\d+)\.tar$/i

/**
 * Minimal ustar reader — enough for EP project TARs (pads/.../pNN).
 * @param {Uint8Array} data
 * @returns {Map<string, Uint8Array>}
 */
export function readTarMembers(data) {
  const out = new Map()
  let offset = 0
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break
    const name = asciiField(header, 0, 100).replace(/^\.\//, '')
    const sizeOct = asciiField(header, 124, 12).replace(/\0.*$/, '').trim()
    const size = sizeOct ? parseInt(sizeOct, 8) : 0
    if (!Number.isFinite(size) || size < 0) break
    const payload = data.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    if (name) out.set(name, payload)
  }
  return out
}

function asciiField(buf, start, len) {
  let s = ''
  for (let i = 0; i < len; i++) {
    const c = buf[start + i]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

/** Sample slots 1..999 from pad records; ≥1000 = Riddim supertone, skipped. */
export function slotsFromProjectTar(tarBytes) {
  const slots = new Set()
  const members = readTarMembers(tarBytes)
  for (const [name, payload] of members) {
    if (!name.startsWith('pads/') || !/\/p\d+$/.test(name)) continue
    if (payload.length < 3) continue
    const slot = payload[1] | (payload[2] << 8)
    if (slot >= 1 && slot <= 999) slots.add(slot)
  }
  return slots
}

/**
 * Riddim Supertone pads store `sym − 1` at pad bytes 1–2 (sym 1001..1010 → 1000..1009).
 * EP-133 has no Supertone engines — loading these projects can fault (e.g. err sound 24).
 * @returns {Array<{ path: string, engine: number|null, sym: number }>}
 */
export function scanTarForSupertone(tarBytes) {
  const hits = []
  const members = readTarMembers(tarBytes)
  for (const [name, payload] of members) {
    if (!name.startsWith('pads/') || !/\/p\d+$/.test(name)) continue
    if (payload.length < 3) continue
    const stored = payload[1] | (payload[2] << 8)
    if (stored < 1000) continue
    const sym = stored + 1
    const engine = stored >= 1000 && stored <= 1009 ? stored - 1000 : null
    hits.push({ path: name, engine, sym })
  }
  return hits
}

/** Unassigned pad record of `size` bytes (EP-133/Sample-Tool-safe defaults). */
export function blankPadRecord(size) {
  const n = Math.max(26, size | 0)
  const payload = new Uint8Array(n)
  const view = new DataView(payload.buffer)
  view.setFloat32(12, 120, true)
  payload[16] = 100
  payload[20] = 255
  payload[24] = 60
  return payload
}

/**
 * Mutate a kotu tar entry list in place: clear Supertone pads, Riddim loop mode, drop `live`.
 * @param {Array<{ path: string, type?: string, data?: Uint8Array }>} entries
 * @returns {{ padsCleared: number, loopsCleared: number, liveRemoved: boolean }}
 */
export function stripSupertoneFromTarEntries(entries) {
  let padsCleared = 0
  let loopsCleared = 0
  let liveRemoved = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    const path = entry.path?.replace(/^\.\//, '') || ''
    if (entry.type === 'file' && (path === 'live' || path.endsWith('/live'))) {
      entries.splice(i, 1)
      liveRemoved = true
      continue
    }
    if (entry.type !== 'file' || !entry.data) continue
    if (!path.startsWith('pads/') || !/\/p\d+$/.test(path)) continue
    if (entry.data.length < 3) continue
    const stored = entry.data[1] | (entry.data[2] << 8)
    const isSuper = stored >= 1000
    const isLoop = entry.data.length > 23 && entry.data[23] === 3
    if (isSuper) {
      entry.data = blankPadRecord(entry.data.length)
      padsCleared++
    } else if (isLoop) {
      const copy = entry.data.slice()
      copy[23] = 0
      entry.data = copy
      loopsCleared++
    }
  }
  return { padsCleared, loopsCleared, liveRemoved }
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export async function inspectPak(buffer) {
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const files = await readZip(raw)
  const projects = new Map()
  const sounds = new Map()
  let meta = null

  for (const [name, bytes] of files) {
    if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) continue
    const mProj = name.match(PROJECT_RE)
    if (mProj) {
      projects.set(Number(mProj[1]), { name, bytes })
      continue
    }
    const mSound = name.match(SOUND_RE)
    if (mSound) {
      sounds.set(Number(mSound[1]), {
        name,
        bytes,
        size: bytes.length,
        label: mSound[2],
      })
      continue
    }
    const leaf = name.split('/').pop()
    if (leaf === 'meta.json') {
      try {
        meta = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        meta = null
      }
    }
  }
  return { meta, projects, sounds }
}

export function planThin(pack, projectNums) {
  const needed = new Set()
  const missingProjects = []
  for (const n of projectNums) {
    const p = pack.projects.get(n)
    if (!p) {
      missingProjects.push(n)
      continue
    }
    for (const s of slotsFromProjectTar(p.bytes)) needed.add(s)
  }
  const present = [...needed].filter((s) => pack.sounds.has(s)).sort((a, b) => a - b)
  const missingSlots = [...needed].filter((s) => !pack.sounds.has(s)).sort((a, b) => a - b)
  let wavBytes = 0
  for (const s of present) wavBytes += pack.sounds.get(s).size
  return {
    projects: projectNums.filter((n) => pack.projects.has(n)),
    missingProjects,
    slots: present,
    missingSlots,
    wavBytes,
  }
}

export async function buildThinnedPak(pack, projectNums) {
  const plan = planThin(pack, projectNums)
  if (plan.missingProjects.length) {
    throw new Error(`projects missing from pack: ${plan.missingProjects.join(', ')}`)
  }
  const meta = {
    ...(pack.meta || {
      info: 'teenage engineering - pak file',
      pak_version: 1,
      pak_type: 'user',
    }),
    thinned_projects: plan.projects.map((n) => `P${String(n).padStart(2, '0')}`),
    thinned_by: 'ep-unity/web',
  }
  /** @type {{path:string,data:Uint8Array}[]} */
  const entries = [
    {
      path: '/meta.json',
      data: new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'),
    },
  ]
  for (const n of plan.projects) {
    entries.push({
      path: `/projects/P${String(n).padStart(2, '0')}.tar`,
      data: pack.projects.get(n).bytes,
    })
  }
  for (const slot of plan.slots) {
    const sound = pack.sounds.get(slot)
    const label = sound.label || 'sample'
    entries.push({
      path: `/sounds/${String(slot).padStart(3, '0')} ${label}.wav`,
      data: sound.bytes,
    })
  }
  return { bytes: await writeZip(entries), plan }
}

export function formatMb(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

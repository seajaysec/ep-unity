/**
 * Browser FILE backup / restore built on the kotu WebMIDI stack (bundled).
 */

import {
  openEp133,
  Ep133Session,
  listSlots,
  downloadSlot,
  uploadSlot,
  getNodeMetadata,
  setNodeMetadata,
  buildUploadMetadata,
  getStorage,
  encodeWav,
  decodeWav,
  writeZip,
  writeTar,
  readTar,
  be16,
  parseListPage,
  MAX_LIST_PAGES,
  isSlotMeta,
  isSynthMeta,
} from './kotu.bundle.js'
import { inspectPak, scanTarForSupertone, stripSupertoneFromTarEntries } from './pak.js'

export { getStorage, listSlots, scanTarForSupertone }

export const PROJECTS_NODE = 2000
/** Max sample rate the device accepts. OS 2.0+ keeps lower rates as-is — do not upsample. */
export const MAX_SAMPLE_RATE = 46875
/** @deprecated Use MAX_SAMPLE_RATE — kept as alias for older call sites. */
export const NATIVE_RATE = MAX_SAMPLE_RATE

/**
 * On-device PCM bytes for a WAV's payload.
 * Rates ≤46875 stay put (OS 2.0+ / 2.5+); only rates above the max are downsampled.
 */
export function nativePcmBytes(pcmByteLength, channels, sourceRate) {
  const ch = Math.max(1, channels | 0)
  const srcFrames = Math.floor(pcmByteLength / (2 * ch))
  if (sourceRate <= MAX_SAMPLE_RATE) return srcFrames * ch * 2
  const dstFrames = Math.max(1, Math.round((srcFrames * MAX_SAMPLE_RATE) / sourceRate))
  return dstFrames * ch * 2
}

/** Rate to store on device for a source WAV. */
export function deviceSampleRate(sourceRate) {
  return sourceRate > MAX_SAMPLE_RATE ? MAX_SAMPLE_RATE : sourceRate
}

/**
 * Bytes the restore will write (on-device PCM), plus reclaim from overwrites.
 * @param {Map<number, {bytes: Uint8Array}>} sounds
 * @param {number[]} slotList
 * @param {Array<{slot:number, sizeBytes:number}>} occupied
 */
export function planRestoreSpace(sounds, slotList, occupied = []) {
  const bySlot = new Map(occupied.map((e) => [e.slot, e.sizeBytes || 0]))
  let needed = 0
  let reclaimed = 0
  for (const slot of slotList) {
    const sound = sounds.get(slot)
    if (!sound) continue
    const decoded = decodeWav(sound.bytes)
    needed += nativePcmBytes(decoded.pcm.length, decoded.channels, decoded.sampleRate)
    reclaimed += bySlot.get(slot) || 0
  }
  return { needed, reclaimed }
}

/**
 * @returns {null | string} error message if restore would exceed free space
 */
export function roomCheck(storage, needed, reclaimed) {
  if (!storage) return null
  const available = storage.freeSpace + reclaimed
  if (needed <= available) return null
  return (
    `Not enough sample space: need ${formatBytes(needed)}, ` +
    `have ${formatBytes(available)} ` +
    `(${formatBytes(storage.freeSpace)} free` +
    (reclaimed ? ` + ${formatBytes(reclaimed)} from overwrites` : '') +
    ` of ${formatBytes(storage.maxCapacity)}). ` +
    `Thin further, delete samples on-device, or use a 128 MiB unit.`
  )
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

export function projectFid(projectNumber) {
  const n = Number(projectNumber)
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`bad project ${projectNumber}`)
  return 3000 + (n - 1) * 1000
}

export function projectNumberFromFid(fid) {
  if (fid < 3000 || (fid - 3000) % 1000) return null
  const n = (fid - 3000) / 1000 + 1
  return n >= 1 && n <= 99 ? n : null
}

export async function openFileSession() {
  const transport = await openEp133()
  const session = new Ep133Session(transport)
  const info = await session.connect()
  return { session, info, close: () => session.close() }
}

export async function listProjects(session) {
  const all = []
  let terminated = false
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await session.request(0x6a, [0x04, ...be16(page), ...be16(PROJECTS_NODE)], 0x2a)
    const entries = parseListPage(res.payload)
    if (entries.length === 0) {
      terminated = true
      break
    }
    all.push(...entries)
  }
  if (!terminated) throw new Error(`listProjects: did not terminate within ${MAX_LIST_PAGES} pages`)
  const out = []
  for (const e of all) {
    // Project archives are DIR nodes (FILE_PUT flags 0x06). Skipping isDir
    // made every project invisible after a correct restore.
    if (e.slot === PROJECTS_NODE) continue
    const num = projectNumberFromFid(e.slot)
    if (num == null) continue
    out.push({ ...e, project: num })
  }
  return out.sort((a, b) => a.project - b.project)
}

export async function downloadProject(session, projectNumber, onProgress) {
  return downloadSlot(session, projectFid(projectNumber), onProgress)
}

/** Linear resample s16 interleaved PCM to target rate. */
export function resamplePcm16(pcm, channels, sourceRate, targetRate) {
  if (sourceRate === targetRate) return pcm
  const src = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2)
  const srcFrames = Math.floor(src.length / channels)
  const dstFrames = Math.max(1, Math.round((srcFrames * targetRate) / sourceRate))
  const dst = new Int16Array(dstFrames * channels)
  for (let i = 0; i < dstFrames; i++) {
    const srcPos = (i * (srcFrames - 1)) / Math.max(1, dstFrames - 1)
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(srcFrames - 1, i0 + 1)
    const t = srcPos - i0
    for (let c = 0; c < channels; c++) {
      const a = src[i0 * channels + c]
      const b = src[i1 * channels + c]
      dst[i * channels + c] = (a + (b - a) * t) | 0
    }
  }
  return new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)
}

function backupFields(meta) {
  return {
    'sound.playmode': meta['sound.playmode'],
    'sound.rootnote': meta['sound.rootnote'],
    'sound.pitch': meta['sound.pitch'],
    'sound.pan': meta['sound.pan'],
    'sound.amplitude': meta['sound.amplitude'],
    'envelope.attack': meta['envelope.attack'],
    'envelope.release': meta['envelope.release'],
    'time.mode': meta['time.mode'],
  }
}

function be32u(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

/** Thrown when the caller cancels; callers check `.name` to avoid an error banner. */
export class CancelledError extends Error {
  constructor(message = 'cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * @param {(done:number,total:number,label:string)=>void} onProgress
 * @param {{ signal?: AbortSignal }} [opts] cancel is checked between items — a
 *   single slot transfer still runs to completion so the device is never left
 *   mid-read.
 */
export async function backupDevice(session, info, onProgress = () => {}, opts = {}) {
  const { signal } = opts
  const slots = await listSlots(session)
  const projects = await listProjects(session)
  const total = Math.max(1, slots.length + projects.length)
  let done = 0

  const sounds = new Map()
  const slotMeta = new Map()
  for (const e of slots) {
    checkAbort(signal)
    const meta = await getNodeMetadata(session, e.slot)
    if (isSynthMeta(meta) || !isSlotMeta(meta)) {
      onProgress(++done, total, `skip ${e.slot}`)
      continue
    }
    // Big samples used to sit on one frozen-looking tick because this callback
    // was never passed, even though downloadSlot has always accepted it.
    const pcm = await downloadSlot(session, e.slot, (byteDone, byteTotal) => {
      if (!byteTotal) return
      onProgress(
        done,
        total,
        `${meta.name} · ${formatBytes(byteDone)}/${formatBytes(byteTotal)}`,
      )
    })
    const wav = encodeWav(pcm, { channels: meta.channels, sampleRate: meta.samplerate })
    sounds.set(e.slot, {
      name: `${String(e.slot).padStart(3, '0')} ${meta.name}.wav`,
      wav,
    })
    slotMeta.set(e.slot, backupFields(meta))
    onProgress(++done, total, meta.name)
  }

  const projectTars = new Map()
  for (const p of projects) {
    checkAbort(signal)
    const tar = await downloadProject(session, p.project)
    projectTars.set(`P${String(p.project).padStart(2, '0')}`, tar)
    onProgress(++done, total, `P${String(p.project).padStart(2, '0')}`)
  }

  return { sounds, slotMeta, projectTars, info, slotCount: sounds.size, projectCount: projectTars.size }
}

export async function packBackup(backup) {
  const entries = []
  const meta = {
    info: 'teenage engineering - pak file',
    pak_version: 1,
    pak_type: 'user',
    pak_release: '1.2.0',
    device_name: backup.info?.product || 'EP',
    device_sku: backup.info?.sku || '',
    device_version: backup.info?.osVersion || '',
    generated_at: new Date().toISOString(),
    author: 'ep-unity',
    serial: backup.info?.serial || '',
  }
  entries.push({
    path: '/meta.json',
    data: new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'),
  })
  if (backup.slotMeta?.size) {
    const obj = Object.fromEntries([...backup.slotMeta.entries()].map(([k, v]) => [String(k), v]))
    entries.push({
      path: '/kotu/slot-metadata.json',
      data: new TextEncoder().encode(JSON.stringify(obj)),
    })
  }
  for (const [, sound] of backup.sounds) {
    entries.push({ path: `/sounds/${sound.name}`, data: sound.wav })
  }
  for (const [key, tar] of backup.projectTars) {
    entries.push({ path: `/projects/${key}.tar`, data: tar })
  }
  return writeZip(entries)
}

/** FILE_PUT flags: READ|DIR — project TARs are directories, not sound files. */
const PROJECT_PUT_FLAGS = 0x06

export async function uploadProjectTar(session, projectNumber, tarBytes) {
  const fid = projectFid(projectNumber)
  const name = String(projectNumber).padStart(2, '0')
  const nameBytes = [...new TextEncoder().encode(name)]
  const UPLOAD_CHUNK = 433
  const groupRoot = fid + 100

  // Match Sample Tool / epsysex write_project_archive: flags 0x06, no trailing
  // metadata JSON on PUT open. Sound uploads use 0x05 + metadata; copying that
  // here makes the drain-barrier metadata write return status=0x1 and aborts
  // before reload — projects land broken / silent.
  await session.requestDuringTransfer(
    0x7e,
    [
      0x02,
      0x00,
      PROJECT_PUT_FLAGS,
      ...be16(fid),
      ...be16(PROJECTS_NODE),
      ...be32u(tarBytes.length),
      ...nameBytes,
      0x00,
    ],
    0x3e,
    5000,
    { checkStatus: false },
  )
  session.enterTransfer()
  let pending
  try {
    let idx = 0
    for (let off = 0; off < tarBytes.length; off += UPLOAD_CHUNK) {
      const slice = tarBytes.subarray(off, Math.min(off + UPLOAD_CHUNK, tarBytes.length))
      session.fireAndForget(0x7e, [0x02, 0x01, ...be16(idx), ...slice])
      idx++
    }
    // Empty final page = EOF (same as epsysex _write_file).
    session.fireAndForget(0x7e, [0x02, 0x01, ...be16(idx)])
    // Drain barrier must answer with 0x2a so chunk ACKs (0x3e) cannot impersonate
    // it. LIST /projects works on project nodes; writing `{}` metadata does not.
    await session.requestDuringTransfer(
      0x6a,
      [0x04, ...be16(0), ...be16(PROJECTS_NODE)],
      0x2a,
      180_000,
    )
  } catch (err) {
    pending = err
    throw err
  } finally {
    try {
      await session.reinit()
    } catch (reinitErr) {
      if (pending === undefined) throw reinitErr
    }
  }

  // Activation dance matching epsysex write_project_archive_and_reload:
  // remember group/pad, cycle to another project (forces unload), re-activate.
  let activeGroup = null
  let activePad = null
  try {
    const gMeta = await getNodeMetadata(session, groupRoot)
    activeGroup = gMeta?.active ?? null
    if (typeof activeGroup === 'number' && activeGroup > 0) {
      const pMeta = await getNodeMetadata(session, activeGroup)
      activePad = pMeta?.active ?? null
    }
  } catch {
    /* empty / missing group metadata is fine on a fresh write */
  }

  try {
    const others = await listProjects(session)
    const alt = others.find((p) => p.project !== projectNumber)
    if (alt) {
      await setNodeMetadata(session, PROJECTS_NODE, { active: alt.slot })
      await sleep(200)
    }
  } catch {
    /* single-project devices skip the cycle */
  }

  await setNodeMetadata(session, PROJECTS_NODE, { active: fid })
  if (typeof activeGroup === 'number' && activeGroup > 0) {
    await setNodeMetadata(session, groupRoot, { active: activeGroup })
  }
  if (typeof activePad === 'number' && activePad > 0 && typeof activeGroup === 'number') {
    await setNodeMetadata(session, activeGroup, { active: activePad })
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Rewrite pad lengthFrames to match resampled sample lengths.
 * EP-40 factory pads are 29 bytes; EP-133 uses 26 — only touch the u32 at offset 8.
 * @param {Uint8Array} tarBytes
 * @param {Map<number, number>} framesBySlot
 */
export function patchProjectTarLengthFrames(tarBytes, framesBySlot) {
  const entries = readTar(tarBytes)
  let changed = 0
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    if (!entry.path.startsWith('pads/') || !/\/p\d+$/.test(entry.path)) continue
    if (entry.data.length < 12) continue
    const slot = entry.data[1] | (entry.data[2] << 8)
    if (slot < 1 || slot > 999) continue
    const frames = framesBySlot.get(slot)
    if (frames == null) continue
    const next = entry.data.slice()
    const view = new DataView(next.buffer, next.byteOffset, next.byteLength)
    if (view.getUint32(8, true) === frames) continue
    view.setUint32(8, frames, true)
    entry.data = next
    changed++
  }
  return changed ? writeTar(entries) : tarBytes
}

export async function restorePakBytes(
  session,
  buffer,
  { slots = null, projects = null, onProgress = () => {}, signal = null } = {},
) {
  const pack = await inspectPak(buffer)
  const slotList = slots ?? [...pack.sounds.keys()].sort((a, b) => a - b)
  const projList = projects ?? [...pack.projects.keys()].sort((a, b) => a - b)
  const total = Math.max(1, slotList.length + projList.length)
  let done = 0

  /** @type {Map<number, number>} */
  const framesBySlot = new Map()

  // OS 2.0+/2.5+: keep source rate when ≤46875 (no upsample). Only downsample
  // oversize rates. Pad lengthFrames are patched when the frame count changes.
  for (const slot of slotList) {
    checkAbort(signal)
    const sound = pack.sounds.get(slot)
    if (!sound) continue
    const decoded = decodeWav(sound.bytes)
    const rate = deviceSampleRate(decoded.sampleRate)
    // Copy out of the WAV view — upload/CRC must not share the zip buffer.
    const pcm =
      rate === decoded.sampleRate
        ? decoded.pcm.slice()
        : resamplePcm16(decoded.pcm.slice(), decoded.channels, decoded.sampleRate, rate)
    const frames = Math.floor(pcm.length / (2 * decoded.channels))
    framesBySlot.set(slot, frames)
    const name = (sound.label || `slot${slot}`)
      .replace(/^\d+\s+/, '')
      .replace(/\.wav$/i, '')
      .slice(0, 20)
    const meta = buildUploadMetadata({
      channels: decoded.channels,
      samplerate: rate,
      trimmed: false,
      frames,
    })
    let uploaded = false
    let lastErr
    for (let attempt = 0; attempt < 2 && !uploaded; attempt++) {
      try {
        await uploadSlot(session, slot, pcm, name, meta, (byteDone, byteTotal, phase) => {
          if (phase === 'committed') {
            onProgress(done, total, `sound ${slot} · committed`)
          } else if (
            byteDone === 0 ||
            byteDone + UPLOAD_CHUNK >= byteTotal ||
            byteDone % UPLOAD_PROGRESS_STEP < UPLOAD_CHUNK
          ) {
            onProgress(done, total, `sound ${slot} · ${formatBytes(byteDone)}/${formatBytes(byteTotal)}`)
          }
        })
        uploaded = true
      } catch (err) {
        lastErr = err
        const msg = err?.message || String(err)
        if (!/upload verification failed/i.test(msg) || attempt === 1) throw err
        onProgress(done, total, `sound ${slot} · retry after CRC miss`)
        await sleep(300)
      }
    }
    if (!uploaded) throw lastErr
    onProgress(++done, total, `sound ${slot}`)
  }

  for (const n of projList) {
    checkAbort(signal)
    const p = pack.projects.get(n)
    if (!p) continue
    onProgress(done, total, `project P${String(n).padStart(2, '0')}…`)
    const tar = patchProjectTarLengthFrames(p.bytes, framesBySlot)
    await uploadProjectTar(session, n, tar)
    onProgress(++done, total, `P${String(n).padStart(2, '0')}`)
  }

  return { sounds: slotList.length, projects: projList.length }
}

/**
 * Scan every project TAR on the device for Riddim Supertone pad assignments.
 * @returns {Promise<{ projectCount: number, padCount: number, projects: Array<{ project: number, pads: number }> }>}
 */
export async function scanDeviceSupertone(session, onProgress = () => {}) {
  const projects = await listProjects(session)
  const out = []
  let padCount = 0
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i]
    onProgress(i, projects.length, `P${String(p.project).padStart(2, '0')}`)
    let tar
    try {
      tar = await downloadProject(session, p.project)
    } catch {
      continue
    }
    const hits = scanTarForSupertone(tar)
    if (hits.length) {
      out.push({ project: p.project, pads: hits.length, engines: [...new Set(hits.map((h) => h.engine).filter((e) => e != null))] })
      padCount += hits.length
    }
  }
  return { projectCount: out.length, padCount, projects: out }
}

/**
 * Rewrite on-device projects: blank Supertone pads, clear Riddim loop mode, drop `live`.
 * Leaves sample-slot pads alone. Re-uploads each touched project with activation dance.
 */
export async function sanitizeDeviceForEp133(session, onProgress = () => {}) {
  const projects = await listProjects(session)
  const touched = []
  let padsCleared = 0
  let loopsCleared = 0
  let liveRemoved = 0
  for (let i = 0; i < projects.length; i++) {
    const p = projects[i]
    onProgress(i, projects.length, `P${String(p.project).padStart(2, '0')}…`)
    let tar
    try {
      tar = await downloadProject(session, p.project)
    } catch {
      continue
    }
    const entries = readTar(tar)
    const stats = stripSupertoneFromTarEntries(entries)
    if (!stats.padsCleared && !stats.loopsCleared && !stats.liveRemoved) continue
    const next = writeTar(entries)
    await uploadProjectTar(session, p.project, next)
    padsCleared += stats.padsCleared
    loopsCleared += stats.loopsCleared
    if (stats.liveRemoved) liveRemoved++
    touched.push(p.project)
    onProgress(i + 1, projects.length, `P${String(p.project).padStart(2, '0')} cleaned`)
  }
  return { projects: touched, padsCleared, loopsCleared, liveRemoved }
}

const UPLOAD_CHUNK = 433
const UPLOAD_PROGRESS_STEP = UPLOAD_CHUNK * 32

import {
  isTe032,
  isExperimentalSku,
  loadFirmwareCatalog,
  loadFactoryCatalog,
  parseReleasesJson,
  saveUserCatalog,
  loadUserCatalog,
  SKU_EP133,
  SKU_EP40,
  SKU_MEDIEVAL,
} from './lib/catalog.js'
import { parseTfw, rewriteSku, rewrittenFilename } from './lib/tfw.js'
import { TeDfuSession, TeError, parseDebugFrame } from './lib/midi.js'
import { flashFirmware, prepareImage } from './lib/dfu.js'
import { createBusyOverlay, diagnoseDeviceState } from './lib/overlay.js'
import {
  inspectPak,
  planThin,
  buildThinnedPak,
  formatMb,
} from './lib/pak.js'
import { findOutput, runDemoLoop, pickDemo } from './lib/demo.js'
import {
  openFileSession,
  backupDevice,
  packBackup,
  restorePakBytes,
  getStorage,
  listSlots,
  planRestoreSpace,
  roomCheck,
  scanDeviceSupertone,
  sanitizeDeviceForEp133,
  CancelledError,
} from './lib/backup.js'

const $ = (id) => document.getElementById(id)

/** Join copy lines with newlines (CSS white-space: pre-line on targets). */
function lines(...parts) {
  return parts.filter((p) => p != null && p !== '').join('\n')
}

const state = {
  /** @type {TeDfuSession | null} */
  session: null,
  /**
   * Survives DFU→FILE handoff so identity UI doesn't vanish mid-transfer.
   * @type {null | {
   *   serial: string, sku: string, product: string, mode: string, os: string,
   *   chipId: string, deviceId: number, identitySku: string,
   * }}
   */
  deviceSnapshot: null,
  /** @type {null | { maxCapacity: number, freeSpace: number }} */
  storage: null,
  fileName: '',
  bytes: null,
  info: null,
  busy: false,
  /** @type {Awaited<ReturnType<typeof loadFirmwareCatalog>>['devices']} */
  fwDevices: [],
  /** True when the product list came from a releases.json the user supplied. */
  fwFromUser: false,
  /** @type {Awaited<ReturnType<typeof inspectPak>> | null} */
  pak: null,
  pakName: '',
  /** @type {Array<{slot:number, sizeBytes:number}>} */
  occupiedSlots: [],
  /** @type {'before' | 'after'} */
  hexView: 'after',
  /** Opt-in EP-1320 Medieval experimental path (localStorage). */
  medievalExperimental: false,
  /** Set once at boot; false disables connect and shows the capability banner. */
  midiCapable: true,
  /** Serial the risk acknowledgements were checked for — swapping units clears them. */
  riskSerial: '',
  /** True while showing a localStorage profile with nothing plugged in. */
  showingRemembered: false,
  /** Serial we completed a backup for this session; gates the flash-dialog nudge. */
  backupTakenFor: '',
}

const fwLinks = $('fw-links')
const fwCatalogStatus = $('fw-catalog-status')
const factoryLinks = $('factory-links')
const factoryNote = $('factory-note')
const drop = $('drop')
const fileInput = $('file')
const downloadBtn = $('download')
const flashBtn = $('flash')
const connectBtn = $('connect')
const risk = $('risk')
const riskNor = $('risk-nor')
const riskSerial = $('risk-serial')
const medievalExp = $('medieval-exp')
const medievalWarn = $('medieval-warn')

const MEDIEVAL_EXP_KEY = 'ep-unity.medievalExperimental'

function loadMedievalExperimental() {
  try {
    return localStorage.getItem(MEDIEVAL_EXP_KEY) === '1'
  } catch {
    return false
  }
}

function setMedievalExperimental(on) {
  state.medievalExperimental = !!on
  try {
    localStorage.setItem(MEDIEVAL_EXP_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
  if (medievalExp) medievalExp.checked = state.medievalExperimental
  renderFwLinks(state.fwDevices)
  renderMedievalWarn()
  updateActions()
  refreshPreview()
}
const hexEl = $('hex')
const metaEl = $('meta')
const metaTarget = $('meta-target')
const warnEl = $('warn')
const statusEl = $('status')
const dropTitle = $('drop-title')
const dropFile = $('drop-file')
const deviceBar = $('device-bar')
const deviceLabel = $('device-label')
const deviceDot = $('device-dot')
const deviceStorage = $('device-storage')
const progress = $('progress')
const progressBar = $('progress-bar')
const progressLabel = $('progress-label')
const backupHint = $('backup-hint')
const backupBtn = $('backup-btn')
const backupStatus = $('backup-status')
const backupProgress = $('backup-progress')
const backupProgressBar = $('backup-progress-bar')
const backupProgressLabel = $('backup-progress-label')
const identityEl = $('identity')
const idSerial = $('id-serial')
const idSku = $('id-sku')
const idHwSku = $('id-hw-sku')
const idProduct = $('id-product')
const idMidi = $('id-midi')
const idSaved = $('id-saved')
const idNote = $('id-note')
const copySerialBtn = $('copy-serial')
const pakDrop = $('pak-drop')
const pakFile = $('pak-file')
const pakDropTitle = $('pak-drop-title')
const pakPanel = $('pak-panel')
const pakMeta = $('pak-meta')
const projList = $('proj-list')
const pakPlan = $('pak-plan')
const pakDownload = $('pak-download')
const pakRestore = $('pak-restore')
const pakStatus = $('pak-status')
const pakProgress = $('pak-progress')
const pakProgressBar = $('pak-progress-bar')
const pakProgressLabel = $('pak-progress-label')

const connectWarn = $('connect-warn')
const dropWarn = $('drop-warn')
const backupWarn = $('backup-warn')
const pakWarn = $('pak-warn')

/**
 * Errors used to funnel into panel 3's #warn regardless of where the user acted.
 * On a phone that panel is several screens away, so a failed connect read as
 * "nothing happened". Route each failure to the rail that owns the action.
 */
const WARN_TARGETS = {
  connect: connectWarn,
  drop: dropWarn,
  backup: backupWarn,
  pak: pakWarn,
  flash: warnEl,
}

function showError(kind, message) {
  const el = WARN_TARGETS[kind] || warnEl
  el.hidden = false
  el.textContent = message
  // Panel-3 warnings are already where the eye is during a flash; the others
  // can be off-screen from the control that triggered them.
  if (kind !== 'flash') {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
}

function clearError(kind) {
  const el = WARN_TARGETS[kind] || warnEl
  el.hidden = true
  el.textContent = ''
}

function errText(err) {
  return err?.message || String(err)
}

/** mm:ss for anything over a minute, else "45s". */
function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Rolling estimate for the long transfers. DFU sends ~235-byte chunks and waits
 * for an ACK on each, so a multi-MB image is thousands of round-trips — a bare
 * percentage gives no sense of whether it is minutes away or wedged.
 */
function createEta() {
  let startedAt = 0
  let startedAtDone = 0
  return {
    reset() {
      startedAt = 0
      startedAtDone = 0
    },
    /** @returns {string} " · ~2:10 left" once there is enough signal, else ''. */
    suffix(done, total) {
      if (!(total > 0)) return ''
      const now = performance.now()
      if (!startedAt) {
        startedAt = now
        startedAtDone = done
        return ''
      }
      const elapsed = (now - startedAt) / 1000
      const moved = done - startedAtDone
      if (elapsed < 4 || moved <= 0) return ''
      const remaining = ((total - done) / moved) * elapsed
      if (!Number.isFinite(remaining) || remaining < 2) return ''
      return ` · ~${formatDuration(remaining)} left`
    },
  }
}

const flashEta = createEta()
const transferEta = { backup: createEta(), pak: createEta() }

/**
 * Native confirm() is unstylable, unreadable on a phone, and — worst — Chrome
 * offers "prevent this page from creating additional dialogs" once you stack
 * them, which silently suppressed the *final* flash confirmation for anyone who
 * ticked it to skip an earlier prompt. One <dialog> per decision instead.
 */
function askConfirm(body, { okLabel = 'continue', title = 'confirm' } = {}) {
  const dlg = $('confirm-dialog')
  if (!dlg?.showModal) return Promise.resolve(window.confirm(body))
  $('confirm-dialog-title').textContent = title
  $('confirm-dialog-body').textContent = body
  $('confirm-dialog-go').textContent = okLabel
  dlg.showModal()
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true })
  })
}

/**
 * Everything the flash path used to ask across up to four prompts, in one place.
 * @returns {Promise<null | { stripSupertone: boolean }>} null when cancelled.
 */
function askFlashConfirm({ facts, warnings, offerStrip, needsBackupAck }) {
  const dlg = $('flash-dialog')
  const factsEl = $('flash-dialog-facts')
  const warnEls = $('flash-dialog-warnings')
  const stripRow = $('flash-dialog-strip-row')
  const stripBox = $('flash-dialog-strip')
  const backupRow = $('flash-dialog-backup-row')
  const backupBox = $('flash-dialog-backup')
  const go = $('flash-dialog-go')

  factsEl.replaceChildren()
  for (const [term, value] of facts) {
    const div = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = term
    const dd = document.createElement('dd')
    dd.textContent = value
    div.append(dt, dd)
    factsEl.append(div)
  }

  warnEls.replaceChildren()
  warnEls.hidden = !warnings.length
  for (const w of warnings) {
    const li = document.createElement('li')
    li.textContent = w
    warnEls.append(li)
  }

  stripRow.hidden = !offerStrip
  stripBox.checked = offerStrip
  backupRow.hidden = !needsBackupAck
  backupBox.checked = false

  const syncGo = () => {
    go.disabled = needsBackupAck && !backupBox.checked
  }
  syncGo()
  backupBox.onchange = syncGo

  dlg.showModal()
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        backupBox.onchange = null
        resolve(dlg.returnValue === 'flash' ? { stripSupertone: stripBox.checked } : null)
      },
      { once: true },
    )
  })
}

/** Active cancel handle for backup / restore. Flash is deliberately not cancellable. */
let currentAbort = null

const busyOverlay = createBusyOverlay()
const PROFILE_PREFIX = 'ep-unity.devices.'

/** Newest-first list of every serial this browser has seen. */
function listProfiles() {
  const out = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(PROFILE_PREFIX)) continue
      const profile = JSON.parse(localStorage.getItem(key) || 'null')
      if (profile?.serial) out.push(profile)
    }
  } catch {
    return []
  }
  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

function loadProfile(serial) {
  if (!serial) return null
  try {
    return JSON.parse(localStorage.getItem(PROFILE_PREFIX + serial) || 'null')
  } catch {
    return null
  }
}

function saveProfile(serial, patch) {
  if (!serial) return null
  const prev = loadProfile(serial) || {
    serial,
    hardwareSku: '',
    firstSeenAt: new Date().toISOString(),
  }
  const next = { ...prev, ...patch, serial, updatedAt: new Date().toISOString() }
  // hardware SKU: prefer bootloader GREET, else first-seen SKU, never overwrite with later flash SKU once set
  if (!next.hardwareSku && patch.greetSku) next.hardwareSku = patch.greetSku
  if (patch.mode === 'bootloader' && patch.greetSku) next.hardwareSku = patch.greetSku
  localStorage.setItem(PROFILE_PREFIX + serial, JSON.stringify(next))
  return next
}

function deviceSku() {
  return state.session?.device?.metadata?.sku || state.deviceSnapshot?.sku || ''
}

function isDeviceKnown() {
  return !!(state.session?.device || state.deviceSnapshot)
}

function snapshotFromDevice(d) {
  const m = d.metadata
  return {
    serial: m.serial || '',
    sku: m.sku || '',
    product: m.product || '',
    mode: m.mode || '',
    os: m.os_version || '',
    chipId: m.chip_id || '',
    deviceId: d.deviceId,
    identitySku: d.identitySku || '',
  }
}

/**
 * Wipe live FS readings only. Never touch deviceSnapshot or localStorage profiles —
 * serial / hardware SKU are the durable identity we tell people to copy.
 */
function invalidateLiveStorage() {
  state.storage = null
  state.occupiedSlots = []
  state.supertone = null
  renderStorage()
  refreshPakPlan()
  renderSupertoneWarn()
}

function isEp133Sku(sku) {
  return sku === SKU_EP133
}

function isEp40Sku(sku) {
  return sku === SKU_EP40
}

function isMedievalSku(sku) {
  return sku === SKU_MEDIEVAL || isExperimentalSku(sku)
}

function deviceMode() {
  return (
    state.session?.device?.metadata?.mode ||
    state.deviceSnapshot?.mode ||
    ''
  ).toLowerCase()
}

function isBootloader() {
  return deviceMode() === 'bootloader'
}

/** True when device or image involves Medieval without the opt-in. */
function medievalNeedsOptIn() {
  if (state.medievalExperimental) return false
  return isMedievalSku(deviceSku()) || isMedievalSku(state.info?.sku || '')
}

function renderMedievalWarn() {
  if (!medievalWarn) return
  const deviceMed = isMedievalSku(deviceSku())
  const imageMed = isMedievalSku(state.info?.sku || '')
  if (!deviceMed && !imageMed) {
    medievalWarn.hidden = true
    medievalWarn.textContent = ''
    return
  }
  medievalWarn.hidden = false
  if (!state.medievalExperimental) {
    medievalWarn.textContent = lines(
      'EP-1320 Medieval detected (device and/or image). Untested here — different KEYHASH.',
      'On EP-133/40 a Medieval image typically soft-rejects to RDY/bootloader (recoverable).',
      'Enable the experimental checkbox to flash or export wire files that involve Medieval.',
    )
  } else {
    medievalWarn.textContent = lines(
      'Medieval experimental is ON.',
      'Expect soft-rejects to RDY on non-Medieval hardware.',
      'Flashes involving EP-1320 are not validated on this tool.',
    )
  }
}

function renderSupertoneWarn() {
  const el = $('supertone-warn')
  const btn = $('supertone-sanitize')
  if (!el) return
  const s = state.supertone
  if (!s || !s.projectCount) {
    el.hidden = true
    el.textContent = ''
    if (btn) btn.hidden = true
    return
  }
  const list = s.projects
    .map((p) => `P${String(p.project).padStart(2, '0')} (${p.pads} pad${p.pads === 1 ? '' : 's'})`)
    .join(', ')
  el.hidden = false
  el.textContent = lines(
    `Supertone (EP-40 synth) found in ${s.projectCount} project${s.projectCount === 1 ? '' : 's'}: ${list}.`,
    'EP-133 has no Supertone engines — that mismatch can fault (err sound 24).',
    'Use “strip Supertone for EP-133” to blank those pads (and clear loop/live) while keeping sample pads, or SHIFT+ERASE.',
  )
  if (btn) {
    btn.hidden = false
    btn.disabled = state.busy || !isDeviceKnown()
  }
}

/**
 * Merge FILE GREET-ish info into the snapshot without clobbering stronger DFU fields
 * (chip id, bootloader mode, etc.) or blanking serial if FILE omits it.
 */
function mergeFileInfoIntoSnapshot(info, identityCode) {
  const prev = state.deviceSnapshot
  state.deviceSnapshot = {
    serial: info.serial || prev?.serial || '',
    sku: info.sku || prev?.sku || '',
    product: info.product || prev?.product || '',
    mode: prev?.mode || 'normal',
    os: info.osVersion || prev?.os || '',
    chipId: prev?.chipId || '',
    deviceId: identityCode ?? prev?.deviceId,
    identitySku: info.sku || prev?.identitySku || '',
  }
  if (state.deviceSnapshot.serial) {
    saveProfile(state.deviceSnapshot.serial, {
      greetSku: state.deviceSnapshot.sku,
      product: state.deviceSnapshot.product,
      mode: state.deviceSnapshot.mode,
      os: state.deviceSnapshot.os,
      chipId: state.deviceSnapshot.chipId,
      midiDeviceId: state.deviceSnapshot.deviceId,
      identitySku: state.deviceSnapshot.identitySku,
    })
  }
}

/**
 * Risk acknowledgements are per-unit. They used to persist across a device swap,
 * so checking all three for one board left the next board one click from a flash
 * it never consented to.
 */
function resetRiskAcks(reason) {
  if (!risk.checked && !riskNor.checked && !riskSerial.checked) return
  risk.checked = false
  riskNor.checked = false
  riskSerial.checked = false
  statusEl.textContent = reason
  updateActions()
}

function noteRiskSerial(serial) {
  if (!serial) return
  if (state.riskSerial && state.riskSerial !== serial) {
    resetRiskAcks(`different unit (${serial}) — risk acknowledgements cleared`)
  }
  state.riskSerial = serial
}

function rememberDevice(d) {
  state.deviceSnapshot = snapshotFromDevice(d)
  state.showingRemembered = false
  noteRiskSerial(state.deviceSnapshot.serial)
  const serial = state.deviceSnapshot.serial
  if (serial) {
    saveProfile(serial, {
      greetSku: state.deviceSnapshot.sku,
      product: state.deviceSnapshot.product,
      mode: state.deviceSnapshot.mode,
      os: state.deviceSnapshot.os,
      chipId: state.deviceSnapshot.chipId,
      midiDeviceId: state.deviceSnapshot.deviceId,
      identitySku: state.deviceSnapshot.identitySku,
    })
  }
}

/** @deprecated use mergeFileInfoIntoSnapshot — kept for call sites that assigned the return. */
function snapshotFromFileInfo(info, identityCode) {
  mergeFileInfoIntoSnapshot(info, identityCode)
  return state.deviceSnapshot
}

/**
 * WebMIDI is Chromium-only and requires a secure context. No iOS browser has it —
 * they are all WebKit, and Safari has never shipped it — so an iPhone user could
 * previously tap connect, get a DOMException written into panel 3 far below the
 * fold, and reasonably conclude the button was broken. Say it up front instead.
 */
function checkCapability() {
  const banner = $('capability')
  const title = $('capability-title')
  const detail = $('capability-detail')
  if (!banner) return true

  const ua = navigator.userAgent
  const isIos =
    /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const hasMidi = typeof navigator.requestMIDIAccess === 'function'
  const secure = window.isSecureContext

  if (hasMidi && secure) {
    banner.hidden = true
    return true
  }

  banner.hidden = false
  if (!secure && hasMidi) {
    banner.dataset.tone = 'warn'
    title.textContent = 'insecure origin — WebMIDI blocked'
    detail.textContent = lines(
      `This page is on ${location.protocol}//${location.host}, and browsers only expose WebMIDI over https or localhost.`,
      'Run `node web/serve.mjs` and open http://localhost:8766/ instead.',
    )
    return false
  }

  banner.dataset.tone = ''
  title.textContent = isIos ? 'iPhone and iPad cannot run this tool' : 'this browser has no WebMIDI'
  detail.textContent = isIos
    ? lines(
        'Every iOS browser — including the one called Chrome — is WebKit underneath, and Safari has never shipped WebMIDI. There is no iOS workaround.',
        'Use Chrome or Edge on a desktop, or Chrome on Android with a USB-C cable to the unit.',
      )
    : lines(
        'Flashing and backup both need WebMIDI with sysex, which today means a Chromium browser.',
        'Chrome or Edge on desktop, or Chrome on Android over USB-C. Firefox needs a per-site add-on and is untested here; Safari has no support at all.',
      )
  return false
}

async function connect() {
  if (state.busy) return
  if (!state.midiCapable) {
    $('capability')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    return
  }
  connectBtn.disabled = true
  statusEl.textContent = 'requesting WebMIDI…'
  clearError('connect')
  warnEl.hidden = true
  warnEl.textContent = ''
  // Stale free-space only — keep identity strip + localStorage profiles intact.
  invalidateLiveStorage()
  deviceStorage.hidden = false
  deviceStorage.textContent = 'refreshing free space…'
  deviceStorage.classList.remove('tight')
  setDot('busy')

  try {
    state.session?.close()
    state.session = await TeDfuSession.open()
    statusEl.textContent = 'handshake…'
    await state.session.connect()
    rememberDevice(state.session.device)
    showIdentity()
    showDevice()

    if (isBootloader()) {
      // Bootloader (screen RDY): DFU works; FILE / samples do not. Skip the probe
      // so connect doesn't look like a failure after a rejected cross-flash.
      invalidateLiveStorage()
      state.occupiedSlots = []
      state.supertone = null
      statusEl.textContent =
        'bootloader (RDY) — image was rejected; flash stock firmware to recover'
      showDevice()
      updateBackupCli()
      refreshPakPlan()
      renderSupertoneWarn()
      renderBootloaderRecovery()
      updateActions()
      refreshPreview()
      return
    }

    statusEl.textContent = 'connected — refreshing sample library…'
    // The Supertone probe downloads every project TAR, which takes seconds.
    // rememberDevice() has already enabled backup by now, so without this the
    // user could start a second FILE session on top of the probe's.
    state.busy = true
    updateBackupCli()
    try {
      releaseDfuPort()
      const fs = await openFileSession()
      try {
        mergeFileInfoIntoSnapshot(fs.info, fs.session.identityCode)
        showIdentity()
        statusEl.textContent = 'listing samples…'
        try {
          state.occupiedSlots = await listSlots(fs.session)
        } catch {
          state.occupiedSlots = []
        }
        statusEl.textContent = 'reading free space…'
        state.storage = await getStorage(fs.session)
        statusEl.textContent = 'scanning projects for Supertone…'
        try {
          state.supertone = await scanDeviceSupertone(fs.session, (done, total, label) => {
            statusEl.textContent = `scanning Supertone ${done + 1}/${Math.max(1, total)} · ${label}`
          })
        } catch (err) {
          console.warn('supertone scan failed', err)
          state.supertone = null
        }
      } finally {
        fs.close()
      }
      // Re-open DFU so flash stays one click away; rememberDevice refreshes live GREET
      // but saveProfile still preserves first-seen hardwareSku.
      state.session = await TeDfuSession.open()
      await state.session.connect()
      rememberDevice(state.session.device)
    } catch (err) {
      console.warn('storage probe failed', err)
      invalidateLiveStorage()
      statusEl.textContent = 'connected (free-space probe failed — restore will probe again)'
    } finally {
      state.busy = false
    }

    watchForUnplug()
    showDevice()
    updateBackupCli()
    refreshPakPlan()
    renderSupertoneWarn()
    renderBootloaderRecovery()
    updateActions()
    refreshPreview()

    if (state.storage) {
      const listed = (state.occupiedSlots || []).reduce((a, e) => a + (e.sizeBytes || 0), 0)
      const n = (state.occupiedSlots || []).length
      const st =
        state.supertone?.projectCount
          ? ` · Supertone in ${state.supertone.projectCount} project${state.supertone.projectCount === 1 ? '' : 's'}`
          : ''
      statusEl.textContent =
        `connected · ${formatMb(state.storage.freeSpace)} free` +
        ` · ${n} sample${n === 1 ? '' : 's'} (${formatMb(listed)} listed)` +
        st
    } else if (!statusEl.textContent.includes('probe failed')) {
      statusEl.textContent = 'connected'
    }
  } catch (err) {
    state.session = null
    // Keep deviceSnapshot so serial/copy still work after a failed reconnect attempt.
    invalidateLiveStorage()
    showDevice()
    renderBootloaderRecovery()
    showError(
      'connect',
      /permission|denied|NotAllowed/i.test(errText(err))
        ? `${errText(err)} — the browser blocked MIDI access. Click the padlock in the address bar, allow MIDI, then reconnect.`
        : errText(err),
    )
    statusEl.textContent = ''
    updateActions()
  } finally {
    connectBtn.disabled = false
    connectBtn.textContent = isDeviceKnown() ? 'reconnect' : 'connect device'
  }
}

function setDot(mode) {
  deviceDot.dataset.state = mode // off | on | busy
}

/**
 * Nothing outside the post-flash watcher listened for the cable being pulled,
 * so the dot stayed green over stale readings until the next action failed.
 */
let unplugWatched = false
function watchForUnplug() {
  const access = state.session?.access
  if (!access || unplugWatched) return
  unplugWatched = true
  access.addEventListener('statechange', (e) => {
    const port = e.port
    if (!port || port.state !== 'disconnected') return
    if (!/EP-\d+|TE032/i.test(port.name || '')) return
    if (state.busy) return // a flash reboot drops the port on purpose
    demoAbort?.abort()
    state.session?.close()
    state.session = null
    invalidateLiveStorage()
    setDot('off')
    deviceLabel.textContent = lines(
      'port gone — unit unplugged or rebooting',
      'replug, then hit reconnect',
    )
    connectBtn.textContent = 'reconnect'
    updateActions()
    updateBackupCli()
  })
}

function renderStorage() {
  if (!state.storage) {
    deviceStorage.hidden = true
    deviceStorage.textContent = ''
    return
  }
  const free = state.storage.freeSpace
  const max = state.storage.maxCapacity
  const used = Math.max(0, max - free)
  const listed = (state.occupiedSlots || []).reduce((a, e) => a + (e.sizeBytes || 0), 0)
  const n = (state.occupiedSlots || []).length
  deviceStorage.hidden = false
  // Device free_space can lag after SHIFT+ERASE until reconnect; listed sum is the
  // cross-check other tools effectively use ("how much sample data is present").
  deviceStorage.textContent = lines(
    `${formatMb(free)} free · ${formatMb(used)}/${formatMb(max)} used`,
    `${n} sample${n === 1 ? '' : 's'} (${formatMb(listed)} listed)`,
  )
  deviceStorage.classList.toggle('tight', free < 2 * 1024 * 1024)
  deviceStorage.title = lines(
    'Device-reported free space from /sounds metadata.',
    'Listed = sum of slot sizes from LIST. After SHIFT+ERASE, hit reconnect to refresh.',
  )
}

function setTransferProgress(kind, done, total, label) {
  const bar = kind === 'backup' ? backupProgressBar : pakProgressBar
  const wrap = kind === 'backup' ? backupProgress : pakProgress
  const lab = kind === 'backup' ? backupProgressLabel : pakProgressLabel
  wrap.hidden = false
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  bar.style.width = `${pct}%`
  wrap.setAttribute('aria-valuenow', String(pct))
  const eta = transferEta[kind]?.suffix(done, total) || ''
  lab.textContent = (label ? `${label} · ${pct}%` : `${pct}%`) + eta
}

function clearTransferProgress(kind) {
  const wrap = kind === 'backup' ? backupProgress : pakProgress
  const bar = kind === 'backup' ? backupProgressBar : pakProgressBar
  wrap.hidden = true
  bar.style.width = '0%'
  wrap.removeAttribute('aria-valuenow')
  transferEta[kind]?.reset()
}

/** Close DFU MIDI claim so kotu FILE can attach; keep identity snapshot visible. */
function releaseDfuPort() {
  if (state.session?.device) rememberDevice(state.session.device)
  state.session?.close()
  state.session = null
}

function productFlagFromSku(sku) {
  if (sku === SKU_EP40) return 'ep40'
  if (sku === SKU_EP133) return 'ep133'
  if (sku === SKU_MEDIEVAL) return 'ep1320'
  return ''
}

function productLabel(sku) {
  const flag = productFlagFromSku(sku)
  if (flag === 'ep40') return { short: 'EP-40', long: 'EP-40 riddim' }
  if (flag === 'ep133') return { short: 'EP-133', long: 'EP-133 k.o. II' }
  if (flag === 'ep1320') return { short: 'EP-1320', long: 'EP-1320 medieval' }
  if (sku) return { short: sku, long: sku }
  return { short: '—', long: '—' }
}

function applyTheme() {
  // Chrome follows a known unit (live or snapshot). Idle / never-connected stays neutral graphite.
  const deviceFlag = productFlagFromSku(deviceSku())
  const imageFlag = productFlagFromSku(state.info?.sku || '')
  const root = document.documentElement
  root.dataset.device = deviceFlag || ''
  root.dataset.image = imageFlag || ''
  root.dataset.mode = isBootloader() ? 'bootloader' : ''
  root.dataset.cross =
    deviceFlag && imageFlag && deviceFlag !== imageFlag ? '1' : '0'

  const brandSub = $('brand-sub')
  if (!brandSub) return
  const dLabel = productLabel(deviceSku())
  const iLabel = productLabel(state.info?.sku || '')
  if (isBootloader()) {
    brandSub.textContent = lines(
      `bootloader (RDY) · ${dLabel.long}`,
      'flash stock firmware to leave update mode',
    )
  } else if (deviceFlag === 'ep1320' && !state.medievalExperimental) {
    brandSub.textContent = lines(
      `connected ${dLabel.long}`,
      'experimental path locked (opt-in in firmware panel)',
    )
  } else if (deviceFlag && imageFlag && deviceFlag !== imageFlag) {
    brandSub.textContent = `${iLabel.long} image → flash on ${dLabel.long}`
  } else if (deviceFlag) {
    brandSub.textContent = lines(
      `connected ${dLabel.long}`,
      'chrome follows this unit',
    )
  } else if (imageFlag) {
    brandSub.textContent = lines(
      `${iLabel.long} image loaded`,
      'connect a unit to set the flash SKU',
    )
  } else {
    brandSub.textContent = lines(
      'load an image · connect a unit',
      'see the four-byte rewrite',
    )
  }
}

function stockRecoverEntry() {
  // Bootloader GREET reports the hardware SKU (AS001 after Medieval reject on EP-133).
  const greet = deviceSku()
  const recoverSku = isEp40Sku(greet) ? SKU_EP40 : SKU_EP133
  const fromCatalog = (state.fwDevices || []).find((d) => d.sku === recoverSku)
  return {
    sku: recoverSku,
    product: productLabel(recoverSku).short,
    fwUrl:
      fromCatalog?.fwUrl ||
      (recoverSku === SKU_EP40
        ? 'https://teenage.engineering/_software/ep-40/ep-40_firmware_2_5_1.tfw'
        : 'https://teenage.engineering/_software/ep-133/ep-133_firmware_2_5_1.tfw'),
    version: fromCatalog?.version || '2.5.1',
  }
}

function renderBootloaderRecovery() {
  const panel = $('bootloader-recovery')
  const copy = $('bootloader-recovery-copy')
  const manual = $('recover-manual')
  const status = $('recover-status')
  if (!panel) return
  const bl = isBootloader()
  panel.hidden = !bl
  deviceBar.dataset.mode = bl ? 'bootloader' : ''
  if (!bl) return
  const entry = stockRecoverEntry()
  if (copy) {
    copy.innerHTML =
      `GREET reports <code>mode:bootloader</code> · <code>${deviceSku() || '?'}</code> ` +
      `(screen <strong>RDY</strong>).<br>` +
      `Soft-reject after a foreign KEYHASH image is the usual story.<br>` +
      `Leave by flashing stock <strong>${entry.product}</strong> — download from TE, drop it in panel&nbsp;1, flash.`
  }
  if (manual) {
    manual.href = entry.fwUrl
    manual.textContent = `download stock ${entry.product} .tfw ↗`
  }
  if (status && !state.bytes) {
    status.textContent = `Waiting for you to drop the ${entry.product} .tfw — we will not fetch it.`
  } else if (status && state.bytes) {
    const match = state.info?.sku === entry.sku || deviceSku() === entry.sku
    status.textContent = match
      ? `${entry.product} image loaded — check risks in panel 3 and flash to leave RDY.`
      : `Loaded ${state.info?.sku || '?'} — for this board, prefer stock ${entry.sku}, then flash.`
  }
}

function focusRecoverDrop() {
  const entry = stockRecoverEntry()
  drop?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  drop?.classList.add('over')
  setTimeout(() => drop?.classList.remove('over'), 1200)
  const status = $('recover-status')
  if (status) {
    status.textContent = `Drop the ${entry.product} .tfw here (from the TE download link), then flash.`
  }
  fileInput?.click()
}

function updateRewritePanel() {
  const xform = $('xform')
  const fromProduct = $('xform-from-product')
  const fromSku = $('xform-from-sku')
  const toProduct = $('xform-to-product')
  const toSku = $('xform-to-sku')
  const verb = $('xform-verb')
  const note = $('xform-note')
  if (!xform) return

  const fileSku = state.info?.sku || ''
  const wireSku = deviceSku()
  const from = productLabel(fileSku)
  const to = productLabel(wireSku)

  fromProduct.textContent = fileSku ? from.long : '—'
  fromSku.textContent = fileSku || 'drop a .tfw'

  if (!wireSku) {
    toProduct.textContent = 'connect a device'
    toSku.textContent = 'needed for DFU_BEGIN SKU'
  } else if (fileSku && fileSku !== wireSku) {
    toProduct.textContent = `updating to flash on ${to.long}`
    toSku.textContent = wireSku
  } else {
    toProduct.textContent = `flashing on ${to.long}`
    toSku.textContent = wireSku
  }

  if (!fileSku && !wireSku) {
    xform.dataset.state = 'idle'
    verb.textContent = 'waiting'
    note.innerHTML =
      'Connect a device and load a <code>.tfw</code> to see whether the header SKU must change.'
  } else if (!fileSku) {
    xform.dataset.state = 'idle'
    verb.textContent = 'need image'
    note.textContent = `Unit is ${to.long} (${wireSku}). Drop a .tfw to preview the header rewrite.`
  } else if (!wireSku) {
    xform.dataset.state = 'idle'
    verb.textContent = 'need unit'
    note.textContent = `Image is ${from.long} (${fileSku}). Connect so we know which SKU to flash on.`
  } else if (fileSku === wireSku) {
    xform.dataset.state = 'match'
    verb.textContent = 'no rewrite'
    note.textContent = lines(
      `Header already ${wireSku}.`,
      'Flash sends the file as-is — SKU unchanged.',
    )
  } else {
    xform.dataset.state = 'rewrite'
    verb.textContent = 'rewrite 4 bytes'
    note.innerHTML =
      `On flash, only header bytes <code>15..18</code> change:<br>` +
      `<strong>${fileSku}</strong> → <strong>${wireSku}</strong>.<br>` +
      `The ${from.short} firmware is otherwise unchanged; DFU just needs a matching SKU.`
  }

  applyTheme()
}

function renderFwLinks(devices) {
  fwLinks.replaceChildren()
  const shown = (devices || []).filter((d) => {
    if (isMedievalSku(d.sku) || d.experimental) return state.medievalExperimental
    return true
  })
  for (const d of shown) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = d.fwUrl
    a.target = '_blank'
    a.rel = 'noreferrer'
    const ver = d.version ? ` ${d.version}` : ''
    const tag = d.experimental || isMedievalSku(d.sku) ? ' · experimental' : ''
    a.textContent = `download ${d.product}${ver} (${d.sku})${tag} ↗`
    li.append(a)
    fwLinks.append(li)
  }
  const hiddenMed = (devices || []).some((d) => isMedievalSku(d.sku) || d.experimental)
  const mine = loadUserCatalog()
  fwCatalogStatus.textContent = lines(
    mine
      ? `from your releases.json, saved ${mine.savedAt.slice(0, 10)}`
      : `${shown.length} product${shown.length === 1 ? '' : 's'}`,
    hiddenMed && !state.medievalExperimental
      ? 'Medieval hidden until experimental opt-in'
      : null,
  )
}

function renderFactoryLinks(packs) {
  factoryLinks.replaceChildren()
  for (const p of packs) {
    const li = document.createElement('li')
    const a = document.createElement('a')
    a.href = p.url
    a.target = '_blank'
    a.rel = 'noreferrer'
    a.textContent = `download ${p.product} factory .pak \u2197`
    li.append(a)
    factoryLinks.append(li)
  }
  factoryNote.textContent =
    'EP-133 / EP-40 only. These are links to TE — you download, then drop the .pak below.'
}

function updateBackupCli() {
  const connected = isDeviceKnown()
  backupBtn.disabled = !connected || state.busy || !state.midiCapable
  const serial = state.session?.device?.metadata?.serial || state.deviceSnapshot?.serial || ''
  backupHint.textContent = !state.midiCapable
    ? 'Needs WebMIDI — see the banner at the top of the page.'
    : connected
      ? lines(
          'Ready — backup projects + samples over WebMIDI FILE.',
          `Serial ${serial || '?'}.`,
        )
      : 'Connect a device to enable WebMIDI FILE backup.'
}

function setFileBusy(busy, { title, detail, pct, indeterminate, cancellable = false } = {}) {
  state.busy = busy
  if (busy) {
    busyOverlay.show({
      title: title || 'Working…',
      detail: detail || '',
      pct: pct ?? null,
      indeterminate: indeterminate ?? pct == null,
      // Flash is never cancellable: aborting between DFU chunks leaves a
      // half-written image. FILE transfers stop cleanly between items.
      onCancel: cancellable
        ? () => {
            currentAbort?.abort()
            busyOverlay.update({ detail: 'cancelling after the current item…' })
          }
        : null,
    })
  } else {
    busyOverlay.hide()
  }
  updateActions()
  updateBackupCli()
  refreshPakPlan()
  showDevice()
}

function bumpBusyProgress(done, total, label) {
  const pct = total > 0 ? (done / total) * 100 : 0
  busyOverlay.update({
    pct,
    detail: label || `${done}/${total}`,
    indeterminate: false,
  })
}

/**
 * After PERFORM: detach DFU, passively watch MIDI until GREET or known failure mode.
 * @param {{ medievalImage?: boolean }} [opts]
 */
async function watchFlashReturn(opts = {}) {
  const access = state.session?.access
  releaseDfuPort()
  showDevice()

  if (!access) {
    busyOverlay.finish(
      diagnoseDeviceState({
        timedOut: true,
        medievalImage: !!opts.medievalImage,
      }),
    )
    return
  }

  busyOverlay.update({
    title: 'Waiting for reboot…',
    detail: 'Listening for MIDI ports, GREET, and debug spam. Page stays locked until we know the state.',
    indeterminate: true,
  })

  const diagnosis = await busyOverlay.watchAfterFlash({
    access,
    medievalImage: !!opts.medievalImage,
    parseDebug: parseDebugFrame,
    onTick: ({ inputs, outputs }) => {
      if (!inputs || !outputs) {
        busyOverlay.update({
          detail: 'Port gone — waiting for the unit to come back…',
          indeterminate: true,
        })
      } else {
        busyOverlay.update({
          detail: `Port up (${inputs} in / ${outputs} out) — probing GREET / debug…`,
          indeterminate: true,
        })
      }
    },
    tryConnect: async (midiAccess) => {
      const session = new TeDfuSession(midiAccess)
      try {
        const device = await session.connect()
        rememberDevice(device)
        state.session = session
        showIdentity()
        showDevice()
        updateActions()
        return {
          mode: device.metadata.mode,
          sku: device.metadata.sku,
          product: device.metadata.product,
          os: device.metadata.os_version || device.metadata.sw_version,
          serial: device.metadata.serial,
        }
      } catch {
        session.close()
        return null
      }
    },
  })

  busyOverlay.finish(diagnosis)
  state.busy = true // stay locked until dismiss
  renderBootloaderRecovery()
  showDevice()
  updateActions()
}

window.addEventListener('beforeunload', (e) => {
  if (!state.busy) return
  e.preventDefault()
  // Chrome requires returnValue to be set to show the native leave dialog.
  e.returnValue = ''
})

/**
 * Profiles were written on every connect and never read back at boot, so the
 * "write down your serial" advice was unfollowable from a cold page load — the
 * serial was sitting in localStorage the whole time. Show the newest one until
 * a real device answers.
 */
function showRememberedDevice() {
  if (isDeviceKnown()) return false
  const profile = listProfiles()[0]
  if (!profile) return false
  state.showingRemembered = true
  identityEl.hidden = false
  identityEl.dataset.remembered = '1'
  idSerial.textContent = profile.serial
  idSku.textContent = profile.greetSku || '—'
  idHwSku.textContent = profile.hardwareSku || profile.greetSku || '—'
  idProduct.textContent = `${profile.product || '?'} · ${profile.mode || '?'} · os ${profile.os || '?'}`
  idMidi.textContent =
    typeof profile.midiDeviceId === 'number'
      ? `0x${profile.midiDeviceId.toString(16)} (${profile.midiDeviceId})`
      : '—'
  idSaved.textContent = lines(
    profile.updatedAt ? `last seen ${profile.updatedAt.slice(0, 10)}` : 'remembered',
    '(not a backup)',
  )
  idNote.textContent = lines(
    'Remembered from this browser — nothing is connected right now.',
    'Copy the serial while you can; connect to refresh everything else.',
  )
  copySerialBtn.disabled = false
  return true
}

function showIdentity() {
  const d = state.session?.device
  const snap = d
    ? snapshotFromDevice(d)
    : state.deviceSnapshot
  if (!snap) {
    if (showRememberedDevice()) return
    identityEl.hidden = true
    delete identityEl.dataset.remembered
    copySerialBtn.disabled = true
    return
  }
  state.showingRemembered = false
  delete identityEl.dataset.remembered
  const serial = snap.serial || ''
  const profile = saveProfile(serial, {
    greetSku: snap.sku,
    product: snap.product,
    mode: snap.mode,
    os: snap.os,
    chipId: snap.chipId,
    midiDeviceId: snap.deviceId,
    identitySku: snap.identitySku,
  })
  identityEl.hidden = false
  idSerial.textContent = serial || '(no serial in GREET — unusual)'
  idSku.textContent = snap.sku || '—'
  idHwSku.textContent = profile?.hardwareSku || snap.sku || '—'
  idProduct.textContent = `${snap.product || '?'} · ${snap.mode || '?'} · os ${snap.os || '?'}`
  idMidi.textContent =
    typeof snap.deviceId === 'number'
      ? lines(
          `0x${snap.deviceId.toString(16)} (${snap.deviceId})`,
          'follows current firmware product byte',
        )
      : '—'
  idSaved.textContent = profile?.firstSeenAt
    ? lines(
        `remembers serial since ${profile.firstSeenAt.slice(0, 10)}`,
        '(not a backup)',
      )
    : '—'
  idNote.textContent =
    profile?.hardwareSku && profile.hardwareSku !== snap.sku
      ? lines(
          `Note: hardware SKU ${profile.hardwareSku} ≠ current GREET ${snap.sku} — expected after cross-flash.`,
          'Trust serial + hardware SKU for which board this is.',
        )
      : lines(
          'Serial + hardware SKU survive OS swaps; GREET product/SKU describe the image currently running.',
          '“This browser” is only a localStorage note in Chrome — it is not a sample/project backup.',
        )
  copySerialBtn.disabled = !serial
}

async function copySerial() {
  const serial =
    state.session?.device?.metadata?.serial ||
    state.deviceSnapshot?.serial ||
    (state.showingRemembered ? idSerial.textContent : '')
  if (!serial) return
  try {
    await navigator.clipboard.writeText(serial)
    statusEl.textContent = `copied serial ${serial}`
  } catch {
    statusEl.textContent = `serial: ${serial} (clipboard blocked — copy from the identity card)`
  }
}

function formatSize(n) {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

function hexColsForWidth(px) {
  if (px >= 520) return 16
  if (px >= 280) return 8
  return 4
}

function hexDump(header, { highlight = null, cols = 8 } = {}) {
  const rows = []
  for (let off = 0; off < header.length; off += cols) {
    const addr = off.toString(16).padStart(4, '0')
    const cells = []
    for (let i = 0; i < cols && off + i < header.length; i++) {
      const idx = off + i
      const b = header[idx].toString(16).padStart(2, '0')
      if (highlight?.has(idx)) {
        cells.push(`<span class="hi ch">${b}</span>`)
      } else {
        cells.push(`<span>${b}</span>`)
      }
    }
    rows.push(
      `<div class="hex-row"><span class="hex-addr">${addr}</span>` +
        `<span class="hex-bytes">${cells.join('')}</span></div>`,
    )
  }
  return rows.join('')
}

/** Byte indices that differ between two equal-length headers (SKU is 15..18). */
function changedBytes(a, b) {
  const set = new Set()
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) set.add(i)
  }
  return set
}

function setHexView(view) {
  state.hexView = view === 'before' ? 'before' : 'after'
  renderHex()
}

function renderHex() {
  const toolbar = $('hex-toolbar')
  const beforeBtn = $('hex-before')
  const afterBtn = $('hex-after')
  if (!state.bytes || !state.info) {
    if (toolbar) toolbar.hidden = true
    hexEl.textContent = 'waiting for a file…'
    hexEl.style.removeProperty('--hex-cols')
    return
  }

  const sku = deviceSku()
  const before = state.bytes.subarray(0, 64)
  const after = sku ? rewriteSku(state.bytes, sku).subarray(0, 64) : before
  const diff = sku ? changedBytes(before, after) : new Set([15, 16, 17, 18])
  const canToggle = !!(sku && diff.size > 0)

  if (toolbar) toolbar.hidden = false
  if (beforeBtn && afterBtn) {
    beforeBtn.disabled = !canToggle
    afterBtn.disabled = false
    if (!canToggle) state.hexView = 'after'
    beforeBtn.setAttribute('aria-pressed', state.hexView === 'before' ? 'true' : 'false')
    afterBtn.setAttribute('aria-pressed', state.hexView === 'after' ? 'true' : 'false')
  }

  const cols = hexColsForWidth(hexEl.clientWidth || hexEl.parentElement?.clientWidth || 320)
  hexEl.style.setProperty('--hex-cols', String(cols))
  const showing = state.hexView === 'before' && canToggle ? before : after
  hexEl.innerHTML = hexDump(showing, { highlight: diff.size ? diff : null, cols })
  hexEl.dataset.view = state.hexView === 'before' && canToggle ? 'before' : 'after'
  hexEl.dataset.cols = String(cols)

  // The grid is 64 individual spans — a screen reader reads it byte by byte and
  // the change is signalled by colour alone. Hide it and state the diff instead.
  hexEl.setAttribute('aria-hidden', 'true')
  const summary = $('hex-summary')
  if (summary) {
    const changed = [...diff].sort((a, b) => a - b)
    const hex = (arr, i) => arr[i].toString(16).padStart(2, '0')
    summary.textContent = changed.length
      ? `Header bytes ${changed[0]}–${changed[changed.length - 1]} change: ` +
        `${changed.map((i) => hex(before, i)).join(' ')} becomes ` +
        `${changed.map((i) => hex(after, i)).join(' ')}.`
      : 'Header SKU already matches the connected unit — no bytes change.'
  }
}

function setMeta(info) {
  const dds = metaEl.querySelectorAll('dd')
  const sku = deviceSku()
  if (!info) {
    dds[0].textContent = '—'
    dds[1].textContent = '—'
    dds[2].textContent = '—'
    metaTarget.textContent = sku || 'connect a device'
    return
  }
  dds[0].textContent = info.sku
  dds[1].textContent = info.version
  dds[2].textContent = formatSize(info.size)
  metaTarget.textContent = sku || 'connect a device'
}

function updateActions() {
  const medBlocked = medievalNeedsOptIn()
  const ready = !!(
    state.bytes &&
    state.session?.device &&
    risk.checked &&
    riskNor.checked &&
    riskSerial.checked &&
    !state.busy &&
    !medBlocked
  )
  flashBtn.disabled = !ready
  downloadBtn.disabled = !(state.bytes && deviceSku() && !state.busy && !medBlocked)

  const sku = deviceSku()
  const fileSku = state.info?.sku || ''
  if (ready && fileSku && sku) {
    flashBtn.textContent =
      fileSku === sku
        ? `flash ${productLabel(sku).short} (SKU matches)`
        : `flash ${productLabel(fileSku).short} as ${sku}`
  } else {
    flashBtn.textContent = 'flash on device'
  }

  const hint = $('flash-hint')
  if (!hint) return
  if (isBootloader() && !state.bytes) {
    hint.textContent = lines(
      'Bootloader (RDY): download stock .tfw from the recovery banner (TE link),',
      'drop it, then flash.',
    )
  } else if (medBlocked) {
    hint.textContent = lines(
      'Medieval involved — enable experimental support in the firmware panel',
      'before flash or wire export.',
    )
  } else if (!state.bytes) {
    hint.textContent = lines(
      'Load a TE032 .tfw (EP-133 / EP-40; Medieval after opt-in).',
      'Panel 2 shows the SKU transform.',
    )
  } else if (!state.session?.device) {
    hint.textContent = 'Connect a device so panel 2 can show the SKU the rewrite will target.'
  } else if (!risk.checked || !riskNor.checked || !riskSerial.checked) {
    hint.textContent = isBootloader()
      ? lines(
          'Bootloader (RDY): check the risks and flash the stock .tfw you dropped —',
          'that leaves update mode.',
        )
      : lines(
          'Check the risk boxes, then flash.',
          'Wire .tfw export is optional archive only.',
        )
  } else if (state.supertone?.projectCount && isEp133Sku(deviceSku())) {
    hint.textContent = lines(
      `Ready — but ${state.supertone.projectCount} project(s) still have Supertone pads.`,
      'Prefer SHIFT+ERASE before EP-133 flash.',
    )
  } else {
    const match = fileSku === sku
    hint.textContent = match
      ? `Ready — file SKU already ${sku}; flash sends as-is.`
      : lines(
          `Ready — header SKU will be ${fileSku} → ${sku} (four bytes).`,
          'Firmware otherwise unchanged.',
        )
  }
  renderMedievalWarn()
}

function refreshPreview() {
  clearError('flash')
  clearError('drop')

  if (!state.bytes || !state.info) {
    renderHex()
    setMeta(null)
    updateRewritePanel()
    updateActions()
    return
  }

  const sku = deviceSku()
  renderHex()
  if (sku) {
    statusEl.textContent =
      state.info.sku === sku
        ? `SKU already ${sku} — flashing as-is`
        : `header preview: ${state.info.sku} → ${sku} · toggle before/after (bytes 15–18)`
  } else {
    statusEl.textContent = 'connect a device to preview the rewritten flash header'
  }

  setMeta(state.info)
  updateRewritePanel()
  renderBootloaderRecovery()

  if (!isTe032(state.info.sku)) {
    showError(
      'drop',
      `Source SKU ${state.info.sku} is not TE032-family. Abort unless you know what you are doing.`,
    )
  }

  updateActions()
}

function showDevice() {
  deviceBar.hidden = false
  const d = state.session?.device
  const snap = state.deviceSnapshot
  if (state.busy) {
    const serial = d?.metadata?.serial || snap?.serial || '?'
    deviceLabel.textContent = `transferring · serial ${serial}`
    setDot('busy')
    showIdentity()
    updateBackupCli()
    refreshPakPlan()
    renderStorage()
    renderSupertoneWarn()
    renderBootloaderRecovery()
    refreshPreview()
    return
  }
  if (!d && !snap) {
    deviceLabel.textContent = state.midiCapable ? 'not connected' : 'WebMIDI unavailable in this browser'
    if (state.midiCapable) connectBtn.textContent = 'connect device'
    setDot('off')
    showIdentity()
    updateBackupCli()
    refreshPakPlan()
    renderStorage()
    renderSupertoneWarn()
    renderBootloaderRecovery()
    refreshPreview()
    return
  }
  if (d) {
    const m = d.metadata
    const modeBit =
      m.mode === 'bootloader' ? 'bootloader (RDY)' : m.mode || '?'
    deviceLabel.textContent = lines(
      `serial ${m.serial || '?'} · ${m.product || 'EP'} · ${m.sku}`,
      `os ${m.os_version} · ${modeBit}`,
    )
  } else {
    const modeBit =
      snap.mode === 'bootloader' ? 'bootloader (RDY)' : snap.mode || '?'
    deviceLabel.textContent = lines(
      `serial ${snap.serial || '?'} · ${snap.product || 'EP'} · ${snap.sku}`,
      `os ${snap.os} · ${modeBit}`,
      state.session ? '' : 'FILE/DFU idle — reconnect before flash if needed',
    )
  }
  if (state.midiCapable) connectBtn.textContent = 'reconnect'
  setDot('on')
  showIdentity()
  updateBackupCli()
  refreshPakPlan()
  renderStorage()
  renderSupertoneWarn()
  renderBootloaderRecovery()
  renderDemos()
  refreshPreview()
}

/**
 * Import a releases.json the user downloaded from TE themselves. Nothing here
 * contacts teenage.engineering — a hosted copy of this tool must not poll them.
 */
async function loadReleasesJson(file) {
  try {
    const devices = parseReleasesJson(JSON.parse(await file.text()))
    saveUserCatalog(devices)
    state.fwDevices = devices
    state.fwFromUser = true
    renderFwLinks(devices)
    clearError('drop')
    statusEl.textContent = `catalog updated from ${file.name} — ${devices.length} entries`
    updateActions()
  } catch (err) {
    showError('drop', `could not read ${file.name} as TE releases.json: ${errText(err)}`)
  }
}

async function loadFile(file) {
  // The panel-1 input takes releases.json too — same "you fetch it from TE, we
  // only parse it" rule the .tfw follows.
  if (/\.json$/i.test(file.name)) return loadReleasesJson(file)
  statusEl.textContent = 'reading…'
  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    const info = parseTfw(buf)
    state.bytes = buf
    state.info = info
    state.fileName = file.name
    dropTitle.textContent = 'firmware loaded'
    dropFile.hidden = false
    dropFile.textContent = file.name
    dropFile.title = file.name
    statusEl.textContent = `loaded ${file.name}`
    refreshPreview()
  } catch (err) {
    state.bytes = null
    state.info = null
    state.fileName = ''
    dropTitle.textContent = 'drop a .tfw'
    dropFile.hidden = true
    dropFile.textContent = ''
    hexEl.textContent = 'waiting for a file…'
    setMeta(null)
    showError('drop', errText(err))
    statusEl.textContent = ''
    updateRewritePanel()
    updateActions()
  }
}

function downloadRewritten() {
  const sku = deviceSku()
  if (!state.bytes || !sku) return
  if (medievalNeedsOptIn()) {
    showError('flash', 'Enable Medieval experimental support before exporting a wire .tfw that involves EP-1320.')
    return
  }
  const out = rewriteSku(state.bytes, sku)
  const name = rewrittenFilename(state.fileName, sku)
  const url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
  statusEl.textContent = `saved ${name}`
}

async function runSupertoneSanitize({ resumeSession = false } = {}) {
  if (!isDeviceKnown()) {
    showError('flash', 'Connect the device first.')
    return false
  }
  if (
    !(await askConfirm(
      'Strip Riddim-only data from on-device projects?\n\n' +
        '• Supertone pads → empty (unassigned)\n' +
        '• Loop play-mode → oneshot\n' +
        '• Drop project “live” member\n\n' +
        'Sample pads and patterns stay. Back up first if you care about the synth parts.',
      { title: 'strip Supertone', okLabel: 'strip' },
    ))
  ) {
    statusEl.textContent = 'sanitize cancelled'
    return false
  }

  setFileBusy(true, {
    title: 'Stripping Supertone…',
    detail: 'FILE session — do not flash or reload until this finishes.',
    indeterminate: true,
  })
  let fileSession
  try {
    releaseDfuPort()
    showDevice()
    statusEl.textContent = 'opening FILE to strip Supertone…'
    fileSession = await openFileSession()
    mergeFileInfoIntoSnapshot(fileSession.info, fileSession.session.identityCode)
    const result = await sanitizeDeviceForEp133(fileSession.session, (done, total, label) => {
      bumpBusyProgress(done, total, label)
      statusEl.textContent = `sanitize ${done}/${total} · ${label}`
    })
    state.supertone = await scanDeviceSupertone(fileSession.session)
    renderSupertoneWarn()
    statusEl.textContent =
      `sanitize done — cleared ${result.padsCleared} Supertone pad(s), ` +
      `${result.loopsCleared} loop mode(s), live removed from ${result.liveRemoved} project(s)` +
      (result.projects.length
        ? ` · touched ${result.projects.map((n) => `P${String(n).padStart(2, '0')}`).join(', ')}`
        : ' · nothing to change')
    return true
  } catch (err) {
    showError('flash', errText(err))
    statusEl.textContent = 'sanitize failed'
    return false
  } finally {
    fileSession?.close()
    setFileBusy(false)
    if (resumeSession) {
      try {
        state.session = await TeDfuSession.open()
        await state.session.connect()
        rememberDevice(state.session.device)
      } catch (err) {
        console.warn('DFU re-open after sanitize failed', err)
      }
    }
    showDevice()
    updateActions()
  }
}

async function flash() {
  if (
    !state.bytes ||
    !state.session?.device ||
    !risk.checked ||
    !riskNor.checked ||
    !riskSerial.checked
  ) {
    return
  }
  if (medievalNeedsOptIn()) {
    showError('flash', 'Medieval experimental support is off. Enable the checkbox if you really want to proceed.')
    return
  }
  const sku = deviceSku()
  const prepared = prepareImage(state.bytes, sku)
  const from = prepared.fromSku || prepared.info.sku
  const serial = state.session.device.metadata.serial || '(unknown serial)'
  const targetSku = prepared.info.sku
  const product = state.session.device.metadata.product || state.deviceSnapshot?.product || ''

  const supertoneHit = isEp133Sku(targetSku) && state.supertone?.projectCount
  const warnings = []

  if (isMedievalSku(from) || isMedievalSku(targetSku)) {
    warnings.push(
      'MEDIEVAL EXPERIMENTAL — different KEYHASH, no factory-pack story, unknown NOR layout. ' +
        'This path is untested in ep-unity and can brick or soft-brick the unit.',
    )
  }
  if (supertoneHit) {
    const list = state.supertone.projects
      .map((p) => `P${String(p.project).padStart(2, '0')}`)
      .join(', ')
    warnings.push(
      `Supertone pads still on device in ${state.supertone.projectCount} project(s): ${list}. ` +
        'EP-133 has no Supertone engines — that mismatch is the usual source of err sound 24. ' +
        'SHIFT+ERASE after reboot is the nuclear alternative to stripping.',
    )
  } else if (isEp40Sku(from) && isEp133Sku(targetSku)) {
    warnings.push(
      `Cross-flashing a Riddim image onto an EP-133 SKU (${from} → ${targetSku}). ` +
        'Any Riddim/Supertone projects left on NOR can fault (err sound 24).',
    )
  } else if (/EP-40/i.test(product) && isEp133Sku(targetSku) && !state.supertone) {
    warnings.push(
      'GREET says EP-40 but the Supertone scan did not run or found nothing. ' +
        'If projects still hold Riddim synth pads, EP-133 OS can fault after flash.',
    )
  }

  // The tool knows whether a backup happened; nagging for one is cheap and the
  // failure it prevents (SHIFT+ERASE with no .pak) is not recoverable.
  const profile = loadProfile(serial)
  const backedUpThisSession = state.backupTakenFor === serial
  const needsBackupAck = !backedUpThisSession
  if (needsBackupAck) {
    warnings.push(
      profile?.lastBackupAt
        ? `Last backup from this browser: ${profile.lastBackupAt.slice(0, 10)}. Nothing backed up this session — recovery here is SHIFT+ERASE, which wipes the sound store.`
        : 'No backup has ever been taken from this browser for this serial. Recovery here is SHIFT+ERASE, which wipes the sound store.',
    )
  }

  const answer = await askFlashConfirm({
    facts: [
      ['serial', serial],
      ['file', state.fileName || 'firmware'],
      ['image', `${from} ${prepared.info.version}`],
      [
        'DFU_BEGIN sku',
        prepared.rewritten ? `${targetSku} (header rewritten from ${from})` : `${targetSku} (already matched)`,
      ],
    ],
    warnings,
    offerStrip: !!supertoneHit,
    needsBackupAck,
  })
  if (!answer) {
    statusEl.textContent = 'flash cancelled'
    return
  }
  if (supertoneHit && answer.stripSupertone) {
    const cleaned = await runSupertoneSanitize({ resumeSession: true })
    if (!cleaned) return
  }

  const medievalImage = isMedievalSku(from) || isMedievalSku(targetSku)
  state.busy = true
  updateActions()
  flashEta.reset()
  progress.hidden = false
  progressBar.style.width = '0%'
  progress.setAttribute('aria-valuenow', '0')
  progressLabel.textContent = 'starting'
  warnEl.hidden = true
  busyOverlay.show({
    title: 'Flashing firmware…',
    detail: `${from} → ${targetSku} · serial ${serial}`,
    pct: 0,
  })

  try {
    await flashFirmware(state.session, prepared.bytes, {
      onProgress: ({ pct, step }) => {
        const eta = flashEta.suffix(pct, 100)
        const line = `${step} · ${pct}%${eta}`
        progressBar.style.width = `${Math.min(100, pct)}%`
        progress.setAttribute('aria-valuenow', String(Math.min(100, pct)))
        progressLabel.textContent = line
        statusEl.textContent = line
        busyOverlay.update({ pct, detail: line, indeterminate: false })
      },
    })
    statusEl.textContent = 'flash complete — watching for reboot…'
    progressLabel.textContent = 'done'
    // Consent was for this flash. Make the next one re-acknowledge.
    risk.checked = false
    riskNor.checked = false
    riskSerial.checked = false
    await watchFlashReturn({ medievalImage })
  } catch (err) {
    showError('flash', errText(err))
    statusEl.textContent = ''
    const bootloaderHop = err instanceof TeError && /bootloader/i.test(err.message)
    if (bootloaderHop) {
      statusEl.textContent = 'Device rebooting into bootloader — watching…'
      await watchFlashReturn({ medievalImage })
    } else {
      busyOverlay.finish({
        kind: 'error',
        title: 'flash failed',
        detail: err.message || String(err),
        steps: [
          'Check the USB cable / port, then Connect and try again.',
          'RDY on screen → recovery banner (download stock .tfw → drop → flash).',
          'ERR SOUND … → SHIFT+ERASE on power-on, then Connect.',
        ],
      })
      state.busy = true
    }
  } finally {
    // busy stays true while diagnosis overlay is up; dismiss clears it
    if (!busyOverlay.visible) {
      state.busy = false
    }
    updateActions()
  }
}

function selectedProjects() {
  return [...projList.querySelectorAll('input[type=checkbox]:checked')].map((el) =>
    Number(el.value),
  )
}

function refreshPakPlan() {
  if (!state.pak) return
  const nums = selectedProjects()
  if (!nums.length) {
    pakPlan.textContent = 'select projects to see sample/MB estimate'
    pakDownload.disabled = true
    pakRestore.disabled = true
    return
  }
  const plan = planThin(state.pak, nums)
  const space = planRestoreSpace(state.pak.sounds, plan.slots, state.occupiedSlots || [])
  // OS 2.5+: on-device ≈ pack WAV (keep ≤46875). Only oversize rates downsample.
  let fitNote = ''
  if (state.storage) {
    const available = state.storage.freeSpace + space.reclaimed
    fitNote =
      space.needed <= available
        ? ` · fits (${formatMb(available)} available` +
          (space.reclaimed ? ` incl. ${formatMb(space.reclaimed)} overwrite reclaim` : '') +
          `)`
        : ` · WILL NOT FIT (only ${formatMb(available)} available` +
          (space.reclaimed ? ` incl. reclaim` : '') +
          `)`
  } else if (isDeviceKnown()) {
    fitNote = ' · free space unknown — restore will probe on click'
  } else {
    fitNote = ' · connect device to restore (or click restore and you’ll be prompted)'
  }
  const norWarn =
    space.needed > 50 * 1024 * 1024
      ? ' — caution: may be tight on 64 MiB NOR'
      : ''
  const packNote =
    Math.abs(space.needed - plan.wavBytes) > 64 * 1024
      ? ` (pack files ${formatMb(plan.wavBytes)})`
      : ''
  pakPlan.textContent = lines(
    `${plan.projects.length} projects → ${plan.slots.length} samples / ${formatMb(space.needed)} on-device` +
      packNote,
    (fitNote + norWarn).replace(/^ · /, '') || null,
    plan.missingSlots.length ? `${plan.missingSlots.length} slots missing from pack` : null,
  )
  const ok = plan.projects.length > 0 && !state.busy
  pakDownload.disabled = !ok
  // Keep restore clickable whenever a selection exists — grey-on-space/device
  // looked "permanently broken". Click path explains connect / space failures.
  pakRestore.disabled = !ok
  if (!ok) {
    pakRestore.removeAttribute('title')
  } else if (!isDeviceKnown()) {
    pakRestore.title = 'Click to restore — you’ll be asked to connect first'
  } else if (state.storage && space.needed > state.storage.freeSpace + space.reclaimed) {
    pakRestore.title =
      'Selection may not fit current free space — click for details / try anyway after freeing samples'
  } else {
    pakRestore.title = 'Upload selected projects + samples over WebMIDI FILE'
  }
}

/** @type {AudioContext | null} */
let audioCtx = null
/** @type {AudioBufferSourceNode | null} */
let playingNode = null

function stopPreview() {
  try {
    playingNode?.stop()
  } catch {
    /* already ended */
  }
  playingNode = null
  for (const b of document.querySelectorAll('.smp-play[data-playing="1"]')) {
    delete b.dataset.playing
    b.textContent = '▶'
  }
}

function getAudioCtx() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}

/**
 * Decode only. Resuming the context needs a user gesture, so waveform drawing —
 * which happens on render, not on click — must never wait for it.
 */
async function decodeSound(bytes) {
  // decodeAudioData detaches the buffer it is given — never hand it the pak's.
  return getAudioCtx().decodeAudioData(bytes.slice().buffer)
}

async function playSound(bytes, btn) {
  const wasPlaying = btn.dataset.playing === '1'
  stopPreview()
  if (wasPlaying) return
  try {
    const ctx = getAudioCtx()
    if (ctx.state === 'suspended') await ctx.resume()
    const buffer = await decodeSound(bytes)
    const node = audioCtx.createBufferSource()
    node.buffer = buffer
    node.connect(audioCtx.destination)
    node.onended = () => {
      if (playingNode === node) stopPreview()
    }
    node.start()
    playingNode = node
    btn.dataset.playing = '1'
    btn.textContent = '■'
  } catch (err) {
    showError('pak', `could not decode that sample: ${errText(err)}`)
  }
}

async function drawWaveform(canvas, bytes) {
  if (canvas.dataset.drawn) return
  let buffer
  try {
    buffer = await decodeSound(bytes)
  } catch (err) {
    // Marking drawn only on success means a transient failure can retry, and
    // logging means it is not silently a blank box forever.
    console.warn('waveform decode failed', err)
    return
  }
  canvas.dataset.drawn = '1'
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  const data = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(data.length / w))
  ctx.fillStyle = getComputedStyle(canvas).color
  for (let x = 0; x < w; x++) {
    let min = 1
    let max = -1
    for (let i = x * step; i < (x + 1) * step && i < data.length; i++) {
      if (data[i] < min) min = data[i]
      if (data[i] > max) max = data[i]
    }
    const y0 = ((1 - max) / 2) * h
    const y1 = ((1 - min) / 2) * h
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0))
  }
}

/** Sample labels a project's pads point at — the closest thing to a project name. */
function projectSampleLabels(n) {
  const plan = planThin(state.pak, [n])
  return plan.slots
    .map((slot) => state.pak.sounds.get(slot)?.label || `slot ${slot}`)
    .map((l) => l.replace(/\.(wav|pcm)$/i, ''))
}

async function renderProjectList() {
  stopPreview()
  projList.replaceChildren()
  if (!state.pak) return
  const nums = [...state.pak.projects.keys()].sort((a, b) => a - b)
  for (const n of nums) {
    const alone = planThin(state.pak, [n])
    const aloneSpace = planRestoreSpace(state.pak.sounds, alone.slots, [])
    const labels = projectSampleLabels(n)

    const row = document.createElement('div')
    row.className = 'proj-row'

    const label = document.createElement('label')
    label.className = 'proj-opt'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = String(n)
    cb.addEventListener('change', refreshPakPlan)
    const pn = document.createElement('span')
    pn.className = 'pn'
    pn.textContent = `P${String(n).padStart(2, '0')}`
    const title = document.createElement('span')
    title.className = 'proj-title'
    // The old label was the literal word "project" for every row, which told
    // you nothing about which one to keep. Its samples do.
    title.textContent = labels.length
      ? labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3}` : '')
      : 'no sample pads'
    title.title = labels.join(', ')
    const ps = document.createElement('span')
    ps.className = 'ps'
    ps.textContent = `${alone.slots.length} smp · ${formatMb(aloneSpace.needed)} on-dev`
    label.append(cb, pn, title, ps)
    row.append(label)

    if (alone.slots.length) {
      const details = document.createElement('details')
      details.className = 'proj-samples'
      const summary = document.createElement('summary')
      summary.textContent = `listen · ${alone.slots.length} sample${alone.slots.length === 1 ? '' : 's'}`
      details.append(summary)
      const list = document.createElement('div')
      list.className = 'smp-list'
      details.append(list)
      // Build rows lazily — a full factory pack is hundreds of canvases.
      details.addEventListener(
        'toggle',
        () => {
          if (!details.open || list.childElementCount) return
          for (const slot of alone.slots) {
            const sound = state.pak.sounds.get(slot)
            if (!sound) continue
            const item = document.createElement('div')
            item.className = 'smp'
            const play = document.createElement('button')
            play.type = 'button'
            play.className = 'smp-play'
            play.textContent = '▶'
            play.setAttribute('aria-label', `play ${sound.label || `slot ${slot}`}`)
            play.addEventListener('click', () => void playSound(sound.bytes, play))
            const name = document.createElement('span')
            name.className = 'smp-name'
            name.textContent = `${String(slot).padStart(3, '0')} ${(sound.label || '').replace(/\.(wav|pcm)$/i, '')}`
            const canvas = document.createElement('canvas')
            canvas.className = 'smp-wave'
            canvas.setAttribute('aria-hidden', 'true')
            const size = document.createElement('span')
            size.className = 'smp-size'
            size.textContent = formatMb(sound.size)
            item.append(play, name, canvas, size)
            list.append(item)
            // Direct call, not rAF: the canvas already has layout inside the
            // open <details>, and rAF does not fire at all in a hidden tab.
            void drawWaveform(canvas, sound.bytes)
          }
        },
        { once: false },
      )
      row.append(details)
    }

    projList.append(row)
  }
  refreshPakPlan()
}

async function loadPak(file) {
  clearError('pak')
  pakDropTitle.textContent = 'reading…'
  pakStatus.textContent = ''
  try {
    const buf = await file.arrayBuffer()
    state.pak = await inspectPak(buf)
    state.pakName = file.name
    pakDropTitle.textContent = file.name
    pakPanel.hidden = false
    const sku = state.pak.meta?.device_sku || state.pak.meta?.base_sku || '?'
    const ptype = state.pak.meta?.pak_type || '?'
    pakMeta.textContent =
      `${state.pak.projects.size} projects · ${state.pak.sounds.size} sounds · ` +
      `sku ${sku} · type ${ptype}`
    await renderProjectList()
  } catch (err) {
    state.pak = null
    pakPanel.hidden = true
    pakDropTitle.textContent = 'drop a factory .pak'
    showError('pak', errText(err))
  }
}

async function downloadThinned() {
  if (!state.pak) return
  const nums = selectedProjects()
  if (!nums.length) return
  clearError('pak')
  try {
    pakStatus.textContent = 'building thinned .pak…'
    const { bytes, plan } = await buildThinnedPak(state.pak, nums)
    const tag = plan.projects.map((n) => `P${String(n).padStart(2, '0')}`).join('-')
    const name = state.pakName.replace(/\.p?pak$/i, '') + `-thinned-${tag}.pak`
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: name })
    a.click()
    URL.revokeObjectURL(url)
    pakStatus.textContent = `saved ${name} · ${plan.slots.length} samples / ${formatMb(plan.wavBytes)}`
  } catch (err) {
    showError('pak', errText(err))
    pakStatus.textContent = ''
  }
}

async function restoreThinned() {
  const nums = selectedProjects()
  if (!state.pak || !nums.length) return
  clearError('pak')

  if (!isDeviceKnown()) {
    showError('pak', 'Connect the device first (top bar), then hit restore again.')
    pakStatus.textContent = 'need device'
    try {
      await connect()
    } catch {
      return
    }
    if (!isDeviceKnown()) return
  }

  const plan = planThin(state.pak, nums)
  const serial =
    state.session?.device?.metadata?.serial || state.deviceSnapshot?.serial || '?'

  currentAbort = new AbortController()
  setFileBusy(true, {
    title: 'Restoring .pak…',
    detail: 'Building selection — do not flash or reload.',
    indeterminate: true,
    cancellable: true,
  })
  clearTransferProgress('pak')
  pakStatus.textContent = 'building selection…'
  let fileSession
  try {
    const { bytes } = await buildThinnedPak(state.pak, nums)
    releaseDfuPort()
    showDevice()
    pakStatus.textContent = 'opening FILE session…'
    setTransferProgress('pak', 0, 1, 'opening FILE')
    busyOverlay.update({ detail: 'opening FILE session…', indeterminate: true })
    fileSession = await openFileSession()
    state.deviceSnapshot = snapshotFromFileInfo(fileSession.info, fileSession.session.identityCode)
    showIdentity()

    const occupied = await listSlots(fileSession.session)
    state.occupiedSlots = occupied
    state.storage = await getStorage(fileSession.session)
    renderStorage()
    refreshPakPlan()

    const space = planRestoreSpace(state.pak.sounds, plan.slots, occupied)
    const blocked = roomCheck(state.storage, space.needed, space.reclaimed)
    if (blocked) {
      showError('pak', blocked)
      pakStatus.textContent = 'restore blocked — not enough free space'
      return
    }

    if (
      !(await askConfirm(
        `Restore ${plan.projects.length} projects / ${plan.slots.length} samples ` +
          `(${formatMb(space.needed)} on-device) to serial ${serial}?\n\n` +
          `Free now: ${formatMb(state.storage.freeSpace)}` +
          (space.reclaimed ? ` (+${formatMb(space.reclaimed)} reclaimed by overwrite)` : '') +
          `.\nUploads over WebMIDI FILE; filling the FS can brick the user partition ` +
          `(ERR SYSTEM_MODEL / err sound loops — recover with SHIFT+ERASE).`,
        { title: 'confirm restore', okLabel: 'restore' },
      ))
    ) {
      pakStatus.textContent = 'cancelled'
      return
    }

    busyOverlay.update({
      title: 'Restoring .pak…',
      detail: `${plan.projects.length} projects / ${plan.slots.length} samples`,
      pct: 0,
    })
    const result = await restorePakBytes(fileSession.session, bytes, {
      projects: nums,
      slots: plan.slots,
      signal: currentAbort.signal,
      onProgress: (done, total, label) => {
        setTransferProgress('pak', done, total, label)
        bumpBusyProgress(done, total, label)
        pakStatus.textContent = `restore ${done}/${total} · ${label}`
      },
    })
    state.storage = await getStorage(fileSession.session)
    state.occupiedSlots = await listSlots(fileSession.session)
    renderStorage()
    refreshPakPlan()
    setTransferProgress('pak', 1, 1, 'done')
    pakStatus.textContent = `restore done — ${result.sounds} sounds, ${result.projects} projects`
  } catch (err) {
    if (err instanceof CancelledError) {
      pakStatus.textContent =
        'restore cancelled — samples already uploaded stay on the device; re-run to finish'
    } else {
      showError(
        'pak',
        errText(err) +
          ' — If the unit shows ERR SYSTEM_MODEL / err sound, power off, hold SHIFT+ERASE, power on, then restore a smaller selection.',
      )
      pakStatus.textContent = 'restore failed'
    }
  } finally {
    currentAbort = null
    fileSession?.close()
    setFileBusy(false)
    clearTransferProgress('pak')
    showDevice()
    statusEl.textContent = 'Reconnect if you need DFU flash again.'
  }
}

async function runBackup() {
  if (!isDeviceKnown()) return
  clearError('backup')
  const serial =
    state.session?.device?.metadata?.serial || state.deviceSnapshot?.serial || '?'
  if (
    !(await askConfirm(
      `Backup projects + samples from serial ${serial}?\n` +
        'This opens a FILE session (kotu) and may take a while. You can cancel between items.',
      { title: 'confirm backup', okLabel: 'back up' },
    ))
  ) {
    return
  }
  currentAbort = new AbortController()
  setFileBusy(true, {
    title: 'Backing up device…',
    detail: 'FILE session — do not flash or reload until the .pak downloads.',
    indeterminate: true,
    cancellable: true,
  })
  clearTransferProgress('backup')
  backupStatus.textContent = 'opening FILE session…'
  let fileSession
  try {
    releaseDfuPort()
    showDevice()
    fileSession = await openFileSession()
    state.deviceSnapshot = snapshotFromFileInfo(fileSession.info, fileSession.session.identityCode)
    state.storage = await getStorage(fileSession.session)
    renderStorage()
    showIdentity()
    busyOverlay.update({ title: 'Backing up device…', detail: 'reading projects + samples…', pct: 0 })
    const backup = await backupDevice(
      fileSession.session,
      fileSession.info,
      (done, total, label) => {
        setTransferProgress('backup', done, total, label)
        bumpBusyProgress(done, total, label)
        backupStatus.textContent = `backup ${done}/${total} · ${label}`
      },
      { signal: currentAbort.signal },
    )
    backupStatus.textContent = 'zipping .pak…'
    const bytes = await packBackup(backup)
    const name = `${fileSession.info.serial || 'ep'}-backup-${new Date().toISOString().slice(0, 10)}.pak`
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: name })
    a.click()
    URL.revokeObjectURL(url)
    setTransferProgress('backup', 1, 1, 'done')
    backupStatus.textContent =
      `saved ${name} · ${backup.slotCount} sounds · ${backup.projectCount} projects`
    state.backupTakenFor = fileSession.info.serial || serial
    saveProfile(state.backupTakenFor, { lastBackupAt: new Date().toISOString() })
  } catch (err) {
    if (err instanceof CancelledError) {
      backupStatus.textContent = 'backup cancelled — nothing was written to the device'
    } else {
      showError('backup', errText(err))
      backupStatus.textContent = 'backup failed'
    }
  } finally {
    currentAbort = null
    fileSession?.close()
    setFileBusy(false)
    clearTransferProgress('backup')
    showDevice()
  }
}

/** @type {AbortController | null} */
let demoAbort = null

/**
 * One button in the device bar. Notes and CC only, so there is nothing to gate,
 * back up, or restore — which is what keeps it a button instead of a workflow.
 */
function renderDemos() {
  const btn = $('demo-btn')
  const note = $('demo-status')
  if (!btn) return

  const running = !!demoAbort
  // Needs a live MIDI output, not just a remembered profile. After a backup the
  // DFU session is closed on purpose, so this is legitimately false while the
  // bar still shows a serial.
  const output = state.session?.access ? findOutput(state.session.access) : null
  const ready = !!output && !state.busy

  btn.hidden = !isDeviceKnown()
  btn.disabled = !ready && !running
  btn.textContent = running ? 'stop' : 'play 10s demo'
  if (note && !running) {
    note.textContent = ready ? pickDemo(productFlagFromSku(deviceSku())).label : ''
  }
}

async function startDemo() {
  if (demoAbort) return stopDemo()
  const output = state.session?.access ? findOutput(state.session.access) : null
  if (!output) {
    showError('connect', 'No EP MIDI output — reconnect and try again.')
    return
  }
  const note = $('demo-status')
  demoAbort = new AbortController()
  renderDemos()
  if (note) note.textContent = 'playing…'
  try {
    await runDemoLoop(output, productFlagFromSku(deviceSku()), demoAbort.signal)
    if (note) note.textContent = 'done'
  } catch (err) {
    if (note) {
      note.textContent = err?.name === 'AbortError' ? 'stopped' : errText(err)
    }
  } finally {
    demoAbort = null
    renderDemos()
  }
}

function stopDemo() {
  demoAbort?.abort()
}

function bindDrop(el, input, onFile) {
  el.addEventListener('click', () => input.click())
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      input.click()
    }
  })
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (f) void onFile(f)
  })
  ;['dragenter', 'dragover'].forEach((type) => {
    el.addEventListener(type, (e) => {
      e.preventDefault()
      el.classList.add('over')
    })
  })
  ;['dragleave', 'drop'].forEach((type) => {
    el.addEventListener(type, (e) => {
      e.preventDefault()
      el.classList.remove('over')
    })
  })
  el.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0]
    if (f) void onFile(f)
  })
}

bindDrop(drop, fileInput, loadFile)
bindDrop(pakDrop, pakFile, loadPak)

/**
 * Dropping onto the two small zones was the only way in; anywhere else the
 * browser just navigated to the file. Route by extension instead.
 */
function bindPageWideDrop() {
  const overlayClass = 'page-drag'
  let depth = 0
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault()
    depth++
    document.body.classList.add(overlayClass)
  })
  window.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault()
  })
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0
      document.body.classList.remove(overlayClass)
    }
  })
  window.addEventListener('drop', (e) => {
    depth = 0
    document.body.classList.remove(overlayClass)
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    e.preventDefault()
    if (/\.tfw$/i.test(file.name)) {
      void loadFile(file)
      drop.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else if (/\.p?pak$/i.test(file.name)) {
      void loadPak(file)
      pakDrop.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else if (/\.json$/i.test(file.name)) {
      void loadReleasesJson(file)
    } else {
      showError(
        'drop',
        `${file.name} is not a .tfw, .pak, or releases.json — nothing to do with it.`,
      )
    }
  })
}
bindPageWideDrop()

connectBtn.addEventListener('click', () => void connect())
$('supertone-sanitize')?.addEventListener('click', () => void runSupertoneSanitize({ resumeSession: true }))
downloadBtn.addEventListener('click', downloadRewritten)
$('hex-before')?.addEventListener('click', () => setHexView('before'))
$('hex-after')?.addEventListener('click', () => setHexView('after'))
flashBtn.addEventListener('click', () => void flash())
$('busy-dismiss')?.addEventListener('click', () => {
  state.busy = false
  updateActions()
  updateBackupCli()
  refreshPakPlan()
  showDevice()
})
copySerialBtn.addEventListener('click', () => void copySerial())
risk.addEventListener('change', updateActions)
riskNor.addEventListener('change', updateActions)
riskSerial.addEventListener('change', updateActions)
medievalExp?.addEventListener('change', () => setMedievalExperimental(medievalExp.checked))
$('recover-focus-drop')?.addEventListener('click', focusRecoverDrop)
$('pak-all').addEventListener('click', () => {
  projList.querySelectorAll('input').forEach((el) => {
    el.checked = true
  })
  refreshPakPlan()
})
$('pak-none').addEventListener('click', () => {
  projList.querySelectorAll('input').forEach((el) => {
    el.checked = false
  })
  refreshPakPlan()
})
pakDownload.addEventListener('click', () => void downloadThinned())
pakRestore.addEventListener('click', () => void restoreThinned())
backupBtn.addEventListener('click', () => void runBackup())
$('demo-btn')?.addEventListener('click', () => void startDemo())
// A page unload mid-demo would otherwise leave the unit holding a chord.
window.addEventListener('pagehide', stopDemo)

state.medievalExperimental = loadMedievalExperimental()
if (medievalExp) medievalExp.checked = state.medievalExperimental

state.midiCapable = checkCapability()
if (!state.midiCapable) {
  connectBtn.disabled = true
  connectBtn.textContent = 'WebMIDI unavailable'
  backupBtn.disabled = true
}

showDevice()
refreshPreview()
updateBackupCli()
renderMedievalWarn()
renderDemos()

if (typeof ResizeObserver !== 'undefined' && hexEl) {
  let hexCols = 0
  const ro = new ResizeObserver(() => {
    const next = hexColsForWidth(hexEl.clientWidth || 320)
    if (next !== hexCols) {
      hexCols = next
      if (state.bytes) renderHex()
    }
  })
  ro.observe(hexEl)
}

// Shell-only offline cache. Registration failure is not worth a banner — the
// page works exactly as before without it.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((err) => {
    console.warn('service worker registration failed', err)
  })
}

void (async () => {
  const fw = loadFirmwareCatalog()
  state.fwDevices = fw.devices
  state.fwFromUser = fw.fromUser
  renderFwLinks(fw.devices)
  renderFactoryLinks(loadFactoryCatalog().packs)
})()

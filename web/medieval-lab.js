/**
 * EP-1320 Medieval lab page. One question — does a Medieval boot a KO/Riddim
 * image? — asked once, with an automatic restore to stock and a log to send back.
 */

import { TeDfuSession, frameHex, parseDebugFrame } from './lib/midi.js'
import { parseTfw } from './lib/tfw.js'
import { flashFirmware, prepareImage } from './lib/dfu.js'
import { SKU_EP133, SKU_EP40, SKU_MEDIEVAL, loadFirmwareCatalog } from './lib/catalog.js'
import {
  LAB_VERSION,
  checkDevice,
  checkFiles,
  probeVerdict,
  restoreOk,
  summaryText,
} from './lib/lab.js'

const $ = (id) => document.getElementById(id)
const EP_RE = /EP-133|EP-40|EP-1320/i
const WIRE_CAP = 40000
const RESTORE_ATTEMPTS = 3

const report = {
  lab: LAB_VERSION,
  started: new Date().toISOString(),
  userAgent: navigator.userAgent,
  connect: null,
  flashes: [],
  debugTexts: [],
  result: '',
  events: [],
  wire: [],
}

/** @type {MIDIAccess | null} */
let access = null
/** @type {TeDfuSession | null} */
let session = null
let busy = false
const files = { probe: null, stock: null }

const t0 = performance.now()
const now = () => Math.round(performance.now() - t0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errText = (e) => (e && e.message) || String(e)

function log(msg) {
  report.events.push({ t: now(), msg })
  const el = $('log')
  el.textContent += `${(now() / 1000).toFixed(1)}s  ${msg}\n`
  el.scrollTop = el.scrollHeight
  renderFwLinks()
renderSummary()
}

function tap(dir, data, port) {
  if (report.wire.length >= WIRE_CAP) return
  report.wire.push({ t: now(), dir, port, len: data.length, hex: frameHex(data, 32) })
}

function renderSummary() {
  $('summary').textContent = summaryText(report)
  try {
    const { wire, ...light } = report
    localStorage.setItem('ep-unity.medievalLab.last', JSON.stringify(light))
  } catch {}
}

function verdict(id, text, kind = '') {
  $(id).textContent = text
  $(id).dataset.kind = kind
}

function setBusy(on) {
  busy = on
  $('btn-connect').disabled = on
  $('file-probe').disabled = on
  $('file-stock').disabled = on
  updateButtons()
}

function updateButtons() {
  const devOk = report.connect?.ok && !checkDevice(report.connect.meta).length
  const filesOk = !checkFiles(files.probe?.info, files.stock?.info).length
  const ack = $('ack').checked
  $('btn-probe').disabled = busy || !devOk || !filesOk || !ack
  // Restore needs only the stock file: a unit stuck in bootloader may not look like an EP-1320.
  $('btn-restore').disabled = busy || !files.stock || files.stock.info.sku !== SKU_MEDIEVAL || !ack
}

function progress(pct, text) {
  const bar = $('progress')
  bar.hidden = pct == null
  if (pct != null) bar.value = pct
  $('progress-text').textContent = text || ''
}

// ── MIDI plumbing ─────────────────────────────────────────────────────────

const debugSeen = new Set()
const attached = new WeakSet()
function onAnyMidi(e) {
  const dbg = parseDebugFrame(new Uint8Array(e.data))
  if (!dbg?.text) return
  if (debugSeen.has(dbg.text)) return
  debugSeen.add(dbg.text)
  report.debugTexts.push(dbg.text)
  log(`device debug frame: ${dbg.text}`)
}
function attachDebug() {
  access?.inputs.forEach((input) => {
    if (attached.has(input)) return
    attached.add(input)
    input.addEventListener('midimessage', onAnyMidi)
  })
}

function listPorts() {
  const ports = []
  access.inputs.forEach((p) => ports.push({ type: 'in', name: p.name, manufacturer: p.manufacturer, state: p.state, connection: p.connection }))
  access.outputs.forEach((p) => ports.push({ type: 'out', name: p.name, manufacturer: p.manufacturer, state: p.state, connection: p.connection }))
  return ports
}

function epPortsPresent() {
  let i = 0
  let o = 0
  access.inputs.forEach((p) => { if (EP_RE.test(p.name || '') && p.state === 'connected') i++ })
  access.outputs.forEach((p) => { if (EP_RE.test(p.name || '') && p.state === 'connected') o++ })
  return i > 0 && o > 0
}

async function ensureAccess() {
  if (access) return access
  access = await navigator.requestMIDIAccess({ sysex: true })
  access.addEventListener('statechange', (e) => {
    attachDebug()
    const p = e.port
    if (p && EP_RE.test(p.name || '')) log(`port ${p.type} "${p.name}" ${p.state}`)
  })
  attachDebug()
  return access
}

async function connectFresh() {
  session?.close()
  session = new TeDfuSession(access, { tap })
  const d = await session.connect()
  return d
}

/**
 * Wait for the unit to come back after a flash. Prefer seeing the port vanish
 * first (a real reboot); after 6 s without that, start asking anyway.
 */
async function waitForUnit({ timeoutMs = 120000, label = 'waiting for reboot' } = {}) {
  const start = Date.now()
  let sawGone = false
  while (Date.now() - start < timeoutMs) {
    const secs = Math.round((Date.now() - start) / 1000)
    if (!epPortsPresent()) {
      if (!sawGone) log('ports gone (rebooting)')
      sawGone = true
      progress(100, `${label}… ${secs}s · ports gone`)
      await sleep(500)
      continue
    }
    if (!sawGone && Date.now() - start < 6000) {
      await sleep(400)
      continue
    }
    progress(100, `${label}… ${secs}s · asking the unit`)
    try {
      const d = await connectFresh()
      log(`unit answered: ${d.metadata.product} mode=${d.metadata.mode} os=${d.metadata.os_version || d.metadata.sw_version}`)
      return d.metadata
    } catch (err) {
      session?.close()
      session = null
      await sleep(1500)
    }
  }
  log(`no answer within ${Math.round(timeoutMs / 1000)}s`)
  return null
}

/**
 * Flash one image at the Medieval SKU. If the running OS refuses in-app DFU,
 * flashFirmware() reboots it into the bootloader; reconnect and try once more.
 */
async function flashOnce(role, file) {
  const info = file.info
  const f = {
    role,
    image: `${info.product || info.sku} ${info.version}`,
    file: file.name,
    wireSku: SKU_MEDIEVAL,
    steps: [],
    before: null,
    after: null,
    error: '',
  }
  report.flashes.push(f)
  const prepared = prepareImage(file.bytes, SKU_MEDIEVAL)
  if (prepared.rewritten) log(`${role}: header SKU ${prepared.fromSku} → ${SKU_MEDIEVAL}`)

  for (let attempt = 1; attempt <= 2; attempt++) {
    const d = await connectFresh()
    f.before ??= d.metadata
    log(`${role}: flashing ${f.image} (attempt ${attempt}, unit mode=${d.metadata.mode})`)
    let lastStep = ''
    try {
      await flashFirmware(session, prepared.bytes, {
        onProgress: ({ pct, step }) => {
          if (step !== lastStep) {
            lastStep = step
            f.steps.push(step)
            log(`${role}: ${step}`)
          }
          progress(pct, `${role}: ${step} ${pct}%`)
        },
      })
      f.error = ''
      break
    } catch (err) {
      const msg = errText(err)
      log(`${role}: ${msg}`)
      if (/rebooting into bootloader/.test(msg) && attempt === 1) {
        f.steps.push('entered bootloader')
        session?.close()
        session = null
        const back = await waitForUnit({ timeoutMs: 60000, label: 'waiting for bootloader' })
        if (!back) {
          f.error = 'unit did not come back after entering bootloader'
          break
        }
        continue
      }
      f.error = msg
      // Nothing was written if the failure came before any chunk moved.
      if (!f.steps.includes('transfer')) f.beginError = msg
      break
    }
  }

  session?.close()
  session = null
  f.after = await waitForUnit({ timeoutMs: f.beginError ? 20000 : 120000 })
  renderFwLinks()
renderSummary()
  return f
}

// ── Steps ─────────────────────────────────────────────────────────────────

async function runConnect() {
  setBusy(true)
  verdict('connect-verdict', 'checking…', 'busy')
  const c = { ok: false, via: '', deviceId: null, meta: null, error: '', ports: [], portErrors: [], unparsed: [] }
  report.connect = c
  try {
    await ensureAccess()
    c.ports = listPorts()
    log(`ports: ${c.ports.map((p) => `${p.type}:"${p.name}" (${p.state}/${p.connection})`).join(', ') || 'none'}`)
    const eps = []
    access.inputs.forEach((p) => EP_RE.test(p.name || '') && eps.push(p))
    access.outputs.forEach((p) => EP_RE.test(p.name || '') && eps.push(p))
    for (const p of eps) {
      try {
        await p.open()
      } catch (err) {
        c.portErrors.push(`${p.type} "${p.name}": ${errText(err)}`)
        log(`could not open ${p.type} "${p.name}": ${errText(err)} — another app may hold it`)
      }
    }
    log('listening 1.5s for anything the unit sends on its own')
    await sleep(1500)
    const d = await connectFresh()
    c.ok = true
    c.via = d.via === 'greet' ? 'greet sweep' : 'identity'
    c.deviceId = d.deviceId
    c.identitySku = d.identitySku
    c.meta = d.metadata
    log(`connected via ${c.via}: device byte 0x${d.deviceId.toString(16)} · ${JSON.stringify(d.metadata)}`)
    const bad = checkDevice(d.metadata)
    if (bad.length) verdict('connect-verdict', `connected, but: ${bad.join('; ')}`, 'bad')
    else {
      verdict(
        'connect-verdict',
        `connected · ${d.metadata.product} · ${d.metadata.mode} · OS ${d.metadata.os_version || d.metadata.sw_version} · serial ${d.metadata.serial}`,
        'ok',
      )
    }
  } catch (err) {
    c.error = errText(err)
    c.unparsed = session?.unparsed ?? []
    log(`connect failed: ${c.error}`)
    verdict(
      'connect-verdict',
      `could not connect: ${c.error}\nCopy the summary below and send it back — that is the useful part.`,
      'bad',
    )
  } finally {
    session?.close()
    session = null
    setBusy(false)
    renderFwLinks()
renderSummary()
  }
}

async function runRestore() {
  for (let i = 1; i <= RESTORE_ATTEMPTS; i++) {
    verdict('probe-verdict', `restoring stock EP-1320 firmware (attempt ${i}/${RESTORE_ATTEMPTS})…`, 'busy')
    let f
    try {
      f = await flashOnce('restore', files.stock)
    } catch (err) {
      log(`restore attempt ${i} could not start: ${errText(err)}`)
      f = null
    }
    if (f && restoreOk(f.after, files.stock.info.version)) {
      f.verdict = 'RESTORED'
      return true
    }
    if (f) f.verdict = 'NOT YET'
    if (!f?.after && i < RESTORE_ATTEMPTS) {
      verdict('probe-verdict', 'No answer. Turn the EP-1320 off and on again now — the page keeps trying.', 'bad')
      await waitForUnit({ timeoutMs: 180000, label: 'waiting for you to power-cycle' })
    }
  }
  return false
}

const RESTORE_HELP =
  'Restore did not confirm. Do not unplug in a panic:\n' +
  '1. Power-cycle the EP-1320 and leave it plugged in.\n' +
  '2. Reload this page, pick the stock file again, tick the box, press "restore stock only".\n' +
  '3. If that fails, try TE’s own updater at teenage.engineering/apps/update.\n' +
  'Send the log either way.'

async function runProbe() {
  setBusy(true)
  try {
    const probeInfo = files.probe.info
    const f = await flashOnce('probe', files.probe)
    const v = probeVerdict(f.after, probeInfo.version, { beginError: f.beginError })
    f.verdict = v.label
    log(`probe verdict: ${v.label} — ${v.detail}`)
    verdict('probe-verdict', `${v.label}: ${v.detail}`, v.kind === 'accepted' ? 'ok' : 'busy')

    if (v.kind === 'accepted') {
      report.result = 'ACCEPTED — Medieval booted the probe image; left installed'
      verdict(
        'probe-verdict',
        `ACCEPTED: the Medieval booted ${probeInfo.version}. Copy the summary now. ` +
          'You can keep this firmware — it stays on until you flash something else. ' +
          'Don’t SHIFT+ERASE unless you’re ready to lose the Medieval sounds (no backup path yet). ' +
          'To go back, press "restore stock only" any time.',
        'ok',
      )
      return
    }
    if (!v.needsRestore) {
      // Refused at BEGIN: nothing written. Confirm the unit is still healthy.
      const healthy = restoreOk(f.after, files.stock.info.version)
      report.result = `${v.label}; unit ${healthy ? 'healthy on stock' : 'state unclear — restoring anyway'}`
      if (healthy) {
        verdict('probe-verdict', `${v.label}: nothing was written and the unit is fine. Send the summary.`, 'ok')
        return
      }
    }
    const ok = await runRestore()
    report.result = `${v.label}; ${ok ? 'restored to stock' : 'RESTORE NOT CONFIRMED'}`
    verdict(
      'probe-verdict',
      ok ? `${v.label} → restored to stock ${files.stock.info.version}. Done — send the summary.` : RESTORE_HELP,
      ok ? 'ok' : 'bad',
    )
  } catch (err) {
    log(`probe aborted: ${errText(err)}`)
    report.result = `aborted: ${errText(err)}`
    verdict('probe-verdict', `Stopped: ${errText(err)}\nIf the unit is not on stock, press "restore stock only".`, 'bad')
  } finally {
    session?.close()
    session = null
    progress(null)
    setBusy(false)
    renderFwLinks()
renderSummary()
  }
}

async function runRestoreOnly() {
  setBusy(true)
  try {
    await ensureAccess()
    const ok = await runRestore()
    report.result = `${report.result ? `${report.result}; ` : ''}manual restore ${ok ? 'ok' : 'NOT CONFIRMED'}`
    verdict('probe-verdict', ok ? `Restored to stock ${files.stock.info.version}. Send the summary.` : RESTORE_HELP, ok ? 'ok' : 'bad')
  } catch (err) {
    log(`restore aborted: ${errText(err)}`)
    verdict('probe-verdict', `${errText(err)}\n\n${RESTORE_HELP}`, 'bad')
  } finally {
    session?.close()
    session = null
    progress(null)
    setBusy(false)
    renderFwLinks()
renderSummary()
  }
}

// ── Files ─────────────────────────────────────────────────────────────────

const PRODUCT_BY_SKU = { TE032AS001: 'EP-133', TE032AS006: 'EP-40', TE032AS005: 'EP-1320' }

async function loadFile(which, input) {
  const file = input.files?.[0]
  if (!file) {
    files[which] = null
  } else {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const info = parseTfw(bytes)
      info.product = PRODUCT_BY_SKU[info.sku] || info.sku
      files[which] = { name: file.name, bytes, info }
      log(`${which} file: ${file.name} · ${info.product} ${info.version} · ${bytes.length} bytes`)
    } catch (err) {
      files[which] = null
      log(`${which} file rejected: ${errText(err)}`)
    }
  }
  const lines = []
  for (const k of ['probe', 'stock']) {
    const f = files[k]
    lines.push(`${k}: ${f ? `${f.name} · ${f.info.product} ${f.info.version} (${f.info.sku})` : '—'}`)
  }
  const problems = checkFiles(files.probe?.info, files.stock?.info)
  if (problems.length) lines.push('', ...problems.map((p) => `· ${p}`))
  else lines.push('', 'files ok')
  $('files-status').textContent = lines.join('\n')
  updateButtons()
}

// ── Firmware links (same catalog as the main tool, incl. a saved releases.json) ──

function renderFwLinks() {
  const { devices, fromUser, savedAt } = loadFirmwareCatalog()
  const fill = (id, skus) => {
    const ul = $(id)
    ul.replaceChildren()
    for (const d of devices.filter((d) => skus.includes(d.sku))) {
      if (!d.fwUrl) continue
      const li = document.createElement('li')
      const a = document.createElement('a')
      a.href = d.fwUrl
      a.target = '_blank'
      a.rel = 'noreferrer'
      a.textContent = `download ${d.product}${d.version ? ` ${d.version}` : ''} (${d.sku}) ↗`
      li.append(a)
      ul.append(li)
    }
  }
  fill('fw-links-probe', [SKU_EP133, SKU_EP40])
  fill('fw-links-stock', [SKU_MEDIEVAL])
  $('fw-catalog-status').textContent = fromUser
    ? `versions from your releases.json (saved ${String(savedAt).slice(0, 10)} in the main tool)`
    : 'built-in version list — drop a newer releases.json into the main tool to update it'
}

// ── Wire-up ───────────────────────────────────────────────────────────────

if (!navigator.requestMIDIAccess) {
  $('capability').hidden = false
  $('btn-connect').disabled = true
}

$('btn-connect').addEventListener('click', runConnect)
$('btn-probe').addEventListener('click', runProbe)
$('btn-restore').addEventListener('click', runRestoreOnly)
$('ack').addEventListener('change', updateButtons)
$('file-probe').addEventListener('change', (e) => loadFile('probe', e.target))
$('file-stock').addEventListener('change', (e) => loadFile('stock', e.target))

$('btn-copy').addEventListener('click', async () => {
  const text = summaryText(report)
  try {
    await navigator.clipboard.writeText(text)
    $('btn-copy').textContent = 'copied'
    setTimeout(() => ($('btn-copy').textContent = 'copy summary'), 1500)
  } catch {
    // Clipboard blocked: select the text so a manual copy works.
    const r = document.createRange()
    r.selectNodeContents($('summary'))
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  }
})

$('btn-download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' })
  const a = document.createElement('a')
  const serial = report.connect?.meta?.serial || 'unknown'
  a.href = URL.createObjectURL(blob)
  a.download = `medieval-lab-${serial}-${report.started.slice(0, 19).replace(/[:T]/g, '-')}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
})

window.addEventListener('beforeunload', (e) => {
  if (!busy) return
  e.preventDefault()
  e.returnValue = ''
})

renderFwLinks()
renderSummary()

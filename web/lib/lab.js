/**
 * EP-1320 Medieval lab — pure pieces (verdicts, file checks, summary text).
 * The page in ../medieval-lab.js does the MIDI; everything here is testable in node.
 */

import { SKU_EP133, SKU_EP40, SKU_MEDIEVAL } from './catalog.js'

export const LAB_VERSION = 'medieval-lab 1'

/** Probe image must be KO/Riddim (the other KEYHASH); stock must be Medieval. */
export function checkFiles(probe, stock) {
  const problems = []
  if (!probe) problems.push('drop an EP-133 or EP-40 .tfw as the probe image')
  else if (probe.sku !== SKU_EP133 && probe.sku !== SKU_EP40) {
    problems.push(`probe image is ${probe.sku}; it must be an EP-133 or EP-40 .tfw`)
  }
  if (!stock) problems.push('drop the stock EP-1320 .tfw (for the automatic restore)')
  else if (stock.sku !== SKU_MEDIEVAL) {
    problems.push(`restore image is ${stock.sku}; it must be the stock EP-1320 .tfw`)
  }
  return problems
}

/**
 * Only an EP-1320 in a known state may run the probe. A KO/Riddim unit has
 * the main tool for this; flashing one from here would prove nothing new.
 */
export function checkDevice(meta) {
  if (!meta) return ['not connected']
  const problems = []
  if (meta.sku !== SKU_MEDIEVAL && !/1320/.test(meta.product || '')) {
    problems.push(`connected unit reports ${meta.product || '?'} / ${meta.sku || '?'} — this lab is for the EP-1320 only`)
  }
  return problems
}

/**
 * What the unit did with the probe image.
 * @param {{ mode?: string, os_version?: string, sw_version?: string } | null} after GREET after reboot
 * @param {string} probeVersion e.g. '2.5.1'
 * @param {{ beginError?: string }} [ctx]
 */
export function probeVerdict(after, probeVersion, ctx = {}) {
  if (ctx.beginError) {
    return {
      kind: 'refused_at_begin',
      label: 'REFUSED AT BEGIN',
      detail: `Bootloader refused the image before any bytes were written: ${ctx.beginError}`,
      needsRestore: false,
    }
  }
  if (!after) {
    return {
      kind: 'no_answer',
      label: 'NO ANSWER',
      detail: 'Unit did not answer after the flash. Power-cycle it, then press "restore stock".',
      needsRestore: true,
    }
  }
  const os = after.os_version || after.sw_version || ''
  if (after.mode === 'bootloader') {
    return {
      kind: 'rejected',
      label: 'REJECTED',
      detail: 'Unit fell back to its bootloader — the Medieval does not trust the KO/Riddim key.',
      needsRestore: true,
    }
  }
  if (after.mode === 'normal' && os === probeVersion) {
    return {
      kind: 'accepted',
      label: 'ACCEPTED',
      detail: `Unit booted OS ${os} from the probe image. Check the screen and pads, then restore stock.`,
      needsRestore: false,
    }
  }
  return {
    kind: 'unchanged',
    label: 'KEPT OLD OS',
    detail: `Unit came back in ${after.mode || '?'} mode on OS ${os || '?'} — the probe image was not installed.`,
    needsRestore: true,
  }
}

/** Restore is done when the unit is back in normal mode on the stock version. */
export function restoreOk(after, stockVersion) {
  if (!after || after.mode !== 'normal') return false
  return (after.os_version || after.sw_version) === stockVersion
}

function metaLine(m) {
  if (!m) return 'no answer'
  const f = (k) => m[k] || '?'
  return `${f('product')} mode=${f('mode')} sku=${f('sku')} os=${m.os_version || m.sw_version || '?'} bl=${f('bl_version')}`
}

/** Short text the tester can paste into a chat message. */
export function summaryText(report) {
  const out = [`${LAB_VERSION} · ${report.started}`]
  out.push(`browser: ${report.userAgent || '?'}`)
  const c = report.connect
  if (c) {
    out.push(
      c.ok
        ? `connect: ok via ${c.via} dev=0x${(c.deviceId ?? 0).toString(16)} · ${metaLine(c.meta)}`
        : `connect: FAILED · ${c.error}`,
    )
    if (c.portErrors?.length) out.push(`port errors: ${c.portErrors.join(' | ')}`)
    if (c.ports) out.push(`ports: ${c.ports.map((p) => `${p.type}:${p.name}`).join(', ') || 'none'}`)
  }
  for (const f of report.flashes || []) {
    out.push(`${f.role}: ${f.image} → ${f.wireSku} · ${f.error ? `error: ${f.error}` : `transfer ok (${f.steps?.join(' > ') || ''})`}`)
    out.push(`  after: ${metaLine(f.after)}${f.verdict ? ` · ${f.verdict}` : ''}`)
  }
  if (report.debugTexts?.length) out.push(`debug frames: ${report.debugTexts.slice(0, 6).join(' | ')}`)
  if (report.result) out.push(`RESULT: ${report.result}`)
  return out.join('\n')
}

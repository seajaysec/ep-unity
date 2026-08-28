/**
 * What we know about a flash combination, and where to report what happened.
 *
 * Outcome reports are thin — the numbers below are the whole evidence base, so
 * the tool states them plainly rather than implying broader coverage. Nothing
 * here is a risk model; the risk language lives in the acknowledgements.
 *
 * On record:
 *   EP-40 firmware on EP-133 hardware   one report, a 64 MiB EP-133 (TE032AS001)
 *   EP-133 firmware on EP-40 hardware   none
 *   same-family reflash                 routine, not tracked here
 *
 * Hardware note: no 64 MiB EP-40 exists — riddim ships 128 MiB only. EP-133
 * ships both (TE032AS001 64 MiB, TE032AS002 128 MiB).
 */

import { SKU_EP133, SKU_EP40, SKU_MEDIEVAL } from './catalog.js'

export const ISSUES_URL = 'https://github.com/seajaysec/ep-unity/issues'
const NEW_ISSUE_URL = 'https://github.com/seajaysec/ep-unity/issues/new'

/** Rough MB, for report text only. */
function mb(bytes) {
  return bytes ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : ''
}

function family(sku) {
  if (sku === SKU_EP133) return 'EP-133'
  if (sku === SKU_EP40) return 'EP-40'
  if (sku === SKU_MEDIEVAL) return 'EP-1320'
  return ''
}

/**
 * A one-line statement of how much is known about this combination, or null
 * when there is nothing notable to say (same-family reflash, unknown SKUs).
 *
 * @param {{imageSku?: string, wireSku?: string, boardSku?: string, maxCapacity?: number}} opts
 * @returns {null | string}
 */
export function crossFlashReportNote({ imageSku, wireSku, boardSku, maxCapacity } = {}) {
  const from = family(imageSku)
  const to = family(wireSku)
  if (!from || !to || from === to) return null

  const ask = 'Please report the result either way — reports are what this is built on.'

  if (from === 'EP-133' && to === 'EP-40') {
    return `No outcome has been reported for EP-133 firmware on EP-40 hardware. ${ask}`
  }

  if (from === 'EP-40' && to === 'EP-133') {
    // Board revision decides whether the one existing report covers this unit.
    const big = boardSku === 'TE032AS002' || (maxCapacity && maxCapacity > 100 * 1024 * 1024)
    return big
      ? `EP-40 firmware on EP-133 hardware has one report, on a 64 MiB board. ` +
          `This unit reports ${mb(maxCapacity) || '128 MiB'} — no reports on that board yet. ${ask}`
      : `EP-40 firmware on EP-133 hardware has one report, on a 64 MiB board like this one. ${ask}`
  }

  return `No outcome has been reported for ${from} firmware on ${to} hardware. ${ask}`
}

/**
 * Prefilled "report the result" issue link.
 *
 * Carries the SKUs, OS and capacity the device reported — deliberately NOT the
 * serial, which is device-identifying and is the one field check_publishable.sh
 * exists to keep out of this repository.
 *
 * @param {{outcome?: string, imageSku?: string, wireSku?: string, boardSku?: string,
 *          os?: string, maxCapacity?: number, state?: string}} opts
 */
/**
 * Browsers and servers both tolerate far more, but a prefilled issue that
 * silently truncates is worse than one that asks for an attachment, so keep
 * the whole URL well inside where anything starts to get opinionated.
 */
const MAX_PREFILL_URL = 6000

/**
 * A prefilled issue carrying the entire report, so reporting is one click and
 * there is nothing to attach. If a device spat out enough debug lines to
 * outgrow the URL, the body asks for the saved file instead of quietly
 * dropping the interesting half.
 *
 * Never carries the serial — that is the field check_publishable.sh exists to
 * keep out of this repository.
 *
 * @param {Parameters<typeof buildReport>[0]} opts
 */
export function reportIssueUrl(opts = {}) {
  const report = buildReport(opts)
  const title = `[report] ${report.combination}${opts.outcome ? ` — ${opts.outcome}` : ''}`

  const summary = [
    `- **outcome:** ${report.outcome}`,
    `- **combination:** ${report.combination}`,
    `- **image:** ${report.image.sku || '(unknown)'}${report.image.version ? ` ${report.image.version}` : ''}` +
      `${report.image.headerRewritten ? ' (header rewritten)' : ''}`,
    `- **announced at DFU_BEGIN:** ${report.device.announcedAtDfuBegin || '(unknown)'}`,
    `- **board revision:** ${report.device.boardRevision || '(unknown)'}`,
    `- **device os:** ${report.device.os || '(unknown)'}`,
    `- **sample store:** ${report.device.sampleStore || '(not probed)'}`,
    `- **post-flash state:** ${report.postFlashState || '(what the screen said)'}`,
  ].join('\n')

  const debug = report.deviceDebug.length
    ? ['', '### What the device said', '', '```', ...report.deviceDebug, '```'].join('\n')
    : ''

  const full = [
    summary,
    debug,
    '',
    '### What happened',
    '',
    '',
    '<details><summary>Full report</summary>',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    '</details>',
    '',
    `_${report.contains}_`,
  ].join('\n')

  const url = (body) => `${NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
  const withReport = url(full)
  if (withReport.length <= MAX_PREFILL_URL) return withReport

  // Too much debug output to inline. Ask for the file rather than truncate it.
  return url(
    [
      summary,
      '',
      '### What happened',
      '',
      '',
      `_This device produced ${report.deviceDebug.length} debug lines — too many to prefill._`,
      '_Please attach the saved report file, which has all of them._',
    ].join('\n'),
  )
}


/** Filename for a saved report. Dated, so a person can send more than one. */
export function reportFilename(now = new Date()) {
  return `ep-unity-report-${now.toISOString().slice(0, 10)}.json`
}

/**
 * The report itself: everything the tool observed, as a file the reporter can
 * read before sending. Carries the device's own error SysEx, which is the part
 * that is too long to retype and so never makes it into a hand-written report.
 *
 * No serial. No sample or project content. Nothing the page fetched.
 *
 * @param {{outcome?: string, imageSku?: string, imageVersion?: string, wireSku?: string,
 *          boardSku?: string, os?: string, maxCapacity?: number, state?: string,
 *          rewritten?: boolean, debugTexts?: string[], now?: Date}} opts
 */
export function buildReport({
  outcome = '',
  imageSku = '',
  imageVersion = '',
  wireSku = '',
  boardSku = '',
  os = '',
  maxCapacity = 0,
  state = '',
  rewritten = false,
  debugTexts = [],
  now = new Date(),
} = {}) {
  return {
    tool: 'ep-unity',
    reportVersion: 1,
    generatedAt: now.toISOString(),
    outcome: outcome || 'unknown',
    combination:
      family(imageSku) && family(wireSku)
        ? family(imageSku) === family(wireSku)
          ? `${family(imageSku)} reflash`
          : `${family(imageSku)} firmware on ${family(wireSku)}`
        : 'unknown',
    image: { sku: imageSku, version: imageVersion, headerRewritten: !!rewritten },
    device: {
      announcedAtDfuBegin: wireSku,
      boardRevision: boardSku || wireSku,
      os,
      sampleStoreBytes: maxCapacity || null,
      sampleStore: mb(maxCapacity) || null,
    },
    postFlashState: state,
    deviceDebug: [...debugTexts],
    contains: 'No serial number, no samples, no project data.',
  }
}

/** The report as the text that gets written to disk. */
export function reportFileText(opts) {
  return `${JSON.stringify(buildReport(opts), null, 2)}\n`
}

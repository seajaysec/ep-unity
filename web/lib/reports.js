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
export function reportIssueUrl({
  outcome = '',
  imageSku = '',
  wireSku = '',
  boardSku = '',
  os = '',
  maxCapacity = 0,
  state = '',
} = {}) {
  const from = family(imageSku)
  const to = family(wireSku)
  const combo = from && to ? (from === to ? `${from} reflash` : `${from} firmware on ${to}`) : 'flash'
  const title = `[report] ${combo}${outcome ? ` — ${outcome}` : ''}`

  const rows = [
    ['outcome', outcome || '(worked / failed / describe)'],
    ['image sku', imageSku || '(unknown)'],
    ['announced at DFU_BEGIN', wireSku || '(unknown)'],
    ['board revision', boardSku || '(same as above)'],
    ['device os', os || '(unknown)'],
    ['sample store', mb(maxCapacity) || '(not probed)'],
    ['post-flash state', state || '(what the screen said)'],
  ]

  const body = [
    ...rows.map(([k, v]) => `- **${k}:** ${v}`),
    '',
    '### What happened',
    '',
    '',
    '---',
    '_No serial number is included above. Please leave it out — it is not needed._',
  ].join('\n')

  return `${NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

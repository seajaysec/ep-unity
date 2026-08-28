import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  crossFlashReportNote,
  reportIssueUrl,
  buildReport,
  reportFileText,
  reportFilename,
  reportDestination,
  ISSUES_URL,
} from './reports.js'

const EP133 = 'TE032AS001'
const EP133_128 = 'TE032AS002'
const EP40 = 'TE032AS006'
const CAP_64 = 62853120
const CAP_128 = 134021120

describe('reports.js crossFlashReportNote', () => {
  it('says nothing for a same-family reflash', () => {
    assert.equal(crossFlashReportNote({ imageSku: EP133, wireSku: EP133 }), null)
    assert.equal(crossFlashReportNote({ imageSku: EP40, wireSku: EP40 }), null)
  })

  it('says nothing when a SKU is unknown', () => {
    assert.equal(crossFlashReportNote({ imageSku: '', wireSku: EP133 }), null)
    assert.equal(crossFlashReportNote(), null)
  })

  it('reports zero coverage for EP-133 firmware on EP-40 hardware', () => {
    // The least-tested direction: no riddim has ever been flashed.
    const note = crossFlashReportNote({ imageSku: EP133, wireSku: EP40 })
    assert.match(note, /No outcome has been reported for EP-133 firmware on EP-40 hardware/)
    assert.match(note, /Please report the result either way/)
  })

  it('cites the single 64 MiB report when the board matches it', () => {
    const note = crossFlashReportNote({
      imageSku: EP40,
      wireSku: EP133,
      boardSku: EP133,
      maxCapacity: CAP_64,
    })
    assert.match(note, /one report, on a 64 MiB board like this one/)
  })

  it('flags that the 64 MiB report does not cover a 128 MiB board', () => {
    const note = crossFlashReportNote({
      imageSku: EP40,
      wireSku: EP133,
      boardSku: EP133_128,
      maxCapacity: CAP_128,
    })
    assert.match(note, /no reports on that board yet/)
    assert.match(note, /127\.81 MB/)
  })

  it('uses the board revision even when capacity was never probed', () => {
    const note = crossFlashReportNote({ imageSku: EP40, wireSku: EP133, boardSku: EP133_128 })
    assert.match(note, /no reports on that board yet/)
  })

  it('states facts without predicting an outcome', () => {
    for (const note of [
      crossFlashReportNote({ imageSku: EP133, wireSku: EP40 }),
      crossFlashReportNote({ imageSku: EP40, wireSku: EP133, boardSku: EP133_128 }),
    ]) {
      assert.doesNotMatch(note, /brick|danger|risk|will fail|unsafe/i)
    }
  })
})

describe('reports.js reportIssueUrl', () => {
  const opts = {
    outcome: 'worked',
    imageSku: EP40,
    wireSku: EP133,
    boardSku: EP133_128,
    os: '2.5.1',
    maxCapacity: CAP_128,
    state: 'booted to mode:normal',
  }

  it('points at this repository', () => {
    assert.ok(reportIssueUrl(opts).startsWith('https://github.com/seajaysec/ep-unity/issues/new?'))
    assert.equal(ISSUES_URL, 'https://github.com/seajaysec/ep-unity/issues')
  })

  it('carries the combination in the title', () => {
    const body = decodeURIComponent(reportIssueUrl(opts))
    assert.match(body, /\[report\] EP-40 firmware on EP-133 — worked/)
  })

  it('includes the reported facts', () => {
    const url = decodeURIComponent(reportIssueUrl(opts))
    for (const fragment of [EP40, EP133, EP133_128, '2.5.1', '127.81 MB', 'booted to mode:normal']) {
      assert.ok(url.includes(fragment), `missing ${fragment}`)
    }
  })

  it('never carries a serial, and says so', () => {
    const url = reportIssueUrl({ ...opts, serial: 'EP133-1234567' })
    assert.ok(!url.includes('1234567'))
    assert.match(decodeURIComponent(url), /No serial number is included/)
  })

  it('fills placeholders when the device was never probed', () => {
    const url = decodeURIComponent(reportIssueUrl({}))
    assert.match(url, /\(unknown\)/)
    assert.match(url, /\(not probed\)/)
  })
})

describe('reports.js buildReport', () => {
  const opts = {
    outcome: 'worked',
    imageSku: EP40,
    imageVersion: '2.5.1',
    wireSku: EP133,
    boardSku: EP133_128,
    os: '2.5.1',
    maxCapacity: CAP_128,
    state: 'rebooted to mode:normal',
    rewritten: true,
    debugTexts: ['err sound 44 2_0_5', 'ERR SYSTEM_MODEL 58 2_5_1'],
    now: new Date('2026-08-28T12:00:00Z'),
  }

  it('names the combination in a form a human can read', () => {
    assert.equal(buildReport(opts).combination, 'EP-40 firmware on EP-133')
    assert.equal(buildReport({ ...opts, imageSku: EP133 }).combination, 'EP-133 reflash')
  })

  it('keeps the device debug lines — the part too long to retype', () => {
    assert.deepEqual(buildReport(opts).deviceDebug, opts.debugTexts)
  })

  it('does not alias the caller’s debug array', () => {
    const src = ['a']
    const report = buildReport({ ...opts, debugTexts: src })
    src.push('b')
    assert.deepEqual(report.deviceDebug, ['a'])
  })

  it('records both raw and human capacity, and the board revision', () => {
    const d = buildReport(opts).device
    assert.equal(d.sampleStoreBytes, CAP_128)
    assert.equal(d.sampleStore, '127.81 MB')
    assert.equal(d.boardRevision, EP133_128)
    assert.equal(d.announcedAtDfuBegin, EP133)
  })

  it('falls back to the wire SKU when no separate board revision is known', () => {
    assert.equal(buildReport({ ...opts, boardSku: '' }).device.boardRevision, EP133)
  })

  it('carries no serial and says what it contains', () => {
    const text = reportFileText({ ...opts, serial: 'EP133-1234567' })
    assert.ok(!text.includes('1234567'))
    assert.match(text, /No serial number, no samples, no project data/)
  })

  it('writes parseable JSON ending in a newline', () => {
    const text = reportFileText(opts)
    assert.ok(text.endsWith('\n'))
    assert.equal(JSON.parse(text).outcome, 'worked')
  })

  it('names the file by date so several can be sent', () => {
    assert.equal(reportFilename(new Date('2026-08-28T12:00:00Z')), 'ep-unity-report-2026-08-28.json')
  })

  it('defaults to GitHub issues until a form URL is configured', () => {
    // REPORT_FORM_URL is empty by default; set it and reports go there instead.
    const dest = reportDestination()
    assert.ok(dest.href.startsWith('https://'))
    assert.ok(dest.label.length > 0)
  })
})

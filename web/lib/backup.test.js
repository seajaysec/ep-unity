import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { roomCheck } from './backup.js'

// Device-reported max_capacity from /sounds metadata. The 64 MiB part reports
// 62,853,120; the 128 MiB TE032AS002 reports roughly twice that.
const NOR_64 = { maxCapacity: 62853120, freeSpace: 4 * 1024 * 1024 }
// The tool renders "60.00 MB" with U+202F (narrow no-break space) between the
// value and the unit, so literal ASCII spaces will not match these strings.
const NB = '\u202f'
const NOR_128 = { maxCapacity: 134021120, freeSpace: 4 * 1024 * 1024 }

describe('backup.js roomCheck', () => {
  it('passes when the restore fits in free space', () => {
    assert.equal(roomCheck(NOR_64, 1024 * 1024, 0), null)
  })

  it('counts reclaimed bytes from overwritten slots as available', () => {
    // 6 MB needed against 4 MB free only fits because 3 MB is being overwritten.
    assert.equal(roomCheck(NOR_64, 6 * 1024 * 1024, 3 * 1024 * 1024), null)
    assert.match(roomCheck(NOR_64, 6 * 1024 * 1024, 0), /Not enough sample space/)
  })

  it('returns null when storage was never probed', () => {
    assert.equal(roomCheck(null, 999 * 1024 * 1024, 0), null)
  })

  it('suggests a 128 MiB unit to someone on 64 MiB', () => {
    const msg = roomCheck(NOR_64, 60 * 1024 * 1024, 0)
    assert.match(msg, new RegExp(`128${NB}MiB unit would also fit more`))
  })

  it('does not suggest a 128 MiB unit to someone already on one', () => {
    // The pre-128 MiB message told every user to "use a 128 MiB unit", which
    // read as nonsense once the tool started working on those boards.
    const msg = roomCheck(NOR_128, 200 * 1024 * 1024, 0)
    assert.match(msg, /Not enough sample space/)
    assert.doesNotMatch(msg, new RegExp(`128${NB}MiB unit`))
  })

  it('reports the unit’s real capacity, not a hardcoded one', () => {
    assert.match(roomCheck(NOR_128, 200 * 1024 * 1024, 0), new RegExp(`of 127\\.81${NB}MB`))
    assert.match(roomCheck(NOR_64, 60 * 1024 * 1024, 0), new RegExp(`of 59\\.94${NB}MB`))
  })
})

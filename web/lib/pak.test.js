import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { inspectPak, planThin, buildThinnedPak, readTarMembers } from './pak.js'

describe('pak.js', () => {
  it('readTarMembers parses without choking on JSDoc (module loads)', () => {
    // Empty tar (two zero blocks)
    const empty = new Uint8Array(1024)
    assert.equal(readTarMembers(empty).size, 0)
  })

  const factory = '/Users/seajay/Downloads/ep-40-factory-content-C42FyxWp.pak'
  it('inspect + thin factory pack when present', { skip: !existsSync(factory) }, async () => {
    const pack = await inspectPak(readFileSync(factory))
    assert.ok(pack.projects.size >= 3)
    assert.ok(pack.sounds.size > 10)
    const plan = planThin(pack, [2, 8, 9])
    assert.deepEqual(plan.projects, [2, 8, 9])
    assert.ok(plan.slots.length > 0)
    const { bytes } = await buildThinnedPak(pack, [2, 8, 9])
    const again = await inspectPak(bytes)
    assert.deepEqual([...again.projects.keys()].sort((a, b) => a - b), [2, 8, 9])
    assert.equal(again.sounds.size, plan.slots.length)
  })
})

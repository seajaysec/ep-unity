import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseReleasesJson, safeFwUrl } from './catalog.js'

test('safeFwUrl keeps https and drops other schemes', () => {
  assert.equal(safeFwUrl('https://teenage.engineering/a.tfw'), 'https://teenage.engineering/a.tfw')
  assert.equal(safeFwUrl('javascript:alert(1)'), '')
  assert.equal(safeFwUrl('data:text/html,x'), '')
  assert.equal(safeFwUrl('http://example.com/a.tfw'), '')
  assert.equal(safeFwUrl('not a url'), '')
})

test('parseReleasesJson prefixes site-relative paths and blanks bad schemes', () => {
  const devices = parseReleasesJson([
    { sku: 'TE032AS001', version: '2.5.1', fw_url: '/_software/ep-133/x.tfw' },
    { sku: 'TE032AS006', version: '2.5.1', fw_url: 'httpx:alert(1)' },
  ])
  assert.equal(devices[0].fwUrl, 'https://teenage.engineering/_software/ep-133/x.tfw')
  assert.equal(devices[1].fwUrl, '')
})

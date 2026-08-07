/**
 * TE032 product list.
 *
 * This file makes no network requests, and neither does anything else in the
 * tool. The list below is what ships; a user who wants different entries can
 * hand us a releases.json they downloaded themselves and it replaces this one.
 * Same rule as the firmware images: the user fetches from TE, we only parse.
 */

export const TE_RELEASES_JSON = 'https://teenage.engineering/_software/releases.json'
export const TE_UPDATE_APP = 'https://teenage.engineering/apps/update'
export const TE_SAMPLE_TOOL = 'https://teenage.engineering/apps/ep-sample-tool'

export const SKU_EP133 = 'TE032AS001'
export const SKU_EP40 = 'TE032AS006'
export const SKU_MEDIEVAL = 'TE032AS005'

/** Default flash / catalog SKUs. Medieval is opt-in experimental. */
export const CORE_SKUS = new Set([SKU_EP133, SKU_EP40])
export const EXPERIMENTAL_SKUS = new Set([SKU_MEDIEVAL])
export const ALL_TE032_SKUS = new Set([...CORE_SKUS, ...EXPERIMENTAL_SKUS])

/** @deprecated use CORE_SKUS — kept for older imports */
export const SUPPORTED_SKUS = CORE_SKUS

/** The products this tool knows how to work with. */
export const TE032_KNOWN = [
  {
    product: 'EP-133',
    label: 'k.o. II',
    sku: SKU_EP133,
    version: '2.5.1',
    fwUrl: 'https://teenage.engineering/_software/ep-133/ep-133_firmware_2_5_1.tfw',
    downloadPage: 'https://teenage.engineering/downloads/ep-133',
    experimental: false,
  },
  {
    product: 'EP-40',
    label: 'riddim',
    sku: SKU_EP40,
    version: '2.5.1',
    fwUrl: 'https://teenage.engineering/_software/ep-40/ep-40_firmware_2_5_1.tfw',
    downloadPage: 'https://teenage.engineering/downloads/ep-40',
    experimental: false,
  },
  {
    product: 'EP-1320',
    label: 'medieval',
    sku: SKU_MEDIEVAL,
    version: '1.5.0',
    fwUrl: 'https://teenage.engineering/_software/ep-1320/ep-1320_firmware_1_5_0.tfw',
    downloadPage: 'https://teenage.engineering/downloads/ep-1320',
    experimental: true,
  },
]

export function isCoreSku(sku) {
  return CORE_SKUS.has(sku)
}

export function isExperimentalSku(sku) {
  return EXPERIMENTAL_SKUS.has(sku)
}

export function isSupportedSku(sku, { medieval = false } = {}) {
  if (CORE_SKUS.has(sku)) return true
  return medieval && EXPERIMENTAL_SKUS.has(sku)
}

/** @deprecated use TE032_KNOWN — kept for older imports */
export const TE032 = TE032_KNOWN

export const FACTORY_PACKS = [
  {
    product: 'EP-133',
    sku: SKU_EP133,
    filename: 'ep-133-factory-content-DRyE_DHC.pak',
    url: 'https://teenage.engineering/apps/ep-sample-tool/assets/ep-133-factory-content-DRyE_DHC.pak',
  },
  {
    product: 'EP-40',
    sku: SKU_EP40,
    filename: 'ep-40-factory-content-C42FyxWp.pak',
    url: 'https://teenage.engineering/apps/ep-sample-tool/assets/ep-40-factory-content-C42FyxWp.pak',
  },
]

export function findBySku(sku, list = TE032_KNOWN) {
  return list.find((d) => d.sku === sku) ?? null
}

export function isTe032(sku) {
  return typeof sku === 'string' && sku.startsWith('TE032')
}

const USER_CATALOG_KEY = 'ep-unity.userCatalog'

/**
 * Normalise TE's releases.json into our device shape.
 * @param {any} data parsed releases.json
 */
export function parseReleasesJson(data) {
  const raw = Array.isArray(data) ? data : data?.devices || data?.products || []
  const devices = raw
    .filter((d) => ALL_TE032_SKUS.has(d.sku))
    .map((d) => {
      const fb = TE032_KNOWN.find((f) => f.sku === d.sku)
      const url = d.fw_url || d.fwUrl || ''
      return {
        product: d.product || fb?.product || d.sku,
        label: d.label || fb?.label || '',
        sku: d.sku,
        version: d.version || fb?.version || '',
        // releases.json uses site-relative paths.
        fwUrl: url.startsWith('http') ? url : `https://teenage.engineering${url}`,
        downloadPage: fb?.downloadPage || '',
        experimental: EXPERIMENTAL_SKUS.has(d.sku),
      }
    })
  if (!devices.some((d) => CORE_SKUS.has(d.sku))) {
    throw new Error('no EP-133 / EP-40 entries — is this really releases.json?')
  }
  return devices
}

/** Persist a user-supplied catalog so they only fetch it from TE once. */
export function saveUserCatalog(devices) {
  try {
    localStorage.setItem(
      USER_CATALOG_KEY,
      JSON.stringify({ savedAt: new Date().toISOString(), devices }),
    )
  } catch {
    /* private mode — the catalog just will not persist */
  }
}

export function loadUserCatalog() {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_CATALOG_KEY) || 'null')
    return raw?.devices?.length ? raw : null
  } catch {
    return null
  }
}

export function clearUserCatalog() {
  try {
    localStorage.removeItem(USER_CATALOG_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{devices: object[], fromUser: boolean, savedAt?: string}}
 */
export function loadFirmwareCatalog() {
  const mine = loadUserCatalog()
  if (mine) return { devices: mine.devices, fromUser: true, savedAt: mine.savedAt }
  return { devices: TE032_KNOWN.map((d) => ({ ...d })), fromUser: false }
}

/**
 * @returns {{packs: object[]}}
 */
export function loadFactoryCatalog() {
  return { packs: FACTORY_PACKS.map((p) => ({ ...p })) }
}

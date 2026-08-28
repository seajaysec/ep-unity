/**
 * Which SKU goes on the wire at DFU_BEGIN.
 *
 * The device answers with two different SKUs and they are not interchangeable:
 *
 *   sku       the hardware/board revision. TE032AS001 is the 64 MiB EP-133;
 *             TE032AS002 is the 128 MiB board.
 *   base_sku  the firmware lineage the board runs. The AS002 board reports
 *             base_sku TE032AS001, because AS001 is the only k.o. II image TE
 *             publishes — there is no AS002 firmware to download.
 *
 * DFU_BEGIN must announce the lineage. Announcing the board revision fails with
 * status=0x1 before a single byte of the image is sent, which is why 128 MiB
 * units appeared to be unsupported: stock TE images were rejected too, so it
 * read as "the tool doesn't know this device" rather than "wrong SKU field".
 *
 * Only the DFU GREET frame carries base_sku. The bundled kotu parseDeviceInfo
 * pulls product/os_version/serial/sku out of the FILE metadata string and drops
 * everything else, so a FILE-only session has no live lineage to read and has
 * to fall back on what an earlier GREET banked.
 */

/**
 * @typedef {object} SkuSources
 * @property {{sku?: string, base_sku?: string}} [metadata] live DFU GREET metadata
 * @property {{sku?: string, baseSku?: string}} [snapshot] last-known device snapshot
 * @property {{baseSku?: string, baseSkuFor?: string}} [profile] stored per-serial profile
 */

/**
 * SKU to announce at DFU_BEGIN. Never the board revision when a lineage is known.
 * @param {SkuSources} sources
 * @returns {string}
 */
export function pickWireSku({ metadata, snapshot, profile } = {}) {
  // A live GREET is the truth and the only frame that reports base_sku, so when
  // we have one it decides alone. Cross-flashing changes what the device
  // answers; a value banked before that must not override it.
  const live = metadata ? metadata.base_sku || metadata.sku : ''
  if (live) return live
  return snapshot?.baseSku || rememberedBaseSku(profile, snapshot) || snapshot?.sku || ''
}

/**
 * Board revision, for display only. Never put this on the wire.
 * @param {SkuSources} sources
 * @returns {string}
 */
export function pickBoardSku({ metadata, snapshot } = {}) {
  return metadata?.sku || snapshot?.sku || ''
}

/**
 * Lineage banked by an earlier GREET on this serial, but only while the device
 * still answers with the SKU it was banked against. After a cross-flash that
 * pairing is stale, and announcing the old lineage would be the same class of
 * mistake as announcing the board revision.
 */
function rememberedBaseSku(profile, snapshot) {
  if (!profile?.baseSku || !profile.baseSkuFor) return ''
  return profile.baseSkuFor === snapshot?.sku ? profile.baseSku : ''
}

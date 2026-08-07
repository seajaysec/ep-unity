# NOR flash variance (from TE + firmware look)

**Source:** TE EP-series response (David/Johan, Jul 17 2026) plus offline
compare of official EP-133 / EP-40 OS **2.5.1** `.tfw` files in `fw/`.

## What TE said

Cross-flashing is unsupported. Field units use **different NOR flash types and
densities**. Publishing should warn about incompatibility, data loss, bricking,
and warranty void. That is stronger and more specific than “SKU check is
client-side.”

## What the packages look like

| Region | Offset | Notes |
|---|---|---|
| `babecafe` header | `0x00` | SKU at bytes 15–18 (only host gate we demonstrated) |
| `beefcafe` mid | `0x40` | Clear metadata; EP-133 vs EP-40 differ only in SKU + a 3-byte field (likely checksum) |
| Encrypted app blob | `0x400`, len `389392` | Entropy ≈ 8.0; **not** decompilable as-is |
| Trailer | after blob | ~89 KiB; mixed shared/differing ARM-looking bytes; no clear JEDEC string table |

Identical encrypted-blob prefix: **128 zero bytes**, then divergent ciphertext.
XOR of the two blobs is high-entropy → not a simple shared keystream with mostly
shared plaintext (or keys differ per SKU).

Implication: **we cannot yet locate or patch a NOR driver / density table inside
the app image.** “Decompile both and fix the NOR region” is blocked on decrypt
(or a device-side dump of the mapped image).

## Likely failure modes (hypothesis)

TE’s note points at *hardware BOM variance within the same SKU*, not just
EP-133 vs EP-40 firmware differences:

1. **Wrong density assumption** — firmware / FS layout writes past end of chip
   → corruption or brick.
2. **Wrong type / command set** — erase/program opcodes or SFDP expectations
   differ (e.g. 4-byte address mode, QE bit, block protect) → silent bad writes
   or failed DFU.
3. **Partition / sample pool size** — public docs (kmorrill) cite ~128 MB sample
   pool on both models; field units may still ship smaller NOR. A cross-flash
   that “works” on a 64 MB unit (as in the disclosure unit) does not prove
   safety on every board.

None of these are proven from the ciphertext alone; they are the risk model TE
asked us to surface.

## Tooling direction

1. **Warn first (ship now):** web tool + blog must quote TE’s NOR / brick /
   warranty language before any flash.
2. **Compare cleartext only:** header/`beefcafe` diff is already enough to show
   packages are SKU-gated wrappers around different encrypted bodies — no
   density field exposed there.
3. **Decrypt / dump next:** recover plaintext (bootloader hook, side-channel,
   or key from device) then search for JEDEC ID tables, SFDP parsers, capacity
   switches (`1 << (id[2] - …)`), and partition constants.
4. **Device probe (preferred safety gate):** if we can read JEDEC ID or reported
   capacity over SysEx/debug, refuse cross-flash when density/type is unknown
   or mismatched — even without patching firmware.
5. **Reference:** `vendor/ep-series-sysex` (cloned) for identity / FILE / recovery
   language; it documents flash-format recovery after bad project writes, not
   NOR ID probing.

## Files

- `fw/ep-133_firmware_2_5_1.tfw`
- `fw/ep-40_firmware_2_5_1.tfw`
- `fw/ep-40_as_TE032AS001.tfw` (SKU-rewritten lab copy)
- `vendor/ep-series-sysex/`

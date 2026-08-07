# Decrypt / DFU oracle — milestone result

**Plan item:** Attempt AES/key recovery via DFU/bootloader oracle; test on
EP-133 and EP-40 blobs.

**Verdict:** Offline decrypt **blocked**. No MIDI-side encryption oracle
exists on EP DFU. EP-133 and EP-40 **share** KEYHASH (one ECIES pubkey); each
image still has a **distinct** per-image AES session key in `ENC_EC256`.

## What was tried

Documented in detail in [`blob-cryptanalysis.md`](blob-cryptanalysis.md). Summary:

| Approach | Result |
|---|---|
| Header / SKU / version-derived AES | No Cortex vector hits |
| Trailer-as-key sliding window | No hits |
| XTEA (classic OP-1) | No hits |
| Host updater JS for keys | None — streams ciphertext only |
| DFU read-back / dump opcode | **None** (write-only) |
| Abort after BEGIN (no PERFORM) | Safe; no keystream leak on wire |
| Mid-PERFORM interrupt | Brick window; still no read channel — **not used** |

Tooling: [`tools/dfu_oracle_probe.py`](../../tools/dfu_oracle_probe.py) —
offline KEYHASH compare + live BEGIN-only probe.

## KEYHASH comparison (family vs Medieval)

| Image | KEYHASH |
|---|---|
| EP-133 2.5.1 / EP-40 2.5.1 (and older KO images tested) | `d349a2d4…84e5` |
| EP-1320 Medieval 1.5.0 | `40e5051c…0226` (**different**) |

Same KEYHASH ⇒ same device encryption **public** key for KO/Riddim. That does
**not** mean one AES key opens both blobs: `ENC_EC256` wraps a **random
per-image** AES-128 key. Decrypting either blob still needs the device
**private** key (or a plaintext dump after on-device decrypt).

## Why OP-Z / OP-1f oracles do not transfer

Those products exposed recoverable IV / serial oracles and different packaging.
EP `.tfw` uses MCUboot `IMAGE_F_ENCRYPTED_AES128` + `ENC_EC256` with no clear IV
in the host file (`0xf0–0xff` are zeros). DFU never returns the primary slot.

## What would unlock decrypt

1. **SWD XIP dump** of mapped app flash after boot (`0x10000000…`) — plaintext
   already decrypted by the device ([`swd-dump-path.md`](swd-dump-path.md)).
2. Extract ECIES private key from CM0+ bootloader / SFlash whose pubkey SHA-256
   equals KEYHASH `d349a2d4…` — then offline unwrap of future same-KEYHASH `.tfw`s.

Until then: **Supertone and all app logic remain opaque** in the ciphertext.

## Live probe (optional)

```bash
python3 tools/dfu_oracle_probe.py \
  --tfw fw/ep-133_firmware_2_5_1.tfw \
  --also fw/ep-40_firmware_2_5_1.tfw \
  --also fw/ep-1320_firmware_1_5_0.tfw
```

# EP-133 / EP-40 `.tfw` encrypted blob — cryptanalysis

**Date:** 2026-07-20  
**Verdict:** Offline decrypt **failed**. Ciphertext is MCUboot AES-128-CTR with a **per-image session key** wrapped in **ECIES-P256 (`ENC_EC256`)**. The unwrapping private key is **device-side only** (not in the `.tfw`, not in the host updater, not in the plaintext trailer).

Artifacts: `fw/extracted/ep133_2_5_1_*`, `fw/extracted/ep40_2_5_1_*`.

---

## 1. Layout (refined)

| Offset | Content |
|--------|---------|
| `0x00` | `babecafe` host header (SKU, version, checksum) |
| `0x40` | `beefcafe` transfer header |
| `0x80` | **MCUboot image header fields** (see below) |
| `0x400` | Encrypted payload, length `img_size = 0x5f110` (389392). First **128 bytes are zeros**, then high-entropy ciphertext |
| `0x5f510` | 128-byte high-entropy **pre-TLV gap** (not covered by `img_size`) |
| `0x5f590` | MCUboot TLV info `0x6907`, total 299 bytes |
| `0x5f6bb` | Zero pad, then plaintext Thumb (LittleFS 2.10.1 + helpers) |

EP-133 file size 479768; EP-40 479776 (trailer length differs by 8).

### MCUboot header at `0x80` (both SKUs identical except surrounding TE meta)

```
magic      = 0x96f3b83d   IMAGE_MAGIC
load_addr  = 0
hdr_size   = 0x0400
prot_tlv   = 0
img_size   = 0x0005f110  (389392)
flags      = 0x00000004  IMAGE_F_ENCRYPTED_AES128
version    = 02 05 01 00 00 00 00 00
```

This is decisive: TE did not invent a private cipher for the app blob; they ship a **standard MCUboot encrypted image** inside the `babecafe`/`beefcafe` wrapper.

---

## 2. TLV area (`0x5f590`, tot=299)

Parsed on both `ep-133_firmware_2_5_1.tfw` and `ep-40_firmware_2_5_1.tfw`:

| Type | Name | Notes |
|------|------|--------|
| `0x10` | SHA256 | Different per SKU (hash of **plaintext** per MCUboot rules — will not match any ciphertext range) |
| `0x01` | KEYHASH | **Identical** on EP-133 and EP-40: `d349a2d4e60588d7759108efb5a25c9363ca38c109a08d5c8b3f6440d28f84e5` |
| `0x22` | ECDSA256 | DER signature, different per image |
| `0x32` | ENC_EC256 | **145 bytes**, different per image — ECIES-wrapped AES session key |

`KEYHASH` is the SHA-256 of the **device encryption public key** used for ECIES. Same hash on both SKUs ⇒ **one shared ECIES keypair** for the EP-32 family (at least AS001/AS006), not SKU-derived.

`ENC_EC256` starts with `0x04` + 64-byte secp256r1 ephemeral point (65 bytes), then 80 bytes of MAC + encrypted AES key material. Upstream MCUboot documents 113 (AES-128) or 129 (AES-256) for `pub ‖ mac ‖ cipherkey`; **145 is a non-stock length** (likely Infineon/TE fork or extra 16-byte field). Structure is still clearly ECIES-P256 key transport, not a host-side password.

---

## 3. What encryption is (and is not)

### Confirmed

- **AES-128-CTR** over the payload (`IMAGE_F_ENCRYPTED_AES128`), counter from 0 per MCUboot design.
- **Random per-image AES key**, wrapped with **ECIES-P256** into `ENC_EC256`.
- Host DFU (`vendor/te-update` / our `web/lib/dfu.js`) sends ciphertext **verbatim**; no `SubtleCrypto`, no WASM decrypt, no key material in JS.
- EP-133 vs EP-40: encrypted bodies **fully differ** after the 128 zero prefix (0 identical 16-byte blocks). Expected: different plaintext **and** different session keys (avalanche), not a simple SKU XOR.
- Trailer after TLV is **not** encrypted; sliding-window AES key search over the trailer (every 4-byte aligned 16/32-byte window, ECB/CBC-0/CTR-0) produced **zero** Cortex-M vector-table hits.
- Candidate keys from SKU/version/`babecafe`/`beefcafe`/NIST vectors/header fields: **no hits**.
- XTEA (classic OP-1): **no hits**.
- No AES S-box tables in the `.tfw` (crypto lives in on-device bootloader / Crypto block).
- Public KEYHASH preimage (raw uncompressed pubkey) is **not** present anywhere in the file.

### Not OP-Z / OP-1f identical packaging

- OP-Z `.zfw`: IV at `0x70`, encrypted filename at `0x300`, AES-256-CBC, oracle via serial.
- OP-1f (forum `_bt`): IV at `0xf0–0xff`, blob at `0x380`.
- EP `.tfw`: **`0xf0–0xff` are zeros** (no clear IV). Session nonce is implicit CTR-from-zero; confidentiality of the AES key is entirely in `ENC_EC256`.

### 128 zero prefix

AES-CTR of zero plaintext cannot yield zero ciphertext. Those 128 bytes are therefore **clear padding** (effective encrypt start at `0x480`) or an imgtool/`hdr_size` quirk — not a usable keystream leak by itself.

### Pre-TLV 128-byte gap

High entropy; sits between `hdr_size+img_size` and the TLV info magic. Not required to conclude the ECIES dead-end; left as a TE packaging oddity.

---

## 4. Attacks attempted (offline)

1. Header/IV/SKU-derived AES-128/256 CBC, CTR, ECB  
2. ChaCha20 with SHA-derived keys  
3. Trailer sliding-window AES key search (~22k windows × modes)  
4. Mid-header sliding-window keys  
5. Ciphertext-prefix-as-IV CBC  
6. XTEA block trials  
7. zlib/raw inflate on blob  
8. Treat `ENC_EC256` trailing bytes as raw AES key  
9. Exhaustive SHA-256 region match against TLV hash (fails — hash is over **decrypted** image)  
10. Web/GitHub search: no public EP-133 decrypt tool or leaked ECIES private key; OP-Z key recovery required a **device encryption oracle** + bootloader dump

---

## 5. Why this is a hard stop for offline RE

MCUboot’s own threat model (encrypted images docs):

> decrypting requires a private key … already in the device  
> It does **not** protect against attaching a JTAG and reading the internal flash

So:

| Path | Status |
|------|--------|
| Derive key from `.tfw` header / SKU | Dead — key is ECIES-wrapped, not derived |
| Host updater leak | Dead — no decrypt code |
| Trailer contains AES or EC privkey | Dead — search negative; KEYHASH pubkey absent |
| Brute ECIES / AES-128 | Dead — 128-bit session key + EC discrete log |
| **SWD dump of primary slot / XIP after boot** | **Open — best path** |
| Extract ECIES privkey from CM0+ bootloader via SWD | Open — enables offline decrypt of future `.tfw`s |
| Device-side oracle (OP-Z style) | Unknown if EP DFU exposes decrypt-to-serial; not observed in updater |

---

## 6. Best remaining path

1. **Open the unit**, locate PSoC6 SWD (SWDIO/SWDCK/XRES/GND/Vref). Medium teardown posts confirm PSoC6; production may have DAP listening window shortened or locked — try acquire before assuming fused shut.
2. After a normal boot (or post-DFU install), **`dump_image` from `0x10000000`** over the app region (at least through VA `0x100df490` trailer / LittleFS). Primary slot should hold **decrypted** XIP.
3. Grep dump for `lfs_config`, `block_count`, JEDEC/`0x9F`, SFDP — that answers NOR density without ever unwrapping ECIES.
4. Optional: dump CM0+ bootloader / SFlash for the ECIES private key (search for secp256r1 scalar whose pubkey SHA-256 equals `KEYHASH` above). That unlocks offline `.tfw` decrypt forever for this keyhash.

Do **not** rely on cross-flashing EP-40↔EP-133 packages to learn NOR size; that risks brick and does not decrypt.

---

## 7. Decisions made

| Picked | Rejected | Why |
|--------|----------|-----|
| Treat blob as MCUboot AES-CTR + ENC_EC256 | Custom TE stream cipher / host AES | `IMAGE_MAGIC`, `flags=4`, TLV `0x32` are unambiguous |
| Declare offline decrypt a dead-end | Keep guessing SKU keys | ECIES privkey absent from all offline material; attacks exhausted |
| Recommend SWD XIP dump next | DFU oracle / more JS scraping | Updater has no crypto; MCUboot docs explicitly allow JTAG read of internal flash |
| Keep ciphertext + TLV extracts under `fw/extracted/` | Claim plaintext recovery | No valid plaintext produced |

---

## 8. Quick reference hashes

| Item | Value |
|------|--------|
| KEYHASH (both) | `d349a2d4e60588d7759108efb5a25c9363ca38c109a08d5c8b3f6440d28f84e5` |
| EP-133 blob SHA-256 | `a28925db75e74b4c5853f8f7adc3125fbc5d0a3fe628467e8624071ff05274cf` |
| EP-40 blob SHA-256 | `83b7e334cbc3bb087b6b73c4b6a50ec6b6b18219b12fefcf4a31acffe0123e87` |
| EP-133 TLV SHA-256 | `85d7e6b6f5abc78b16a3d3408bf0487de01373722b3eef5dce95c8fa09a2e462` |
| EP-40 TLV SHA-256 | `9836b896eddd380e67f42d60e952c9e8f20e754e1e8cc836d100fdab8fe467d9` |

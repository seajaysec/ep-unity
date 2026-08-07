# Supertone → EP-133 feasibility memo

**Plan item:** If decrypted: diff binaries, locate Supertone, assess EP-133 port.
**Status:** Decrypt **did not succeed** (see [`decrypt-oracle.md`](decrypt-oracle.md)).
This memo records what can be said without plaintext app images, and what
hardware path unlocks the rest.

---

## Goal (original)

Understand how EP-40 Riddim wires **Supertone** (built-in synth engines) and
whether a port to EP-133 K.O. II is feasible (patch vs reimplement).

## Gate status

| Prerequisite | Status |
|---|---|
| TFW layout documented | Done — MCUboot AES-128-CTR + ENC_EC256 |
| Same-SKU DFU harness | Done — [`dfu-roundtrip.md`](dfu-roundtrip.md) |
| App plaintext for EP-40 and EP-133 | **Blocked** — device ECIES private key / SWD dump required |
| Locate Supertone in EP-40 binary | **Blocked** on plaintext |
| Diff EP-40 ↔ EP-133 app | **Blocked** on plaintext (ciphertexts fully differ; not informative) |

## What we know without decrypt

### Packaging

- Supertone almost certainly lives in the **encrypted app blob** (`0x400`,
  len `389392`), not the clear LittleFS trailer (~89 KiB of FS library code).
- Trailer string searches (`supertone`, `siren`, engine names): **no hits** in
  either 2.5.1 `.tfw` trailer.
- EP-133 and EP-40 share KEYHASH → same encryption **pubkey**; different
  plaintext + different session keys → ciphertext avalanche. Header SKU is
  **not** the crypto boundary.

### User-facing / FILE layer (epsysex)

From [`vendor/ep-series-sysex/docs/ep40.md`](../../vendor/ep-series-sysex/docs/ep40.md)
(project format + audio sweeps — **not** DSP source):

- Riddim pad records are **29 bytes** (vs 27 on KO); `supports_supertone=True`.
- Engines **0..9** store symbol `1001..1010` as `sym−1` in the slot field; knobX/Y
  at bytes 27–28 (0–254). Knob semantics measured by USB-audio sweep on 2.5.1.
- Supertone symbols have metadata but **no readable PCM** (FILE read fails) —
  engines are live-only from the host’s perspective.
- That documents **how projects address** Supertone, not how the DSP is
  implemented or RAM/CPU cost vs the sampler path.

### Live cross-flash (informational, outside original “no cross-SKU” phase)

This unit runs EP-40 OS on legacy EP-133 **64 MB** hardware. Supertone UI/engines
are therefore **present in that OS image** when flashed — but we still cannot
disassemble them without a dump. Cross-flash does not reveal source.

## Assessment (conditional)

**If** SWD XIP dump (or ECIES privkey) is obtained:

1. Load EP-40 plaintext at VA `0x10000000…`; string/xref hunt for Supertone
   preset tables (10 engines, param pairs per TE docs).
2. Diff against EP-133 plaintext: shared sampler/sequencer vs SKU-ifdef synth.
3. Estimate:
   - **Patch:** if synth is already linked behind SKU checks → flip gates / UI.
   - **Port:** if EP-40-only object files → copy + resolve RAM/CPU vs sampler
     polyphony on 64 MB units.
4. Flash-size / NOR density remains a separate risk (TE warning).

**Until then:** clean-room reimplementation from hearing/docs is the only
host-side path; Option B (“see how TE wired it”) is gated on physical dump.

## Recommended next hardware step

Follow [`swd-dump-path.md`](swd-dump-path.md):

1. Backup user FS (`tools/ep_backup.py`).
2. Open unit; attempt DAP acquire; dump XIP after successful boot of EP-40 image.
3. Run `tools/analyze_xip_dump.py`; resume Supertone symbol hunt in Ghidra.

## Conclusion

Milestone success criteria from the decrypt-first plan:

| Criterion | Result |
|---|---|
| Documented TFW layout | **Met** |
| Reproducible DFU roundtrip | **Met** |
| Decrypted app images **or** write-up of why not | **Met** — write-up: ECIES device key; no MIDI oracle |
| Locatable Supertone entrypoints | **Not met** — blocked on decrypt; memo explains gate |

Supertone port feasibility remains **unknown pending plaintext**. Highest-value
next action is SWD dump, not further MIDI crypto experiments.

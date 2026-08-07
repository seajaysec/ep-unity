# How to get NOR geometry — actually safe options

TE (David/Johan) warned field units ship **different NOR types and densities**.
Chris’s unit is a **legacy 64 MB** EP-133; current SKUs are often **128 MB**.
Goal: understand / optionally patch flash handling. This note replaces the
earlier “ship warnings + SKU rewrite” hand-wave with what the code and the
cloned repos actually support.

## Short answer

**Do not flash to learn NOR.** DFU never returns plaintext. The host sends
ciphertext; the device decrypts internally; there is no DFU read opcode and no
documented recovery if MIDI dies mid-`PERFORM`. Cross-flashing (already done
once) also does not expose flash tables.

**Safest research path:** reverse the **unencrypted trailer** offline (already
contains LittleFS 2.10.1 + Thumb code + 64/128 MiB constants), then optionally
confirm live with **read-only** SysEx. Open the case for SWD only if you need
the encrypted app blob in plaintext.

## What the cloned repo actually is

[`vendor/ep-series-sysex`](https://github.com/kmorrill/ep-series-sysex) is a
**user-filesystem** lab (projects + samples over FILE SysEx). Exhaustive
docs+code review:

| Wanted | Present? |
|---|---|
| Dump `/sounds` + `/projects` (LittleFS user tree) | Yes — verified |
| MIDI Identity / GREET metadata | Yes |
| Debug ASCII frames (`err lfs`, `err 8200 …`) | Yes — stop + power-cycle |
| Raw NOR / JEDEC / QSPI / peek-poke | **No** |
| DFU / bootloader dump / brick recovery | **No** — explicitly “unaddressed risk” |
| 64 MB vs 128 MB detection | **No** — docs quote TE’s 128 MB sample limit only |

FILE top-level cmds are only GREET + FILE. “Flash format” in that repo means
**wipe the user FS from the device UI**, not a firmware/NOR dump.

So: use it to **backup the unit before any risky work**, not to answer NOR.

## What our DFU path actually is

`web/lib/dfu.js`: `BEGIN → CHUNK* → PERFORM → EXIT` (optional `ENTER` if BEGIN
rejects). Body = `.tfw[64:]` **verbatim** (clear `beefcafe` + encrypted blob +
trailer). TE updater JS has **no decrypt**. Abort before `PERFORM` is probably
OK (staging not committed); during/after `PERFORM` is the brick window; if the
unit stops enumerating MIDI, this tree has no recovery path.

## Offline finding that changes the plan

The `.tfw` is not “all encrypted”:

| Region | Role |
|---|---|
| `0x00` header / `0x40` beefcafe | Clear SKU metadata |
| `0x400` len `389392` | Encrypted app — entropy ≈ 8.0 |
| Trailer ~89 KiB | **Mostly shared Thumb**, clearish pockets, **`littlefs-2.10.1/lfs.c`** string |

Extracted under `fw/extracted/`:

- `ep133_trailer.bin` / `ep40_trailer.bin`
- `ep133_trailer_head_48k.bin` (lowest-entropy / most shared)

Observations:

- Trailer `+0x0000…0xc000`: largely shared (often &lt;10% differ).
- Trailer `+0xd000…`: ~95% differ (model-specific packed region).
- Both images embed `../../src/../ext/littlefs-2.10.1/lfs.c`.
- Both trailers contain the same LE `0x04000000` (64 MiB) and `0x08000000`
  (128 MiB) constant sites in the shared head — consistent with **runtime
  multi-density support**, not two completely different flash drivers.
- Near the `littlefs\0` label, EP-133 has `0x20000100` where EP-40 has
  `0x20000200` (needs RE — candidate config/size field, not proven).
- `err 8200` dumps from kmorrill include `100f0696 10040a15 2c006008` — PSoC6
  XIP (`0x100xxxxx`) + a peripheral-looking word; useful once we have a map.

**Implication:** NOR density handling is likely already in the **clear trailer /
shared FS layer**, not locked inside the encrypted app. That is the thing to
decompile first — **zero brick risk**.

## Ranked options (safest → least)

### 1. Offline trailer RE (recommended next)

Load `fw/extracted/ep133_trailer.bin` in Ghidra/Binary Ninja as Cortex-M
(PSoC6 XIP base often `0x10000000`; vector-ish hit near trailer `+0x3b38` with
`Reset≈0x100e2d81`).

Hunt:

- `lfs_config` (`block_size`, `block_count`, `cache_size`)
- JEDEC `0x9F` / SFDP readers
- Branches on capacity ID byte / size constants 64 MiB vs 128 MiB
- Erase/program paths (SMIF)

Diff EP-133 vs EP-40 trailer **only where they diverge** after confirming the
shared head is the flash/FS code.

### 2. Live, read-only, on the connected 64 MB unit

No DFU. Serialize FILE behind one lock (their `err lfs 6327` lesson).

1. Full `.pak` backup (projects + sounds) via epsysex — recovery for *user*
   data, not firmware.
2. `identity.py` + GREET (sku / mode / os / serial).
3. `LIST` root — confirm no surprise nodes.
4. `sound_tool.py list` — occupied MB (usage ≠ chip size; soft signal only).

Do **not** fill the sample pool to “find the ceiling” on the only unit — client
does not enforce capacity; a bad fill is a corruption path.

### 3. Same-SKU official reflash (only to validate DFU hygiene)

Reflash **stock EP-133 2.5.1** onto this EP-133. Tests ENTER/BEGIN/CHUNK/PERFORM
recovery behavior. Teaches nothing about NOR tables. Still avoid killing the
client during `PERFORM`.

### 4. Physical: SWD / chip-off (only if trailer RE stalls)

PSoC6 SWD after opening the case (or desolder NOR) dumps mapped flash /
post-decrypt image. This is how you get the **encrypted app** plaintext.
Warranty already void under TE’s modification language; risk is physical, not
“soft-brick with no MIDI.”

### 5. Cross-flash / speculative DFU — do not use for this goal

Already demonstrated SKU bypass. TE’s NOR warning applies. Does not decrypt
anything for us. Highest software-brick risk relative to information gained.

## What “patching NOR for safety” would mean later

Only after trailer (and maybe app) RE:

- Prefer a **host-side refuse gate**: detect or require user-attested density
  (64 vs 128) before offering cross-flash — no binary patch needed.
- Firmware patch of density tables is last resort and needs a known-good
  same-SKU recovery image + acceptance that `PERFORM` is irreversible without
  hardware debug.

## Decision

**Picked:** offline trailer RE + read-only backup/probe on the live 64 MB unit.  
**Rejected:** using DFU as a dump channel (it isn’t one); filling flash to
measure capacity; more cross-flashes for analysis.  
**Why:** evidence in the packages themselves (LittleFS string + shared trailer)
plus epsysex/DFU code review showing no read-back path.  
**Ramification:** trailer RE is done — see
[`trailer-static-analysis.md`](trailer-static-analysis.md). Result: trailer is
**LittleFS 2.10.1 only**; NOR density is set by the encrypted app’s
`lfs_config.block_count`. Next step is SWD/XIP dump or blob decrypt, not more
trailer patching.

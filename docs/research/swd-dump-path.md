# SWD / plaintext dump path (EP-133 K.O. II)

**Goal:** recover **plaintext application** (JEDEC / density / `lfs_config` builder) without relying on DFU readback. DFU only pushes ciphertext; there is no read opcode ([`nor-safe-path.md`](nor-safe-path.md)).

**Unit under study:** connected **64 MB legacy** EP-133 (user accepts research risk; prefer non-brick paths).

**Related local work:** trailer RE proved LittleFS lives in the clear trailer; NOR density selection is in the **encrypted app** ([`trailer-static-analysis.md`](trailer-static-analysis.md)).

---

## Executive answer

| Question | Answer |
|---|---|
| **Best dump method for firmware plaintext** | **SWD memory dump of mapped code flash after a successful DAP acquire** (`0x10000000…`), ideally post-boot so any on-chip decrypt has already run. Tools: Infineon OpenOCD / KitProg3 / MiniProg4 / J-Link. |
| **Best dump method for NOR density alone** | **SPI `RDID` (0x9F) on the external Winbond** with MCU held in reset — no SWD, no DFU, no write. Teardown part is W25Q512JV → expect JEDEC `EF 40 20` (512 Mbit = 64 MiB). |
| **Chip ID (public evidence)** | MCU: Infineon **PSoC 6**, dual-core + **BLE 5.0** capability → almost certainly **PSoC 63** family (`CY8C63xxxx`), **exact marking not photographed/transcribed**. NOR: **Winbond W25Q512JV**. Codec: **Cirrus CS42L52**. Model FCC text: **TE032AS001** (no dedicated FCC ID photos for EP-133 under grantee Z23). |
| **Is SWD likely locked?** | **Likely yes on a shipping TE unit** (TOC2 `SWJ_PINS_CTL` / 0 ms listen window, and/or lifecycle + eFuse DAP disable — irreversible). **Not proven** until a power-cycle acquire is attempted. Try non-destructive attach first; do not assume open. |

---

## Hardware map (community teardown)

Source: [Tina Lakinger — “Hasty Teardown of the Teenage Engineering KO-II EP-133”](https://medium.com/@Lkngrrr/hasty-teardown-of-the-teenage-engineering-ko-ii-ep-133-sampler-composer-34933e9ad497) (Oct 2024).

| Area | Part | Notes |
|---|---|---|
| Upper-left MCU | Infineon PSoC 6 | Dual CPU + BLE 5.0 mentioned; no `CY8C…` string published |
| Lower-right NOR | **Winbond 25Q512JV** | 512 Mbit = **64 MiB** — matches legacy 64 MB units; current retail copy says 128 MB |
| Lower-left codec | Cirrus **CS42L52** | Discontinued; speaker drive |
| Construction | Single PCBA | 8 back screws + ~43 board screws; boots on USB with board bare |

**Not found in public sources:**

- Exact PSoC marking / package pinout on the EP-133 PCB
- Named SWD/test-point silkscreen (SWDIO / SWDCLK / nRESET)
- Published schematics (see “Open schematics” below)
- Community plaintext firmware dump or Ghidra project of the **encrypted app**
- FCC internal photos for EP-133 (grantee [Z23](https://fccid.io/Z23) lists OP-XY, TP-7, etc., but **no EP-133 / TE032** filing with photo exhibits)

Comments under the teardown confirm flash upgrade needs **firmware changes**, not just chip swap ([Sergey Moraru](https://medium.com/@sm00001/to-swap-it-with-another-size-i-e-477ab4920efe)) — consistent with our trailer analysis.

### Memory model (what to dump)

| Region | Typical PSoC6 map | EP-133 role (inferred) |
|---|---|---|
| Application flash | `0x10000000` | Encrypted `.tfw` blob decrypts here; trailer Thumb already maps ~`0x100df490` |
| Work / aux flash | `0x14000000` | Boot/config (device-dependent) |
| Supervisory flash | `0x16000000` | TOC2, NAR, keys — **read carefully; do not write** |
| External SMIF XIP | often `0x18000000` | Possible; sample FS more likely command-mode SPI to Winbond |
| External NOR (SPI) | not in CPU map unless SMIF XIP | User samples / LittleFS — **not** a substitute for app plaintext |

Trailer RE already placed clear LittleFS code in **internal** XIP space and showed `lfs_config` hooks pointing **into** the encrypted VA range (`0x10024xxxx` / `0x1005xxxx`). So the dump that unblocks JEDEC handling is **MCU flash via SWD**, not a blind NOR chip-off of samples.

---

## Community / crypto landscape

| Asset | Status |
|---|---|
| Encrypted `.tfw` app blob | Local: `fw/ep-133_firmware_2_5_1.tfw` @ `0x400`, len `389392`, entropy ≈ 8.0 ([`nor-flash-variance.md`](nor-flash-variance.md)) |
| Clear trailer + LittleFS | Analyzed; density **not** here ([`trailer-static-analysis.md`](trailer-static-analysis.md)) |
| Public decrypt of TE `.tfw` | **None found** |
| Public Ghidra of full app | **None found** (local Ghidra only on trailer) |
| SysEx / sample protocol RE | [wmealing KO2 sysex notes](https://wmealing.github.io/KO2-EP-133-midi-sysex-messages.html); [garrettjwilke/ep_133_sysex_thingy](https://github.com/garrettjwilke/ep_133_sysex_thingy); local `vendor/ep-series-sysex` — **user FS only, no NOR/JEDEC** |
| TE updater decrypt | Host JS sends ciphertext; decrypt is on-device |

Offline cryptanalysis of the blob is a parallel track; it does not replace a live dump if the key is device-only.

---

## PSoC 6 debug protection (why SWD may fail)

Infineon model ([AN221111](https://documentation.infineon.com/psoc6/docs/isi1667483210870), [debug-port blog](https://community.infineon.com/t5/Blogs/PSoC-6-Debug-Port-Best-Practices-for-System-Debugging/ba-p/388588), [FlashRunner PSoC6 note](https://smh-tech.com/wp-content/uploads/repository/Interfacing%20FlashRunner%202.0%20with%20INFINEON%20PSoC6.pdf)):

1. **Listen window** (TOC2 flags @ SFlash `0x16007DF8`): default **20 ms** after Flash Boot for SWJ acquire; can be 10 ms / 1 ms / **0 ms** / 100 ms.
2. **`SWJ_PINS_CTL`**: default enables SWJ pins in Flash Boot; other values **skip** SWJ pin setup → no debug without firmware help.
3. **Lifecycle + eFuse (SAR/DAR)**: SECURE stage can permanently disable DAP; eFuse changes are **irreversible**.
4. **NAR in SFlash**: NORMAL-stage access restrictions; can only be tightened via system calls.

**Implication for EP-133:** a production sampler almost certainly closes or shortens the window and/or disables CM4/CM0 APs. Still: many products leave a short listen window for factory programming — **probe before concluding locked**.

**Non-destructive test:** KitProg3/MiniProg4/OpenOCD with **power-cycle acquire** (`ENABLE_ACQUIRE`) while asserting reset / cycling VDD. Success ⇒ dump. Failure after repeated acquires ⇒ treat as locked; escalate to SPI NOR RDID (density only) or offline crypto.

Do **not** write SFlash / eFuse / TOC2 while exploring.

---

## Open schematics / RP2040 rumor

Searched TE product pages, FCC Z23 filings, teardown comments, and general “open schematics / RP2040 / KO II” mentions.

**Result:** no public EP-133 schematics; shipping silicon is **PSoC 6**, not RP2040. No TE “open hardware KO II” release found. Nearby open projects (e.g. Teensy Pocket Operator–style FX, RP2040 Pico cores) are **unrelated** DIY. Treat RP2040 + open-schematic talk as **rumor / wrong product** unless a primary source appears.

---

## Local machine inventory (`/Users/seajay/gits/`)

| Path | Relevance |
|---|---|
| **`ep-unity/`** | This repo: `.tfw` packages, trailer RE, DFU/SysEx tooling, TE disclosure notes |
| `ep-unity/vendor/ep-series-sysex` | kmorrill FILE/GREET lab — backup only |
| `ep-unity/vendor/te-update` | Official updater scrape — no decrypt |
| `ep-unity/docs/research/*` | NOR variance, safe path, trailer analysis |
| `binary-re/` | Generic RE skills (r2/Ghidra workflow) — useful after dump |
| `GhidraMacOS/` | Headless Ghidra already used on trailer |
| `epimore/`, `kotu/` | Unrelated (Ableton / other) |

No other local EP-133 firmware-decrypt or SWD pinout repos found.

---

## Ranked procedures (safest → riskiest)

Risk scale is **brick / data-loss / irreversible silicon**, not warranty (case-open already voids TE modification language).

### 0. Offline (already done) — risk: none

Trailer RE + `.tfw` structure. **Does not** yield app plaintext or JEDEC tables. Prerequisite for knowing *what* to look for after a dump.

### 1. Full user backup via SysEx — risk: very low

Use `vendor/ep-series-sysex` to dump projects/sounds to `.pak` before any physical work. Recovers **user data**, not firmware. Serialize FILE; avoid concurrent sample-tool use (`err lfs` lessons in kmorrill docs).

### 2. SPI JEDEC / SFDP on Winbond (MCU in reset) — risk: low

**Best answer if the question is only “what density is this board?”**

1. Open case (teardown: 8 + ~43 screws; keep keycaps).
2. Identify W25Q512JV (lower-right on teardown photo).
3. Hold **PSoC nRESET low** (or power MCU domain off while NOR VCC stays up — prefer probing with a schematic-level understanding of shared rails; if unsure, power whole board from USB with RESET asserted).
4. Attach logic analyzer / CH341A / Bus Pirate / flashrom-capable clip to **CLK, CS#, DI, DO, VCC, GND** (quad lines only if needed; `RDID` is single-SPI).
5. Issue `9F` → expect **`EF 40 20`** for W25Q512JV (Linux MTD: `0xef4020`, 1024×64 KiB). Capacity code `0x20` ⇒ 2³² bits = 512 Mbit.
6. Optional: `5A` SFDP for erase geometry.

**Do not** erase/program. Clip work around the NOR has already eaten 0402s for at least one person ([Jayden Lawson comment](https://medium.com/@jaydenlawson/i-attempted-to-remove-this-but-popped-off-some-of-the-tiny-components-around-it-7f426fbdbdfc)) — use a proper SOIC/WSON fixture or microscope soldering.

This confirms **board density**; it does **not** show how firmware *handles* variance.

### 3. SWD acquire + read-only dump — risk: low–medium (physical), low software if read-only

**Best answer for plaintext app / JEDEC *handling*.**

#### 3a. Find SWD

Expected nets (PSoC 6, [AN218241](https://documentation.infineon.com/psoc6/docs/kwz1667482930244)):

- SWDIO, SWDCLK, GND, VDDIO (3.3 V sense), nRESET (recommended)

Hunt: unpopulated 0.1″ / Tag-Connect / pogo pads near MCU; vias with short traces to SWJ pins. Continuity from MCU pins once marking is known. Photograph markings (macro) before soldering.

#### 3b. Acquire

Preferred adapters: **KitProg3 / MiniProg4** (Infineon acquire path), or OpenOCD with PSoC 6 scripts and `ENABLE_ACQUIRE=1`.

```text
# Conceptual OpenOCD flow (exact cfg depends on probe + part)
# Power-cycle acquire within listen window, then:
halt
dump_image ep133_internal_flash.bin 0x10000000 0x200000   # size = part flash; trim later
# Optional SFlash read-only (careful):
dump_image ep133_sflash.bin 0x16000000 0x8000
```

Also dump SMIF XIP window if the memory map shows a mapped external region after boot.

#### 3c. What “success” looks like

- DAP IDCODE readable; CM0+/CM4 or SYS-AP connect.
- `0x10000000` dump contains Cortex-M vector table + Thumb; strings beyond trailer; xrefs to `lfs_init` callers; immediates `0x9F` / SFDP / `block_count`.
- Load in Ghidra as ARM Cortex-M little-endian @ `0x10000000` (trailer slice already validated @ `0x100df490`).

#### 3d. What “locked” looks like

- No ACK during listen window despite power-cycle acquire.
- IDCODE never appears; SWDIO stuck.

Then stop poking TOC2. Fall back to §2 (density) + offline crypto.

**SWD locked? Prior:** **likely, unproven.** Shipping TE product + encrypted field updates → expect protection. Counter-evidence: none published either way.

### 4. Post-boot XIP / SMIF plaintext via SWD — risk: same as §3

If app executes from SMIF with **on-the-fly AES** ([AN228740](https://documentation.infineon.com/psoc6/docs/jti1667480723906)), a **cold SPI dump of NOR is ciphertext**, while a **running** CPU read through the SMIF window (debugger `dump_image` of the XIP VA) yields plaintext. Keys sit in write-only `SMIF_CRYPTO_KEY*` — not recoverable by reading those regs.

For EP-133, current evidence points more to **internal flash** for code + SPI NOR for samples; still verify both maps once SWD works.

### 5. Full external NOR image (clip / chip-off) — risk: medium–high

Useful for: sample FS forensics, confirming layout, checking whether any clear code lives on NOR.

Not useful alone for: encrypted app (if SMIF crypto or if app is internal-only).

Chip-off / hot-air around the Winbond is the highest **physical** brick risk on a working unit — prefer clip + RESET before desolder.

### 6. Same-SKU official reflash — risk: medium (soft)

Validates DFU hygiene only. Teaches nothing about NOR tables. Avoid killing host during `PERFORM`.

### 7. Cross-flash / speculative DFU — risk: high — **do not use for this goal**

Already demonstrated SKU bypass. TE warned about NOR variance. No plaintext. Worst information/risk ratio.

### 8. eFuse / glitch / invasive unlock — risk: extreme

Out of scope for “prefer non-brick.” Mentions only so we do not accidentally walk there while “just trying one more OpenOCD flag.”

---

## Recommended sequence on the 64 MB unit

1. **SysEx `.pak` backup** (user data).
2. **SPI `RDID`** on Winbond with RESET held → confirm `EF4020` / 64 MiB (documents this board; calibrates TE “variance” claim).
3. **Photograph MCU top marking** (full `CY8C…` string) → pick OpenOCD target / SVD.
4. **Power-cycle SWD acquire** (read-only dumps only).  
   - If open → dump `0x10000000`, hunt JEDEC / `lfs_config` builder, Ghidra.  
   - If closed → stop; do not write flash; continue offline crypto / wait for second sacrificial unit.
5. Only if SWD open and still missing external-code regions → map SMIF and dump XIP VA while running.

---

## Evidence index

| Claim | Link / path |
|---|---|
| PCB / Winbond / Infineon / CS42L52 | [Medium teardown](https://medium.com/@Lkngrrr/hasty-teardown-of-the-teenage-engineering-ko-ii-ep-133-sampler-composer-34933e9ad497) |
| Model TE032AS001 | [TE FCC page](https://teenage.engineering/guides/ep-133/warnings-warranty-fcc) |
| No EP-133 FCC photo dump | [fccid.io/Z23](https://fccid.io/Z23) |
| PSoC6 SWD / listen window / TOC2 | [Infineon listen-window KBA](https://community.infineon.com/t5/Knowledge-Base-Articles/Configuring-the-PSoC-6-MCU-Startup-Time-from-Reset/ta-p/284800); [FlashRunner PSoC6](https://smh-tech.com/wp-content/uploads/repository/Interfacing%20FlashRunner%202.0%20with%20INFINEON%20PSoC6.pdf) |
| Secure lifecycle / DAP | [AN221111](https://documentation.infineon.com/psoc6/docs/isi1667483210870) |
| SMIF on-the-fly crypto | [AN228740](https://documentation.infineon.com/psoc6/docs/jti1667480723906) |
| W25Q512JV JEDEC `EF4020` | [linux-mtd patch discussion](https://lists.infradead.org/pipermail/linux-mtd/2021-January/084698.html) |
| Trailer ≠ NOR driver | [`trailer-static-analysis.md`](trailer-static-analysis.md) |
| DFU ≠ dump | [`nor-safe-path.md`](nor-safe-path.md) |
| SysEx RE (not firmware) | [wmealing](https://wmealing.github.io/KO2-EP-133-midi-sysex-messages.html); [ep_133_sysex_thingy](https://github.com/garrettjwilke/ep_133_sysex_thingy) |

---

## Decision log

| Decision | Picked | Rejected | Why |
|---|---|---|---|
| Primary path to app plaintext | SWD read of `0x10000000` after acquire | NOR chip-off as first step; DFU | App VA already in internal map; DFU has no readback; NOR likely samples |
| Primary path to density fact | SPI `RDID` with RESET | Fill sample pool; cross-flash | Non-destructive; matches teardown part |
| SWD lock expectation | Assume **likely locked**, verify with acquire | Assume open factory pads | Consumer encrypted updates + Infineon TOC2/eFuse toolkit |
| Schematics | None available | Chase RP2040 open-HW rumor | No primary source; shipping MCU is PSoC6 |

**Ramifications:** Opening the case is enough for SPI density confirmation. Getting JEDEC *handling* still needs either SWD success or blob decrypt. If SWD is locked on this unit, a second sacrificial board or crypto work becomes the gate — not more DFU experiments.

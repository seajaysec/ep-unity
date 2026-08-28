# ep-unity

A browser tool for flashing firmware files to Teenage Engineering's **EP-133 k.o. II**
and **EP-40 riddim**. It assists with rewriting the four SKU bytes in a `.tfw` header so a device
will accept an image built for its peer. Flashes over WebMIDI, and backs up and
restores your projects and samples as well.

Written up here: **[My K.O. II boots as a riddim now. It took four bytes.][post]**  
Video demo of result: **[youtube.com/watch?v=_iU3sdBdjdo][video]**

> **Unsupported, and it can brick your device.**
> Teenage Engineering asked that I share this:
> cross-flashing is unsupported. EP units ship different NOR flash
> types and densities, and the risks associated with this could include data loss, a brick,
> and a voided warranty. Everything here was tested on one legacy 64 MiB EP-133, plus a
> 128 MiB TE032AS002 tested independently by [Joshua Leak](https://github.com/res0urces). That's still a
> really small sample size - sharing because it is of technical interest. I take no responsibility for broken units.

## What it does

| Panel | |
|---|---|
| 1 · firmware image | Drop any TE032 `.tfw`. Links out to TE's firmware list - you download, this parses it. |
| 2 · SKU rewrite | Live before/after of the four header bytes that change, at offsets 15–18. |
| 3 · flash | WebMIDI DFU behind three risk acknowledgements, with a post-flash watcher that diagnoses `RDY` / `err sound` / `ERR SYSTEM_MODEL` and tells you how to recover. |
| 4 · backup | Projects and samples off the device into a `.pak`, over WebMIDI FILE. Do this first. |
| 5 · factory projects | Thin a factory `.pak` down to just the samples its pads reference, with a free-space check that blocks a restore that won't fit. |
| — | A **play 10s demo** button in the device bar that plays something different depending on which firmware is running. |

## It never contacts teenage.engineering

Every link to TE is one you choose to click. No firmware or factory content is mirrored
in this repository.

## Requirements

WebMIDI with sysex, which today means a **Chromium browser**: Chrome or Edge on
desktop, or **Chrome on Android** over USB-C — handy at a bench with no laptop.

## Running it

```bash
node web/serve.mjs        # http://localhost:8766/
node --test web/lib/*.test.js
```

`serve.mjs` is a plain static file server and makes no outbound requests.

## Things I learned when it seemed like it'd gone wrong

- **Screen stuck on `RDY`** - the image was rejected after transfer. Not a brick;
  MIDI and DFU still work. Flash a stock same-family `.tfw` from the bootloader.
- **`ERR SoUnD` spam** - the user filesystem, not the firmware. Power off, hold
  **SHIFT+ERASE**, power on to format the sound store, then flash, then restore.
- **`ERR SYSTEM_MODEL`** - the restore didn't fit. Check free space first.
- **`status=0x1` at `DFU_BEGIN`, before any bytes move** - the announced SKU was
  rejected. On a 128 MiB unit this used to happen with *stock TE images too*, which
  made it read as "unsupported device" rather than "wrong field". See below.

A clean DFU log is not necessarily indicative of a successful flash: `PERFORM` returning 0 means the bytes
arrived, not that the bootloader accepted them.

## Two SKUs: board revision and firmware lineage

128 MiB units are supported, and the reason they once weren't is worth writing down.
Found and fixed by [Joshua Leak](https://github.com/res0urces), who has the hardware.

The device answers with two SKUs, and they are not interchangeable:

| Field | Meaning | 64 MiB EP-133 | 128 MiB EP-133 |
|---|---|---|---|
| `sku` | board revision | `TE032AS001` | `TE032AS002` |
| `base_sku` | firmware lineage the board runs | `TE032AS001` | `TE032AS001` |

On the 64 MiB board these are the same string, so nothing in the tool ever had to tell
them apart. On the 128 MiB board they diverge — and **`DFU_BEGIN` wants the lineage**.
There is no `AS002` firmware to download; `AS001` is the only k.o. II image TE
publishes, and the AS002 board says so itself in `base_sku`. Announcing the board
revision gets `status=0x1` before a single byte of the image is sent.

That failure mode is why this looked like missing support rather than a bug. A wrong
SKU rejects *any* image, so a 128 MiB owner flashing a stock, untouched TE file got the
same rejection as one attempting a cross-flash — the tool looked like it simply didn't
know the hardware.

Two consequences worth carrying if you build on this:

- **The board revision is display-only.** It belongs on screen, next to the wire SKU,
  so `AS001` at `DFU_BEGIN` on an `AS002` board doesn't read as a bug. It must never
  reach the wire. `lib/sku.js` is the single place that decision is made, and the only
  thing `lib/sku.test.js` exists to protect.
- **Only the DFU GREET frame reports `base_sku`.** The bundled kotu `parseDeviceInfo`
  reads `product` / `os_version` / `serial` / `sku` out of the FILE metadata string and
  drops the rest, so a FILE-only session has no live lineage to read. The tool banks the
  last one it saw, paired with the SKU the device answered at the time, and reuses it
  only while that pairing still holds — after a cross-flash the banked value is stale,
  and announcing it would be the same class of mistake as announcing the revision.

Free-space warnings read `max_capacity` from `/sounds` metadata rather than assuming a
64 MiB part, so a 128 MiB unit is no longer told to go buy a 128 MiB unit.

Hardware note while we're here: **there is no 64 MiB EP-40.** Riddim ships 128 MiB only.
The EP-133 ships both — `TE032AS001` at 64 MiB, `TE032AS002` at 128 MiB.

## Reporting a result

Outcome reports are the entire evidence base for this, and there are very few. What is on
record right now:

| Combination | Reports |
|---|---|
| EP-40 firmware on EP-133 hardware | 1, on a 64 MiB board |
| EP-40 firmware on a 128 MiB EP-133 | 0 |
| EP-133 firmware on EP-40 hardware | 0 |
| EP-1320 either direction | rejected after transfer — different `KEYHASH` |

**A flash that worked is as useful to report as one that didn't.** If you run any of these,
please [open an issue](https://github.com/seajaysec/ep-unity/issues). The tool offers a
prefilled link after every flash; it carries the SKUs, OS and reported capacity, and
deliberately leaves out your serial.

## Command line

```bash
python3 tools/tfw.py info ep-40_firmware_2_5_1.tfw
python3 tools/tfw.py rewrite-sku ep-40_firmware_2_5_1.tfw --sku TE032AS001 -o out.tfw
python3 tools/tfw_mcuboot.py info ep-133_firmware_2_5_1.tfw
```

Firmware files are not included — point these at images you downloaded from TE.

### The header checksum, and a trap if you extend this

The two bytes at offsets 5–6 are **CRC-16/XMODEM over `data[0x40:]`**, identified by
[Charles Vestal](https://github.com/charlesvestal) and verified against every current
official TE release.

That boundary is why the whole four-byte trick works. The SKU at offsets 15–18 sits
*before* `0x40`, outside the CRC's coverage — rewriting it cannot invalidate the
checksum, so no refresh is needed. That is structural, not luck.

**The trap:** the inner `beefcafe` header mirrors the SKU at `0x57`, and `0x57` *is*
inside the outer CRC's range. Anything that rewrites the inner SKU must recompute both
checksums or the file will no longer verify:

```python
out[5:7]       = crc16_xmodem(out, 0x40).to_bytes(2, "big")   # outer
out[0x49:0x4B] = crc16_xmodem(out, 0x80).to_bytes(2, "big")   # inner
```

`rewrite_sku()` deliberately touches only the outer SKU, so it needs neither. Worth
knowing before you reach for the inner one.

For what it's worth, a cross-flashed image with a *mismatched* inner SKU — outer
rewritten to EP-133, inner still reading EP-40 — was accepted and booted by the
hardware. The inner field does not appear to be checked on this path.

## Research notes

| Doc | Topic |
|---|---|
| [`blob-cryptanalysis.md`](docs/research/blob-cryptanalysis.md) | MCUboot / ECIES: why the app payload stays opaque |
| [`trailer-static-analysis.md`](docs/research/trailer-static-analysis.md) | LittleFS trailer reverse engineering |
| [`nor-flash-variance.md`](docs/research/nor-flash-variance.md) | What TE said about NOR types and densities |
| [`decrypt-oracle.md`](docs/research/decrypt-oracle.md) | Why the MIDI crypto oracle went nowhere |
| [`supertone-feasibility.md`](docs/research/supertone-feasibility.md) | What porting Supertone would actually require |
| [`swd-dump-path.md`](docs/research/swd-dump-path.md) | The physical dump route |
| [`midi-stress-checklist.md`](docs/research/midi-stress-checklist.md) | Notes, CC and clock stress run against a cross-flashed unit |

## Prior art

The community work this builds on. None of it is a firmware flasher; all of it was
useful: [ep133-krate](https://github.com/icherniukh/ep133-krate) and
[ep133-ppak](https://github.com/ZacharySBrown/ep133-ppak) for Packed7 and protocol
documentation, [ep133-export-to-daw](https://github.com/phones24/ep133-export-to-daw),
and wmealing's [KO2-SYSEX](https://github.com/wmealing/KO2-SYSEX) plus his
[bring-up capture notes](https://wmealing.github.io/KO2-EP-133-midi-sysex-messages.html).

Direct contributions to this tool: [Joshua Leak](https://github.com/res0urces) worked out
the `base_sku` / `sku` split that makes 128 MiB units flashable and tested it on hardware
I don't own; [Charles Vestal](https://github.com/charlesvestal) identified the header
checksum as CRC-16/XMODEM and verified it against every current official TE release.

## Disclosure

The client-side SKU gate was reported privately to Teenage Engineering before any of
this was public. Their response — the NOR density warning at the top of this file —
is quoted in the write-up rather than buried in a footnote.

Not affiliated with Teenage Engineering. Not recommending you do this.

This tool was written in part with AI.

[post]: https://linecross.ing/ko-ii-boots-as-a-riddim/
[video]: https://www.youtube.com/watch?v=_iU3sdBdjdo

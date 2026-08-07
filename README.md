# ep-unity

A browser tool for TE032-family samplers — Teenage Engineering's **EP-133 k.o. II**
and **EP-40 riddim**. It rewrites the four SKU bytes in a `.tfw` header so a device
will accept an image built for its sibling, flashes over WebMIDI, and backs up and
restores your projects and samples so you have a way back.

Written up here: **[My K.O. II boots as a riddim now. It took four bytes.][post]**  
Walkthrough on video: **[youtube.com/watch?v=_iU3sdBdjdo][video]**

> **Unsupported, and it can brick your device.**
> Teenage Engineering's EP-series team asked that anyone writing about this say it
> plainly: cross-flashing is unsupported. Field units ship **different NOR flash
> types and densities**, and the risks include incompatibility, data loss, a brick,
> and a voided warranty. Everything here was done on one legacy 64 MiB EP-133. It is
> not a green light for your hardware.

## What it does

| Panel | |
|---|---|
| 1 · firmware image | Drop any TE032 `.tfw`. Links out to TE's downloads — you fetch it, this parses it. |
| 2 · SKU rewrite | Live before/after of the four header bytes that change, at offsets 15–18. |
| 3 · flash | WebMIDI DFU behind three risk acknowledgements, with a post-flash watcher that diagnoses `RDY` / `err sound` / `ERR SYSTEM_MODEL` and tells you how to recover. |
| 4 · backup | Projects and samples off the device into a `.pak`, over WebMIDI FILE. Do this first. |
| 5 · factory projects | Thin a factory `.pak` down to just the samples its pads reference, with a free-space check that blocks a restore that won't fit. |
| — | A **play 10s demo** button in the device bar that plays something different depending on which firmware is running. |

## It never contacts teenage.engineering

Not the web app, not the dev server. The product list ships with the code; if you
want current versions, download TE's `releases.json` yourself and drop it in. Every
link to TE is one you choose to click. No firmware or factory content is mirrored
in this repository.

## Requirements

WebMIDI with sysex, which today means a **Chromium browser**: Chrome or Edge on
desktop, or **Chrome on Android** over USB-C — handy at a bench with no laptop.
No browser on iPhone or iPad can run this; Safari has never shipped WebMIDI and
every iOS browser is Safari underneath. The page says so on load rather than
failing silently.

## Running it

```bash
node web/serve.mjs        # http://localhost:8766/
node --test web/lib/*.test.js
```

`serve.mjs` is a plain static file server and makes no outbound requests.

## If something goes wrong

- **Screen stuck on `RDY`** — the image was rejected after transfer. Not a brick;
  MIDI and DFU still work. Flash a stock same-family `.tfw` from the bootloader.
- **`ERR SoUnD` spam** — the user filesystem, not the firmware. Power off, hold
  **SHIFT+ERASE**, power on to format the sound store, then flash, then restore.
- **`ERR SYSTEM_MODEL`** — the restore didn't fit. Check free space first.

A clean DFU log is not a successful flash: `PERFORM` returning 0 means the bytes
arrived, not that the bootloader accepted them.

## Command line

```bash
python3 tools/tfw.py info ep-40_firmware_2_5_1.tfw
python3 tools/tfw.py rewrite-sku ep-40_firmware_2_5_1.tfw --sku TE032AS001 -o out.tfw
python3 tools/tfw_mcuboot.py info ep-133_firmware_2_5_1.tfw
```

Firmware files are not included — point these at images you downloaded from TE.

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

## Disclosure

The client-side SKU gate was reported privately to Teenage Engineering before any of
this was public. Their response — the NOR density warning at the top of this file —
is quoted in the write-up rather than buried in a footnote.

Not affiliated with Teenage Engineering.

[post]: https://linecross.ing/ko-ii-boots-as-a-riddim/
[video]: https://www.youtube.com/watch?v=_iU3sdBdjdo

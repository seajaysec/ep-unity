<!--
SUPERSEDED — DO NOT REBUILD OVER THE GHOST DRAFT.

The live draft at linecross.ing/ghost (slug: ko-ii-boots-as-a-riddim) has been
edited directly in Ghost and is the source of truth. It also has Part 2 folded
into it. This file is the pre-edit version, kept for the figure markup only.

To change the post, edit it in Ghost. To recover the current text into markdown,
pull it back down first — running tools/build_post.py + stage_ghost_post.sh
against this file would overwrite the Ghost edits.
-->

<!--
Part 2. Everything that came after the story in four-bytes.md ended.
This one is a field guide, not a narrative — people will land here from a
search for "ERR SoUnD 44" at 1am. Optimise for: symptom visible, fix visible,
"you are not bricked" visible. Short sections, no build-up.
-->

# Everything that went wrong after I didn't stop

**Dek.** [Part 1](#) ends with my EP-133 happily booting EP-40 firmware. Then I kept going, and the unit found four new ways to be unhappy. None of them bricked it. All of them looked like it had.

**Meta line.** Still one legacy 64&nbsp;MiB EP-133. Still not affiliated with teenage engineering.

> **Unsupported.** Same warning as Part 1, and it matters more here: cross-flashing is unsupported, field units ship different NOR flash types and densities, and you are risking incompatibility, data loss, a brick, and your warranty. Everything below is one unit's behaviour, not a spec.

## The short version

Four things went wrong. Every one of them was the *user filesystem*, not the firmware.

| What I saw | What it was | What fixed it |
|---|---|---|
| Screen stuck on `RDY`, GREET says `mode:bootloader` | Wrong-family image, rejected after transfer | Flash a stock same-family `.tfw` from bootloader |
| `ERR SoUnD 44 2_0_5` spamming ~1/sec | New sound store under old OS | SHIFT+ERASE format boot, then flash |
| `err sound 24 2_5_1` after a KO flash | Riddim projects with Supertone pads still on NOR | Same: SHIFT+ERASE, then restore what you need |
| `ERR SYSTEM_MODEL 58 2_5_1`, intermittent | Restore too big for free space | Check free space first, thin the `.pak` |

That's the whole post. The rest is detail.

## RDY forever: the soft reject

EP-1320 Medieval 1.5.0 packages the same way as the EP-133 and EP-40 files, so it's tempting. It has a **different** `KEYHASH` (`40e5051c…` versus the family's `d349a2d4…`), so it's also useless.

I tried it twice — once with the SKU rewritten to `TE032AS006`, once to my actual hardware SKU. Both times DFU begin / chunk / perform looked completely normal on the wire. `PERFORM` returned 0. Both times the screen then sat on **RDY** and GREET reported `mode:bootloader` with the hardware SKU.

This is the part worth internalising: **`PERFORM` returning 0 means the bytes arrived, not that the bootloader accepted them.** There is no read-back in this DFU path. A clean transfer log tells you nothing about whether the thing will boot.

MIDI DFU still worked in that state. Sample FILE didn't. Recovery both times was the same — download a stock same-family `.tfw` from TE, flash it from bootloader, back to `mode:normal`.

Soft reject, not a brick. The SKU rewrite gets you across products sharing a key. It does nothing across families that don't.

## `ERR SoUnD`: the OS downgrade trap

Same-family downgrade is allowed. 2.5.1 → 2.0.5 booted fine on this unit.

What didn't survive was the sound store. With a *newer* sound store under an *older* OS, the device started spamming firmware debug SysEx about once a second, screen text along the lines of `ERR SoUnD 44 2_0_5`, and stopped answering identity / GREET / DFU usefully. Power-cycling usually just brought the loop straight back.

The fix:

1. Power off.
2. Hold **SHIFT+ERASE**, power on. This formats the sound store.
3. Flash the OS you actually want.
4. Restore projects from a `.pak` backup afterwards.

Order matters. Format first, flash second, restore third.

The same class of thing showed up later as `err sound 24 2_5_1` after flashing EP-133 firmware while Riddim projects with Supertone pads were still sitting on NOR — Riddim stores those as high pad symbols and KO's OS doesn't want them. Before a KO flash, scan on-device projects for Supertone pads and strip or erase first.

Both are one problem wearing two error codes: OS comes up, user data is something the OS can't stomach, MIDI goes mostly deaf until a format boot.

## 64 MiB is a real number

After disclosure, TE's EP-series team asked that write-ups warn about NOR types and densities varying in the field. Here's the concrete version of why.

This board is a legacy **64 MiB** part. Marketing quotes a bigger sample pool. That gap is real the moment you push a whole factory bank at the device.

It is *not* "EP-40 needs more RAM so it can't run." The 2.5.1 packages are nearly the same size and this unit boots Riddim OS happily. The problem is content, not code — factory demos don't live inside the `.tfw` at all. They live in Sample Tool `.pak` archives, and a full Riddim factory bank is on the order of **~86 MB of WAV**.

86 into 64 does not go.

What worked: pick a few jam projects, keep only the samples those projects actually reference, check free space (and overwrite reclaim) *before* uploading, then restore over WebMIDI FILE. On a nearly-full unit — about 1.2 MB free, 163 slots used — a too-large restore threw `ERR SYSTEM_MODEL 58 2_5_1` intermittently. Same family as the `err sound` loops: free space first, SHIFT+ERASE if you're already stuck.

`ep-unity` does the thinning and the free-space check in the browser, which is the only reason I stopped hitting this.

## Unresolved: MIDI weirdness

On the cross-flashed unit I've seen glitches and freezes when driving it hard over MIDI, including with Supertone. People report hangs on factory Riddims too, on unmodified hardware.

I have not pinned a failure mode that clearly blames 64 MiB NOR. Casual use of the Riddim features I actually wanted has been fine on this board. But I'm not going to launder "it works for me" into "the density warning was wrong." Treat intermittent MIDI weirdness as open.

## What I'd tell someone about to try this

- Back up first. Projects and samples, over WebMIDI FILE, before anything else. `ep-unity` will do it.
- Your serial doesn't move. GREET reports the same serial no matter which product the unit currently thinks it is. That's your anchor when everything else is lying to you.
- A clean DFU log is not a successful flash. See RDY, above.
- Bootloader is not a brick. If you can still GREET, you can still flash a stock same-family `.tfw` and get back.
- The failures are almost never the firmware. They're the filesystem. Reach for SHIFT+ERASE earlier than feels comfortable.
- Free space before restore, every time. 64 MiB.

## Sources

Same as [Part 1](#), plus this unit's DFU capture logs and `ep-unity`'s own recovery paths. Firmware files and TE's updater app are not redistributed here.

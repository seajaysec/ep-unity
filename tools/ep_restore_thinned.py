#!/usr/bin/env python3
"""Restore a thinned .pak (projects + referenced WAVs) onto a connected EP.

    python3 tools/ep_restore_thinned.py --product ep40 --pak /tmp/thinned.pak

Uploads factory WAVs at their source rate when ≤46875 Hz (OS 2.0+/2.5+ keep
lower rates; only oversize rates are downsampled). Prefer a thinned pack from
the web slicer or tools/pak_thin.py.
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
import time
import wave
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "ep-series-sysex"))

from epsysex.dependencies import NATIVE_SAMPLE_RATE, wav_to_pcm16  # noqa: E402
from epsysex.fileclient import FileClient  # noqa: E402
from epsysex.sysex import EP133_PRODUCT, EP40_PRODUCT  # noqa: E402

PRODUCTS = {
    "ep133": (EP133_PRODUCT, "EP"),
    "ep40": (EP40_PRODUCT, "EP"),
}

SOUND_RE = re.compile(r"(?:^|/)sounds/(\d+)\s+(.+)\.wav$", re.I)
PROJECT_RE = re.compile(r"(?:^|/)projects/P(\d+)\.tar$", re.I)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--product", choices=sorted(PRODUCTS), required=True)
    ap.add_argument("--pak", type=Path, required=True)
    ap.add_argument("--port", help="MIDI port name substring")
    ap.add_argument("--skip-existing", action="store_true",
                    help="do not re-upload sounds already on device")
    args = ap.parse_args()

    product_byte, _ = PRODUCTS[args.product]
    client = FileClient(
        product_byte=product_byte,
        port_hint=args.port,
        lock_owner="ep_restore_thinned",
    )

    existing = {int(n["id"]) for n in client.list_sounds()}
    print(f"device already has {len(existing)} sound slots", flush=True)

    with zipfile.ZipFile(args.pak) as z:
        sounds = sorted(
            n for n in z.namelist()
            if SOUND_RE.search(n) and "__MACOSX" not in n
        )
        projects = sorted(
            n for n in z.namelist()
            if PROJECT_RE.search(n) and "__MACOSX" not in n
        )
        print(f"pak: {len(sounds)} sounds, {len(projects)} projects", flush=True)

        t0 = time.time()
        uploaded = 0
        skipped = 0
        for i, name in enumerate(sounds, 1):
            m = SOUND_RE.search(name)
            assert m
            slot = int(m.group(1))
            nice = m.group(2)
            if args.skip_existing and slot in existing:
                skipped += 1
                continue
            wav = z.read(name)
            with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
                tmp.write(wav)
                tmp.flush()
                # OS 2.0+ keeps ≤46875; only downsample above max.
                with wave.open(tmp.name, "rb") as wh:
                    src_rate = wh.getframerate()
                target = min(int(src_rate), int(NATIVE_SAMPLE_RATE))
                pcm, meta = wav_to_pcm16(tmp.name, target_rate=target)
            short = nice[:20]
            client.upload_sound(
                slot,
                pcm,
                name=short,
                node_name=f"{slot:03d}.pcm",
                samplerate=meta["samplerate"],
                channels=meta["channels"],
                sample_format="s16",
            )
            uploaded += 1
            if i == 1 or i % 10 == 0 or i == len(sounds):
                print(
                    f"  sound {i}/{len(sounds)} slot={slot} {short!r} "
                    f"({time.time() - t0:.0f}s)",
                    flush=True,
                )

        print(
            f"sounds done: uploaded={uploaded} skipped={skipped} "
            f"in {time.time() - t0:.0f}s; writing projects…",
            flush=True,
        )
        for name in projects:
            m = PROJECT_RE.search(name)
            assert m
            proj = int(m.group(1))
            tar = z.read(name)
            client.write_project_archive_and_reload(proj, tar, cycle=True)
            print(f"  wrote project P{proj:02d} ({len(tar)} B)", flush=True)

    sounds_now = client.list_sounds()
    total = sum(int(n["size"]) for n in sounds_now)
    print(
        f"RESTORE_OK — device now {len(sounds_now)} slots / {total / 1e6:.2f} MB",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

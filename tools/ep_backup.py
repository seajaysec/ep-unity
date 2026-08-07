#!/usr/bin/env python3
"""Backup EP user filesystem (projects + sounds) to a Sample-Tool-shaped .pak.

Pre-DFU safety step for the decrypt-first / DFU roundtrip milestone.

    python3 tools/ep_backup.py --product ep40 -o backups/
    python3 tools/ep_backup.py --product ep133 -o backups/ --port EP

Uses vendor/ep-series-sysex FILE SysEx. Not a firmware dump.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import wave
import zipfile
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "ep-series-sysex"))

from epsysex.fileclient import (  # noqa: E402
    PROJECTS_NODE_ID,
    FileClient,
    project_fid,
)
from epsysex.sysex import EP133_PRODUCT, EP40_PRODUCT  # noqa: E402

# EP-1320 product SysEx byte not verified in epsysex yet — backup KO/Riddim only.
PRODUCTS = {
    "ep133": (EP133_PRODUCT, "EP-133", "TE032AS001"),
    "ep40": (EP40_PRODUCT, "EP-40", "TE032AS006"),
}


def pcm16_to_wav(pcm: bytes, rate: int = 46875, channels: int = 1) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def fid_to_project_number(fid: int) -> int | None:
    if fid < 3000 or (fid - 3000) % 1000:
        return None
    n = (fid - 3000) // 1000 + 1
    return n if 1 <= n <= 99 else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--product", choices=sorted(PRODUCTS), required=True)
    ap.add_argument("-o", "--out-dir", type=Path, default=Path("backups"))
    ap.add_argument("--port", help="MIDI port name substring")
    ap.add_argument("--name", help="output basename (default: serial-timestamp)")
    args = ap.parse_args()

    product_byte, device_name, default_sku = PRODUCTS[args.product]
    client = FileClient(
        product_byte=product_byte,
        port_hint=args.port,
        lock_owner="ep_backup",
    )

    # Identity via GREET if available through a quick list — FileClient doesn't
    # greet; pull serial from MIDI identity is optional. Use timestamp name.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    base = args.name or f"{args.product}-backup-{stamp}"
    out_pak = out_dir / f"{base}.pak"

    print("listing projects…", flush=True)
    project_nodes = client.list_nodes(PROJECTS_NODE_ID)
    projects: list[tuple[int, bytes]] = []
    # Prefer known slots 1..9 (factory jams); LIST size is often 0 even when TAR exists.
    candidates = sorted(
        {
            n
            for node in project_nodes
            for n in [fid_to_project_number(int(node["id"]))]
            if n is not None
        }
        | set(range(1, 10))
    )
    for n in candidates:
        print(f"  try P{n:02d}…", flush=True)
        try:
            tar, _meta = client.read_project_archive(n)
        except Exception as exc:
            print(f"  skip P{n:02d}: {exc}", flush=True)
            continue
        if not tar:
            print(f"  skip P{n:02d} (empty tar)", flush=True)
            continue
        print(f"  got P{n:02d} ({len(tar)} B)", flush=True)
        projects.append((n, tar))

    print("listing sounds…", flush=True)
    sounds = client.list_sounds()
    sound_blobs: list[tuple[int, str, bytes, dict]] = []
    for node in sorted(sounds, key=lambda n: int(n["id"])):
        slot = int(node["id"])
        name = str(node.get("name") or f"slot{slot}")
        print(f"  read sound {slot} {name!r}…", flush=True)
        pcm, meta = client.read_sound(slot)
        rate = int(meta.get("samplerate") or 46875)
        ch = int(meta.get("channels") or 1)
        wav = pcm16_to_wav(pcm, rate=rate, channels=ch)
        sound_blobs.append((slot, name, wav, meta))

    meta = {
        "info": "teenage engineering - pak file",
        "pak_version": 1,
        "pak_type": "user",
        "pak_release": "ep-unity-backup",
        "device_name": device_name,
        "device_sku": default_sku,
        "device_version": "2.5.1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "author": "ep-unity ep_backup.py",
        "base_sku": default_sku,
        "note": "user FS backup before DFU; not a firmware image",
    }

    with zipfile.ZipFile(out_pak, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("/meta.json", json.dumps(meta, indent=2))
        for n, tar in projects:
            zf.writestr(f"/projects/P{n:02d}.tar", tar)
        for slot, name, wav, _m in sound_blobs:
            # Sample Tool convention: "NNN name.wav"
            safe = "".join(c if c.isalnum() or c in " ._-" else "_" for c in name)[:40]
            zf.writestr(f"/sounds/{slot:03d} {safe}.wav", wav)

    print(
        f"wrote {out_pak}  projects={len(projects)} sounds={len(sound_blobs)} "
        f"({out_pak.stat().st_size} bytes)",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Thin a TE factory/user .pak to selected projects + referenced sample slots.

    python3 tools/pak_thin.py \\
      --pak ~/Downloads/ep-40-factory-content-C42FyxWp.pak \\
      --projects 2,8,9 \\
      -o /tmp/ep40-P02-P08-P09.pak

Supertone pad symbols (slot ≥ 1000) are skipped — they have no WAV in the pack.
"""

from __future__ import annotations

import argparse
import json
import re
import tarfile
import zipfile
from io import BytesIO
from pathlib import Path


SOUND_RE = re.compile(r"(?:^|/)sounds/(\d+)\s+(.+)\.wav$", re.I)
PROJECT_RE = re.compile(r"(?:^|/)projects/P(\d+)\.tar$", re.I)


def slots_from_project_tar(data: bytes) -> set[int]:
    slots: set[int] = set()
    with tarfile.open(fileobj=BytesIO(data), mode="r:") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            name = member.name.lstrip("./")
            if not name.startswith("pads/") or "/p" not in name:
                continue
            handle = tf.extractfile(member)
            if handle is None:
                continue
            record = handle.read()
            if len(record) < 3:
                continue
            slot = int.from_bytes(record[1:3], "little")
            # 1..999 = samples; ≥1000 = Riddim supertone symbol−1
            if 1 <= slot <= 999:
                slots.add(slot)
    return slots


def list_pack(z: zipfile.ZipFile):
    """Accept Sample-Tool leading-slash packs and macOS-wrapped folder zips."""
    projects = {}
    sounds = {}
    meta = None
    for name in z.namelist():
        if name.endswith("/") or name.startswith("__MACOSX/") or "/__MACOSX/" in name:
            continue
        base = name.split("/")[-1]
        m = PROJECT_RE.search(name)
        if m:
            projects[int(m.group(1))] = name
            continue
        m = SOUND_RE.search(name)
        if m:
            sounds[int(m.group(1))] = name
            continue
        if base == "meta.json":
            meta = json.loads(z.read(name))
    return meta, projects, sounds


def thin(pak_path: Path, project_nums: list[int], out_path: Path) -> dict:
    with zipfile.ZipFile(pak_path, "r") as zin:
        meta, projects, sounds = list_pack(zin)
        missing = [n for n in project_nums if n not in projects]
        if missing:
            raise SystemExit(f"projects not in pack: {missing}; have {sorted(projects)}")

        needed: set[int] = set()
        project_bytes = {}
        for n in project_nums:
            data = zin.read(projects[n])
            project_bytes[n] = data
            needed |= slots_from_project_tar(data)

        missing_slots = sorted(s for s in needed if s not in sounds)
        present = sorted(needed & set(sounds))

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            if meta is not None:
                meta = dict(meta)
                meta["pak_type"] = meta.get("pak_type") or "user"
                meta["info"] = meta.get("info") or "teenage engineering - pak file"
                meta["thinned_projects"] = [f"P{n:02d}" for n in project_nums]
                meta["thinned_by"] = "ep-unity/pak_thin"
                zout.writestr("/meta.json", json.dumps(meta, indent=2) + "\n")
            for n in project_nums:
                zout.writestr(f"/projects/P{n:02d}.tar", project_bytes[n])
            wav_bytes = 0
            for slot in present:
                name = sounds[slot]
                data = zin.read(name)
                wav_bytes += len(data)
                m = SOUND_RE.search(name)
                label = m.group(2) if m else "sample"
                zout.writestr(
                    f"/sounds/{slot:03d} {label}.wav",
                    data,
                )

    return {
        "projects": [f"P{n:02d}" for n in project_nums],
        "slots": present,
        "missingSlots": missing_slots,
        "wavBytes": wav_bytes,
        "out": str(out_path),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pak", type=Path, required=True)
    ap.add_argument(
        "--projects",
        required=True,
        help="comma list of project numbers, e.g. 2,8,9 or all",
    )
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--json", action="store_true", help="print plan as JSON")
    args = ap.parse_args()

    with zipfile.ZipFile(args.pak, "r") as z:
        _meta, projects, _sounds = list_pack(z)
        available = sorted(projects)

    if args.projects.strip().lower() == "all":
        nums = available
    else:
        nums = [int(x.strip()) for x in args.projects.split(",") if x.strip()]

    plan = thin(args.pak, nums, args.out)
    if args.json:
        print(json.dumps(plan, indent=2))
    else:
        mb = plan["wavBytes"] / (1024 * 1024)
        print(
            f"wrote {plan['out']}: projects {', '.join(plan['projects'])}; "
            f"{len(plan['slots'])} samples / {mb:.2f} MB WAV"
        )
        if plan["missingSlots"]:
            print(f"WARNING missing slots in pack: {plan['missingSlots'][:20]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

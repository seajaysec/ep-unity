#!/usr/bin/env python3
"""Analyze a post-boot XIP dump for NOR / LittleFS config builders.

Usage (after SWD dump of primary slot):
  python3 tools/analyze_xip_dump.py fw/extracted/xip_dump.bin

Looks for:
  - littlefs strings and lfs_init (assert line immediates)
  - JEDEC 0x9F / SFDP 0x5A thumb immediates
  - W25Q / MX25 / IS25 / GD25 ASCII
  - xrefs toward known trailer VA base 0x100df490 if dump is absolute
"""

from __future__ import annotations

import argparse
import re
import struct
from pathlib import Path

LFS_INIT_LINES = (0x1081, 0x1083, 0x1084, 0x1085, 0x1092, 0x1095)
TRAILER_BASE = 0x100DF490


def find_all(data: bytes, needle: bytes) -> list[int]:
    out = []
    start = 0
    while True:
        i = data.find(needle, start)
        if i < 0:
            break
        out.append(i)
        start = i + 1
    return out


def thumb_mov_imm(data: bytes, imm: int) -> list[tuple[int, int]]:
    """Return (offset, rd) for movs rd, #imm."""
    hits = []
    for rd in range(8):
        enc = bytes([imm & 0xFF, 0x20 | rd])
        for off in find_all(data, enc):
            if off % 2 == 0:
                hits.append((off, rd))
    return hits


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("dump")
    ap.add_argument("--base", type=lambda s: int(s, 0), default=0x10000000)
    args = ap.parse_args()
    data = Path(args.dump).read_bytes()
    base = args.base
    print(f"dump={args.dump} size={len(data)} assume_base={base:#x}")

    for s in (
        b"littlefs-2.10.1",
        b"littlefs",
        b"W25Q",
        b"MX25",
        b"IS25",
        b"GD25",
        b"SFDP",
        b"JEDEC",
    ):
        hits = find_all(data, s)
        if hits:
            print(f"  string {s!r}: {[hex(base + h) for h in hits[:8]]}")

    for imm, label in [(0x9F, "JEDEC_ID"), (0x5A, "SFDP"), (0x9E, "READ_ID")]:
        hits = thumb_mov_imm(data, imm)
        if hits:
            print(f"  movs #0x{imm:02x} ({label}): {[(hex(base + o), f'r{rd}') for o, rd in hits[:12]]}")

    for line in LFS_INIT_LINES:
        # mov.w style or plain movs — search LE u16 of line for narrow, and wide encodings loosely
        packed = struct.pack("<H", line)
        offs = [o for o in find_all(data, packed) if o % 2 == 0]
        if offs:
            print(f"  imm {line:#x} (lfs.c line {line}): {[hex(base + o) for o in offs[:8]]}")

    # Pointers into known trailer lfs_init
    target = TRAILER_BASE + (0x100EC35C - TRAILER_BASE)  # 0x100ec35c
    packed = struct.pack("<I", target | 1)  # thumb
    offs = find_all(data, packed)
    print(f"  thumb ptrs to lfs_init {target:#x}: {[hex(base + o) for o in offs[:16]]}")
    packed2 = struct.pack("<I", target)
    offs2 = find_all(data, packed2)
    print(f"  abs ptrs to lfs_init: {[hex(base + o) for o in offs2[:16]]}")

    # Capacity constants aligned
    for val, name in [(0x4000000, "64MiB"), (0x8000000, "128MiB"), (16384, "block_count_64M_4k"), (32768, "block_count_128M_4k")]:
        packed = struct.pack("<I", val)
        hits = [o for o in range(0, len(data) - 3, 4) if data[o : o + 4] == packed]
        if hits:
            print(f"  {name} ({val:#x}): n={len(hits)} first={[hex(base + h) for h in hits[:8]]}")

    print("done — feed interesting VAs into r2/Ghidra next")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

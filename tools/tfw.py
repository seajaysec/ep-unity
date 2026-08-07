#!/usr/bin/env python3
"""Parse / rewrite Teenage Engineering .tfw firmware headers (babecafe layout)."""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path


def sku_bytes_to_string(sku: bytes) -> str:
    if len(sku) != 4:
        raise ValueError("sku must be 4 bytes")
    e = (sku[0] << 24) | (sku[1] << 16) | (sku[2] << 8) | sku[3]
    model = (e >> 14) & 1023
    mid = "??" if ((e >> 10) & 15) else "AS"
    variant = e & 1023
    return f"TE{model:03d}{mid}{variant:03d}"


def sku_string_to_bytes(sku: str) -> bytes:
    # TE032AS001 / TE032AS006
    if not sku.startswith("TE") or "AS" not in sku:
        raise ValueError(f"unsupported sku format: {sku}")
    body = sku[2:]
    model_s, variant_s = body.split("AS", 1)
    model = int(model_s)
    variant = int(variant_s)
    e = (model << 14) | variant
    return bytes([(e >> 24) & 255, (e >> 16) & 255, (e >> 8) & 255, e & 255])


def version_string(ver: bytes) -> str:
    majors = (ver[0] << 8) | ver[1]
    minors = (ver[2] << 8) | ver[3]
    patch = (ver[4] << 8) | ver[5]
    build = (ver[6] << 8) | ver[7]
    s = f"{majors}.{minors}.{patch}"
    return f"{s}+{build}" if build else s


def parse_tfw(data: bytes) -> dict:
    if data[0:4] != bytes.fromhex("babecafe"):
        raise ValueError("missing babecafe magic")
    if len(data) < 64:
        raise ValueError("truncated header")
    fw_type = data[4]
    checksum = data[5:7]
    version = data[7:15]
    sku = data[15:19]
    info = {
        "size": len(data),
        "firmware_type": fw_type,
        "checksum": checksum.hex(),
        "version": version_string(version),
        "version_bytes": version.hex(),
        "sku": sku_bytes_to_string(sku),
        "sku_bytes": sku.hex(),
        "beefcafe": data[0x40:0x44] == bytes.fromhex("beefcafe"),
        "transfer_offset": 64,
        "transfer_len": len(data) - 64,
    }
    # Encrypted app region (observed on EP 2.5.1)
    if len(data) >= 0x400 + 4:
        blob_off = 0x400
        blob_len = struct.unpack_from("<I", data, 0x8C)[0] if len(data) > 0x90 else None
        info["blob_offset"] = blob_off
        info["blob_len_field"] = blob_len
        if blob_len and blob_off + blob_len <= len(data):
            info["trailer_offset"] = blob_off + blob_len
            info["trailer_len"] = len(data) - (blob_off + blob_len)
    return info


def rewrite_sku(data: bytes, new_sku: str) -> bytes:
    out = bytearray(data)
    out[15:19] = sku_string_to_bytes(new_sku)
    # Header checksum @5-6 is not documented as CRC of body; leave unless we learn otherwise.
    # Caller should compare device acceptance with/without checksum refresh.
    return bytes(out)


def cmd_info(args: argparse.Namespace) -> int:
    data = Path(args.path).read_bytes()
    info = parse_tfw(data)
    for k, v in info.items():
        print(f"{k}: {v}")
    return 0


def cmd_rewrite_sku(args: argparse.Namespace) -> int:
    src = Path(args.path)
    data = src.read_bytes()
    before = parse_tfw(data)
    out = rewrite_sku(data, args.sku)
    after = parse_tfw(out)
    dest = Path(args.output) if args.output else src.with_name(src.stem + f"_{args.sku}" + src.suffix)
    dest.write_bytes(out)
    print(f"wrote {dest}")
    print(f"sku {before['sku']} -> {after['sku']}")
    return 0


def cmd_split(args: argparse.Namespace) -> int:
    data = Path(args.path).read_bytes()
    info = parse_tfw(data)
    out_dir = Path(args.outdir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "header.bin").write_bytes(data[:64])
    (out_dir / "beef.bin").write_bytes(data[64:])
    blob_off = info.get("blob_offset")
    blob_len = info.get("blob_len_field")
    if blob_off and blob_len:
        (out_dir / "blob_enc.bin").write_bytes(data[blob_off : blob_off + blob_len])
        (out_dir / "trailer.bin").write_bytes(data[blob_off + blob_len :])
    print(f"wrote splits under {out_dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("info", help="print header fields")
    i.add_argument("path")
    i.set_defaults(func=cmd_info)

    r = sub.add_parser("rewrite-sku", help="rewrite SKU bytes @15-18")
    r.add_argument("path")
    r.add_argument("--sku", required=True, help="e.g. TE032AS001")
    r.add_argument("-o", "--output")
    r.set_defaults(func=cmd_rewrite_sku)

    s = sub.add_parser("split", help="dump header / beef / blob / trailer")
    s.add_argument("path")
    s.add_argument("-o", "--outdir", required=True)
    s.set_defaults(func=cmd_split)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

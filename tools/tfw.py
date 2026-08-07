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


def crc16_xmodem(data: bytes, start: int = 0) -> int:
    """CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflection, no final XOR.

    This is the algorithm behind the babecafe header checksum @5-6 (stored
    big-endian), computed over data[0x40:] to end of file. The inner beefcafe
    header carries the same CRC over data[0x80:] at bytes 0x49-0x4A. Verified
    against every current official TE .tfw (EP-133 / EP-40 / EP-1320 and the
    rest of the line).
    """
    crc = 0
    for b in data[start:]:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


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
    # Outer checksum @5-6 is CRC-16/XMODEM over data[0x40:] (verified on all
    # current TE .tfw releases).
    stored_crc = (data[5] << 8) | data[6]
    info["checksum_algo"] = "crc16/xmodem over data[0x40:]"
    info["checksum_valid"] = stored_crc == crc16_xmodem(data, 0x40)
    # Inner beefcafe header mirrors the SKU and carries its own CRC-16/XMODEM
    # over data[0x80:] at 0x49-0x4A, plus a size field == len(data) - 128.
    if info["beefcafe"] and len(data) >= 0x5B:
        inner_stored = (data[0x49] << 8) | data[0x4A]
        info["inner_sku"] = sku_bytes_to_string(data[0x57:0x5B])
        info["inner_size_field"] = int.from_bytes(data[0x45:0x49], "big")
        info["inner_checksum_valid"] = inner_stored == crc16_xmodem(data, 0x80)
    # 256-byte signature slot @0x380 (RSA-2048 sized); zero on the unsigned EP
    # images, populated on TE's signed devices. Encrypted payload begins @0x480.
    if len(data) >= 0x480:
        info["signed"] = any(data[0x380:0x480])
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
    # The checksum @5-6 is CRC-16/XMODEM over data[0x40:] (see crc16_xmodem).
    # The outer SKU @15-18 sits *before* 0x40, so it is outside the CRC's range:
    # rewriting it here does NOT invalidate the checksum, no refresh needed.
    # (The inner beefcafe header mirrors the SKU at 0x57, which IS inside the
    # outer CRC range; if a future rewrite touches that too, recompute with
    # crc16_xmodem(out, 0x40) into out[5:7] big-endian, and the inner CRC with
    # crc16_xmodem(out, 0x80) into out[0x49:0x4B].)
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

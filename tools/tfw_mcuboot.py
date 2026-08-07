#!/usr/bin/env python3
"""Parse Teenage Engineering .tfw as babecafe wrapper + MCUboot encrypted image.

Does NOT decrypt. The app payload is AES-128-CTR with a per-image session key
wrapped in ENC_EC256 (ECIES-P256). Unwrapping requires the device private key.
See docs/research/blob-cryptanalysis.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from pathlib import Path

IMAGE_MAGIC = 0x96F3B83D
TLV_INFO_MAGIC = 0x6907
IMAGE_F_ENCRYPTED_AES128 = 0x4

TLV_NAMES = {
    0x10: "SHA256",
    0x01: "KEYHASH",
    0x22: "ECDSA256",
    0x32: "ENC_EC256",
    0x30: "ENC_RSA2048",
    0x31: "ENC_KW",
    0x33: "ENC_X25519",
}


def sku_bytes_to_string(sku: bytes) -> str:
    e = (sku[0] << 24) | (sku[1] << 16) | (sku[2] << 8) | sku[3]
    model = (e >> 14) & 1023
    mid = "??" if ((e >> 10) & 15) else "AS"
    variant = e & 1023
    return f"TE{model:03d}{mid}{variant:03d}"


def parse_tlvs(data: bytes, off: int) -> tuple[dict, int]:
    if off + 4 > len(data):
        raise ValueError("truncated TLV header")
    magic, tot = struct.unpack_from("<HH", data, off)
    if magic != TLV_INFO_MAGIC:
        raise ValueError(f"bad TLV magic {magic:#x} at {off:#x}")
    end = off + 4 + tot
    if end > len(data):
        raise ValueError("TLV tot exceeds file")
    cur = off + 4
    out: dict[str, str] = {}
    while cur + 4 <= end:
        t, l = struct.unpack_from("<HH", data, cur)
        if t == 0 and l == 0:
            break  # zero padding after last TLV
        cur += 4
        if cur + l > end:
            break
        payload = data[cur : cur + l]
        cur += l
        name = TLV_NAMES.get(t, f"TLV_{t:#x}")
        out[name] = payload.hex()
    return out, end


def parse_tfw_mcuboot(data: bytes) -> dict:
    if data[0:4] != bytes.fromhex("babecafe"):
        raise ValueError("missing babecafe")
    if data[0x40:0x44] != bytes.fromhex("beefcafe"):
        raise ValueError("missing beefcafe")
    magic = struct.unpack_from("<I", data, 0x80)[0]
    if magic != IMAGE_MAGIC:
        raise ValueError(f"missing MCUboot IMAGE_MAGIC at 0x80 (got {magic:#x})")

    load_addr, hdr_size, prot_tlv, img_size, flags = struct.unpack_from("<IHHII", data, 0x84)
    version = data[0x94:0x9C]
    sku = data[15:19]
    blob_off = hdr_size  # 0x400
    blob = data[blob_off : blob_off + img_size]
    zero_prefix = 0
    for b in blob:
        if b:
            break
        zero_prefix += 1

    tlv_off = blob_off + img_size
    # TE packaging: 128-byte high-entropy gap before TLV info on 2.5.1
    gap = 0
    if tlv_off + 4 <= len(data) and struct.unpack_from("<H", data, tlv_off)[0] != TLV_INFO_MAGIC:
        # scan forward a little for TLV magic
        found = None
        for delta in range(0, 256, 4):
            if tlv_off + delta + 4 > len(data):
                break
            if struct.unpack_from("<H", data, tlv_off + delta)[0] == TLV_INFO_MAGIC:
                found = delta
                break
        if found is None:
            raise ValueError(f"TLV info not found near {tlv_off:#x}")
        gap = found
        tlv_off = tlv_off + gap

    tlvs, tlv_end = parse_tlvs(data, tlv_off)
    trailer_off = tlv_end
    # skip zero pad
    while trailer_off < len(data) and data[trailer_off] == 0:
        trailer_off += 1

    info = {
        "size": len(data),
        "sku": sku_bytes_to_string(sku),
        "sku_bytes": sku.hex(),
        "version_bytes": version.hex(),
        "mcuboot": {
            "magic": hex(magic),
            "load_addr": hex(load_addr),
            "hdr_size": hex(hdr_size),
            "protect_tlv_size": prot_tlv,
            "img_size": img_size,
            "flags": hex(flags),
            "encrypted_aes128": bool(flags & IMAGE_F_ENCRYPTED_AES128),
        },
        "blob_offset": blob_off,
        "blob_sha256": hashlib.sha256(blob).hexdigest(),
        "blob_zero_prefix": zero_prefix,
        "pre_tlv_gap": gap,
        "tlv_offset": hex(tlv_off),
        "tlvs": {k: (v[:64] + "…" if len(v) > 64 else v) for k, v in tlvs.items()},
        "tlvs_full": tlvs,
        "trailer_offset": hex(trailer_off),
        "trailer_len": len(data) - trailer_off,
        "littlefs_string": b"littlefs-2.10.1" in data[trailer_off:],
        "decrypt": "blocked — need device ECIES-P256 private key for ENC_EC256",
    }
    return info


def cmd_info(args: argparse.Namespace) -> int:
    data = Path(args.path).read_bytes()
    info = parse_tfw_mcuboot(data)
    if args.json:
        # full tlvs in JSON mode
        out = dict(info)
        out["tlvs"] = out.pop("tlvs_full")
        json.dump(out, sys.stdout, indent=2)
        print()
    else:
        info.pop("tlvs_full", None)
        for k, v in info.items():
            if isinstance(v, dict):
                print(f"{k}:")
                for kk, vv in v.items():
                    print(f"  {kk}: {vv}")
            else:
                print(f"{k}: {v}")
    return 0


def cmd_extract(args: argparse.Namespace) -> int:
    data = Path(args.path).read_bytes()
    info = parse_tfw_mcuboot(data)
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    blob_off = info["blob_offset"]
    img_size = info["mcuboot"]["img_size"]
    tlv_off = int(info["tlv_offset"], 16)
    trailer_off = int(info["trailer_offset"], 16)
    (out / "blob_enc.bin").write_bytes(data[blob_off : blob_off + img_size])
    (out / "tlv_region.bin").write_bytes(data[tlv_off:trailer_off])
    (out / "trailer.bin").write_bytes(data[trailer_off:])
    meta = dict(info)
    meta["tlvs"] = meta.pop("tlvs_full")
    (out / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    print(f"wrote {out}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("info")
    i.add_argument("path")
    i.add_argument("--json", action="store_true")
    i.set_defaults(func=cmd_info)
    e = sub.add_parser("extract")
    e.add_argument("path")
    e.add_argument("-o", "--outdir", required=True)
    e.set_defaults(func=cmd_extract)
    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

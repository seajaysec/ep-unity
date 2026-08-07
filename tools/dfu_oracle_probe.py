#!/usr/bin/env python3
"""Non-destructive DFU / crypto oracle probes against a live EP.

The decrypt-first plan hoped for an OP-Z-style encryption oracle (interrupted
DFU / bootloader readback). EP DFU is **write-only ciphertext** — there is no
documented read opcode and PERFORM does not return plaintext.

This script:
  1. GREET + identity (sanity)
  2. Confirms DFU_BEGIN accepts a same-SKU image header without sending chunks
     (abort before CHUNK — staging should not commit)
  3. Parses local .tfw KEYHASH / ENC_EC256 and prints why offline unwrap fails
  4. Optionally compares KEYHASH across multiple .tfw paths

It does **not** brick-risk mid-PERFORM experiments.

    python3 tools/dfu_oracle_probe.py --tfw fw/ep-133_firmware_2_5_1.tfw \\
      --also fw/ep-40_firmware_2_5_1.tfw --also fw/ep-1320_firmware_1_5_0.tfw
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from dfu_capture_flash import (  # noqa: E402
    CMD_DFU,
    DFU_BEGIN,
    TeClient,
    Capture,
    begin_payload,
)
from tfw_mcuboot import parse_tfw_mcuboot  # noqa: E402


def summarize_tfw(path: Path) -> dict:
    data = path.read_bytes()
    info = parse_tfw_mcuboot(data)
    tlvs = info.get("tlvs_full") or info["tlvs"]
    enc = tlvs.get("ENC_EC256", "")
    # truncated display values may contain '…'
    enc_clean = enc.replace("…", "")
    try:
        enc_len = len(bytes.fromhex(enc_clean)) if enc_clean else None
    except ValueError:
        enc_len = None
    return {
        "path": str(path),
        "sku": info["sku"],
        "version_bytes": info["version_bytes"],
        "img_size": info["mcuboot"]["img_size"],
        "flags": info["mcuboot"]["flags"],
        "encrypted_aes128": info["mcuboot"]["encrypted_aes128"],
        "KEYHASH": tlvs.get("KEYHASH"),
        "ENC_EC256_len": enc_len,
        "ENC_EC256_head": enc_clean[:20],
        "SHA256": tlvs.get("SHA256"),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--tfw", type=Path, required=True, help="primary .tfw to summarize / BEGIN-probe")
    ap.add_argument("--also", type=Path, action="append", default=[], help="extra .tfw for KEYHASH compare")
    ap.add_argument("--port", default="EP")
    ap.add_argument("--capture", type=Path, default=Path("docs/research/dfu-captures/oracle-probe.jsonl"))
    ap.add_argument("--skip-live", action="store_true", help="offline TLV compare only")
    args = ap.parse_args()

    reports = [summarize_tfw(args.tfw)]
    for p in args.also:
        reports.append(summarize_tfw(p))

    keyhashes = {r["KEYHASH"] for r in reports if r.get("KEYHASH")}
    print("=== offline MCUboot / TLV ===")
    print(json.dumps(reports, indent=2))
    print(f"\nunique KEYHASH count: {len(keyhashes)}")
    for kh in sorted(keyhashes):
        skus = [r["sku"] for r in reports if r.get("KEYHASH") == kh]
        print(f"  {kh[:16]}… → {skus}")

    print(
        "\nOracle conclusion (static):\n"
        "  AES session keys differ per image (ENC_EC256 differs).\n"
        "  Unwrapping requires device ECIES private key matching KEYHASH.\n"
        "  Host DFU never sees plaintext; no SysEx readback of flash.\n"
        "  Interrupted DFU before PERFORM does not leak keystream over MIDI.\n"
    )

    if args.skip_live:
        return 0

    cap = Capture(args.capture)
    try:
        client = TeClient(args.port, cap)
        sku = client.identity()
        greet = client.greet()
        print("=== live ===")
        print("identity", sku)
        print("greet", greet)
        data = args.tfw.read_bytes()
        # Rewrite SKU if needed so BEGIN is accepted
        from tfw import rewrite_sku, parse_tfw

        info = parse_tfw(data)
        if info["sku"] != sku:
            data = rewrite_sku(data, sku)
            print(f"rewrote SKU {info['sku']} → {sku} for BEGIN probe only")
        begin = begin_payload(data)
        print("DFU_BEGIN probe (no chunks)…")
        ack, text = client.request(CMD_DFU, begin, timeout=20)
        print(f"BEGIN ack len={len(ack)} text={text!r} hex={ack[:8].hex() if ack else ''}")
        print(
            "Aborting without CHUNK/PERFORM — if device stays in normal mode, "
            "BEGIN alone did not commit an image (expected)."
        )
        # Re-greet
        g2 = client.greet()
        print("post-BEGIN greet", g2)
        client.close()
    except Exception as e:
        cap.log(dir="meta", error=str(e))
        print("live probe error:", e)
        return 1
    finally:
        cap.close()

    print("\nWrote", args.capture)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

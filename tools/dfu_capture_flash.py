#!/usr/bin/env python3
"""Logged TE DFU flasher for handshake capture (same sequence as web/lib/dfu.js).

Does not corrupt images. Logs every SysEx to a JSONL capture file.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import mido

# Allow importing sibling tools
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from tfw import parse_tfw, rewrite_sku  # noqa: E402

TE_MFG = (0x00, 0x20, 0x76)
MIDI_SYSEX_TE = 0x40
BIT_IS_REQUEST = 64
BIT_REQUEST_ID_AVAILABLE = 32
CMD_GREET, CMD_DFU = 1, 3
DFU_ENTER, DFU_ENTER_MIDI, DFU_BEGIN, DFU_BEGIN_APP = 1, 1, 2, 176
DFU_CHUNK, DFU_PERFORM, DFU_EXIT, DFU_ENTER_READY = 3, 4, 5, 64
STATUS_OK, STATUS_BAD_REQUEST, STATUS_PROGRESS = 0, 3, 64


def packed_length(n: int) -> int:
    return 0 if n <= 0 else n + (n + 6) // 7


def pack7(raw: bytes) -> bytes:
    if not raw:
        return b""
    out = bytearray(packed_length(len(raw)))
    r, s = 1, 0
    for o, byte in enumerate(raw):
        a = o % 7
        out[s] |= (byte >> 7) << a
        out[r] = byte & 127
        r += 1
        if a == 6 and o < len(raw) - 1:
            s += 8
            r += 1
    return bytes(out)


def unpack7(packed: bytes) -> bytes:
    if not packed:
        return b""
    e = bytearray(packed)
    t = r = s = 0
    o = 1
    a = e[r] if e else 0
    while o < len(e):
        u = (1 if (a & (1 << s)) else 0) << 7
        e[t] = u | (e[o] & 127)
        s += 1
        o += 1
        t += 1
        if s > 6:
            o += 1
            s = 0
            r += 8
            a = e[r] if r < len(e) else 0
    return bytes(e[:t])


class Capture:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = path.open("w")
        self.t0 = time.time()

    def log(self, **kw):
        kw["t"] = round(time.time() - self.t0, 4)
        self._fh.write(json.dumps(kw, default=str) + "\n")
        self._fh.flush()
        line = {k: kw[k] for k in kw if k in ("dir", "step", "status", "text", "pct", "note", "error")}
        if line:
            print(json.dumps(line), flush=True)

    def close(self):
        self._fh.close()


class TeClient:
    def __init__(self, port_substr: str, capture: Capture):
        self.cap = capture
        names_in = mido.get_input_names()
        names_out = mido.get_output_names()
        pin = next((n for n in names_in if port_substr.lower() in n.lower()), None)
        pout = next((n for n in names_out if port_substr.lower() in n.lower()), None)
        if not pin or not pout:
            raise SystemExit(f"no MIDI port matching {port_substr!r}: in={names_in} out={names_out}")
        self.inp = mido.open_input(pin)
        self.out = mido.open_output(pout)
        self.port_in, self.port_out = pin, pout
        self.req_id = 1
        self.device_id = None
        self.cap.log(dir="meta", note=f"opened in={pin} out={pout}")
        # drain
        t0 = time.time()
        while time.time() - t0 < 0.2:
            for _ in self.inp.iter_pending():
                pass

    def close(self):
        self.inp.close()
        self.out.close()

    def _recv_raw(self, timeout: float):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for msg in self.inp.iter_pending():
                if msg.type == "sysex":
                    raw = bytes([0xF0, *msg.data, 0xF7])
                    self.cap.log(dir="rx", hex=raw.hex(), len=len(raw))
                    return raw
            time.sleep(0.002)
        return None

    def identity(self, timeout=3.0):
        req = bytes([0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7])
        self.cap.log(dir="tx", step="identity", hex=req.hex())
        self.out.send(mido.Message("sysex", data=list(req[1:-1])))
        raw = self._recv_raw(timeout)
        if not raw or len(raw) < 17:
            raise TimeoutError("identity timeout")
        # F0 7E <id> 06 02 00 20 76 ...
        self.device_id = raw[2]
        model = raw[8] ^ (raw[9] << 7)
        variant = raw[10] ^ (raw[11] << 7)
        sku = f"TE{model:03d}AS{variant:03d}"
        self.cap.log(dir="meta", step="identity", device_id=self.device_id, sku=sku, hex=raw.hex())
        return sku

    def _send(self, command: int, payload: bytes):
        assert self.device_id is not None
        rid = self.req_id
        self.req_id = (self.req_id + 1) % 4096
        packed = pack7(payload)
        frame = bytearray(10 + len(packed))
        frame[0] = 0xF0
        frame[1:4] = TE_MFG
        frame[4] = self.device_id & 0x7F
        frame[5] = MIDI_SYSEX_TE
        frame[6] = BIT_IS_REQUEST | BIT_REQUEST_ID_AVAILABLE | ((rid >> 7) & 31)
        frame[7] = rid & 127
        frame[8] = command
        if packed:
            frame[9 : 9 + len(packed)] = packed
        frame[-1] = 0xF7
        self.cap.log(
            dir="tx",
            command=command,
            request_id=rid,
            payload_hex=payload.hex(),
            payload_len=len(payload),
            frame_len=len(frame),
        )
        self.out.send(mido.Message("sysex", data=list(frame[1:-1])))
        return rid

    def request(self, command: int, payload: bytes = b"", timeout=20.0, on_progress=None):
        rid = self._send(command, payload)
        deadline = time.time() + timeout
        while time.time() < deadline:
            raw = self._recv_raw(min(0.5, deadline - time.time()))
            if not raw:
                continue
            # TE frame: F0 00 20 76 id 40 flags lo cmd [status] packed F7
            if len(raw) < 10 or raw[1:4] != bytes(TE_MFG) or raw[5] != MIDI_SYSEX_TE:
                # maybe identity leftover / debug
                if len(raw) > 6 and raw[5] == 0x33:
                    text = raw[6:-1].decode("ascii", "replace")
                    self.cap.log(dir="rx", step="debug_frame", text=text)
                continue
            flags = raw[6]
            if flags & BIT_IS_REQUEST:
                continue
            has_id = bool(flags & BIT_REQUEST_ID_AVAILABLE)
            req = ((flags & 31) << 7) | (raw[7] & 127) if has_id else -1
            cmd = raw[8]
            status = raw[9]
            packed = raw[10:-1]
            payload_u = unpack7(packed)
            text = payload_u.decode("latin-1", "replace")
            self.cap.log(
                dir="rx",
                command=cmd,
                request_id=req,
                status=status,
                text=text if len(text) < 200 else text[:200],
                payload_hex=payload_u.hex()[:200],
            )
            if req != rid or cmd != command:
                continue
            if status == STATUS_OK:
                return payload_u, text
            if status == STATUS_PROGRESS:
                pct = payload_u[0] if payload_u else 0
                label = payload_u[1:].decode("utf-8", "replace") if len(payload_u) > 1 else ""
                self.cap.log(dir="rx", step="progress", pct=pct, text=label)
                if on_progress:
                    on_progress(pct, label)
                deadline = time.time() + timeout  # reset
                continue
            raise RuntimeError(f"device status={status} cmd={cmd}: {text}")
        raise TimeoutError(f"timeout waiting for cmd {command}")

    def greet(self):
        payload, text = self.request(CMD_GREET, b"", timeout=5)
        # text may have nulls from unpack quirks; also try parsing payload as ascii stripping nuls
        clean = text.replace("\x00", "")
        self.cap.log(dir="meta", step="greet", text=clean)
        return clean


def begin_payload(data: bytes) -> bytes:
    version = data[7:15]
    sku = data[15:19]
    transfer = len(data) - 64
    size = bytes([(transfer >> 24) & 255, (transfer >> 16) & 255, (transfer >> 8) & 255, transfer & 255])
    return bytes([DFU_BEGIN, *version, DFU_BEGIN_APP, *sku, *size, data[4]])


def flash(client: TeClient, image: bytes, capture: Capture):
    info = parse_tfw(image)
    capture.log(dir="meta", step="image", sku=info["sku"], version=info["version"], size=info["size"])
    begin = begin_payload(image)
    capture.log(dir="meta", step="dfu_begin_payload", hex=begin.hex())

    try:
        ack, _ = client.request(CMD_DFU, begin, timeout=20)
    except RuntimeError as e:
        if "status=3" not in str(e):
            raise
        capture.log(dir="meta", step="begin_rejected_entering_bootloader", error=str(e))
        client.request(CMD_DFU, bytes([DFU_ENTER, DFU_ENTER_MIDI, 0, 200]), timeout=20)
        capture.log(dir="meta", note="device entering bootloader — reconnect and re-run")
        raise SystemExit("bootloader reboot required — reconnect MIDI and re-run this script")

    if ack and ack[0] == DFU_ENTER_READY:
        capture.log(dir="meta", step="in_app_dfu")
    advertised = (ack[0] << 8 | ack[1]) if len(ack) >= 2 else 0
    max_chunk = max(16, (advertised * 7 + 7) // 8 - 12) if advertised else 235
    if ack and ack[0] == DFU_ENTER_READY:
        max_chunk = 235
    capture.log(dir="meta", step="chunk_size", advertised=advertised, max_chunk=max_chunk)

    offset = 64
    chunk_n = 0
    total = len(image)
    while offset < total:
        end = min(offset + max_chunk, total)
        slice_ = image[offset:end]
        payload = bytes([DFU_CHUNK, chunk_n % 256]) + slice_
        client.request(CMD_DFU, payload, timeout=5)
        offset = end
        chunk_n += 1
        if chunk_n % 50 == 0 or offset >= total:
            pct = int(offset / total * 100)
            capture.log(dir="meta", step="transfer", pct=pct, offset=offset)

    def on_prog(pct, label):
        print(f"  perform {pct}% {label}", flush=True)

    client.request(CMD_DFU, bytes([DFU_PERFORM]), timeout=120, on_progress=on_prog)
    try:
        client.request(CMD_DFU, bytes([DFU_EXIT]), timeout=2)
    except TimeoutError:
        capture.log(dir="meta", note="DFU_EXIT timeout (expected if rebooting)")
    capture.log(dir="meta", step="flash_complete")


def wait_reconnect(substr: str, capture: Capture, timeout=60):
    capture.log(dir="meta", step="wait_reconnect")
    deadline = time.time() + timeout
    while time.time() < deadline:
        names = mido.get_input_names()
        if any(substr.lower() in n.lower() for n in names):
            time.sleep(1.5)  # settle
            return
        time.sleep(0.5)
    raise TimeoutError("device did not reappear")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tfw", type=Path)
    ap.add_argument("--port", default="EP")
    ap.add_argument("--sku", help="rewrite header SKU to this before flash")
    ap.add_argument("--capture", type=Path, required=True)
    ap.add_argument("--skip-flash", action="store_true", help="only greet/identity")
    args = ap.parse_args()

    data = args.tfw.read_bytes()
    info = parse_tfw(data)
    cap = Capture(args.capture)
    try:
        client = TeClient(args.port, cap)
        sku = client.identity()
        greet = client.greet()
        print(f"before: identity_sku={sku} greet={greet!r}", flush=True)

        if args.skip_flash:
            return 0

        if args.sku and args.sku != info["sku"]:
            data = rewrite_sku(data, args.sku)
            info = parse_tfw(data)
            cap.log(dir="meta", step="sku_rewrite", to=args.sku)
            print(f"rewrote SKU -> {args.sku}", flush=True)
        elif info["sku"] != sku:
            # auto-match connected device for DFU_BEGIN
            data = rewrite_sku(data, sku)
            cap.log(dir="meta", step="sku_rewrite_auto", to=sku, from_sku=info["sku"])
            print(f"auto-rewrote SKU {info['sku']} -> {sku}", flush=True)

        flash(client, data, cap)
        client.close()

        wait_reconnect(args.port, cap)
        client2 = TeClient(args.port, cap)
        sku2 = client2.identity()
        greet2 = client2.greet()
        print(f"after: identity_sku={sku2} greet={greet2!r}", flush=True)
        cap.log(dir="meta", step="after", identity_sku=sku2, greet=greet2)
        client2.close()
        return 0
    except Exception as e:
        cap.log(dir="meta", error=str(e))
        raise
    finally:
        cap.close()
        print(f"capture -> {args.capture}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())

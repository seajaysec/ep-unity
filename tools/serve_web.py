#!/usr/bin/env python3
"""Serve web/ with a same-origin proxy for TE catalogs (no CORS on TE CDN).

    python3 tools/serve_web.py
    # → http://localhost:8766/

Proxies:
  GET /api/releases  → teenage.engineering/_software/releases.json
  GET /api/factory   → discover factory .pak asset URLs from EP Sample Tool JS
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DOCS = ROOT / "docs"

TE_RELEASES = "https://teenage.engineering/_software/releases.json"
SAMPLE_TOOL = "https://teenage.engineering/apps/ep-sample-tool/"
ASSET_BASE = "https://teenage.engineering/apps/ep-sample-tool/assets/"

# Static fallbacks if Sample Tool scrape fails (hashed names change over time).
FACTORY_FALLBACK = [
    {
        "product": "EP-133",
        "sku": "TE032AS001",
        "filename": "ep-133-factory-content-DRyE_DHC.pak",
        "url": ASSET_BASE + "ep-133-factory-content-DRyE_DHC.pak",
    },
    {
        "product": "EP-40",
        "sku": "TE032AS006",
        "filename": "ep-40-factory-content-C42FyxWp.pak",
        "url": ASSET_BASE + "ep-40-factory-content-C42FyxWp.pak",
    },
]

TE032_META = {
    "TE032AS001": {"product": "EP-133", "label": "k.o. II"},
    "TE032AS006": {"product": "EP-40", "label": "riddim"},
    "TE032AS005": {"product": "EP-1320", "label": "medieval"},
}


def fetch(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "ep-unity-serve/1.0 (lab helper; not TE)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


@lru_cache(maxsize=1)
def _releases_cached(_bucket: int) -> dict:
    """Cache ~60s buckets so we don't hammer TE on every page reload."""
    return json.loads(fetch(TE_RELEASES).decode("utf-8"))


def releases_payload() -> dict:
    bucket = int(__import__("time").time() // 60)
    raw = _releases_cached(bucket)
    devices = []
    for entry in raw.get("devices", []):
        sku = entry.get("sku")
        meta = TE032_META.get(sku)
        if not meta:
            continue
        devices.append(
            {
                **meta,
                "sku": sku,
                "version": entry.get("version"),
                "fwUrl": entry.get("fw_url"),
                "downloadPage": entry.get("link"),
                "releaseNotes": entry.get("release_notes") or "",
            }
        )
    # Stable order: 133, 40, medieval
    order = ["TE032AS001", "TE032AS006", "TE032AS005"]
    devices.sort(key=lambda d: order.index(d["sku"]) if d["sku"] in order else 99)
    return {
        "source": TE_RELEASES,
        "fetched": True,
        "devices": devices,
        "rawDeviceCount": len(raw.get("devices", [])),
    }


@lru_cache(maxsize=1)
def _factory_cached(_bucket: int) -> dict:
    html = fetch(SAMPLE_TOOL).decode("utf-8", errors="replace")
    m = re.search(r'src="/apps/ep-sample-tool/assets/(index-[^"]+\.js)"', html)
    if not m:
        raise RuntimeError("could not find Sample Tool bundle in HTML")
    js = fetch(ASSET_BASE + m.group(1)).decode("utf-8", errors="replace")
    names = sorted(set(re.findall(r"ep-\d+-factory-content-[A-Za-z0-9_-]+\.pak", js)))
    packs = []
    for name in names:
        product = "EP-133" if name.startswith("ep-133") else (
            "EP-40" if name.startswith("ep-40") else name.split("-")[0].upper()
        )
        sku = {
            "EP-133": "TE032AS001",
            "EP-40": "TE032AS006",
        }.get(product, "")
        packs.append(
            {
                "product": product,
                "sku": sku,
                "filename": name,
                "url": ASSET_BASE + name,
            }
        )
    return {
        "source": SAMPLE_TOOL,
        "bundle": m.group(1),
        "fetched": True,
        "packs": packs,
        "note": "EP-1320 Medieval has no factory .pak in Sample Tool assets (mostly onboard ROM).",
    }


def factory_payload() -> dict:
    bucket = int(__import__("time").time() // 300)  # 5 min
    try:
        return _factory_cached(bucket)
    except Exception as exc:  # noqa: BLE001
        return {
            "source": SAMPLE_TOOL,
            "fetched": False,
            "error": str(exc),
            "packs": FACTORY_FALLBACK,
            "note": "Using static fallback URLs; Sample Tool scrape failed.",
        }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # directory is overridden per-request for /blog and /disclosure
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/releases":
            return self._json(releases_payload())
        if path == "/api/factory":
            return self._json(factory_payload())
        if path.startswith("/blog/"):
            return self._serve_docs(path[len("/blog/") :], DOCS / "blog")
        if path.startswith("/disclosure/"):
            return self._serve_docs(path[len("/disclosure/") :], DOCS / "disclosure")
        return super().do_GET()

    def _serve_docs(self, rel: str, root: Path):
        # Prevent path escape
        target = (root / rel).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404, f"missing {rel}")
            return
        data = target.read_bytes()
        ctype = "text/html; charset=utf-8"
        if target.suffix == ".md":
            ctype = "text/markdown; charset=utf-8"
        elif target.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif target.suffix == ".js":
            ctype = "text/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, payload: dict):
        body = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if " /lib/" in msg or " /styles.css" in msg or " /app.js" in msg:
            return
        super().log_message(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8766)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"ep-unity web → http://{args.host}:{args.port}/", flush=True)
    print("  /api/releases  live TE032 firmware catalog", flush=True)
    print("  /api/factory   Sample Tool factory .pak URLs", flush=True)
    print("  /blog/         docs/blog (four-bytes write-up)", flush=True)
    print("  /disclosure/   private heads-up letter", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

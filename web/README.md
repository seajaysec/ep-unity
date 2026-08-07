# ep-unity web helper

Static page under `web/`. No TE updater JS. Firmwares and factory packs stay on TE’s CDN (you download them). Backup / thin / restore all run **in the browser** via a bundled kotu FILE stack (`lib/kotu.bundle.js`).

## Run

TE’s CDN has no CORS headers, so the browser cannot fetch `releases.json` directly. Start the tiny Node proxy:

```bash
node web/serve.mjs
# → http://localhost:8766/
```

- `GET /api/releases` — live TE032 firmware versions from [`releases.json`](https://teenage.engineering/_software/releases.json)
- `GET /api/factory` — factory `.pak` asset URLs scraped from EP Sample Tool (with static fallback)

Without the proxy, the page still loads; firmware links fall back to versions baked into `lib/catalog.js`.

## Flow

1. **Connect device** — serial is shown large (stable hardware ID); copy it; profile saved in localStorage
2. **Backup device to .pak** — WebMIDI FILE (kotu); projects + samples download in-page
3. Download the OS you want from the live TE links → drop the `.tfw` → risk boxes → **Flash on device**
4. Optional: download a factory `.pak` → pick projects → **download thinned .pak** and/or **restore selection to device** (same FILE session)

Read the write-up while the server is up: [http://localhost:8766/blog/four-bytes.html](http://localhost:8766/blog/four-bytes.html).

## Why not “use TE’s updater”?

Their app **always fetches** the `.tfw` that matches the connected device SKU from `releases.json`. There is no supported “upload this other OS” path — so a rewritten file alone never gets the Update button to install EP-40 onto an EP-133 (or the reverse).

This page speaks **DFU over WebMIDI** itself after rewriting the header SKU to match the live device.

## Tests

```bash
node --test web/lib/*.test.js
# pak inspect/thin smoke (needs a local factory .pak):
node --input-type=module -e "import {inspectPak,buildThinnedPak} from './web/lib/pak.js'; …"
```

## What we ship

| Module | Role |
|---|---|
| `serve.mjs` | Static + catalog proxy (Node) |
| `lib/catalog.js` | TE032 fallbacks + live `/api/releases` + `/api/factory` |
| `lib/tfw.js` | babecafe parse / SKU rewrite |
| `lib/te-pack.js` | TE DFU 7-bit SysEx pack |
| `lib/midi.js` | WebMIDI identity + GREET + DFU request/response |
| `lib/dfu.js` | DFU_BEGIN / CHUNK / PERFORM / EXIT |
| `lib/kotu.bundle.js` | kotu WebMIDI + FILE + zip (esbuild of `build/kotu-entry.ts`) |
| `lib/pak.js` | factory `.pak` inspect / thin (kotu zip) |
| `lib/backup.js` | FILE backup / restore using kotu |

## What we don’t

- Host or redistribute `teenage.engineering/apps/update`
- Host `.tfw` / `.pak` binaries

# Launch checklist

Nothing here is done. This is the sequence for when you give the signal.

## Decisions still yours

1. **GitHub repo name** — `seajaysec/ep-unity` unless you want otherwise.
2. **Tool URL** — see hosting below. `ep-unity.linecross.ing` is the recommendation.
3. **YouTube link** — paste it in and I'll place it.
4. **Whether the tool is public at all.** It's currently nowhere; I took it down.

## Hosting the tool: what's actually possible

**GitHub Pages cannot serve a path on someone else's domain.** Custom domains work
at the apex or a subdomain, never `linecross.ing/ep-unity/`. Three real options:

| | URL | How | Trade-off |
|---|---|---|---|
| **A. Subdomain (recommended)** | `ep-unity.linecross.ing` | CNAME at Porkbun → `seajaysec.github.io`, plus a `CNAME` file in the repo | Standard, free TLS from GitHub, obviously yours. Nothing to maintain. |
| **B. Path via reverse proxy** | `linecross.ing/ep-unity/` | nginx `proxy_pass` to `seajaysec.github.io` | Fragile: Pages redirects on `Host`, asset paths need the repo configured for a subpath, and you're proxying a third party you don't control. |
| **C. Self-hosted** | `linecross.ing/ep-unity/` | rsync to nginx-root, as before | Full control, but the tool lives on the same box as the blog and you maintain it. |

A is the one to pick. The URL still reads as your site, GitHub handles the cert,
and a static-only host makes the "this never calls TE" claim structurally true —
there's no server that *could* call them.

### Steps for A, when you say go

1. Create the repo, push `main`.
2. Settings → Pages → deploy from `main`, folder `/web` (or move `web/` to `/docs`).
3. Add `web/CNAME` containing `ep-unity.linecross.ing`.
4. At Porkbun: `CNAME  ep-unity  →  seajaysec.github.io`.
5. Wait for DNS, then tick **Enforce HTTPS** in Pages settings.
6. Verify WebMIDI works over the new origin — it needs a secure context, which
   Pages provides, but the service worker scope changes and wants a real check.

## Before the first push

```bash
tools/check_publishable.sh     # must print "clean — safe to publish"
```

Currently clean: 72 files, 2.0 MB. Excluded by `.gitignore` and re-checked by that
script:

- `fw/` — seven TE firmware images. Not ours to redistribute.
- `vendor/` — TE's updater app and a clone of ep-series-sysex.
- `backups/`, `docs/research/dfu-captures/`, `dfu-lab/`, `live-device-*.json` —
  device data, and 30 files carrying the hardware serial.
- `docs/disclosure/` — the private letter to TE.
- `ops/`, `tools/stage_ghost*.sh`, `tools/deploy_web.sh` — your server config and
  deploy tooling.
- `docs/research/dfu-roundtrip.md` and `NOR-CONCLUSION.md` — still quote the serial.
  Scrub and un-ignore if you want them public; they're good notes.

## Blog post: links to add

Drop this in near the `ep-unity` section. Nothing is filled in yet.

```markdown
The tool is at [ep-unity.linecross.ing](https://ep-unity.linecross.ing/), the source
is on [GitHub](https://github.com/seajaysec/ep-unity), and there's a walkthrough on
[YouTube](PASTE_URL_HERE).
```

## Post state

| slug | state |
|---|---|
| `ko-ii-boots-as-a-riddim` | the one to publish — your edits, Part 2 folded in, no serial |
| `after-the-cross-flash` | redundant now; delete it |
| `four-bytes-and-a-product-line` | the original long-form version; delete or keep as an archive |

The NOR section replacement (the 2.5.x sample-rate correction) is **not yet applied**
to the draft — it's sitting in the copy-paste page.

## Order of operations on the day

1. Apply the NOR section correction to the draft.
2. Add the YouTube link.
3. `tools/check_publishable.sh` → clean.
4. Create and push the GitHub repo.
5. Turn on Pages + DNS, confirm the tool loads and WebMIDI works on the new origin.
6. Publish the post.
7. Delete the two redundant drafts.

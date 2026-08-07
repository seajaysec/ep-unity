#!/usr/bin/env python3
"""Render a blog Markdown source into the standalone article HTML.

The Markdown files under docs/blog/ are the editing surface. Prose is ordinary
Markdown; the visual figures stay as raw HTML blocks and pass through untouched,
because their styling is the whole point of them.

    python3 tools/build_post.py docs/blog/four-bytes.md

Writes docs/blog/four-bytes.build.html next to the source. Chain:

    four-bytes.md -> build_post.py -> four-bytes.html -> build_ghost_post.py

Deliberately dependency-free. It supports exactly the Markdown these posts use;
it is not a general CommonMark implementation. If you reach for a feature it
does not have, either add it here or drop to a raw HTML block.
"""

from __future__ import annotations

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = ROOT / "docs/blog/post.css"

# A line opening one of these at column 0 starts a raw passthrough block.
RAW_OPENERS = ("<figure", "<ol", "<ul", "<div", "<table", "<aside", "<pre")

HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <meta name="description" content="{description}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&amp;family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&amp;family=Literata:opsz,wght@7..72,500;7..72,700&amp;display=swap" rel="stylesheet" />
  <style>
{css}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <p class="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p class="dek">{dek}</p>
      <p class="meta-line">{meta}</p>
    </header>

{callouts}
    <article>
{article}
    </article>
  </div>
</body>
</html>
"""


def inline(text: str) -> str:
    """Markdown inline spans -> HTML. Code spans are protected first."""
    codes: list[str] = []

    def stash(match: re.Match[str]) -> str:
        codes.append(f"<code>{html.escape(match.group(1))}</code>")
        return f"\x00{len(codes) - 1}\x00"

    text = re.sub(r"`([^`]+)`", stash, text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![*\w])\*([^*]+)\*(?!\w)", r"<em>\1</em>", text)
    text = re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)
    return text


def split_blocks(body: str) -> list[tuple[str, str]]:
    """-> [(kind, text)] where kind is 'raw' or 'md'."""
    blocks: list[tuple[str, str]] = []
    lines = body.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if any(line.startswith(tag) for tag in RAW_OPENERS):
            tag = re.match(r"<(\w+)", line).group(1)
            closer = f"</{tag}>"
            chunk = [line]
            depth = line.count(f"<{tag}") - line.count(closer)
            while depth > 0 and i + 1 < len(lines):
                i += 1
                chunk.append(lines[i])
                depth += lines[i].count(f"<{tag}") - lines[i].count(closer)
            blocks.append(("raw", "\n".join(chunk)))
            i += 1
            continue
        if not line.strip():
            i += 1
            continue
        chunk = []
        while i < len(lines) and lines[i].strip():
            if any(lines[i].startswith(tag) for tag in RAW_OPENERS):
                break
            chunk.append(lines[i])
            i += 1
        blocks.append(("md", "\n".join(chunk)))
    return blocks


def render_md_block(text: str) -> str:
    lines = text.split("\n")
    first = lines[0]

    if first.startswith("### "):
        return f"<h3>{inline(first[4:])}</h3>"
    if first.startswith("## "):
        return f"<h2>{inline(first[3:])}</h2>"
    if first.strip() == "---":
        return ""

    if first.startswith("> "):
        stripped = [ln[2:] if ln.startswith("> ") else ln.lstrip("> ") for ln in lines]
        cite = ""
        while stripped and not stripped[-1].strip():
            stripped.pop()
        if stripped and stripped[-1].lstrip().startswith("—"):
            cite = f"<cite>{inline(stripped.pop().lstrip()[1:].strip())}</cite>"
        para = inline(" ".join(s.strip() for s in stripped if s.strip()))
        if para.startswith("<strong>Unsupported."):
            return f'<aside class="callout" role="note">{para}</aside>'
        return f"<blockquote><p>{para}</p>{cite}</blockquote>"

    if first.lstrip().startswith(("- ", "* ")):
        items = "".join(
            f"<li>{inline(ln.lstrip()[2:])}</li>" for ln in lines if ln.strip()
        )
        return f"<ul>{items}</ul>"

    if re.match(r"^\d+\.\s", first):
        marker = re.compile(r"^\d+\.\s+")
        items = "".join(
            "<li>" + inline(marker.sub("", ln.strip())) + "</li>"
            for ln in lines
            if ln.strip()
        )
        return f"<ol>{items}</ol>"

    if first.startswith("|"):
        rows = [ln for ln in lines if ln.strip().startswith("|")]
        cells = [
            [c.strip() for c in row.strip().strip("|").split("|")] for row in rows
        ]
        head, body_rows = cells[0], cells[2:]  # cells[1] is the ---|--- separator
        thead = "".join(f"<th>{inline(c)}</th>" for c in head)
        tbody = "".join(
            "<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>"
            for row in body_rows
        )
        return (
            '<div class="tablewrap"><table>'
            f"<thead><tr>{thead}</tr></thead><tbody>{tbody}</tbody>"
            "</table></div>"
        )

    return f"<p>{inline(' '.join(ln.strip() for ln in lines))}</p>"


def build(source: Path) -> Path:
    text = re.sub(r"<!--.*?-->", "", source.read_text(), flags=re.S)

    title_match = re.search(r"^#\s+(.+)$", text, re.M)
    if not title_match:
        raise SystemExit(f"{source}: no '# Title' line")
    title = title_match.group(1).strip()

    def pull(label: str) -> str:
        match = re.search(rf"^\*\*{label}\.\*\*\s*(.+)$", text, re.M)
        if not match:
            raise SystemExit(f"{source}: missing '**{label}.**' line")
        return inline(match.group(1).strip())

    dek, meta = pull("Dek"), pull("Meta line")

    body = text[title_match.end() :]
    body = re.sub(r"^\*\*(?:Dek|Meta line)\.\*\*.*$", "", body, flags=re.M)

    rendered = [
        piece if kind == "raw" else render_md_block(piece)
        for kind, piece in split_blocks(body)
    ]

    callouts = [r for r in rendered if r.startswith('<aside class="callout"')]
    article = [r for r in rendered if r and not r.startswith('<aside class="callout"')]

    out = source.with_suffix(".build.html")
    out.write_text(
        HEAD.format(
            title=html.escape(title),
            description=html.escape(re.sub(r"<[^>]+>", "", dek)),
            css="\n".join("    " + ln if ln.strip() else ln
                          for ln in CSS.read_text().rstrip().split("\n")),
            eyebrow="Lab notebook &middot; EP-133 &middot; EP-40 &middot; USB MIDI",
            dek=dek,
            meta=meta,
            callouts="\n".join(f"    {c}\n" for c in callouts),
            article="\n\n".join(f"      {r}" for r in article),
        )
    )
    figures = "\n".join(article).count("<figure>")
    print(f"wrote {out.relative_to(ROOT)}  ({len(article)} blocks, {figures} figures, "
          f"{len(callouts)} callout(s))")
    return out


if __name__ == "__main__":
    targets = [Path(a) for a in sys.argv[1:]] or sorted(
        p for p in (ROOT / "docs/blog").glob("*.md")
    )
    for target in targets:
        build(target if target.is_absolute() else ROOT / target)

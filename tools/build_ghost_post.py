#!/usr/bin/env python3
"""Build Ghost-friendly HTML from the standalone Four Bytes article.

Ordinary prose remains ordinary HTML so Ghost converts it into native,
WYSIWYG-editable Lexical blocks. Visual figures, callouts, and the DFU
timeline are wrapped in Ghost HTML-card markers so their custom styling
survives the conversion.
"""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "docs/blog/four-bytes.html"


GHOST_CSS = r"""
<style>
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Literata:opsz,wght@7..72,500;7..72,700&display=swap");

body.post-template {
  background:
    radial-gradient(ellipse 80% 50% at 10% -10%, #dfe8e2 0%, transparent 55%),
    linear-gradient(180deg, #eef2ee 0%, #e8ece8 28%, #e4eae4 100%);
  color: #1a2420;
}

.gh-article {
  padding: 3rem 1.25rem 5rem;
}

.gh-article-title {
  font-family: Literata, Georgia, serif;
  font-size: clamp(2rem, 4.5vw, 2.85rem);
  letter-spacing: -0.02em;
  line-height: 1.15;
  margin: 0 auto 1.5rem;
  max-width: 42rem;
}

.gh-content {
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 1.05rem;
  line-height: 1.65;
}

.gh-content > * {
  margin-left: auto;
  margin-right: auto;
  max-width: 42rem;
}

.gh-content > p {
  margin-bottom: 1rem;
}

.gh-content h2 {
  font-family: Literata, Georgia, serif;
  font-size: 1.55rem;
  letter-spacing: -0.015em;
  margin-bottom: 0.85rem;
  margin-top: 2.75rem;
}

.gh-content h3 {
  font-size: 1.05rem;
  margin-bottom: 0.5rem;
  margin-top: 1.75rem;
}

.gh-content > ul,
.gh-content > ol {
  margin-bottom: 1.1rem;
  padding-left: 1.25rem;
}

.gh-content li {
  margin-bottom: 0.4rem;
}

.gh-content blockquote {
  border-left: 3px solid #c45c26;
  color: #33413a;
  font-style: italic;
  margin-bottom: 1.25rem;
  margin-top: 1.25rem;
  padding: 0.4rem 0 0.4rem 1.1rem;
}

.gh-content code {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 2px;
  padding: 0.1em 0.35em;
}

.gh-content p a,
.gh-content p code,
.gh-content li a,
.gh-content li code,
.gh-content figcaption a,
.gh-content figcaption code {
  overflow-wrap: anywhere;
  word-break: break-word;
}

.fb-intro {
  margin-bottom: 2rem;
}

.fb-dek {
  color: #4a5a52;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 1.12rem;
  line-height: 1.65;
  margin: 0 0 1rem;
}

.fb-meta {
  color: #4a5a52;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.78rem;
}

.fb-callout {
  background: #fff4e8;
  border: 1px solid #d4a06a;
  border-radius: 2px;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 0.95rem;
  margin: 1.5rem auto 2rem;
  padding: 1rem 1.15rem;
}

.fb-callout.follow {
  background: #eef5f0;
  border-color: #8aab96;
}

.fb-callout strong {
  color: #7a3d12;
}

.fb-figure {
  margin: 1.75rem auto 2rem;
  max-width: 52rem;
}

.fb-figure figcaption {
  color: #4a5a52;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  line-height: 1.5;
  margin-top: 0.55rem;
}

.fb-terminal {
  background: #1c221f;
  border-radius: 4px;
  box-shadow: 0 12px 40px rgba(26, 36, 32, 0.18);
  color: #c8d6cc;
  overflow: hidden;
}

.fb-terminal .bar {
  align-items: center;
  background: #2a332e;
  color: #9aada0;
  display: flex;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.68rem;
  gap: 0.4rem;
  padding: 0.55rem 0.75rem;
}

.fb-terminal .bar .dot {
  background: #5a6b60;
  border-radius: 50%;
  height: 0.55rem;
  width: 0.55rem;
}

.fb-terminal pre {
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  line-height: 1.55;
  margin: 0;
  overflow-x: auto;
  padding: 1rem 1.1rem 1.2rem;
  white-space: pre;
}

.fb-terminal .hi {
  background: #c45c26;
  border-radius: 1px;
  color: #fff;
  padding: 0 0.1em;
}

.fb-terminal .hi2 {
  background: #3f5d6a;
  border-radius: 1px;
  color: #fff;
  padding: 0 0.1em;
}

.fb-terminal .dim { color: #7a8f82; }
.fb-terminal .ok { color: #7dcea0; }

.fb-pair {
  display: grid;
  gap: 0.75rem;
}

@media (min-width: 1100px) {
  .fb-pair.cols-2 {
    margin-left: calc(50% - 40vw);
    margin-right: calc(50% - 40vw);
    grid-template-columns: 1fr 1fr;
  }
}

.fb-devtools {
  background: #252a2e;
  border-radius: 6px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.22);
  color: #d7dde3;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.72rem;
  overflow: hidden;
}

.fb-devtools .chrome {
  background: #1b1f23;
  border-bottom: 1px solid #3a424a;
  color: #9aa5b0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
}

.fb-devtools .tab {
  border-radius: 3px;
  padding: 0.2rem 0.45rem;
}

.fb-devtools .tab.on {
  background: #3c464f;
  color: #fff;
}

.fb-devtools .url {
  background: #121517;
  border-radius: 3px;
  color: #8ab4f8;
  flex: 1;
  min-width: 12rem;
  padding: 0.25rem 0.5rem;
}

.fb-devtools .rows { padding: 0.35rem 0; }

.fb-devtools .row {
  border-bottom: 1px solid #30363c;
  display: grid;
  gap: 0.5rem;
  grid-template-columns: 4.5rem 1fr 4rem 3.5rem;
  padding: 0.35rem 0.75rem;
}

.fb-devtools .row.sel { background: #303848; }
.fb-devtools .method,
.fb-devtools .status { color: #89d185; }

.fb-devtools .pane {
  background: #1a1e22;
  border-top: 1px solid #3a424a;
  color: #c5cdd6;
  line-height: 1.5;
  overflow-x: auto;
  padding: 0.85rem 0.9rem 1rem;
}

.fb-devtools .pane pre {
  margin: 0;
  white-space: pre;
}

.fb-devtools .key { color: #9cdcfe; }
.fb-devtools .str { color: #ce9178; }

.fb-snippet {
  background: #f4f7f4;
  border: 1px solid #b8c4bc;
  border-radius: 3px;
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.74rem;
  line-height: 1.55;
  margin: 0;
  overflow-x: auto;
  padding: 0.9rem 1rem;
  white-space: pre;
}

.fb-snippet .cmt { color: #6a7a70; }
.fb-snippet .kw { color: #8a2f0e; }
.fb-snippet .str { color: #1f5a3a; }

.fb-seq {
  border-left: 2px solid #b8c4bc;
  list-style: none;
  margin: 1rem 0 1.5rem;
  padding: 0;
}

.fb-seq li {
  margin: 0;
  padding: 0.55rem 0 0.55rem 1.15rem;
  position: relative;
}

.fb-seq li::before {
  background: #c45c26;
  border-radius: 50%;
  content: "";
  height: 8px;
  left: -5px;
  position: absolute;
  top: 1rem;
  width: 8px;
}

.fb-seq strong {
  font-family: "IBM Plex Mono", monospace;
  font-size: 0.85em;
  font-weight: 600;
}

.fb-sources {
  border-top: 1px solid #b8c4bc;
  color: #4a5a52;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 0.88rem;
  margin-top: 3.5rem;
  padding-top: 1.5rem;
}

@media (max-width: 700px) {
  .fb-devtools .row {
    grid-template-columns: 3.5rem minmax(9rem, 1fr) 3rem;
  }

  .fb-devtools .row > :last-child {
    display: none;
  }
}

.fb-tablewrap {
  margin: 1.6rem auto;
  max-width: 42rem;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.fb-tablewrap table {
  background: #f4f7f4;
  border-collapse: collapse;
  font-size: 0.9rem;
  min-width: 30rem;
  width: 100%;
}

.fb-tablewrap th,
.fb-tablewrap td {
  border-bottom: 1px solid #b8c4bc;
  padding: 0.6rem 0.75rem;
  text-align: left;
  vertical-align: top;
}

.fb-tablewrap th {
  border-bottom-width: 2px;
  color: #4a5a52;
  font-family: "IBM Plex Sans", system-ui, sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.fb-tablewrap tr:last-child td { border-bottom: none; }
</style>
""".strip()


def capture(source: str, pattern: str, label: str) -> str:
    match = re.search(pattern, source, flags=re.DOTALL)
    if not match:
        raise RuntimeError(f"could not find {label}")
    return match.group(1).strip()


def html_card(fragment: str) -> str:
    return (
        "<!--kg-card-begin: html-->\n"
        f"{fragment.strip()}\n"
        "<!--kg-card-end: html-->"
    )


def ghost_classes(fragment: str) -> str:
    replacements = {
        'class="callout"': 'class="fb-callout"',
        'class="terminal"': 'class="fb-terminal"',
        'class="pair cols-2"': 'class="fb-pair cols-2"',
        'class="devtools"': 'class="fb-devtools"',
        'class="snippet"': 'class="fb-snippet"',
        'class="seq"': 'class="fb-seq"',
        'class="tablewrap"': 'class="fb-tablewrap"',
    }
    for old, new in replacements.items():
        fragment = fragment.replace(old, new)
    fragment = fragment.replace("<figure>", '<figure class="fb-figure">')
    return fragment


def main(source_path: Path = DEFAULT_SOURCE) -> None:
    source = source_path.read_text()
    output_path = source_path.with_suffix(".ghost.html")

    dek = capture(source, r'<p class="dek">(.*?)</p>', "dek")
    meta = capture(source, r'<p class="meta-line">(.*?)</p>', "meta line")
    callouts = re.findall(
        r'<aside class="callout"[^>]*>(.*?)</aside>', source, flags=re.DOTALL
    )
    if not callouts:
        raise RuntimeError("expected at least one callout, found none")

    article = capture(source, r"<article>(.*?)</article>", "article")
    expected_figures = article.count("<figure>")
    footer_match = re.search(
        r'<footer class="fin">\s*<p>(.*?)</p>\s*</footer>', source, flags=re.DOTALL
    )
    footer = footer_match.group(1).strip() if footer_match else ""

    for pattern in (
        r"<figure>.*?</figure>",
        r'<ol class="seq">.*?</ol>',
        r'<div class="tablewrap">.*?</table></div>',
    ):
        article = re.sub(
            pattern,
            lambda match: html_card(ghost_classes(match.group(0))),
            article,
            flags=re.DOTALL,
        )

    intro = (
        '<div class="fb-intro">\n'
        f'  <p class="fb-dek">{dek}</p>\n'
        f'  <p class="fb-meta">{meta}</p>\n'
        "</div>"
    )
    pieces = [html_card(GHOST_CSS), html_card(intro)]
    pieces.append(html_card(f'<aside class="fb-callout">{callouts[0].strip()}</aside>'))
    pieces.extend(
        html_card(f'<aside class="fb-callout follow">{extra.strip()}</aside>')
        for extra in callouts[1:]
    )
    pieces.append(article)
    if footer:
        pieces.append(html_card(f'<div class="fb-sources"><p>{footer}</p></div>'))

    output = "\n\n".join(pieces)
    output_path.write_text(output + "\n")

    card_count = output.count("<!--kg-card-begin: html-->")
    figure_count = output.count('class="fb-figure"')
    if figure_count != expected_figures:
        raise RuntimeError(
            f"figure loss: source had {expected_figures}, output has {figure_count}"
        )

    print(f"wrote {output_path.relative_to(ROOT)}")
    print(f"html cards: {card_count}; styled figures: {figure_count}")


if __name__ == "__main__":
    import sys

    for arg in sys.argv[1:] or [DEFAULT_SOURCE]:
        path = Path(arg)
        main(path if path.is_absolute() else ROOT / path)

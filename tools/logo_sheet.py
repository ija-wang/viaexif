"""Render every brand mark at the exact same optical height and screenshot it.

This is the visual gate for "all logos look the same size, and each keeps its
own colours". One cell per mark, on the white bar it is actually drawn on.

Every file in web/assets/brands is normalised by tools/normalize-logos.mjs to a
200-unit-tall viewBox whose ink fills 92% of that box, so setting the same CSS
height on each <img> is enough to make them match — the mark height here is the
same number the renderer uses (bar height / 3).

The cell is sized from the *widest* mark rather than the other way round: at four
columns Hasselblad (13.4:1) overflowed its cell and got clipped by the rounded
corner, which read as a broken logo instead of a wide one.

A dark row is deliberately *not* included: on dark templates the renderer only
repaints a mark's neutral ink white (Fujifilm keeps its red block, Canon keeps
its red wordmark, Nikon keeps its yellow tile), and no CSS filter can express
"recolour the black parts only". `filter: invert(1)` would instead document an
effect the app never produces — Canon red turning cyan, Fujifilm red turning
teal. For dark-mode behaviour look at docs/assets/screenshot-classic.png.

Run:  .venv/Scripts/python.exe tools/logo_sheet.py
Out:  docs/assets/logo-sheet.png
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.config import BRANDS  # noqa: E402

EDGE = r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
BAR_H = 96            # pretend bar height
COLS = 3
GAP = 14
PAD = 14
WIN_W = 1400
CAPTION_H = 24
OUT = ROOT / "docs/assets/logo-sheet.png"
PAGE = ROOT / "web/__sheet.html"

CELL_W = (WIN_W - PAD * 2 - GAP * (COLS - 1)) / COLS
WIDEST = max(b["aspect"] for b in BRANDS)
# Leave 12px of air so the widest mark is centred rather than touching its cell.
MARK_H = min(32, (CELL_W - 12) / WIDEST)
ROWS = (len(BRANDS) + COLS - 1) // COLS
WIN_H = int(PAD * 2 + ROWS * (BAR_H + CAPTION_H + GAP))


cells = []
for b in BRANDS:
    src = f"./assets/brands/{b['logo']}" if b.get("logo") else ""
    img = (f'<img src="{src}" style="height:{MARK_H:.1f}px" alt="{b["name"]}">'
           if src else f'<span>{b["name"]}</span>')
    cells.append(
        f'<div class="cell"><div class="bar">{img}</div>'
        f'<div class="cap">{b["key"]}</div></div>'
    )

html = f"""<!doctype html><meta charset="utf-8">
<style>
  body {{ margin:0; background:#f3f4f6; font:12px/1.4 -apple-system,"Segoe UI",sans-serif; }}
  .grid {{ display:grid; grid-template-columns:repeat({COLS},1fr); gap:{GAP}px; padding:{PAD}px; }}
  .cell {{ background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px #0002; }}
  .bar {{ height:{BAR_H}px; display:flex; align-items:center; justify-content:center; background:#fff; }}
  .cap {{ padding:4px 8px; color:#6b7280; font-size:11px; }}
  img {{ display:block; }}
</style>
<div class="grid">{''.join(cells)}</div>
"""

PAGE.write_text(html, encoding="utf-8")

subprocess.run([
    EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
    f"--screenshot={OUT.as_posix()}", f"--window-size={WIN_W},{WIN_H}",
    "--virtual-time-budget=4000",
    PAGE.as_uri(),
], check=True, timeout=90)

PAGE.unlink(missing_ok=True)
print(f"wrote {OUT}  ({len(BRANDS)} marks, {COLS} cols, mark height {MARK_H:.1f}px)")

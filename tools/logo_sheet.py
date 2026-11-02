"""Render every brand mark at the exact same optical height and screenshot it.

This is the visual gate for "all logos look the same size, and each keeps its
own colours". One row per mark, on the white bar it is actually drawn on.

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
BAR_H = 96          # pretend bar height
MARK_H = BAR_H / 3  # the 1/3 rule
OUT = ROOT / "docs/assets/logo-sheet.png"
PAGE = ROOT / "web/__sheet.html"

def is_mono(logo: str) -> bool:
    """True when every fill in the file is neutral ink (see isNeutralInk)."""
    import re

    path = ROOT / "web/assets/brands" / logo
    text = path.read_text(encoding="utf-8")
    hexes = set(re.findall(r'fill="(#[0-9a-fA-F]{3,8})"', text))
    hexes |= set(re.findall(r"fill://s*(#[0-9a-fA-F]{3,8})", text))
    for raw in hexes:
        h = raw.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        hi, lo = max(r, g, b), min(r, g, b)
        if not (hi == 0 or hi - lo <= 24 or (hi - lo) / hi <= 0.22):
            return False
    return True


cells = []
for b in BRANDS:
    src = f"./assets/brands/{b['logo']}" if b.get("logo") else ""
    klass = "mono" if b.get("logo") and is_mono(b["logo"]) else "keep"
    img = (f'<img class="{klass}" src="{src}" style="height:{MARK_H}px" alt="{b["name"]}">'
           if src else f'<span>{b["name"]}</span>')
    cells.append(
        f'<div class="cell"><div class="bar">{img}</div>'
        f'<div class="cap">{b["key"]}</div></div>'
    )

html = f"""<!doctype html><meta charset="utf-8">
<style>
  body {{ margin:0; background:#f3f4f6; font:12px/1.4 -apple-system,"Segoe UI",sans-serif; }}
  .grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; padding:14px; }}
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
    f"--screenshot={OUT.as_posix()}", "--window-size=1400,1310",
    "--virtual-time-budget=4000",
    PAGE.as_uri(),
], check=True, timeout=90)

PAGE.unlink(missing_ok=True)
print("wrote", OUT)

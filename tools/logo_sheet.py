"""Render every brand mark at the exact same optical height, on both the light
bar and the dark blur backdrop, then screenshot it. This is the visual gate for
"all logos look the same size".

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

cells = []
for b in BRANDS:
    src = f"./assets/brands/{b['logo']}" if b.get("logo") else ""
    img = f'<img src="{src}" style="height:{MARK_H}px" alt="{b["name"]}">' if src else f'<span>{b["name"]}</span>'
    cells.append(
        f'<div class="cell"><div class="bar">{img}</div>'
        f'<div class="dark">{img}</div>'
        f'<div class="cap">{b["key"]}</div></div>'
    )

html = f"""<!doctype html><meta charset="utf-8">
<style>
  body {{ margin:0; background:#f3f4f6; font:12px/1.4 -apple-system,"Segoe UI",sans-serif; }}
  .grid {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; padding:14px; }}
  .cell {{ background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px #0002; }}
  .bar {{ height:{BAR_H}px; display:flex; align-items:center; justify-content:center; background:#fff; }}
  .dark {{ height:{BAR_H}px; display:flex; align-items:center; justify-content:center;
           background:#23262b; }}
  .dark img {{ filter:invert(1) brightness(2); }}
  .cap {{ padding:4px 8px; color:#6b7280; font-size:11px; }}
  img {{ display:block; }}
</style>
<div class="grid">{''.join(cells)}</div>
"""

PAGE.write_text(html, encoding="utf-8")

subprocess.run([
    EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars",
    f"--screenshot={OUT.as_posix()}", "--window-size=1400,1900",
    "--virtual-time-budget=4000",
    PAGE.as_uri(),
], check=True, timeout=90)

PAGE.unlink(missing_ok=True)
print("wrote", OUT)

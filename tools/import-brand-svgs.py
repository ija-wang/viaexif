#!/usr/bin/env python3
"""Import brand marks from the spreadsheet the studio keeps (`svg信息.xlsx`).

Each row is `<品牌>/<中文名>` plus an iconfont-exported `<svg>` blob. Those
blobs carry editor bookkeeping (`t`, `class`, `p-id`, a fixed `width`/`height`)
that means nothing to a browser here, and they always declare an absolute
`viewBox`, so the aspect ratio is knowable without rendering.

Usage:
    python tools/import-brand-svgs.py "C:/path/to/svg信息.xlsx" --check
    python tools/import-brand-svgs.py "C:/path/to/svg信息.xlsx" --write

`--check` only reports what would change; `--write` also prints the config rows
that need to be pasted into server/config.py BRANDS.
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "assets" / "brands"

# Spreadsheet label -> (key used by server/config.py, display name in the UI).
# Slugs stay stable so existing BRAND_HINTS and stored shares keep resolving.
ALIASES = {
    "canon": ("canon", "Canon"),
    "nikon": ("nikon", "Nikon"),
    "sony": ("sony", "Sony"),
    "fujifilm": ("fujifilm", "Fujifilm"),
    "leica": ("leica", "Leica"),
    "hasselblad": ("hasselblad", "Hasselblad"),
    "panasonic": ("panasonic", "Panasonic"),
    "lumix": ("lumix", "Lumix"),
    "olympus": ("olympus", "Olympus"),
    "pentax": ("pentax", "Pentax"),
    "ricoh": ("ricoh", "Ricoh"),
    "sigma": ("sigma", "Sigma"),
    "tamron": ("tamron", "Tamron"),
    "dji": ("dji", "DJI"),
    "insta360": ("insta360", "Insta360"),
    "gopro": ("gopro", "GoPro"),
    "apple": ("apple", "Apple"),
    "samsung": ("samsung", "Samsung"),
    "huawei": ("huawei", "Huawei"),
    "honor": ("honor", "Honor"),
    "xiaomi": ("xiaomi", "Xiaomi"),
    "redmi": ("redmi", "Redmi"),
    "oppo": ("oppo", "OPPO"),
    "vivo": ("vivo", "vivo"),
    "oneplus": ("oneplus", "OnePlus"),
    "realme": ("realme", "realme"),
    "meizu": ("meizu", "Meizu"),
    "nubia": ("nubia", "nubia"),
    "zte": ("zte", "ZTE"),
    "google": ("google", "Google"),
    "nokia": ("nokia", "Nokia"),
    "lenovo": ("lenovo", "Lenovo"),
    "rog": ("rog", "ROG"),
    "casio": ("casio", "Casio"),
}

DROP_ATTRS = ("t", "class", "p-id", "width", "height")


def slug(label: str) -> str:
    """`Canon/佳能` -> `canon`."""
    head = label.split("/")[0].strip()
    return re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKD", head).lower())


def label_cn(label: str) -> str:
    parts = label.split("/")
    return parts[1].strip() if len(parts) > 1 else ""


def clean_svg(raw: str) -> tuple[str, float]:
    """Strip editor bookkeeping; return (svg, aspect) with a self-contained root."""
    raw = raw.strip()
    root = re.match(r"<svg\b[^>]*>", raw)
    if not root:
        raise ValueError("no <svg> root")
    tag = root.group(0)

    for attr in DROP_ATTRS:
        tag = re.sub(rf'\s{attr}="[^"]*"', "", tag)
    # keep exactly one viewBox + xmlns; drop XMLNS:xlink noise nobody uses here
    if "xmlns=" not in tag:
        tag = tag.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"', 1)
    tag = re.sub(r"\s+>", ">", tag)

    body = raw[len(root.group(0)):]
    body = re.sub(r'\s+p-id="[^"]*"', "", body)

    vb = re.search(r'viewBox="([^"]+)"', tag)
    if not vb:
        raise ValueError("no viewBox")
    nums = [float(n) for n in re.split(r"[ ,]+", vb.group(1).strip())]
    if len(nums) != 4 or nums[3] <= 0:
        raise ValueError(f"bad viewBox {vb.group(1)!r}")
    aspect = round(nums[2] / nums[3], 4)

    svg = tag + body
    if not svg.endswith("</svg>"):
        svg = svg.rstrip() + "</svg>"
    return svg + "\n", aspect


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("xlsx")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    try:
        import openpyxl
    except ImportError:
        print("pip install openpyxl", file=sys.stderr)
        return 2

    ws = openpyxl.load_workbook(args.xlsx, data_only=True).worksheets[0]
    rows = [(r[0], r[1]) for r in ws.iter_rows(min_row=2, values_only=True) if r and r[0]]
    if not rows:
        print("no rows", file=sys.stderr)
        return 2

    seen: dict[str, str] = {}
    out_rows: list[tuple[str, str, float, int]] = []
    problems: list[str] = []

    for label, raw in rows:
        label = str(label).strip()
        if not raw:
            problems.append(f"{label}: empty svg cell")
            continue
        s = slug(label)
        if s not in ALIASES:
            problems.append(f"{label}: no key mapping (add it to ALIASES)")
            continue
        key, display = ALIASES[s]
        if key in seen:
            problems.append(f"{label}: duplicate key {key!r} (also from {seen[key]!r})")
            continue
        seen[key] = label
        try:
            svg, aspect = clean_svg(str(raw))
        except ValueError as exc:
            problems.append(f"{label}: {exc}")
            continue
        target = OUT / f"{key}.svg"
        old = target.read_text(encoding="utf-8") if target.exists() else ""
        if svg != old:
            print(f"{'rewrite' if old else 'add    '} {key + '.svg':22} aspect={aspect:<8} {label}")
            if args.write:
                target.write_text(svg, encoding="utf-8", newline="\n")
        out_rows.append((key, display, aspect, len(svg)))

    missing = sorted(set(OUT.glob("*.svg")) - {OUT / f"{k}.svg" for k, *_ in out_rows})
    if missing:
        print("\nnot in the spreadsheet (left untouched): " + ", ".join(p.name for p in missing))

    if problems:
        print("\nPROBLEMS")
        for p in problems:
            print("  " + p)

    print("\n# paste into BRANDS (aspect from viewBox; tint decided per mark)")
    for key, display, aspect, _ in out_rows:
        print(f'    {{"key": "{key}", "name": "{display}", "logo": "{key}.svg", "aspect": {aspect}, "tint": True}},')
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())

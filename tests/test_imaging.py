"""Server-side imaging tests: sniffing, HEIC/RAW decoding, metadata, frame cache.

Run: python tests/test_imaging.py
Uses the fixtures produced by tests/gen_fixtures.py.
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import imaging as im  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
passed = 0
failed = 0


def check(name: str, ok: bool, detail: object = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


def expect(name: str, actual: object, wanted: object) -> None:
    check(name, actual == wanted, f"expected {wanted!r}, got {actual!r}")


print("sniff")
expect("jpeg", im.sniff((FIX / "sample.jpg").read_bytes()).kind, "jpeg")
expect("png", im.sniff((FIX / "sample.png").read_bytes()).kind, "png")
expect("webp", im.sniff((FIX / "sample.webp").read_bytes()).kind, "webp")
expect("heic", im.sniff((FIX / "sample.heic").read_bytes()).kind, "heic")
dng = im.sniff((FIX / "synthetic.dng").read_bytes())
expect("dng -> raw", dng.kind, "raw")
expect("dng label", dng.label, "Adobe DNG")
expect("cr3 header", im.sniff(b"\x00\x00\x00\x18ftypcrx \x00\x00\x00\x00" + b"\x00" * 32).kind, "raw")
expect("raf header", im.sniff(b"FUJIFILMCCD-RAW 0201" + b"\x00" * 32).kind, "raw")
expect("orf header", im.sniff(b"IIRO\x08\x00\x00\x00" + b"\x00" * 32).kind, "raw")
expect("x3f header", im.sniff(b"FOVb" + b"\x00" * 40).kind, "raw")
expect("unknown", im.sniff(b"\x00" * 64).kind, "unknown")
expect("empty", im.sniff(b"").kind, "unknown")

print("decode")
page = im.decode_image((FIX / "sample.heic").read_bytes(), "heic")
expect("heic size", page.size, (1200, 800))
expect("heic mode", page.mode, "RGB")
check("heic jpeg", len(im.to_jpeg(page)) > 4000)

raw = im.decode_image((FIX / "synthetic.dng").read_bytes(), "raw")
expect("dng size", raw.size, (200, 150))
check("dng has real pixels", len(raw.getcolors(maxcolors=1 << 20) or []) > 8)

print("metadata")
meta = im.read_meta((FIX / "sample.heic").read_bytes(), "heic")
expect("heic make", meta.get("make"), "FUJIFILM")
expect("heic model", meta.get("model"), "X-T4")
expect("heic fNumber", round(meta.get("fNumber", 0), 2), 3.2)
expect("heic iso", meta.get("iso"), 640)
check("heic exposure ~1/5800", abs(1 / meta["exposure"] - 5800) < 30, meta.get("exposure"))
expect("heic lens", meta.get("lens"), "XF56mmF1.2 R")

rag = im.read_meta((FIX / "synthetic.dng").read_bytes(), "raw")
expect("dng make", rag.get("make"), "TestCam")

print("encode")
src = im.to_jpeg(page, 90)
out, mime, ext = im.encode(src, "heic", 88)
expect("heic mime", mime, "image/heic")
expect("heic ext", ext, "heic")
check("heic payload", out[:8] == b"\x00\x00\x00\x1cftyp", out[:12])
back = im.decode_image(out, "heic")
expect("heic roundtrip size", back.size, (1200, 800))
passthrough, mime2, _ = im.encode(src, "jpeg")
check("jpeg is a passthrough", passthrough is src and mime2 == "image/jpeg")
try:
    im.encode(src, "tiff")
    check("unknown target rejected", False)
except im.DecodeError:
    check("unknown target rejected", True)

print("frame cache")
cache = im.FrameCache(ttl=60, max_bytes=1000)
tok = cache.put(b"x" * 400)
check("cache hit", cache.get(tok) == b"x" * 400)
cache.put(b"y" * 400)
cache.put(b"z" * 400)
check("cache evicts by size", cache.get(tok) is None)
check("missing token", cache.get("nope") is None)
cache.purge()

print("capabilities")
caps = im.capabilities()
check("heic capability reported", isinstance(caps["heic"], bool))
check("raw capability reported", isinstance(caps["raw"], bool))

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)

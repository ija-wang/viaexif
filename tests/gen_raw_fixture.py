"""Build a tiny, valid DNG so the RAW pipeline can be tested without shipping
a 40 MB camera file.

The result is a real (if synthetic) Bayer sensor: 16-bit CFA mosaic, DNG 1.4
tags, straight TIFF layout. libraw accepts it, which means the end-to-end path
(sniff -> rawpy -> demosaic -> JPEG) is exercised by CI.

Run: python tests/gen_raw_fixture.py
"""
from __future__ import annotations

import math
import struct
from pathlib import Path

OUT = Path(__file__).parent / "fixtures" / "synthetic.dng"

TYPE_SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8}


def _mosaic(w: int, h: int) -> bytes:
    """Bayer RGGB mosaic of a simple synthetic scene."""
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            ty, tx = y / h, x / w
            # sky gradient
            r = 0.25 + 0.55 * (1 - ty)
            g = 0.40 + 0.45 * (1 - ty)
            b = 0.65 + 0.30 * (1 - ty)
            # a sun
            dx, dy = (tx - 0.72) * 1.6, (ty - 0.30) * 1.6
            if dx * dx + dy * dy < 0.03:
                r = g = b = 0.98
            # a dark hillside
            if ty > 0.72 + 0.05 * math.sin(tx * 9):
                r, g, b = 0.10, 0.13, 0.10
            even_y, even_x = y % 2 == 0, x % 2 == 0
            if even_y and even_x:
                val = r
            elif even_y or even_x:
                val = g
            else:
                val = b
            row += struct.pack("<H", max(0, min(65535, int(val * 60000))))
        rows.append(bytes(row))
    return b"".join(rows)


def build_dng(path: Path, w: int = 200, h: int = 150) -> Path:
    data = _mosaic(w, h)
    entries: list[tuple[int, int, int, bytes]] = []

    def add(tag: int, typ: int, count: int, payload: bytes) -> None:
        entries.append((tag, typ, count, payload))

    def ascii_(tag: int, text: str) -> None:
        raw = text.encode("ascii") + b"\x00"
        add(tag, 2, len(raw), raw)

    def shorts(tag: int, *vals: int) -> None:
        add(tag, 3, len(vals), b"".join(struct.pack("<H", v) for v in vals))

    def longs(tag: int, *vals: int) -> None:
        add(tag, 4, len(vals), b"".join(struct.pack("<I", v) for v in vals))

    def bytes_(tag: int, *vals: int) -> None:
        add(tag, 1, len(vals), bytes(vals))

    def rationals(tag: int, pairs) -> None:
        add(tag, 5, len(pairs), b"".join(struct.pack("<II", n, d) for n, d in pairs))

    def srationals(tag: int, pairs) -> None:
        add(tag, 10, len(pairs), b"".join(struct.pack("<ii", n, d) for n, d in pairs))

    data_offset = 8
    data_len = len(data)

    longs(0x0100, w)                     # ImageWidth
    longs(0x0101, h)                     # ImageLength
    shorts(0x0102, 16)                   # BitsPerSample
    shorts(0x0103, 1)                    # Compression = none
    shorts(0x0106, 32803)                # PhotometricInterpretation = CFA
    ascii_(0x010F, "TestCam")            # Make
    ascii_(0x0110, "Synthetic DNG")      # Model
    longs(0x0111, data_offset)           # StripOffsets
    shorts(0x0115, 1)                    # SamplesPerPixel
    longs(0x0116, h)                     # RowsPerStrip
    longs(0x0117, data_len)              # StripByteCounts
    shorts(0x011C, 1)                    # PlanarConfiguration
    shorts(0x828D, 2, 2)                 # CFARepeatPatternDim
    bytes_(0x828E, 0, 1, 1, 2)           # CFAPattern (RGGB)
    bytes_(0xC612, 1, 4, 0, 0)           # DNGVersion
    bytes_(0xC613, 1, 1, 0, 0)           # DNGBackwardVersion
    ascii_(0xC614, "Synthetic DNG")      # UniqueCameraModel
    bytes_(0xC616, 0, 1, 2)              # CFAPlaneColor
    shorts(0xC617, 1)                    # CFALayout
    shorts(0xC619, 2, 2)                 # BlackLevelRepeatDim
    rationals(0xC61A, [(0, 1)] * 4)      # BlackLevel
    longs(0xC61D, 65535)                 # WhiteLevel
    srationals(0xC621, [(1, 1), (0, 1), (0, 1),
                        (0, 1), (1, 1), (0, 1),
                        (0, 1), (0, 1), (1, 1)])   # ColorMatrix1 (identity-ish)
    shorts(0xC65A, 21)                   # CalibrationIlluminant1 = D65
    rationals(0xC628, [(1, 1), (1, 1), (1, 1)])    # AsShotNeutral
    shorts(0x8827, 200)                  # ISO (IFD0 copy, harmless)
    rationals(0x829A, [(1, 250)])        # ExposureTime
    rationals(0x829D, [(28, 10)])        # FNumber

    entries.sort(key=lambda e: e[0])
    ifd_offset = data_offset + data_len
    dir_len = 2 + len(entries) * 12 + 4
    extra_offset = ifd_offset + dir_len

    body = bytearray()
    body += struct.pack("<H", len(entries))
    extra = bytearray()
    for tag, typ, count, payload in entries:
        body += struct.pack("<HHI", tag, typ, count)
        if len(payload) <= 4:
            body += payload.ljust(4, b"\x00")
        else:
            body += struct.pack("<I", extra_offset + len(extra))
            extra += payload
            if len(extra) % 2:
                extra += b"\x00"
    body += struct.pack("<I", 0)  # no next IFD

    out = b"II*\x00" + struct.pack("<I", ifd_offset) + data + bytes(body) + bytes(extra)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out)
    return path


def main() -> None:
    p = build_dng(OUT)
    print(f"{p.name}: {p.stat().st_size} bytes")
    try:
        import rawpy

        with rawpy.imread(str(p)) as raw:
            print("  libraw", rawpy.__version__, "size", raw.sizes, "camera", raw.camera_whitebalance[:3])
            rgb = raw.postprocess(use_camera_wb=True, output_bps=8)
            print("  postprocess ->", rgb.shape)
    except Exception as exc:  # pragma: no cover
        print("  libraw could not read the fixture:", type(exc).__name__, exc)


if __name__ == "__main__":
    main()

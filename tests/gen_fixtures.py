"""Generate every fixture the tests need — EXIF, HEIC, RAW and a Live Photo pair.

Run: python tests/gen_fixtures.py
Requires: pillow, pillow-heif (and rawpy only to self-check the DNG).
"""
import struct
from pathlib import Path

from PIL import Image, ImageDraw, TiffImagePlugin

from gen_raw_fixture import build_dng

OUT = Path(__file__).parent / "fixtures"
OUT.mkdir(parents=True, exist_ok=True)


def base_image(size=(1200, 800)) -> Image.Image:
    im = Image.new("RGB", size, (28, 38, 58))
    d = ImageDraw.Draw(im)
    for y in range(size[1]):
        t = y / size[1]
        d.line([(0, y), (size[0], y)], fill=(int(30 + 90 * t), int(60 + 70 * t), int(110 + 60 * t)))
    d.ellipse([size[0] * 0.55, size[1] * 0.25, size[0] * 0.95, size[1] * 0.8], fill=(240, 210, 160))
    d.rectangle([0, size[1] * 0.7, size[0], size[1]], fill=(18, 26, 24))
    return im


def build_exif() -> Image.Exif:
    exif = Image.Exif()
    exif[0x010F] = "FUJIFILM"          # Make
    exif[0x0110] = "X-T4"              # Model
    exif[0x0112] = 1                   # Orientation
    exif[0x0132] = "2024:05:16 12:33:44"

    sub = exif.get_ifd(0x8769)
    sub[0x829A] = TiffImagePlugin.IFDRational(1, 5800)    # ExposureTime
    sub[0x829D] = TiffImagePlugin.IFDRational(32, 10)    # FNumber -> f/3.2
    sub[0x8827] = 640                  # ISO
    sub[0x920A] = TiffImagePlugin.IFDRational(53, 1)     # FocalLength
    sub[0x9003] = "2024:05:16 12:33:44"
    sub[0xA434] = "XF56mmF1.2 R"
    return exif


def build_mov(path: Path, content_id: str, duration: float = 3.2, timescale: int = 600) -> Path:
    """Minimal QuickTime file that carries Apple's Live Photo metadata."""
    def box(typ: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", 8 + len(payload)) + typ + payload

    def full(typ: bytes, payload: bytes, version: int = 0, flags: int = 0) -> bytes:
        return box(typ, struct.pack(">I", (version << 24) | flags) + payload)

    ftyp = box(b"ftyp", b"qt  " + struct.pack(">I", 0x200) + b"qt  ")

    matrix = b"".join(struct.pack(">I", v) for v in (
        0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000,
    ))
    mvhd = full(
        b"mvhd",
        struct.pack(">IIII", 0, 0, timescale, int(duration * timescale))
        + struct.pack(">IHH", 0x00010000, 0x0100, 0)
        + b"\x00" * 8
        + matrix
        + b"\x00" * 24
        + struct.pack(">I", 2),
    )

    hdlr = full(b"hdlr", struct.pack(">I", 0) + b"mdta" + b"\x00" * 12 + b"\x00")

    keys_list = [
        b"com.apple.quicktime.content.identifier",
        b"com.apple.quicktime.still-image-time",
    ]
    entries = b""
    for key in keys_list:
        entries += struct.pack(">I", 8 + len(key)) + b"mdta" + key
    keys = full(b"keys", struct.pack(">I", len(keys_list)) + entries)

    def data_utf8(text: str) -> bytes:
        raw = text.encode("utf-8")
        return box(b"data", struct.pack(">II", 1, 0) + raw)

    def data_int(value: int) -> bytes:
        return box(b"data", struct.pack(">IIi", 21, 0, value))

    ilst = box(
        b"ilst",
        box(struct.pack(">I", 1), struct.pack(">I", 1) + data_utf8(content_id))
        + box(struct.pack(">I", 2), struct.pack(">I", 2) + data_int(0)),
    )

    meta = full(b"meta", hdlr + keys + ilst)
    moov = box(b"moov", mvhd + meta)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(ftyp + moov)
    return path


def build_apple_exif() -> Image.Exif:
    exif = Image.Exif()
    exif[0x010F] = "Apple"
    exif[0x0110] = "iPhone 15 Pro"
    exif[0x0112] = 1
    exif[0x0132] = "2026:10:04 18:12:07"
    sub = exif.get_ifd(0x8769)
    sub[0x829A] = TiffImagePlugin.IFDRational(1, 120)
    sub[0x829D] = TiffImagePlugin.IFDRational(178, 100)
    sub[0x8827] = 64
    sub[0x920A] = TiffImagePlugin.IFDRational(6765, 1000)
    sub[0x9003] = "2026:10:04 18:12:07"
    sub[0xA434] = "iPhone 15 Pro back triple camera 6.765mm f/1.78"
    return exif


def main() -> None:
    im = base_image()
    exif = build_exif()

    jpg = OUT / "sample.jpg"
    im.save(jpg, "JPEG", quality=92, exif=exif.tobytes())

    png = OUT / "sample.png"
    im.save(png, "PNG", exif=exif.tobytes())

    webp = OUT / "sample.webp"
    im.save(webp, "WEBP", quality=90, exif=exif.tobytes())

    plain = OUT / "no-exif.jpg"
    base_image((900, 600)).save(plain, "JPEG", quality=88)

    # ---- HEIC: the format an iPhone actually hands you
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        heic = OUT / "sample.heic"
        im.save(heic, "HEIF", quality=90, exif=exif.tobytes())
        live_dir = OUT / "live"
        live_dir.mkdir(parents=True, exist_ok=True)
        live_heic = live_dir / "IMG_0001.HEIC"
        im.save(live_heic, "HEIF", quality=88, exif=build_apple_exif().tobytes())
        mov = build_mov(live_dir / "IMG_0001.MOV", "C4A1F0E2-9B77-4C33-8A1D-2F5B7E9C0D31")
        print(f"{heic.name}: {heic.stat().st_size} bytes")
        print(f"{live_heic.name}: {live_heic.stat().st_size} bytes")
        print(f"{mov.name}: {mov.stat().st_size} bytes")
    except ImportError:
        print("pillow-heif not installed, skipping HEIC fixtures")

    # ---- RAW: a real (synthetic) Bayer DNG
    dng = build_dng(OUT / "synthetic.dng")
    print(f"{dng.name}: {dng.stat().st_size} bytes")

    for p in (jpg, png, webp, plain):
        print(f"{p.name}: {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()

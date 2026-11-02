"""Camera-native decoding: HEIC/HEIF, AVIF and RAW.

The browser can only decode JPEG/PNG/WebP, so everything else is normalised
here into a plain sRGB JPEG plus a metadata dict in the same shape the
front-end EXIF reader produces.

Deliberately defensive: every optional dependency is imported lazily, so a
image without libraw still serves JPEGs and reports `raw: false` in /api/config.
"""
from __future__ import annotations

import io
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

# --------------------------------------------------------------- optional deps
try:
    from PIL import Image, ImageOps
except Exception:  # pragma: no cover - Pillow is a hard requirement in practice
    Image = None  # type: ignore
    ImageOps = None  # type: ignore

_HEIF = None
_HEIF_ERR = ""
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    _HEIF = pillow_heif
except Exception as exc:  # pragma: no cover
    _HEIF_ERR = f"{type(exc).__name__}: {exc}"

_RAWPY = None
_RAWPY_ERR = ""
try:
    import rawpy

    _RAWPY = rawpy
except Exception as exc:  # pragma: no cover
    _RAWPY_ERR = f"{type(exc).__name__}: {exc}"

_EXIFREAD = None
try:
    import exifread

    _EXIFREAD = exifread
except Exception:  # pragma: no cover
    _EXIFREAD = None


NATIVE_KINDS = {"jpeg", "png", "webp"}
SERVER_KINDS = {"heic", "avif", "tiff", "raw"}


@dataclass
class Sniff:
    kind: str            # jpeg | png | webp | heic | avif | tiff | raw | unknown
    label: str           # human label, shown in the UI
    raw: bool = False    # needs demosaicing (slow)
    extra: dict = field(default_factory=dict)


# ------------------------------------------------------------------- sniffing
_ISO_HEIC = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs",
             b"mif1", b"msf1"}
_ISO_AVIF = {b"avif", b"avis"}


def _brand(data: bytes) -> bytes:
    return data[8:12]


def sniff(data: bytes) -> Sniff:
    """Identify by magic bytes; extensions and MIME types lie constantly."""
    n = len(data)
    if n < 16:
        return Sniff("unknown", "未知")

    if data[:3] == b"\xff\xd8\xff":
        return Sniff("jpeg", "JPEG")
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return Sniff("png", "PNG")
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return Sniff("webp", "WEBP")

    # ISO base media file format: HEIC / AVIF / CR3 / MP4 family
    if data[4:8] == b"ftyp":
        brand = _brand(data)
        if brand in _ISO_HEIC:
            label = "HEIC" if brand.startswith(b"hei") else "HEIF"
            return Sniff("heic", label, extra={"brand": brand.decode("latin-1")})
        if brand in _ISO_AVIF:
            return Sniff("avif", "AVIF")
        if brand in {b"crx ", b"crx"}:
            return Sniff("raw", "Canon CR3", True, {"camera": "Canon"})

    if data[:15] == b"FUJIFILMCCD-RAW":
        return Sniff("raw", "Fujifilm RAF", True, {"camera": "Fujifilm"})
    if data[:4] == b"FOVb":
        return Sniff("raw", "Sigma X3F", True, {"camera": "Sigma"})
    if data[:4] == b"\x00MRM":
        return Sniff("raw", "Minolta MRW", True, {"camera": "Minolta"})
    if data[:14] == b"II\x1a\x00\x00\x00HEAPCCDR":
        return Sniff("raw", "Canon CRW", True, {"camera": "Canon"})
    if data[:4] == b"IIII":
        return Sniff("raw", "Phase One IIQ", True, {"camera": "Phase One"})
    if data[:4] in (b"IIRO", b"MMOR", b"IIRS", b"MMRS"):
        return Sniff("raw", "Olympus ORF", True, {"camera": "Olympus"})

    # TIFF family: CR2 / NEF / ARW / DNG / PEF / RW2 / SRW / 3FR / MOS ...
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return _classify_tiff(data)

    return Sniff("unknown", "未知")


def _classify_tiff(data: bytes) -> Sniff:
    tags = _tiff_ifd0(data)
    make = str(tags.get(0x010F, "") or "").strip()
    model = str(tags.get(0x0110, "") or "").strip()

    if data[8:10] == b"CR":
        return Sniff("raw", "Canon CR2", True, {"make": make, "model": model})
    if 0xC612 in tags:  # DNGVersion
        return Sniff("raw", "Adobe DNG", True, {"make": make, "model": model})
    if make or model:
        return Sniff("raw", f"{make or 'TIFF'} RAW", True, {"make": make, "model": model})
    return Sniff("tiff", "TIFF", False)


def _tiff_ifd0(data: bytes) -> dict:
    """Pull a few IFD0 tags out of a TIFF header. Returns {} when unreadable."""
    try:
        view = memoryview(data)
        le = data[:2] == b"II"
        order = "little" if le else "big"
        if int.from_bytes(data[2:4], order) != 42:
            return {}
        offset = int.from_bytes(data[4:8], order)
        if offset <= 0 or offset + 2 > len(data):
            return {}
        count = int.from_bytes(view[offset:offset + 2], order)
        if count > 512:
            return {}
        out: dict[int, object] = {}
        for i in range(count):
            base = offset + 2 + i * 12
            if base + 12 > len(data):
                break
            tag = int.from_bytes(view[base:base + 2], order)
            typ = int.from_bytes(view[base + 2:base + 4], order)
            num = int.from_bytes(view[base + 4:base + 8], order)
            if typ == 2:
                size = num
                ptr = base + 8 if size <= 4 else int.from_bytes(view[base + 8:base + 12], order)
                if ptr + size <= len(data):
                    out[tag] = bytes(view[ptr:ptr + size]).split(b"\x00")[0].decode("latin-1", "ignore")
            elif typ == 3 and num == 1:
                out[tag] = int.from_bytes(view[base + 8:base + 10], order)
            elif typ == 4 and num == 1:
                out[tag] = int.from_bytes(view[base + 8:base + 12], order)
            elif typ == 1 and num <= 4:
                out[tag] = bytes(view[base + 8:base + 8 + num])
        return out
    except Exception:
        return {}


# -------------------------------------------------------------------- decoding
class DecodeError(Exception):
    """Raised with a user-facing (Chinese) message."""


def _limit(img, max_px: int):
    w, h = img.size
    if max(w, h) <= max_px:
        return img
    scale = max_px / float(max(w, h))
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def decode_image(data: bytes, kind: str, max_px: int = 12000):
    """Return a loaded, upright sRGB PIL image."""
    if Image is None:
        raise DecodeError("服务端缺少 Pillow，无法解码该格式")

    if kind in ("heic", "avif"):
        if _HEIF is None:
            raise DecodeError(f"服务端未安装 pillow-heif：{_HEIF_ERR}")
        try:
            img = Image.open(io.BytesIO(data))
            img.load()
            img = ImageOps.exif_transpose(img) if ImageOps else img
        except Exception as exc:
            raise DecodeError(f"{kind.upper()} 解码失败：{exc}") from exc
        return _limit(_to_rgb(img), max_px)

    if kind in ("raw", "tiff"):
        errors: list[str] = []
        order = ("rawpy", "pillow") if kind == "raw" else ("pillow", "rawpy")
        for backend in order:
            try:
                if backend == "rawpy":
                    img = _decode_rawpy(data)
                else:
                    img = _decode_pillow(data)
                return _limit(_to_rgb(img), max_px)
            except DecodeError as exc:
                errors.append(str(exc))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{backend}: {exc}")
        raise DecodeError("；".join(errors) or "RAW 解码失败")

    try:
        return _limit(_to_rgb(_decode_pillow(data)), max_px)
    except Exception as exc:
        raise DecodeError(f"图片解码失败：{exc}") from exc


def _decode_pillow(data: bytes):
    img = Image.open(io.BytesIO(data))
    img.load()
    if ImageOps:
        img = ImageOps.exif_transpose(img)
    return img


def _decode_rawpy(data: bytes):
    if _RAWPY is None:
        raise DecodeError(f"服务端未安装 rawpy：{_RAWPY_ERR}")
    with _RAWPY.imread(io.BytesIO(data)) as raw:
        # Camera white balance + a gentle highlight recovery is what Lightroom's
        # default profile does; auto-bright keeps underexposed shots usable.
        arr = raw.postprocess(
            use_camera_wb=True,
            no_auto_bright=False,
            output_bps=8,
            gamma=(2.222, 4.5),
            four_color_rgb=False,
            demosaic_algorithm=_RAWPY.DemosaicAlgorithm.AHD,
        )
    return Image.fromarray(arr)


def _to_rgb(img):
    if img.mode in ("RGB",):
        return img
    if img.mode in ("RGBA", "LA", "P"):
        if img.mode != "RGBA":
            img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        return bg
    if img.mode in ("I;16", "I;16B", "I", "F"):
        # 16-bit grayscale/linear data: normalise before dropping to 8 bit
        return img.convert("I").point(lambda v: v / 256).convert("L").convert("RGB")
    return img.convert("RGB")


def to_jpeg(img, quality: int = 92) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, subsampling="4:2:0", optimize=True, progressive=True)
    return buf.getvalue()


# -------------------------------------------------------------------- metadata
def _ratio(value):
    if value is None:
        return None
    try:
        if hasattr(value, "num") and hasattr(value, "den"):
            return float(value.num) / float(value.den) if value.den else None
        values = getattr(value, "values", None)
        if values:
            first = values[0]
            if hasattr(first, "num") and hasattr(first, "den"):
                return float(first.num) / float(first.den) if first.den else None
            return float(first)
        text = str(value).strip()
        if "/" in text:
            a, b = text.split("/", 1)
            return float(a) / float(b) if float(b) else None
        return float(text)
    except Exception:
        return None


def _text(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\x00", "").strip()


def read_meta(data: bytes, kind: str) -> dict:
    """Return {make, model, lens, exposure, fNumber, iso, focal, dateTime, orientation}."""
    if kind in ("heic", "avif"):
        meta = _meta_pillow(data)
        if meta.get("make") or meta.get("model"):
            return meta
        return meta or _meta_exifread(data)
    meta = _meta_exifread(data)
    if meta.get("make") or meta.get("model"):
        return meta
    fb = _meta_pillow(data)
    for key, val in fb.items():
        meta.setdefault(key, val)
    return meta


def _meta_pillow(data: bytes) -> dict:
    out: dict = {}
    if Image is None:
        return out
    try:
        img = Image.open(io.BytesIO(data))
        exif = img.getexif()
        if not exif:
            return out
        sub = {}
        try:
            sub = exif.get_ifd(0x8769) or {}
        except Exception:
            sub = {}
        out["make"] = _text(exif.get(0x010F))
        out["model"] = _text(exif.get(0x0110))
        out["dateTime"] = _text(exif.get(0x0132))
        out["orientation"] = _text(exif.get(0x0112))
        out["exposure"] = _ratio(sub.get(0x829A))
        out["fNumber"] = _ratio(sub.get(0x829D))
        iso = sub.get(0x8827) or sub.get(0x8833)
        out["iso"] = int(_ratio(iso)) if _ratio(iso) else None
        out["focal"] = _ratio(sub.get(0x920A))
        out["lens"] = _text(sub.get(0xA434))
        out["dateTime"] = _text(sub.get(0x9003)) or out["dateTime"]
    except Exception:
        return {}
    return {k: v for k, v in out.items() if v not in (None, "")}


def _meta_exifread(data: bytes) -> dict:
    out: dict = {}
    if _EXIFREAD is None:
        return out
    try:
        tags = _EXIFREAD.process_file(io.BytesIO(data), details=False)
    except Exception:
        return out
    if not tags:
        return out

    def get(*names):
        for name in names:
            if name in tags:
                return tags[name]
        return None

    out["make"] = _text(get("Image Make"))
    out["model"] = _text(get("Image Model"))
    out["dateTime"] = _text(get("EXIF DateTimeOriginal", "Image DateTime"))
    out["orientation"] = _text(get("Image Orientation"))
    out["exposure"] = _ratio(get("EXIF ExposureTime"))
    out["fNumber"] = _ratio(get("EXIF FNumber"))
    iso = _ratio(get("EXIF ISOSpeedRatings", "EXIF PhotographicSensitivity"))
    out["iso"] = int(iso) if iso else None
    out["focal"] = _ratio(get("EXIF FocalLength"))
    out["lens"] = _text(get("EXIF LensModel", "EXIF LensMake"))
    return {k: v for k, v in out.items() if v not in (None, "")}


# --------------------------------------------------------------------- re-encode
def encode(data: bytes, target: str, quality: int = 92) -> tuple[bytes, str, str]:
    """Re-encode a rendered frame. Returns (bytes, mime, ext)."""
    target = target.lower()
    if target in ("jpeg", "jpg", "image/jpeg"):
        return data, "image/jpeg", "jpg"
    if target in ("png", "image/png"):
        return data, "image/png", "png"
    if target in ("webp", "image/webp", "heic", "heif", "image/heic"):
        if Image is None or (_HEIF is None and target != "webp"):
            raise DecodeError("服务端未安装 HEIC 编码器")
        img = Image.open(io.BytesIO(data))
        img.load()
        buf = io.BytesIO()
        if target == "webp":
            img.save(buf, "WEBP", quality=quality, method=4)
            return buf.getvalue(), "image/webp", "webp"
        # keep the call surface minimal: `chroma` only exists in newer pillow-heif
        img.save(buf, "HEIF", quality=max(40, min(100, quality)))
        return buf.getvalue(), "image/heic", "heic"
    raise DecodeError(f"不支持的导出格式：{target}")


def capabilities() -> dict:
    return {
        "heic": _HEIF is not None,
        "avif": _HEIF is not None,
        "raw": _RAWPY is not None,
        "heicEncode": _HEIF is not None,
        "libheif": getattr(_HEIF, "libheif_version", lambda: "")() if _HEIF else None,
        "libraw": getattr(_RAWPY, "__version__", None) if _RAWPY else None,
        "meta": "exifread" if _EXIFREAD is not None else "pillow",
    }


# ------------------------------------------------------------------- frame cache
class FrameCache:
    """Decoded frames waiting to be picked up by the browser.

    Kept in a container-local dict instead of /data: these are full-resolution
    intermediates, worthless after the tab closes, and never touched by the
    share-link lifecycle.
    """

    def __init__(self, ttl: int = 900, max_bytes: int = 512 * 1024 * 1024) -> None:
        self._ttl = ttl
        self._max = max_bytes
        self._items: OrderedDict[str, tuple[float, bytes]] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, payload: bytes) -> str:
        token = secrets.token_urlsafe(18)
        with self._lock:
            self._items[token] = (time.time() + self._ttl, payload)
            self._evict()
        return token

    def get(self, token: str) -> bytes | None:
        with self._lock:
            item = self._items.get(token)
            if not item:
                return None
            expires, payload = item
            if expires < time.time():
                self._items.pop(token, None)
                return None
            self._items.move_to_end(token)
            return payload

    def _evict(self) -> None:
        total = sum(len(p) for _, p in self._items.values())
        now = time.time()
        while self._items:
            token, (expires, payload) = next(iter(self._items.items()))
            if expires > now and total <= self._max:
                break
            self._items.pop(token, None)
            total -= len(payload)

    def purge(self) -> int:
        with self._lock:
            now = time.time()
            dead = [k for k, (exp, _) in self._items.items() if exp < now]
            for key in dead:
                self._items.pop(key, None)
            return len(dead)


frames = FrameCache()

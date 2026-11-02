"""Single source of truth: templates, layout spec, brand list, runtime settings.

The browser renderer pulls this via GET /api/config, so layout numbers are
defined exactly once and never drift between UI and docs.
"""
from __future__ import annotations

import os
from pathlib import Path

from .imaging import capabilities

BASE_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = BASE_DIR / "web"

APP_VERSION = "1.1.0"


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    port: int = _int_env("PORT", 8080)
    data_dir: Path = Path(os.environ.get("EXIF_DATA_DIR", "/data"))
    share_ttl: int = _int_env("EXIF_SHARE_TTL", 86400)  # seconds, 0 = never expire
    max_upload_mb: int = _int_env("EXIF_MAX_UPLOAD_MB", 40)
    max_share_mb: int = _int_env("EXIF_MAX_SHARE_MB", 40)
    # RAW files are routinely 60-120 MB; HEIC bursts add up fast.
    max_decode_mb: int = _int_env("EXIF_MAX_DECODE_MB", 200)
    decode_max_px: int = _int_env("EXIF_DECODE_MAX_PX", 12000)

    @property
    def share_dir(self) -> Path:
        return self.data_dir / "shares"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "shares.sqlite3"


settings = Settings()

# ---------------------------------------------------------------- templates
TEMPLATES = [
    {"id": "classic", "name": "经典", "desc": "永不过时的参数横幅"},
    {"id": "blur", "name": "模糊", "desc": "艺术感模糊背景效果"},
]

# ---------------------------------------------------------------- layout spec
# All values are ratios, resolved against the *oriented* image width `W`
# (and `H` for vertical anchors). `barRatio` / `brandRatio` are user sliders.
SPEC = {
    "classic": {
        "expandBottom": True,
        "sliders": {
            "barRatio": {"label": "白条高度", "hint": "白条高度占图片宽度的比例，默认 8%",
                         "min": 0.05, "max": 0.15, "step": 0.01, "default": 0.08},
            "brandRatio": {"label": "品牌 logo 大小", "hint": "默认等于白条高度的 1/3，向右放大、向左缩小",
                           "min": 0.15, "max": 0.60, "step": 0.05, "default": 0.30},
        },
        "layout": {
            "barPadX": 0.020,
            "modelFont": 0.260,      # × barH
            "dateFont": 0.155,       # × barH
            "paramFont": 0.230,      # × barH
            "modelBaseline": 0.450,  # × barH from bar top
            "dateBaseline": 0.820,   # × barH from bar top
            "brandFont": 0.3333,     # × barH = 1/3 of the bar, scaled by brandRatio/0.30
            "gap": 0.130,            # × barH
            "dividerW": 0.012,       # × barH, min 1px
            "dividerH": 0.460,       # × barH
        },
        "colors": {
            "bar": "#FFFFFF",
            "text": "#111111",
            "sub": "#6B7280",
            "divider": "#D1D5DB",
        },
    },
    "blur": {
        "expandBottom": False,
        "sliders": {
            "barRatio": {"label": "白条高度", "hint": "该模板不拉伸画布，此项仅影响底部留白",
                         "min": 0.05, "max": 0.15, "step": 0.01, "default": 0.08},
            "brandRatio": {"label": "品牌 logo 大小", "hint": "默认与型号文字等高，向右放大、向左缩小",
                           "min": 0.15, "max": 0.60, "step": 0.05, "default": 0.30},
        },
        "layout": {
            "padX": 0.062,        # × W
            "padTop": 0.030,      # × W
            "radius": 0.018,      # × W
            "bgBlur": 0.020,      # × W, gaussian sigma
            "bgDarken": 0.22,     # 0..1 alpha of black overlay
            "textFont": 0.0165,   # × W
            "line2Baseline": 0.036,   # × W from bottom
            "lineGap": 1.350,     # × textFont
            "brandFont": 1.150,   # × textFont, scaled by brandRatio/0.30
            "brandGap": 0.550,    # × textFont
            "photoGapAboveText": 1.600,  # × textFont
        },
        "colors": {
            "text": "#FFFFFF",
            "sub": "#E5E7EB",
            "shadow": "rgba(0,0,0,0.40)",
        },
    },
}

# ---------------------------------------------------------------- fields
FIELDS = [
    {"key": "model", "label": "相机型号", "placeholder": "EOS R5", "group": "left"},
    {"key": "focal", "label": "焦距", "placeholder": "85mm", "group": "param"},
    {"key": "aperture", "label": "光圈", "placeholder": "f/2.8", "group": "param"},
    {"key": "shutter", "label": "快门", "placeholder": "1/125s", "group": "param"},
    {"key": "iso", "label": "ISO", "placeholder": "ISO100", "group": "param"},
    {"key": "shotAt", "label": "拍摄时间", "placeholder": "2025-01-01", "group": "left"},
]

# ---------------------------------------------------------------- brands
# 水印里画的是品牌 **logo 图片**（web/assets/brands/<key>.svg），不是文字。
#   logo   : 文件名；None 表示该品牌缺资源，渲染时回退成 name 文本
#   aspect : viewBox 宽高比，用来按高度算宽度
#   tint   : True 表示 logo 本身是单色深色（黑/灰），深色模板上必须染成文字色
#   color  : 仅用于选择列表色点
# 商标归各品牌所有，此处仅用于标识照片的拍摄设备。
BRANDS = [
    {"key": "canon", "name": "Canon", "color": "#CC2229", "logo": "canon.svg", "aspect": 4.8155, "tint": False},
    {"key": "nikon", "name": "Nikon", "color": "#FADF3C", "logo": "nikon.svg", "aspect": 1.0, "tint": False},
    {"key": "sony", "name": "Sony", "color": "#111111", "logo": "sony.svg", "aspect": 5.6799, "tint": True},
    {"key": "fujifilm", "name": "Fujifilm", "color": "#ED1A3A", "logo": "fujifilm.svg", "aspect": 6.009, "tint": True},
    {"key": "leica", "name": "Leica", "color": "#E20613", "logo": "leica.svg", "aspect": 1.0, "tint": False},
    {"key": "hasselblad", "name": "Hasselblad", "color": "#111111", "logo": "hasselblad.svg", "aspect": 14.9584, "tint": True},
    {"key": "panasonic", "name": "Panasonic", "color": "#2866AD", "logo": "panasonic.svg", "aspect": 6.7762, "tint": False},
    {"key": "olympus", "name": "OM System", "color": "#3258A1", "logo": "olympus.svg", "aspect": 3.5978, "tint": False},
    {"key": "pentax", "name": "Pentax", "color": "#FF0017", "logo": "pentax.svg", "aspect": 5.144, "tint": False},
    {"key": "ricoh", "name": "Ricoh", "color": "#DA003B", "logo": "ricoh.svg", "aspect": 5.5395, "tint": False},
    {"key": "sigma", "name": "Sigma", "color": "#111111", "logo": "sigma.svg", "aspect": 4.2502, "tint": True},
    {"key": "tamron", "name": "Tamron", "color": "#E4002B", "logo": "tamron.svg", "aspect": 6.3711, "tint": False},
    {"key": "dji", "name": "DJI", "color": "#111111", "logo": "dji.svg", "aspect": 1.731, "tint": True},
    {"key": "gopro", "name": "GoPro", "color": "#111111", "logo": "gopro.svg", "aspect": 3.5296, "tint": True},
    {"key": "insta360", "name": "Insta360", "color": "#111111", "logo": "insta360.svg", "aspect": 4.839, "tint": True},
    {"key": "apple", "name": "Apple", "color": "#111111", "logo": "apple.svg", "aspect": 0.8142, "tint": True},
    {"key": "samsung", "name": "Samsung", "color": "#1428A0", "logo": "samsung.svg", "aspect": 6.5, "tint": True},
    {"key": "huawei", "name": "Huawei", "color": "#CE0E2D", "logo": "huawei.svg", "aspect": 0.9981, "tint": False},
    {"key": "honor", "name": "Honor", "color": "#111111", "logo": "honor.svg", "aspect": 5.2798, "tint": True},
    {"key": "xiaomi", "name": "Xiaomi", "color": "#FF6900", "logo": "xiaomi.svg", "aspect": 0.9994, "tint": False},
    {"key": "redmi", "name": "Redmi", "color": "#FF6900", "logo": "redmi.svg", "aspect": 3.4641, "tint": True},
    {"key": "oppo", "name": "OPPO", "color": "#1D7A46", "logo": "oppo.svg", "aspect": 4.1787, "tint": True},
    {"key": "vivo", "name": "vivo", "color": "#415FFF", "logo": "vivo.svg", "aspect": 3.5985, "tint": False},
    {"key": "oneplus", "name": "OnePlus", "color": "#EB0028", "logo": "oneplus.svg", "aspect": 1.0, "tint": False},
    {"key": "realme", "name": "realme", "color": "#F5C518", "logo": "realme.svg", "aspect": 3.3333, "tint": False},
    {"key": "meizu", "name": "Meizu", "color": "#00A9E0", "logo": "meizu.svg", "aspect": 5.5688, "tint": False},
    {"key": "nubia", "name": "nubia", "color": "#E4001F", "logo": "nubia.svg", "aspect": 3.8019, "tint": False},
    {"key": "zte", "name": "ZTE", "color": "#0A4EA2", "logo": "zte.svg", "aspect": 2.0693, "tint": False},
    {"key": "nothing", "name": "Nothing", "color": "#111111", "logo": "nothing.svg", "aspect": 7.5715, "tint": True},
    {"key": "google", "name": "Google", "color": "#4285F4", "logo": "google.svg", "aspect": 0.98, "tint": False},
    {"key": "motorola", "name": "Motorola", "color": "#111111", "logo": "motorola.svg", "aspect": 1.0021, "tint": True},
    {"key": "nokia", "name": "Nokia", "color": "#124191", "logo": "nokia.svg", "aspect": 5.933, "tint": False},
]

# Make / Model substring -> brand key. Ordered: first hit wins.
BRAND_HINTS = [
    ("hasselblad", "hasselblad"), ("fujifilm", "fujifilm"), ("canon", "canon"),
    ("nikon", "nikon"), ("sony", "sony"), ("leica", "leica"), ("panasonic", "panasonic"),
    ("olympus", "olympus"), ("om digital", "olympus"), ("pentax", "pentax"),
    ("ricoh", "ricoh"), ("sigma", "sigma"), ("tamron", "tamron"),
    ("dji", "dji"), ("gopro", "gopro"), ("insta360", "insta360"),
    ("apple", "apple"), ("samsung", "samsung"), ("huawei", "huawei"), ("honor", "honor"),
    ("xiaomi", "xiaomi"), ("redmi", "redmi"), ("oppo", "oppo"), ("vivo", "vivo"),
    ("oneplus", "oneplus"), ("realme", "realme"), ("meizu", "meizu"), ("nubia", "nubia"),
    ("zte", "zte"), ("nothing", "nothing"), ("google", "google"),
    ("motorola", "motorola"), ("nokia", "nokia"),
    # model-only hints (camera lines)
    ("eos", "canon"), ("ilce", "sony"), ("ilca", "sony"), ("dsc-", "sony"), ("x-t", "fujifilm"),
    ("x-h", "fujifilm"), ("x100", "fujifilm"), ("x-pro", "fujifilm"), ("gf x", "fujifilm"),
    ("nikon z", "nikon"), ("dc-", "pentax"), ("gr ii", "ricoh"), ("lumix", "panasonic"),
]

EXPORT_FORMATS = [
    {"id": "image/jpeg", "ext": "jpg", "label": "JPEG", "quality": True},
    {"id": "image/png", "ext": "png", "label": "PNG", "quality": False},
    {"id": "image/webp", "ext": "webp", "label": "WEBP", "quality": True},
    # HEIC is encoded on the server (libheif): the canvas has no such encoder.
    {"id": "image/heic", "ext": "heic", "label": "HEIC", "quality": True, "server": True},
]

ACCEPTED_MIME = {"image/jpeg", "image/png", "image/webp", "image/heic"}

# Input formats. `server: True` means the browser cannot decode it, so the file
# is sent to /api/decode and comes back as a normalised sRGB JPEG.
INPUT_FORMATS = [
    {"ext": "jpg", "label": "JPEG", "kind": "native"},
    {"ext": "jpeg", "label": "JPEG", "kind": "native"},
    {"ext": "png", "label": "PNG", "kind": "native"},
    {"ext": "webp", "label": "WEBP", "kind": "native"},
    {"ext": "heic", "label": "HEIC", "kind": "heic"},
    {"ext": "heif", "label": "HEIF", "kind": "heic"},
    {"ext": "avif", "label": "AVIF", "kind": "heic"},
    {"ext": "tif", "label": "TIFF", "kind": "tiff"},
    {"ext": "tiff", "label": "TIFF", "kind": "tiff"},
    {"ext": "dng", "label": "DNG", "kind": "raw"},
    {"ext": "cr2", "label": "Canon CR2", "kind": "raw"},
    {"ext": "cr3", "label": "Canon CR3", "kind": "raw"},
    {"ext": "crw", "label": "Canon CRW", "kind": "raw"},
    {"ext": "nef", "label": "Nikon NEF", "kind": "raw"},
    {"ext": "nrw", "label": "Nikon NRW", "kind": "raw"},
    {"ext": "arw", "label": "Sony ARW", "kind": "raw"},
    {"ext": "srf", "label": "Sony SRF", "kind": "raw"},
    {"ext": "sr2", "label": "Sony SR2", "kind": "raw"},
    {"ext": "raf", "label": "Fujifilm RAF", "kind": "raw"},
    {"ext": "orf", "label": "Olympus ORF", "kind": "raw"},
    {"ext": "rw2", "label": "Panasonic RW2", "kind": "raw"},
    {"ext": "raw", "label": "Panasonic RAW", "kind": "raw"},
    {"ext": "pef", "label": "Pentax PEF", "kind": "raw"},
    {"ext": "srw", "label": "Samsung SRW", "kind": "raw"},
    {"ext": "3fr", "label": "Hasselblad 3FR", "kind": "raw"},
    {"ext": "fff", "label": "Hasselblad FFF", "kind": "raw"},
    {"ext": "iiq", "label": "Phase One IIQ", "kind": "raw"},
    {"ext": "mos", "label": "Leaf MOS", "kind": "raw"},
    {"ext": "mrw", "label": "Minolta MRW", "kind": "raw"},
    {"ext": "x3f", "label": "Sigma X3F", "kind": "raw"},
    {"ext": "dcr", "label": "Kodak DCR", "kind": "raw"},
    {"ext": "kdc", "label": "Kodak KDC", "kind": "raw"},
    {"ext": "erf", "label": "Epson ERF", "kind": "raw"},
    {"ext": "mef", "label": "Mamiya MEF", "kind": "raw"},
    {"ext": "rwl", "label": "Leica RWL", "kind": "raw"},
]


def public_config() -> dict:
    return {
        "version": APP_VERSION,
        "templates": TEMPLATES,
        "spec": SPEC,
        "fields": FIELDS,
        "brands": BRANDS,
        "brandHints": BRAND_HINTS,
        "formats": EXPORT_FORMATS,
        "inputs": INPUT_FORMATS,
        "decode": capabilities(),
        "limits": {
            "maxUploadMb": settings.max_upload_mb,
            "maxShareMb": settings.max_share_mb,
            "maxDecodeMb": settings.max_decode_mb,
            "shareTtl": settings.share_ttl,
            "acceptedMime": sorted(ACCEPTED_MIME),
        },
    }

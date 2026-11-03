"""viaEXIF self-host — FastAPI app.

Responsibilities (deliberately small):
  * serve the static SPA
  * hand the single-source layout config to the browser
  * normalise camera-native files (HEIC / RAW) the browser cannot decode
  * store/share rendered images (the only stateful part)

JPEG / PNG / WEBP are still fully client-side. Anything else takes one trip to
/api/decode and comes back as plain sRGB JPEG; the original file is never
written to disk and the decoded frame expires from memory after 15 minutes.
"""
from __future__ import annotations

import asyncio
import contextlib
import secrets
import sqlite3
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .config import ACCEPTED_MIME, APP_VERSION, WEB_DIR, public_config, settings
from .imaging import DecodeError, capabilities, decode_image, encode as encode_image
from .imaging import frames, read_meta, sniff, to_jpeg

STARTED_AT = time.time()
_SHARE_ID_RE_LEN = 22

# libraw is CPU-bound and allocates a few hundred MB per full-frame file.
# Two at a time keeps a 20-file batch responsive without thrashing the box.
_DECODE_SLOTS = threading.Semaphore(2)


# ------------------------------------------------------------------ storage
@contextlib.contextmanager
def db():
    """Short-lived connection; commits on success, always closes."""
    conn = sqlite3.connect(settings.db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_storage() -> None:
    settings.share_dir.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS shares (
                id         TEXT PRIMARY KEY,
                filename   TEXT NOT NULL,
                mime       TEXT NOT NULL,
                size       INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            )
            """
        )


def purge_expired() -> int:
    now = int(time.time())
    with db() as conn:
        rows = conn.execute(
            "SELECT id, filename FROM shares WHERE expires_at != 0 AND expires_at < ?", (now,)
        ).fetchall()
        for row in rows:
            with contextlib.suppress(FileNotFoundError):
                (settings.share_dir / row["filename"]).unlink()
        conn.execute(
            "DELETE FROM shares WHERE expires_at != 0 AND expires_at < ?", (now,)
        )
    return len(rows)


async def _purge_loop() -> None:
    while True:
        await asyncio.sleep(300)
        try:
            purge_expired()
            frames.purge()
        except Exception:  # never let the janitor kill the app
            pass


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    init_storage()
    task = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="viaEXIF Self-host", version=APP_VERSION, lifespan=lifespan)


# --------------------------------------------------------------------- api
@app.get("/api/health")
def health() -> dict:
    with db() as conn:
        shares = conn.execute("SELECT COUNT(*) AS c FROM shares").fetchone()["c"]
    return {
        "status": "ok",
        "version": APP_VERSION,
        "uptime": int(time.time() - STARTED_AT),
        "shares": shares,
        "shareTtl": settings.share_ttl,
        "decode": capabilities(),
    }


@app.get("/api/config")
def config() -> JSONResponse:
    # Carries APP_VERSION, so it must never outlive the container that answered.
    return JSONResponse(public_config(), headers={"Cache-Control": "no-store"})


async def _read_raw(upload: UploadFile, cap_bytes: int) -> bytes:
    """Read an upload without trusting its declared MIME type."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        if total > cap_bytes:
            raise HTTPException(413, f"文件超过 {cap_bytes // (1024 * 1024)}MB 限制")
        chunks.append(chunk)
    if total == 0:
        raise HTTPException(400, "空文件")
    return b"".join(chunks)


async def _save_upload(upload: UploadFile, cap_bytes: int) -> bytes:
    mime = (upload.content_type or "").split(";")[0].strip().lower()
    if mime not in ACCEPTED_MIME:
        raise HTTPException(415, f"不支持的格式: {mime or 'unknown'}，仅接受 JPG / PNG / WEBP / HEIC")
    return await _read_raw(upload, cap_bytes)


def _decode_blocking(data: bytes, kind: str) -> bytes:
    with _DECODE_SLOTS:
        img = decode_image(data, kind, settings.decode_max_px)
        payload = to_jpeg(img, quality=94 if kind == "raw" else 92)
        img.close()
        return payload


@app.post("/api/decode")
async def decode_upload(file: UploadFile = File(...)) -> dict:
    """Normalise a camera-native file into a JPEG the canvas can draw.

    Returns a token instead of the pixels: a 60 MP RAW becomes a ~20 MB JPEG,
    which is pointless to base64 into JSON. The browser fetches it once for the
    preview and again (from cache) at export time.
    """
    data = await _read_raw(file, settings.max_decode_mb * 1024 * 1024)
    fmt = sniff(data)
    if fmt.kind == "unknown":
        raise HTTPException(415, "无法识别的图片格式（文件头既不匹配 JPEG/PNG/WEBP，也不是 HEIC 或 RAW）")

    started = time.time()
    try:
        payload = await run_in_threadpool(_decode_blocking, data, fmt.kind)
    except DecodeError as exc:
        raise HTTPException(415, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"解码失败：{exc}") from exc

    meta = await run_in_threadpool(read_meta, data, fmt.kind)
    token = frames.put(payload)
    return {
        "token": token,
        "kind": fmt.kind,
        "label": fmt.label,
        "raw": fmt.raw,
        "size": len(payload),
        "ms": int((time.time() - started) * 1000),
        "exif": meta,
        "url": f"/api/decode/{token}",
    }


@app.get("/api/decode/{token}")
def decode_frame(token: str) -> Response:
    payload = frames.get(token)
    if payload is None:
        raise HTTPException(404, "解码结果已过期，请重新上传图片")
    return Response(
        payload,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=900"},
    )


@app.post("/api/encode")
async def encode_frame(
    file: UploadFile = File(...),
    format: str = Form("heic"),
    quality: int = Form(92, ge=40, le=100),
) -> Response:
    """Re-encode a rendered frame into a format the canvas cannot write."""
    data = await _read_raw(file, settings.max_upload_mb * 1024 * 1024)
    try:
        out, mime, ext = await run_in_threadpool(encode_image, data, format, quality)
    except DecodeError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(
        out,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="viaexif.{ext}"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/share")
async def create_share(file: UploadFile = File(...)) -> dict:
    data = await _save_upload(file, settings.max_share_mb * 1024 * 1024)
    share_id = secrets.token_urlsafe(16)
    suffix = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/heic": ".heic",
    }[(file.content_type or "").split(";")[0].strip().lower()]
    filename = f"{share_id}{suffix}"
    (settings.share_dir / filename).write_bytes(data)

    now = int(time.time())
    expires = now + settings.share_ttl if settings.share_ttl > 0 else 0
    with db() as conn:
        conn.execute(
            "INSERT INTO shares (id, filename, mime, size, created_at, expires_at) VALUES (?,?,?,?,?,?)",
            (share_id, filename, file.content_type, len(data), now, expires),
        )
    return {
        "id": share_id,
        "url": f"/s/{share_id}",
        "size": len(data),
        "expiresAt": expires,
    }


@app.get("/s/{share_id}")
def view_share(share_id: str, download: int = Query(0, ge=0, le=1)) -> FileResponse:
    if not (8 <= len(share_id) <= 64):
        raise HTTPException(404, "链接不存在")
    with db() as conn:
        row = conn.execute("SELECT * FROM shares WHERE id = ?", (share_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "链接不存在或已过期")
    if row["expires_at"] and row["expires_at"] < int(time.time()):
        raise HTTPException(410, "链接已过期")
    path = settings.share_dir / row["filename"]
    if not path.exists():
        raise HTTPException(404, "文件已被清理")
    headers = {"Cache-Control": "public, max-age=86400"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{share_id}{Path(row["filename"]).suffix}"'
    return FileResponse(path, media_type=row["mime"], headers=headers)


@app.exception_handler(HTTPException)
async def http_exc(request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


# ------------------------------------------------------------------ static
if not WEB_DIR.is_dir():
    raise RuntimeError(f"web assets missing: {WEB_DIR}")

class BuildFreshStatic(StaticFiles):
    """Serve the SPA so an upgraded container is visible on the next reload.

    Two rounds of "the NAS still shows the old build" came from the same cause:
    Starlette's default sends `Last-Modified` and `ETag` but no `Cache-Control`,
    and a browser is then free to invent a freshness lifetime of its own —
    typically 10% of the file's age. A build that had been sitting on the NAS
    for two days therefore looked "fresh" for nearly five hours, so after
    `docker` swapped the image the browser kept rendering the previous app.js
    without ever asking the new container. `no-cache` (1.2.1) only fixed the
    responses issued *after* the upgrade; an entry cached before it still keeps
    its invented lifetime, which is why a restart changed nothing.

    `no-store` is the honest answer for a LAN tool of this size: nothing here is
    worth an offline hit, every asset is a few dozen kilobytes over gigabit, and
    a deploy is then visible on a plain reload — no hard refresh, no devtools,
    no "clear your cache". Web fonts are the one exception: they are large, they
    never change inside a build, and the names are already unique per family.
    """

    CACHEABLE_PREFIX = "assets/fonts/"

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        # Starlette normalises the mount-relative path with os.path, so on
        # Windows it arrives back-slash separated; compare in one dialect.
        probe = path.replace("\\", "/").lstrip("/")
        if probe.startswith(self.CACHEABLE_PREFIX):
            response.headers["Cache-Control"] = "public, max-age=604800, immutable"
        else:
            response.headers["Cache-Control"] = "no-store"
        return response


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def index() -> HTMLResponse:
    """The shell, stamped with the build that is answering.

    The version lives in the markup rather than being painted by app.js: if the
    bundle is stale or fails to load, the tab still says which container replied,
    which is the whole point of the chip.
    """
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        html.replace("__APP_VERSION__", APP_VERSION),
        headers={"Cache-Control": "no-store"},
    )


app.mount("/", BuildFreshStatic(directory=WEB_DIR, html=True), name="web")

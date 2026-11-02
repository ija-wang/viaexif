#!/usr/bin/env bash
# Unit tests for the browser modules + zip integrity check.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p tests/.tmp
cp web/js/exif.js tests/.tmp/exif.mjs
cp web/js/zip.js tests/.tmp/zip.mjs
cp web/js/formats.js tests/.tmp/formats.mjs
cp web/js/live.js tests/.tmp/live.mjs

node tests/run.mjs

# Server-side decode tests (HEIC / RAW) need Pillow + pillow-heif + rawpy.
PY=python
[ -x .venv/Scripts/python.exe ] && PY=.venv/Scripts/python.exe
[ -x .venv/bin/python ] && PY=.venv/bin/python
"$PY" tests/test_imaging.py

python - <<'PY'
import zipfile, sys
with zipfile.ZipFile("tests/.tmp/out.zip") as z:
    bad = z.testzip()
    assert bad is None, f"corrupt entry: {bad}"
    assert z.namelist() == ["a.txt"], z.namelist()
    data = z.read("a.txt").decode()
    assert data == "hello viaexif", data
print("  ok   zip readable by python zipfile (CRC verified)")
PY

rm -rf tests/.tmp
echo "all tests passed"

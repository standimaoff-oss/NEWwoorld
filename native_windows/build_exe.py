"""
Generates gzip-compressed embedded web assets (C header) and compiles
`windows/NEWwoorldStudio.exe` as a genuine PE32+ x86_64 Windows GUI executable
using `zig cc -target x86_64-windows-gnu`.
"""

from __future__ import annotations
import gzip
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
OUT_HDR = ROOT / "native_windows" / "embedded_assets.h"
OUT_EXE = ROOT / "windows" / "NEWwoorldStudio.exe"

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
}


def generate_embedded_assets_header() -> None:
    files = [
        ("/index.html", WEB_DIR / "index.html"),
        ("/css/studio.css", WEB_DIR / "css" / "studio.css"),
        ("/js/app.js", WEB_DIR / "js" / "app.js"),
    ]
    three_dir = WEB_DIR / "vendor" / "three"
    for p in sorted(three_dir.glob("*.js")):
        files.append((f"/vendor/three/{p.name}", p))

    lines = [
        "#ifndef NEWWOORLD_EMBEDDED_ASSETS_H",
        "#define NEWWOORLD_EMBEDDED_ASSETS_H",
        "#include <stddef.h>",
        "#include <stdint.h>",
        "#include <string.h>",
        "",
        "typedef struct { const char *path; const char *mime; const uint8_t *data; size_t len; } EmbeddedAsset;",
        "",
    ]

    entries = []
    for idx, (url_path, fpath) in enumerate(files):
        raw = fpath.read_bytes()
        gz = gzip.compress(raw, compresslevel=9)
        var = f"asset_data_{idx}"
        mime = MIME_TYPES.get(fpath.suffix.lower(), "application/octet-stream")
        hex_bytes = ", ".join(f"0x{b:02x}" for b in gz)
        lines.append(f"static const uint8_t {var}[] = {{ {hex_bytes} }};")
        entries.append((url_path, mime, var, len(gz)))
        print(f"Embedded {url_path:40s} | raw={len(raw):7d} -> gzip={len(gz):7d}")

    lines.append("")
    lines.append("static const EmbeddedAsset EMBEDDED_ASSETS[] = {")
    for url_path, mime, var, sz in entries:
        lines.append(f'    {{ "{url_path}", "{mime}", {var}, {sz} }},')
    lines.append("};")
    lines.append(f"static const size_t NUM_EMBEDDED_ASSETS = {len(entries)};")
    lines.extend([
        "",
        "static const EmbeddedAsset *find_embedded_asset(const char *path) {",
        "    for (size_t i = 0; i < NUM_EMBEDDED_ASSETS; i++) {",
        "        if (strcmp(EMBEDDED_ASSETS[i].path, path) == 0) return &EMBEDDED_ASSETS[i];",
        "    }",
        "    return NULL;",
        "}",
        "#endif",
    ])
    OUT_HDR.write_text("\n".join(lines) + "\n", encoding="utf-8")


def compile_windows_exe() -> None:
    OUT_EXE.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        sys.executable,
        "-m",
        "ziglang",
        "cc",
        "-target",
        "x86_64-windows-gnu",
        "-O2",
        "-s",
        "-Wl,--subsystem,windows",
        str(ROOT / "native_windows" / "main.c"),
        "-lws2_32",
        "-lshell32",
        "-luser32",
        "-lgdi32",
        "-o",
        str(OUT_EXE),
    ]
    print("Compiling:", " ".join(cmd))
    subprocess.check_call(cmd)
    print(f"Built Windows EXE -> {OUT_EXE} ({OUT_EXE.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    generate_embedded_assets_header()
    compile_windows_exe()

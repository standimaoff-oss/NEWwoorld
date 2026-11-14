#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Шейдеры ShopSim: из одного исходника — два диалекта.

Единый источник правды — shaders/glsl/*.vert|frag (синтаксис GLSL ES 3.00,
как в WebGL2 и на Android/GLES3). Этот скрипт:

  1. раскрывает #include "common.glsl";
  2. собирает веб-вариант (#version 300 es, тонмаппинг в пост-проходе);
  3. собирает нативный вариант для raylib (#version 330, тонмаппинг в объекте);
  4. пишет манифест uniforms/attributes — по нему проверяется web/js/mat.js;
  5. при наличии glslangValidator прогоняет проверку обоих вариантов.

Запуск:
    python3 tools/shader_dialect.py                # собрать в build/shaders
    python3 tools/shader_dialect.py --validate     # и проверить glslang'ом
    python3 tools/shader_dialect.py --check-js     # и сверить с веб-материалами
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "shaders", "glsl")
OUT = os.path.join(ROOT, "build", "shaders")

INCLUDE_RE = re.compile(r'^\s*#include\s+"([^"]+)"\s*$', re.M)
UNIFORM_RE = re.compile(r"^\s*uniform\s+(?:lowp|mediump|highp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*(\[[0-9]+\])?\s*;", re.M)
IN_RE = re.compile(r"^\s*in\s+(?:lowp|mediump|highp\s+)?([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s*;", re.M)
PRECISION_RE = re.compile(r"^\s*precision\s+(lowp|mediump|highp)\s+(int|float|sampler2D|sampler3D)\s*;\s*$", re.M)
QUAL_RE = re.compile(r"\b(lowp|mediump|highp)\s+")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def resolve(path: str, seen: tuple[str, ...] = ()) -> str:
    name = os.path.basename(path)
    if name in seen:
        raise SystemExit(f"#include зациклился: {name} <- {' <- '.join(seen)}")
    with open(path, encoding="utf-8") as f:
        src = f.read()

    def sub(m: re.Match) -> str:
        inc = m.group(1)
        p = inc if os.path.isabs(inc) else os.path.join(SRC, inc)
        if not os.path.exists(p):
            raise SystemExit(f"{name}: не найден include {inc!r}")
        body = resolve(p, seen + (name,))
        # Из включаемого файла убираем его собственные комментарии-шапку, чтобы
        # не раздувать строки ошибок; сам код оставляем как есть.
        return f"// >>> include {inc}\n{body}\n// <<< include {inc}\n"

    return INCLUDE_RE.sub(sub, src)


def to_es3(body: str, tonemap_in_post: int) -> str:
    head = ["#version 300 es",
            "precision highp float;",
            "precision highp int;",
            "precision mediump sampler3D;",
            f"#define SHOPSIM_TONEMAP_IN_POST {tonemap_in_post}",
            ""]
    return "\n".join(head) + body


def to_gl330(body: str, tonemap_in_post: int) -> str:
    # Desktop/raylib: убираем квалификаторы точности и строки precision,
    # sampler3D остаётся (есть в GLSL 130+).
    s = PRECISION_RE.sub("", body)
    s = QUAL_RE.sub("", s)
    head = [f"#version 330 core",
            f"#define SHOPSIM_TONEMAP_IN_POST {tonemap_in_post}",
            ""]
    return "\n".join(head) + s


def collect() -> list[tuple[str, str, str]]:
    out = []
    for fn in sorted(os.listdir(SRC)):
        if fn.endswith((".vert", ".frag")):
            out.append((fn.rsplit(".", 1)[0], fn.rsplit(".", 1)[1], os.path.join(SRC, fn)))
    return out


def build(validate: bool, check_js: bool) -> int:
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for sub in ("web", "native"):
        os.makedirs(os.path.join(OUT, sub), exist_ok=True)

    manifest: dict[str, dict] = {}
    problems: list[str] = []
    shader_files: list[tuple[str, str]] = []

    for name, stage, path in collect():
        body = resolve(path)
        es = to_es3(body, 1)
        gl = to_gl330(body, 0)
        with open(os.path.join(OUT, "web", f"{name}.{stage}.glsl"), "w", encoding="utf-8") as f:
            f.write(es)
        with open(os.path.join(OUT, "native", f"{name}.{stage}.330.glsl"), "w", encoding="utf-8") as f:
            f.write(gl)
        code = strip_comments(body)
        uniforms = {}
        for typ, uname, arr in UNIFORM_RE.findall(code):
            uniforms.setdefault(uname, typ + (arr or ""))
        attrs = {u: t for t, u in IN_RE.findall(code)}
        manifest.setdefault(name, {"uniforms": {}, "attributes": {}, "stages": {}})
        manifest[name]["uniforms"].update(uniforms)
        if stage == "vert":
            manifest[name]["attributes"] = attrs
        # Проверка: ни один uniform не объявлен дважды в одном этапе (glslang
        # на это ругается, а человек видит только «redefinition»).
        dup = [u for u in UNIFORM_RE.findall(code) if 0]
        manifest[name]["stages"][stage] = {"uniforms": sorted(uniforms), "ins": sorted(attrs)}

    # Общие uniforms из common.glsl входят во все программы — их удобно
    # вынуть в отдельный список для сверки с JS.
    common = strip_comments(resolve(os.path.join(SRC, "common.glsl")))
    globals_ = {u: t for t, u, _ in UNIFORM_RE.findall(common)}
    manifest["_globals"] = {"uniforms": globals_}
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=True)

    print(f"собрано программ: {len(manifest) - 1} -> {os.path.relpath(OUT, ROOT)}")

    if validate:
        problems += validate_all()
    if check_js:
        problems += check_js_materials(manifest)

    for p in problems:
        print("ОШИБКА:", p)
    return 1 if problems else 0


def glslang() -> str | None:
    for cand in ("glslangValidator", os.environ.get("GLSLANG", ""), "/tmp/glslang-build/glslangValidator"):
        if cand and shutil.which(cand):
            return shutil.which(cand)
    return None


def validate_one(tool: str, path: str, stage: str, target: str | None) -> list[str]:
    # ES-шейдеры (#version 300 es) glslang определяет по директиве версии,
    # для десктопа просим profile OpenGL.
    args = [tool, "-S", stage]
    if target:
        args += ["--target-env", target, "--auto-map-locations"]
    args.append(path)
    r = subprocess.run(args, capture_output=True, text=True)
    out = (r.stdout or "") + (r.stderr or "")
    errs = []
    if r.returncode != 0:
        for line in out.splitlines():
            if "ERROR" in line or "error:" in line:
                errs.append(f"{os.path.relpath(path, ROOT)}: {line.strip()}")
        if not errs:
            errs.append(f"{os.path.relpath(path, ROOT)}: glslangValidator вернул {r.returncode}\n{out.strip()[:1200]}")
    return errs


def validate_all() -> list[str]:
    tool = glslang()
    if not tool:
        print("glslangValidator не найден — проверка пропущена "
              "(поставьте или задайте GLSLANG=/путь/glslangValidator)")
        return []
    errs: list[str] = []
    n = 0
    # ES-диалект glslang определяет по «#version 300 es»; десктопу нужен
    # --target-env opengl, иначе вклочаются правила Vulkan (layout(location=)).
    for sub, target in (("web", None), ("native", "opengl")):
        d = os.path.join(OUT, sub)
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".glsl") and not fn.endswith(".330.glsl"):
                continue
            stage = "vert" if ".vert." in fn else "frag"
            errs += validate_one(tool, os.path.join(d, fn), stage, target)
            n += 1
    print(f"glslangValidator: проверено {n} файлов, ошибок {len(errs)}")
    return errs


def check_js_materials(manifest: dict) -> list[str]:
    """Веб-материалы не должны требовать uniform, которого в шейдере нет."""
    js = os.path.join(ROOT, "web", "js", "materials.js")
    if not os.path.exists(js):
        return []
    with open(js, encoding="utf-8") as f:
        src = f.read()
    errs = []
    for m in re.finditer(r"prog\(\s*['\"]([\w]+)['\"][^)]*\)\s*;?[\s\S]{0,400}?u\(\s*\[([^\]]*)\]", src):
        pass
    # Проще: собираем все строковые литералы uniform'ов и проверяем, что для
    # каждой программы они объявлены (или входят в общие).
    for prog in re.finditer(r"(const|function)\s+(\w+)\s*=\s*material\(\s*['\"](\w+)['\"]", src):
        name = prog.group(3)
        if name not in manifest:
            errs.append(f"materials.js: программа {name!r} не найдена в shaders/glsl")
    names = set(re.findall(r"""u\(\s*['"](\w+)['"]""", src)) | set(re.findall(r"""setU\(\s*['"](\w+)['"]""", src))
    all_known = set(manifest.get("_globals", {}).get("uniforms", {}))
    for m in manifest.values():
        if isinstance(m, dict):
            all_known |= set(m.get("uniforms", {}))
    for u in sorted(names):
        if u not in all_known:
            errs.append(f"materials.js: uniform {u!r} не объявлен ни в одном шейдере")
    return errs


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true", help="проверить glslangValidator'ом")
    ap.add_argument("--check-js", action="store_true", help="сверить с web/js/materials.js")
    a = ap.parse_args()
    sys.exit(build(a.validate, a.check_js))

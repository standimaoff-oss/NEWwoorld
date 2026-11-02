#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Структурная проверка шейдеров Godot (.gdshader) и их связи с GDScript.

Godot компилирует шейдеры только в рантайме/редакторе, поэтому офлайн
проверить их нечем. Но значительная часть ошибок — СТРУКТУРНЫЕ, и их
видно без компилятора GLSL:

  1. Нет `shader_type` — шейдер не загрузится вообще.
  2. `shader_type` не из разрешённого набора (spatial/canvas_item/particles/sky/fog).
  3. Несбалансированные фигурные скобки (типично после правки руками).
  4. `render_mode` с неизвестным флагом.
  5. Обращение к uniform'у, который не объявлен в этом же файле
     (частая опечатка: `wind_strenght`).
  6. ГЛОБАЛЬНЫЕ uniform'ы ветра должны совпадать по именам с теми, что
     публикует WindSystem. Расхождение — шейдер молча получит ноль,
     и листва перестанет качаться. Баг, который невозможно заметить
     по сообщению об ошибке, потому что ошибки не будет.
  7. Объявлен uniform, который нигде не используется (мусор в инспекторе).

Запуск:
    python3 tools/lint/shader_check.py
    python3 tools/lint/shader_check.py --strict
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Dict, List, Set, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GAME_ROOT = os.path.join(REPO_ROOT, "game")
WIND_SYSTEM = os.path.join(GAME_ROOT, "scripts", "systems", "wind_system.gd")

VALID_SHADER_TYPES = {"spatial", "canvas_item", "particles", "sky", "fog"}

# Флаги render_mode, допустимые для каждого типа шейдера.
# Взяты из документации Godot 4; список закрытый — движок отвергает чужие.
RENDER_MODES: Dict[str, Set[str]] = {
    "spatial": {
        "blend_mix", "blend_add", "blend_sub", "blend_mul",
        "depth_draw_opaque", "depth_draw_always", "depth_draw_never",
        "depth_prepass_alpha", "depth_test_disabled",
        "sss_mode_shadows",
        "cull_back", "cull_front", "cull_disabled",
        "unshaded", "vertex_lighting", "diffuse_burley", "diffuse_lambert",
        "diffuse_lambert_wrap", "diffuse_toon", "specular_schlick_ggx",
        "specular_blinn", "specular_phong", "specular_toon", "specular_disabled",
        "shadows_disabled", "ambient_light_disabled",
        "fog_disabled", "world_vertex_coords",
    },
    "canvas_item": {
        "blend_mix", "blend_add", "blend_sub", "blend_mul", "blend_premul_alpha",
        "light_only", "unshaded",
    },
    "particles": {"disable_force", "disable_velocity", "keep_data"},
    "sky": {"use_half_res_pass", "use_quarter_res_pass", "use_device_res_pass"},
    "fog": {},
}

SHADER_TYPE_RE = re.compile(r"^\s*shader_type\s+([a-z_]+)\s*;", re.MULTILINE)
RENDER_MODE_RE = re.compile(r"^\s*render_mode\s+([^;]+);", re.MULTILINE)
UNIFORM_RE = re.compile(
    r"\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?"
    r"(float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|"
    r"bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|sampler2DArray|sampler3D|"
    r"samplerCube|samplerExternalOES)\s+([A-Za-z_][A-Za-z0-9_]*)\s*"
    r"(?::[^=;]+)?(?:=[^;]+)?;"
)
# Объявления глобальных shader-параметров в WindSystem:
#     const PARAM_DIRECTION: StringName = &"wind_direction"
WIND_PARAM_RE = re.compile(
    r'const\s+PARAM_[A-Z_]+\s*:\s*StringName\s*=\s*&"([a-z0-9_]+)"'
)
# Типы GLSL — нужны, чтобы отличать ОБЪЯВЛЕНИЕ переменной от её использования.
GLSL_TYPES = (
    "float|int|uint|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|uvec2|uvec3|uvec4|"
    "bvec2|bvec3|bvec4|mat2|mat3|mat4|sampler2D|sampler2DArray|sampler3D|"
    "samplerCube|samplerExternalOES"
)
# Локальные объявления: `float wind_power = ...;` / `vec2 uv_a = ...;`
LOCAL_DECL_RE = re.compile(r"\b(?:%s)\s+([A-Za-z_][A-Za-z0-9_]*)\b" % GLSL_TYPES)
# Константы: `const mat3 PROTAN = ...;`
CONST_DECL_RE = re.compile(r"\bconst\s+(?:%s)\s+([A-Za-z_][A-Za-z0-9_]*)" % GLSL_TYPES)
# Функции: `float hash21(vec2 p)` и их параметры
FUNC_DECL_RE = re.compile(
    r"\b(?:void|float|int|uint|bool|vec2|vec3|vec4|mat2|mat3|mat4|sampler2D)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)")
# Структуры: `struct Foo {`
STRUCT_DECL_RE = re.compile(r"\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)")

# Идентификаторы, которые не являются uniform'ами
GLSL_BUILTINS = {
    "VERTEX", "NORMAL", "TANGENT", "BINORMAL", "COLOR", "UV", "UV2", "POINT_SIZE",
    "POSITION", "NORMAL_MAP", "NORMAL_MAP_DEPTH", "ALBEDO", "ALPHA", "ROUGHNESS",
    "METALLIC", "SPECULAR", "EMISSION", "RIM", "RIM_TINT", "CLEARCOAT",
    "CLEARCOAT_ROUGHNESS", "ANISOTROPY", "ANISOTROPY_FLOW", "AO", "AO_LIGHT_AFFECT",
    "SSS_STRENGTH", "BACKLIGHT", "TRANSMITTANCE", "FOG", "SCREEN_UV", "SCREEN_PIXEL_SIZE",
    "CLIP_COORD", "FRAGCOORD", "INV_PROJECTION_MATRIX", "PROJECTION_MATRIX",
    "MODEL_MATRIX", "VIEW_MATRIX", "INV_VIEW_MATRIX", "CAMERA_MATRIX",
    "INV_CAMERA_MATRIX", "MODELVIEW_MATRIX", "INV_MODEL_MATRIX", "TIME", "PI",
    "EYEDIR", "LIGHT", "ATTENUATION", "SHADOW_ATTENUATION", "COLOR", "ALPHA",
    "SIZE", "VELOCITY", "MASS", "ACTIVE", "CUSTOM", "RESTART_POSITION",
    "RESTART_ROTATE", "RESTART_SCALE", "RESTART_VELOCITY", "EMISSION_MATRIX",
    "TEXTURE", "POINT_COORD", "INSTANCE_CUSTOM", "AT_LIGHT_PASS", "LIGHT_ITERATIONS",
}


def strip_glsl_comments(text: str) -> str:
    """Убирает // и /* */ — иначе uniform внутри комментария считается."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"//[^\n]*", "", text)
    return text


def find_shaders(root: str) -> List[str]:
    found: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".git", ".godot", "addons"}]
        for name in filenames:
            if name.endswith(".gdshader"):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def read_wind_params() -> Set[str]:
    if not os.path.isfile(WIND_SYSTEM):
        return set()
    with open(WIND_SYSTEM, "r", encoding="utf-8") as fh:
        return set(WIND_PARAM_RE.findall(fh.read()))


def check_shader(path: str, wind_params: Set[str]) -> Tuple[List[str], List[str]]:
    errors: List[str] = []
    warnings: List[str] = []
    rel = os.path.relpath(path, REPO_ROOT)

    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    code = strip_glsl_comments(raw)

    # --- 1/2. shader_type --------------------------------------------------
    type_match = SHADER_TYPE_RE.search(code)
    if not type_match:
        errors.append("%s: отсутствует 'shader_type ...;'" % rel)
        return errors, warnings
    shader_type = type_match.group(1)
    if shader_type not in VALID_SHADER_TYPES:
        errors.append("%s: shader_type '%s' неизвестен (допустимы: %s)"
                      % (rel, shader_type, ", ".join(sorted(VALID_SHADER_TYPES))))
        return errors, warnings

    # --- 3. скобки ---------------------------------------------------------
    opens = code.count("{")
    closes = code.count("}")
    if opens != closes:
        errors.append("%s: несбалансированные скобки — { %d, } %d" % (rel, opens, closes))

    # --- 4. render_mode ----------------------------------------------------
    allowed_modes = RENDER_MODES.get(shader_type, set())
    for rm in RENDER_MODE_RE.finditer(code):
        for flag in (f.strip() for f in rm.group(1).split(",")):
            if not flag:
                continue
            if flag not in allowed_modes:
                errors.append("%s: render_mode '%s' недопустим для shader_type '%s'"
                              % (rel, flag, shader_type))

    # --- 5/6/7. uniform'ы ---------------------------------------------------
    declared: Set[str] = set()
    for m in UNIFORM_RE.finditer(code):
        declared.add(m.group(2))

    # Все локальные имена файла: переменные, константы, функции, параметры,
    # структуры. Без этого набора проверка «использовано без объявления»
    # принимает `float wind_power = ...` за опечатку в имени uniform'а.
    locals_here: Set[str] = set()
    locals_here |= set(LOCAL_DECL_RE.findall(code))
    locals_here |= set(CONST_DECL_RE.findall(code))
    locals_here |= set(STRUCT_DECL_RE.findall(code))
    for m in FUNC_DECL_RE.finditer(code):
        locals_here.add(m.group(1))
        for chunk in m.group(2).split(","):
            token = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\s*$", chunk.strip())
            if token:
                locals_here.add(token.group(1))

    # --- 6. глобальные параметры ветра --------------------------------------
    # Синтаксически глобальный shader-параметр и обычный uniform выглядят
    # одинаково: в shading language Godot нет ключевого слова `global`.
    # Различие только в имени — движок связывает параметр по совпадению.
    # Поэтому проверяем пересечение с именами из WindSystem, а не «всё, что
    # начинается с wind_»: wind_response — законный per-material uniform.
    global_wind_used = declared & wind_params
    if global_wind_used:
        unused_wind = wind_params - declared
        if unused_wind:
            warnings.append(
                "%s: WindSystem публикует также %s, но шейдер их не читает — "
                "проверьте, что это намеренно"
                % (rel, ", ".join(sorted(unused_wind))))
    # Uniform'ы с префиксом wind_, которых нет в WindSystem, — per-material.
    # Предупреждаем, а не падаем: это нормальный способ настройки материала.
    per_material_wind = {u for u in declared if u.startswith("wind_")} - wind_params
    for name in sorted(per_material_wind):
        warnings.append(
            "%s: uniform '%s' не является глобальным параметром WindSystem — "
            "убедитесь, что значение задаётся у материала" % (rel, name))

    # Использовано имя wind_*, которого нет ни в uniform'ах, ни в локальных
    # переменных — почти наверняка опечатка (`wind_strenght`).
    used_wind = set(re.findall(r"\b(wind_[a-z_]+)\b", code)) - declared - locals_here
    for name in sorted(used_wind):
        errors.append("%s: используется '%s', но ни uniform, ни локальная "
                      "переменная с таким именем не объявлены (опечатка?)" % (rel, name))

    # Неиспользуемые uniform'ы — мусор в инспекторе материала.
    body = code[SHADER_TYPE_RE.search(code).end():]
    for name in sorted(declared):
        uses = len(re.findall(r"\b%s\b" % re.escape(name), body))
        if uses == 0:
            warnings.append("%s: uniform '%s' объявлен, но не используется" % (rel, name))

    # Идентификатор в ВЕРХНЕМ регистре, которого нет среди встроенных имён,
    # uniform'ов и констант файла: ловит опечатки вида VERTEXS / ALBEDO.
    # Константы (const mat3 PROTAN) исключаем — они законны.
    for token in set(re.findall(r"\b([A-Z][A-Z0-9_]{2,})\b", body)):
        if token in GLSL_BUILTINS or token in locals_here:
            continue
        if token.startswith(("ARRAY_", "PRIMITIVE_", "MSAA_", "SHADOW_", "LIGHT_",
                             "SPECULAR_", "DIFFUSE_", "BLEND_", "SSS_", "USE_")):
            continue
        warnings.append("%s: '%s' не является ни uniform'ом, ни константой, "
                        "ни известным встроенным именем — проверьте опечатку" % (rel, token))

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    roots = args.paths or [os.path.join(GAME_ROOT, "shaders")]
    files: List[str] = []
    for root in roots:
        full = root if os.path.isabs(root) else os.path.join(REPO_ROOT, root)
        if os.path.isfile(full):
            files.append(full)
        elif os.path.isdir(full):
            files.extend(find_shaders(full))
    files = sorted(set(files))

    wind_params = read_wind_params()
    if not args.quiet:
        print("Shader check: %d файлов" % len(files))
        print("  глобальные параметры ветра из WindSystem: %s"
              % (", ".join(sorted(wind_params)) or "нет"))

    all_errors: List[str] = []
    all_warnings: List[str] = []
    for path in files:
        errors, warnings = check_shader(path, wind_params)
        all_errors.extend(errors)
        all_warnings.extend(warnings)

    for line in all_errors:
        print("  [ERROR] " + line)
    for line in all_warnings:
        print("  [WARN ] " + line)

    if all_errors:
        print("\nОШИБОК: %d, предупреждений: %d" % (len(all_errors), len(all_warnings)))
        return 1
    if all_warnings and args.strict:
        print("\nПРЕДУПРЕЖДЕНИЙ (strict): %d" % len(all_warnings))
        return 1
    if not args.quiet:
        print("\nOK: шейдеры структурно корректны (предупреждений: %d)" % len(all_warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

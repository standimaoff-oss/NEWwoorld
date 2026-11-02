#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Проверка использования API движка Godot в GDScript — БЕЗ запуска Godot.

ЗАЧЕМ ЭТО НУЖНО. Единственный способ узнать, что `RenderingServer.foo()`
не существует — обычно запуск движка. Но в репозитории godot-cpp лежит
`gdextension/extension_api.json`: полный машинно-читаемый дамп API
(971 класс, все методы, свойства, константы, enum'ы, синглтоны,
utility-функции) для конкретной версии Godot. Этот скрипт сверяет наш код
с этим дампом.

Что проверяется:
  1. `SomeEngineClass.member` — существует ли member с учётом наследования;
  2. `SomeClass.EnumName` и `SomeClass.CONSTANT` — существуют ли;
  3. глобальные utility-функции (`clampf`, `snappedf`, …) — существуют ли;
  4. обращения к autoload-синглтона движка (`OS`, `Engine`, `Input`, …).

Что НЕ проверяется (осознанно, чтобы не врать):
  * типы аргументов и их количество — это делает сам Godot при разборе;
  * свойства пользовательских классов (мы их не знаем без полного
    разрешения типов — отдельная задача);
  * ключи ProjectSettings — их нет в extension_api.json; для них есть
    отдельный белый список в конце файла.

Запуск:
    python3 tools/lint/godot_api_check.py
    python3 tools/lint/godot_api_check.py --api путь/к/extension_api.json
    python3 tools/lint/godot_api_check.py --strict   # ненулевой код при warns
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, Iterable, List, Optional, Set, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_API = os.path.join(
    REPO_ROOT, "gdextension", "godot-cpp", "gdextension", "extension_api.json"
)
GAME_ROOT = os.path.join(REPO_ROOT, "game")
EXCLUDED_DIRS = {".git", ".godot", "node_modules", ".venv", "addons", "build", "export"}

# Ключи ProjectSettings, которые проект реально выставляет/читает.
# Держим белым списком: опечатка в ключе — это «настройка молча не работает»,
# одна из самых противных категорий багов.
KNOWN_PROJECT_SETTINGS: Set[str] = {
    "rendering/mesh_lod/lod_change/threshold_pixels",
    "rendering/lights_and_shadows/directional_shadow/soft_shadow_filter_quality",
    "rendering/lights_and_shadows/positional_shadow/soft_shadow_filter_quality",
    "rendering/lights_and_shadows/directional_shadow/size",
    "rendering/textures/default_filters/anisotropic_filtering_level",
    "rendering/occlusion_culling/use_occlusion_culling",
    "rendering/environment/defaults/default_environment",
    "rendering/renderer/rendering_method",
    "rendering/anti_aliasing/quality/msaa_3d",
    "rendering/2d/snap/snap_2d_transforms_to_pixel",
    "display/window/size/viewport_width",
    "display/window/size/viewport_height",
    "display/window/stretch/mode",
    "application/config/name",
    "application/config/version",
    "physics/common/physics_ticks_per_second",
    "physics/3d/default_gravity",
    # Ключи самого проекта. Префикс newwoorld/ отделяет их от настроек
    # движка: так видно, что это наше, и обновление Godot их не тронет.
    "newwoorld/menu/hero_scene",
    "newwoorld/menu/motion_scale_default",
    "newwoorld/game/difficulty_default",
    "internationalization/locale/fallback",
    # Стандартные пространства имён движка. Перечислять каждый ключ
    # бессмысленно: их сотни, и они меняются между версиями. Префикс
    # надёжнее — «rendering/anti_aliasing/quality/msaa_3d» опечатать
    # можно, а «renderinggg/» нельзя.
    "run/main_scene",
    "application/config/features",
    "display/window/stretch/mode",
    "display/window/stretch/aspect",
}

# Префиксы стандартных разделов project.godot. Ключ вне этих префиксов и
# вне белого списка выше — почти наверняка опечатка или выдуманное имя.
STANDARD_SETTING_PREFIXES: Tuple[str, ...] = (
    "application/", "audio/", "debug/", "display/", "dotnet/", "filesystem/",
    "gui/", "input/", "input_devices/", "internationalization/",
    "layer_names/", "network/", "physics/", "rendering/", "run/", "text_to_speech/",
    "xr/", "editor/", "autoload/", "shader_globals/", "localization/",
)


def is_standard_setting(key: str) -> bool:
    """Ключ относится к стандартным разделам настроек Godot."""
    return key in KNOWN_PROJECT_SETTINGS or key.startswith(STANDARD_SETTING_PREFIXES)


# Паттерн `ClassName.member` — только если ClassName начинается с заглавной.
QUALIFIED_RE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b")
# Паттерн вызова функции: `name(`
CALL_RE = re.compile(r"\b([a-z_][a-z0-9_]*)\s*\(")
# Паттерн ключа ProjectSettings в кавычках
PSETTINGS_RE = re.compile(
    r'(?:set_setting|get_setting|has_setting)\s*\(\s*"([^"]+)"'
)

# Имена, которые выглядят как Class.member, но классами движка не являются:
# наши autoload-синглтоны, классы проекта и локальные enum'ы.
LOCAL_NAMES: Set[str] = {
    "GameConfig", "EventBus", "Diagnostics", "PerfMonitor", "SettingsService",
    "SaveService", "AudioService", "SceneService", "QualityService",
    "QualityProfile", "ObjectPool", "DestructionService", "WindSystem",
    "PlayerController", "Destructible", "SettingsForm", "LoadingScreen",
    "MainMenu", "Boot", "Hud", "FpsCounter", "MenuBackdrop", "CreditsPanel",
    "SettingsPanel", "PauseMenu", "World", "Validators", "ServiceLocator",
}


class GodotApi:
    """Индекс API движка с разрешением наследования."""

    def __init__(self, path: str) -> None:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        self.version: str = str(
            raw.get("header", {}).get("version_full_name", "unknown")
        )
        self.classes: Dict[str, dict] = {c["name"]: c for c in raw["classes"]}
        self.singletons: Set[str] = {s["name"] for s in raw.get("singletons", [])}
        self.utility_functions: Set[str] = {
            f["name"] for f in raw.get("utility_functions", [])
        }
        self.global_enums: Dict[str, Set[str]] = {}
        for enum in raw.get("global_enums", []):
            values = enum.get("values", {})
            names = set(values.keys()) if isinstance(values, dict) else {
                v["name"] for v in values
            }
            self.global_enums[enum["name"]] = names
        self.global_constants: Set[str] = {
            c["name"] for c in raw.get("global_constants", [])
        }
        self.builtin_classes: Set[str] = {
            b["name"] for b in raw.get("builtin_classes", [])
        }
        # Сторонние классы (GUT и будущие аддоны) в extension_api.json
        # отсутствуют, но лежат на диске. Без их индекса проверка ругается
        # на assert_eq()/watch_signals() в каждом тесте — то есть ровно на
        # тот код, который обязан быть корректным.
        self.addon_classes: Dict[str, dict] = {}
        self._member_cache: Dict[str, Set[str]] = {}

    def load_addon_classes(self, addons_root: str) -> int:
        """Индексирует class_name/extends/func из .gd-файлов аддонов.

        Класс аддона регистрируется как обычный класс с `inherits`, поэтому
        chain() и members() работают без изменений: GutTest -> Node -> Object
        даёт тесту и assert_eq(), и add_child().
        """
        if not os.path.isdir(addons_root):
            return 0
        count = 0
        for current, dirnames, filenames in os.walk(addons_root):
            dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules"}]
            for filename in filenames:
                if not filename.endswith(".gd"):
                    continue
                path = os.path.join(current, filename)
                info = _parse_addon_script(path)
                if info is None:
                    continue
                self.addon_classes[info["name"]] = info
                count += 1
        return count

    def resolve(self, class_name: str) -> Optional[dict]:
        """Описание класса из движка ИЛИ из аддонов."""
        if class_name in self.classes:
            return self.classes[class_name]
        return self.addon_classes.get(class_name)

    # -- наследование -------------------------------------------------------
    def chain(self, class_name: str) -> List[str]:
        out: List[str] = []
        seen: Set[str] = set()
        cur = class_name
        # Цепочка может начинаться в аддоне и продолжаться в движке:
        # GutTest -> Node -> Object. Обходить нужно оба индекса.
        while cur and cur not in seen:
            entry = self.resolve(cur)
            if entry is None:
                break
            out.append(cur)
            seen.add(cur)
            cur = entry.get("inherits") or None
        return out

    def members(self, class_name: str) -> Set[str]:
        if class_name in self._member_cache:
            return self._member_cache[class_name]
        out: Set[str] = set()
        for cls in self.chain(class_name):
            entry = self.resolve(cls)
            if entry is None:
                continue
            out |= {m["name"] for m in entry.get("methods", [])}
            out |= {p["name"] for p in entry.get("properties", [])}
            # Сигналы в extension_api.json лежат ОТДЕЛЬНЫМ списком. Без них
            # проверка ругалась бы на Button.pressed и Timer.timeout —
            # то есть на самые обычные вещи.
            out |= {sg["name"] for sg in entry.get("signals", [])}
            for const in entry.get("constants", []):
                out.add(const["name"])
            for enum in entry.get("enums", []):
                out.add(enum["name"])
                values = enum.get("values", {})
                if isinstance(values, dict):
                    out |= set(values.keys())
                else:
                    out |= {v["name"] for v in values}
        self._member_cache[class_name] = out
        return out

    def knows_class(self, name: str) -> bool:
        return name in self.classes or name in self.addon_classes

    # -- enum'ы как типы ----------------------------------------------------
    def enum_type_names(self, class_name: str) -> Set[str]:
        """Имена enum'ов класса: для `as Viewport.MSAA`."""
        out: Set[str] = set()
        for cls in self.chain(class_name):
            entry = self.resolve(cls)
            if entry is None:
                continue
            for enum in entry.get("enums", []):
                out.add(enum["name"])
        return out


# ------------------------------------------------------------- аддоны ------

_ADDON_CLASS_NAME_RE = re.compile(r"^\s*class_name\s+([A-Za-z0-9_]+)", re.MULTILINE)
_ADDON_EXTENDS_RE = re.compile(r"^\s*extends\s+([A-Za-z0-9_]+)", re.MULTILINE)
_ADDON_FUNC_RE = re.compile(r"^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)",
                            re.MULTILINE)


def _parse_addon_script(path: str) -> Optional[dict]:
    """Минимальный разбор .gd аддона: имя класса, родитель, методы.

    Типы параметров и возвращаемых значений не нужны: проверка API отвечает
    на вопрос «существует ли такой метод», а не «правильно ли он вызван»
    (это задача gdscript_call_check.py).
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None
    name_match = _ADDON_CLASS_NAME_RE.search(text)
    if name_match is None:
        return None
    extends_match = _ADDON_EXTENDS_RE.search(text)
    methods = [{"name": m.group(1)} for m in _ADDON_FUNC_RE.finditer(text)]
    return {
        "name": name_match.group(1),
        "inherits": extends_match.group(1) if extends_match else "RefCounted",
        "methods": methods,
        "properties": [],
        "signals": [],
        "constants": [],
        "enums": [],
    }


def find_gd_files(root: str) -> List[str]:
    found: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            if name.endswith(".gd"):
                found.append(os.path.join(dirpath, name))
    found.sort()
    return found


def strip_comments_and_strings(line: str) -> str:
    """Убирает комментарии и содержимое строк, чтобы не ловить ложные
    срабатывания внутри текста логов и докстрингов."""
    out: List[str] = []
    i = 0
    in_str: str | None = None
    while i < len(line):
        ch = line[i]
        if in_str:
            if ch == "\\" and i + 1 < len(line):
                i += 2
                continue
            if ch == in_str:
                in_str = None
                out.append(" ")
            i += 1
            continue
        if ch in ("'", '"'):
            in_str = ch
            i += 1
            continue
        if ch == "#":
            break
        out.append(ch)
        i += 1
    return "".join(out)


class Issue:
    def __init__(self, path: str, line: int, kind: str, message: str,
                 severity: str = "error") -> None:
        self.path = path
        self.line = line
        self.kind = kind
        self.message = message
        self.severity = severity

    def render(self, repo_root: str) -> str:
        rel = os.path.relpath(self.path, repo_root)
        return "%s:%d: [%s] %s: %s" % (
            rel, self.line, self.severity.upper(), self.kind, self.message
        )


PROJECT_FUNC_RE = re.compile(r"^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)")
PROJECT_MEMBER_RE = re.compile(
    r"^\s*(?:@export\s+|@onready\s+)*(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)"
)
PROJECT_SIGNAL_RE = re.compile(r"^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)")
PROJECT_ENUM_RE = re.compile(r"^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)")
EXTENDS_PATH_RE = re.compile(r'^\s*extends\s+"([^"]+)"')


TOPLEVEL_DECL_RE = re.compile(
    r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:static\s+)?(?:var|const|func|signal|enum)\s+"
    r"([A-Za-z_][A-Za-z0-9_]*)"
)


def collect_autoload_names() -> Dict[str, str]:
    """Имя автозагрузки -> путь к скрипту, из project.godot.

    Автозагрузка доступна по имени без class_name: `EventBus.emit_event(...)`.
    Без этого индекса такие обращения не проверялись вовсе, а опечатка в имени
    сигнала шины событий обнаруживалась бы только в запущенной игре.
    """
    config = os.path.join(GAME_ROOT, "project.godot")
    out: Dict[str, str] = {}
    if not os.path.exists(config):
        return out
    with open(config, "r", encoding="utf-8") as fh:
        section = ""
        for line in fh:
            stripped = line.strip()
            if stripped.startswith("["):
                section = stripped
                continue
            if section != "[autoload]" or "=" not in stripped or stripped.startswith(";"):
                continue
            name, _, value = stripped.partition("=")
            name = name.strip()
            value = value.strip().strip('"')
            if value.startswith("*"):
                value = value[1:]
            if name and value.endswith(".gd"):
                out[name] = os.path.join(GAME_ROOT, value[len("res://"):])
    return out


def collect_project_classes(files: List[str]) -> Dict[str, Dict[str, object]]:
    """Индекс собственных классов проекта: class_name -> extends и члены.

    ЗАЧЕМ. Скрипт наследуется не только от класса движка: `Door extends
    Interactable extends Area3D`. Без этого индекса проверка знала бы
    базовый класс Door как «Interactable», не нашла бы его в
    extension_api.json и объявила недоступными ВСЕ методы Node —
    create_tween(), set_process_input(), get_tree(). Это ложные
    срабатывания на корректном коде, и тем чаще, чем активнее проект
    использует собственные базовые классы (а использовать их правильно).

    Индекс намеренно избыточен: в члены попадают и функции внутренних
    классов. Цель — не дублировать анализатор областей видимости GDScript,
    а не ругаться на заведомо существующие методы.
    """
    index: Dict[str, Dict[str, object]] = {}
    by_path: Dict[str, str] = {}
    pending: List[Tuple[str, str, Set[str], str]] = []
    for path in files:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        class_name = ""
        base = "RefCounted"
        members: Set[str] = set()
        for raw in lines:
            m = CLASS_NAME_RE.match(raw)
            if m:
                class_name = m.group(1)
            m = EXTENDS_RE.match(raw)
            if m:
                base = m.group(1)
            m = EXTENDS_PATH_RE.match(raw)
            if m:
                # `extends "res://path.gd"`: имя базового класса ещё не
                # известно, разрешим его после обхода всех файлов.
                base = "\x00path:" + m.group(1)
            for pattern in (
                PROJECT_FUNC_RE, PROJECT_MEMBER_RE, PROJECT_SIGNAL_RE, PROJECT_ENUM_RE
            ):
                m = pattern.match(raw)
                if m:
                    members.add(m.group(1))
        declared: Set[str] = set()
        for raw in lines:
            m = TOPLEVEL_DECL_RE.match(raw)
            if m:
                declared.add(m.group(1))
        if class_name:
            index[class_name] = {"extends": base, "members": members, "declared": declared}
            pending.append((path, class_name, members, base))
    # Автозагрузки индексируются по имени из project.godot, даже если у
    # скрипта нет class_name: обращение к ним всё равно выглядит как
    # обращение к классу.
    for auto_name, auto_path in collect_autoload_names().items():
        if auto_name in index or not os.path.exists(auto_path):
            continue
        with open(auto_path, "r", encoding="utf-8") as fh:
            auto_lines = fh.read().split("\n")
        auto_members: Set[str] = set()
        auto_declared: Set[str] = set()
        auto_base = "RefCounted"
        for raw in auto_lines:
            m = EXTENDS_RE.match(raw)
            if m:
                auto_base = m.group(1)
            for pattern in (
                PROJECT_FUNC_RE, PROJECT_MEMBER_RE, PROJECT_SIGNAL_RE, PROJECT_ENUM_RE
            ):
                m = pattern.match(raw)
                if m:
                    auto_members.add(m.group(1))
            m = TOPLEVEL_DECL_RE.match(raw)
            if m:
                auto_declared.add(m.group(1))
        index[auto_name] = {
            "extends": auto_base, "members": auto_members, "declared": auto_declared
        }
    # res://path -> class_name. Путь в скрипте отсчитывается от каталога game.
    for path, class_name, _members, _base in pending:
        normalized = path.replace("\\", "/")
        marker = normalized.find("/game/")
        if marker >= 0:
            by_path["res://" + normalized[marker + len("/game/"):]] = class_name
        by_path[normalized] = class_name
    for class_name, entry in index.items():
        base = str(entry["extends"])
        if base.startswith("\x00path:"):
            resolved = by_path.get(base[len("\x00path:"):], "")
            entry["extends"] = resolved if resolved else "RefCounted"
    return index


def resolve_chain_members(
    api: "GodotApi", base_class: str, index: Dict[str, Dict[str, object]],
    key: str = "members"
) -> Set[str]:
    """Члены, доступные в скрипте «без точки», по всей цепочке наследования.

    Цепочка может проходить через несколько скриптов проекта и заканчиваться
    классом движка. api.members() уже разворачивает наследование внутри
    движка, поэтому на первом же известном ему классе обход останавливается.
    """
    out: Set[str] = set()
    current = base_class
    seen: Set[str] = set()
    guard = 0
    while current and guard < 32:
        guard += 1
        if current in seen:
            break
        seen.add(current)
        if api.knows_class(current):
            out |= api.members(current)
            break
        entry = index.get(current)
        if entry is None:
            break
        out |= set(entry.get(key, set()))  # type: ignore[arg-type]
        current = str(entry["extends"])
    return out


def project_chain_members(
    api: "GodotApi", class_name: str, index: Dict[str, Dict[str, object]]
) -> Optional[Set[str]]:
    """Объявленные члены класса проекта, либо None, если класс неизвестен.

    None означает «не наш уровень ответственности»: имя может быть
    внутренним классом, перечислением или опечаткой, которую ловит другая
    проверка. Пустое множество означало бы «класс есть, но пуст» — и это
    уже настоящий признак ошибки.
    """
    if api.knows_class(class_name) or class_name not in index:
        return None
    return resolve_chain_members(api, class_name, index, "declared")


def collect_project_functions(files: List[str]) -> Set[str]:
    """Все имена функций, объявленные в GDScript-файлах проекта.

    Нужно, чтобы проверка «голых» вызовов не ругалась на наши же методы:
    в GDScript `my_helper()` без точки — это и метод класса, и глобальный
    вызов, различить их без полного анализа типов нельзя.
    """
    names: Set[str] = set()
    pattern = re.compile(r"^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)")
    for path in files:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                m = pattern.match(line)
                if m:
                    names.add(m.group(1))
    return names


EXTENDS_RE = re.compile(r"^\s*extends\s+([A-Za-z_][A-Za-z0-9_]*)")
SIGNAL_DECL_RE = re.compile(r"^\s*signal\s+([A-Za-z_][A-Za-z0-9_]*)")
FUNC_DECL_RE = re.compile(r"^\s*(?:static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)")
# Список параметров функции: `func f(a: int, b := 2) -> void:`
FUNC_PARAMS_RE = re.compile(r"func\s+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)")
# Локальные объявления: `var name := ...` / `var name: int = ...`
LOCAL_VAR_RE = re.compile(r"^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)")
CLASS_NAME_RE = re.compile(r"^\s*class_name\s+([A-Za-z0-9_]+)")
INNER_CLASS_RE = re.compile(r"^\s*class\s+([A-Za-z0-9_]+)")


def detect_base_class(lines: List[str]) -> str:
    """Базовый класс скрипта по строке `extends X`.

    В GDScript без `extends` скрипт наследуется от RefCounted.
    Знание базового класса позволяет точно определить, какие методы
    доступны «без точки» (через self), и не плодить ложные срабатывания.
    """
    for raw in lines:
        m = EXTENDS_RE.match(raw)
        if m:
            return m.group(1)
        if raw.strip().startswith("func ") or raw.strip().startswith("var "):
            break
    return "RefCounted"


def _collect_locals(raw_lines: List[str]) -> Set[str]:
    """Локальные var'ы, параметры функций и имена `for x in ...`.

    Всё это легитимные идентификаторы, которых нет в API движка. Точное
    разрешение области видимости здесь не нужно: цель проверки — ловить
    опечатки в вызовах (`sqrtff`, `get_world_3d` не в том классе), а не
    дублировать анализатор типов GDScript.
    """
    names: Set[str] = set()
    for raw in raw_lines:
        m = LOCAL_VAR_RE.match(raw)
        if m:
            names.add(m.group(1))
        m = re.match(r"\s*for\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*\w+)?\s+in\b", raw)
        if m:
            names.add(m.group(1))
        m = FUNC_PARAMS_RE.search(raw)
        if m:
            for chunk in m.group(1).split(","):
                token = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)", chunk)
                if token:
                    names.add(token.group(1))
    return names


def check_file(path: str, api: GodotApi, known_locals: Set[str],
               project_functions: Set[str],
               autoload_names: Set[str],
               project_classes: Optional[Dict[str, Dict[str, object]]] = None
               ) -> List[Issue]:
    """Проверяет один файл.

    ВАЖНО: анализ идёт по ВСЕМУ файлу, а не построчно. gdformat переносит
    цепочки вызовов на новую строку (`_break_queue\n    .append(...)`),
    и построчная проверка видит `append(` как «голый» глобальный вызов.
    Поэтому сначала строим карту «смещение -> номер строки», а признак
    «перед именем точка» ищем с перескоком через переводы строк.
    """
    issues: List[Issue] = []
    with open(path, "r", encoding="utf-8") as fh:
        raw_lines = fh.read().split("\n")

    base_class = detect_base_class(raw_lines)
    # Цепочка наследования разворачивается целиком: базовым классом может
    # быть скрипт проекта, а уже он наследуется от класса движка.
    bare_allowed: Set[str] = resolve_chain_members(
        api, base_class, project_classes if project_classes is not None else {}
    )
    bare_allowed |= api.utility_functions
    bare_allowed |= _GDSCRIPT_BUILTINS
    bare_allowed |= project_functions
    bare_allowed |= autoload_names
    # `new()` в extension_api.json не описан, но есть у любого класса.
    bare_allowed.add("new")

    # Имена, объявленные в этом файле: class_name, внутренние классы,
    # сигналы, константы и переменные. В API движка их, естественно, нет.
    locals_here: Set[str] = set(known_locals)
    locals_here.add(base_class)
    for raw in raw_lines:
        for pattern in (CLASS_NAME_RE, INNER_CLASS_RE, SIGNAL_DECL_RE):
            m = pattern.match(raw)
            if m:
                locals_here.add(m.group(1))
        m = re.match(r"\s*(?:const|var|@onready\s+var|@export\s+var)\s+"
                     r"([A-Za-z_][A-Za-z0-9_]*)", raw)
        if m:
            locals_here.add(m.group(1))

    # Локальные переменные и параметры функций. Без них проверка «голых»
    # вызовов спотыкается о переносы gdformat: `away = impact_normal` +
    # следующая строка, начинающаяся с `(`, выглядит как вызов
    # `impact_normal()`.
    locals_here |= _collect_locals(raw_lines)

    # --- собираем «код без строк и комментариев» + карту строк -------------
    code_chunks: List[str] = []
    line_starts: List[int] = [0]
    skip_line: List[bool] = []
    in_docstring = False
    for raw in raw_lines:
        stripped = raw.strip()
        is_decl = stripped.startswith("signal ") or stripped.startswith("@")
        if stripped.startswith('"""'):
            in_docstring = not in_docstring
            skip_line.append(True)
        elif in_docstring or is_decl:
            skip_line.append(True)
        else:
            skip_line.append(False)
        code_chunks.append("" if skip_line[-1] else strip_comments_and_strings(raw))
        code_chunks.append("\n")
        line_starts.append(line_starts[-1] + len(code_chunks[-2]) + 1)
    code_all = "".join(code_chunks)

    def line_of(offset: int) -> int:
        lo, hi = 0, len(line_starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1

    def preceded_by_dot(offset: int) -> bool:
        j = offset - 1
        while j >= 0 and code_all[j] in " \t\n\r":
            j -= 1
        return j >= 0 and code_all[j] == "."

    # --- Class.member ------------------------------------------------------
    for m in QUALIFIED_RE.finditer(code_all):
        cls, member = m.group(1), m.group(2)
        # Класс проекта проверяется ПЕРЕД отсечением по locals_here.
        # В LOCAL_NAMES перечислены автозагрузки и собственные классы
        # проекта, и раньше они попадали в locals_here и пропускались —
        # то есть не проверялись именно те обращения, которые важнее всего.
        # Внутренние классы и локальные class_name в индекс проекта не
        # попадают, поэтому для них ниже срабатывает прежнее отсечение.
        if not api.knows_class(cls) and cls not in api.builtin_classes:
            project_members = project_chain_members(api, cls, project_classes or {})
            if project_members is not None:
                if member != "new" and member not in project_members:
                    issues.append(Issue(
                        path, line_of(m.start()), "unknown-project-member",
                        "%s.%s не объявлен ни в %s, ни в его базовых классах"
                        % (cls, member, cls),
                    ))
                continue
        if cls in locals_here:
            continue
        if cls in api.builtin_classes and not api.knows_class(cls):
            # Встроенные типы (Vector3, String…) описаны отдельным блоком,
            # их методы в extension_api.json не перечислены — не проверяем.
            continue
        if not api.knows_class(cls):
            # Не класс движка и не класс проекта: внутренний класс,
            # перечисление или имя, которое ловит другая проверка.
            continue
        allowed = api.members(cls) | api.enum_type_names(cls)
        allowed.add("new")
        if member not in allowed:
            issues.append(Issue(
                path, line_of(m.start()), "unknown-member",
                "%s.%s не существует в %s" % (cls, member, api.version),
            ))

    # --- «голые» вызовы ----------------------------------------------------
    # Ловим опечатки в глобальных вызовах: `sqrtff(...)`, `get_world_3d()`
    # в классе, унаследованном не от Node3D, и т.п.
    for m in CALL_RE.finditer(code_all):
        fn = m.group(1)
        if preceded_by_dot(m.start()):
            continue
        if fn in bare_allowed or fn in locals_here:
            continue
        issues.append(Issue(
            path, line_of(m.start()), "unknown-global-call",
            "вызов '%s()' не является ни utility-функцией Godot, ни методом "
            "базового класса %s, ни функцией проекта" % (fn, base_class),
        ))

    # --- ключи ProjectSettings ---------------------------------------------
    # Ищем по ИСХОДНЫМ строкам: strip_comments_and_strings() вырезает
    # содержимое строковых литералов, а ключ настройки — как раз литерал.
    for lineno, raw in enumerate(raw_lines, start=1):
        if skip_line[lineno - 1]:
            continue
        for m in PSETTINGS_RE.finditer(raw):
            key = m.group(1)
            if not is_standard_setting(key):
                issues.append(Issue(
                    path, lineno, "unknown-project-setting",
                    "ключ '%s' не относится к стандартным разделам Godot и не "
                    "в белом списке KNOWN_PROJECT_SETTINGS" % key,
                    severity="warning",
                ))
    return issues


# Встроенные функции/ключевые слова GDScript, которых нет в extension_api.json.
_GDSCRIPT_BUILTINS: Set[str] = {
    "if", "elif", "else", "for", "while", "match", "func", "return", "await",
    "assert", "breakpoint", "pass", "break", "continue", "class", "class_name",
    "extends", "signal", "enum", "const", "var", "static", "super", "self",
    "print", "print_rich", "printerr", "printrich", "prints", "push_error",
    "push_warning", "range", "len", "str", "int", "float", "bool", "Array",
    "Dictionary", "Vector2", "Vector3", "Vector4", "Vector2i", "Vector3i",
    "Color", "String", "StringName", "NodePath", "Transform2D", "Transform3D",
    "Basis", "Quaternion", "Rect2", "Rect2i", "AABB", "Plane", "PackedScene",
    "load", "preload", "is_instance_valid", "type", "typeof", "weakref", "hash",
    "inst_to_dict", "dict_to_inst", "get_stack", "print_stack", "randf",
    "randi", "randfn", "randf_range", "randi_range", "seed", "randomize",
    "abs", "min", "max", "sign", "pow", "sqrt", "lerp", "doplerp",
    "preload_resource", "emit_signal", "connect", "disconnect", "is_connected",
    "not", "and", "or", "in", "is", "as", "new", "await_signal",
    "true", "false", "null", "PI", "TAU", "INF", "NAN", "self", "super",
    "get_node", "get_node_or_null", "has_node", "add_child", "remove_child",
    "queue_free", "free", "duplicate", "get_tree", "get_viewport", "get_meta",
    "set_meta", "has_meta", "get_class", "is_class", "set", "get",
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--api", default=DEFAULT_API,
                        help="путь к extension_api.json")
    parser.add_argument("paths", nargs="*", help="файлы/каталоги (по умолчанию game/)")
    parser.add_argument("--strict", action="store_true",
                        help="считать предупреждения ошибкой")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--addons", default=os.path.join(GAME_ROOT, "addons"),
                        help="каталог аддонов: их class_name индексируются "
                             "как базовые классы (нужно для тестов GUT)")
    parser.add_argument("--no-addons", action="store_true",
                        help="не индексировать аддоны")
    args = parser.parse_args()

    if not os.path.isfile(args.api):
        print("НЕТ ФАЙЛА API: %s" % args.api, file=sys.stderr)
        print("Сначала выполните: bash tools/setup/setup.sh", file=sys.stderr)
        return 2

    api = GodotApi(args.api)
    if not args.no_addons:
        addon_count = api.load_addon_classes(args.addons)
        if not args.quiet:
            print("Индекс аддонов: %d class_name из %s" % (addon_count, args.addons))
    targets: Iterable[str] = args.paths or [GAME_ROOT]
    files: List[str] = []
    for target in targets:
        full = target if os.path.isabs(target) else os.path.join(REPO_ROOT, target)
        if os.path.isdir(full):
            files.extend(find_gd_files(full))
        elif os.path.isfile(full):
            files.append(full)

    project_functions = collect_project_functions(files)
    project_classes = collect_project_classes(files)
    all_issues: List[Issue] = []
    for path in files:
        all_issues.extend(
            check_file(path, api, LOCAL_NAMES, project_functions, set(LOCAL_NAMES),
                       project_classes)
        )

    errors = [i for i in all_issues if i.severity == "error"]
    warnings = [i for i in all_issues if i.severity != "error"]

    if not args.quiet:
        print("Godot API check против %s" % api.version)
        print("  классов в API: %d, синглтонов: %d, utility-функций: %d"
              % (len(api.classes), len(api.singletons), len(api.utility_functions)))
        print("  проверено файлов: %d" % len(files))

    for issue in errors + warnings:
        print("  " + issue.render(REPO_ROOT))

    if errors:
        print("\nОШИБОК: %d" % len(errors))
        return 1
    if warnings and args.strict:
        print("\nПРЕДУПРЕЖДЕНИЙ (strict): %d" % len(warnings))
        return 1
    if not args.quiet:
        print("\nOK: неизвестных обращений к API не найдено "
              "(предупреждений: %d)" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

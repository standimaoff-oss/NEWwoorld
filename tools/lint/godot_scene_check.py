#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Структурный валидатор текстовых ресурсов Godot (.tscn / .tres / .godot).

ЗАЧЕМ. .tscn — это сериализованный граф узлов. Godot при малейшей
несостыковке (несуществующий id ресурса, отсутствующий файл, неверный
load_steps) либо молча теряет узлы, либо отказывается открывать сцену с
непонятной ошибкой. Оба исхода дорого искать руками. Этот скрипт ловит
их ДО запуска движка.

Проверяет:
  1. Заголовок: [gd_scene ...] / [gd_resource ...] / config_version для .godot
  2. load_steps совпадает с числом ext_resource + sub_resource + 1
  3. Каждый ExtResource("id") и SubResource("id") имеет определение
  4. Каждый ext_resource path физически существует (res:// -> game/)
  5. Каждый .gd, на который ссылается сцена, существует
  6. parent="..." у [node] разрешается в существующий узел
  7. [connection] ссылается на существующие узлы
  8. id ресурсов уникальны
  9. Секции не дублируются бессмысленно

НЕ проверяет (и не врёт об этом):
  * корректность значений свойств (тип Vector3, диапазон и т.п.) —
    это делает движок;
  * существование свойств у классов — для GDScript есть godot_api_check.py.

Запуск:
    python3 tools/lint/godot_scene_check.py            # все сцены/ресурсы
    python3 tools/lint/godot_scene_check.py game/scenes/menu/main_menu.tscn
    python3 tools/lint/godot_scene_check.py --strict   # warnings -> errors
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional, Set, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GAME_ROOT = os.path.join(REPO_ROOT, "game")

SECTION_RE = re.compile(r"^\[([a-z_]+)(?:\s+(.*))?\]\s*$")
ATTR_RE = re.compile(r'(\w+)=(?:"([^"]*)"|([^ \]]+))')
EXT_REF_RE = re.compile(r'ExtResource\(\s*"([^"]+)"\s*\)')
SUB_REF_RE = re.compile(r'SubResource\(\s*"([^"]+)"\s*\)')
NODE_PATH_REF_RE = re.compile(r'NodePath\(\s*"([^"]+)"\s*\)')


class Section:
    def __init__(self, kind: str, attrs: Dict[str, str], line: int,
                 body: List[str]) -> None:
        self.kind = kind
        self.attrs = attrs
        self.line = line
        self.body = body

    def attr(self, name: str, default: str = "") -> str:
        return self.attrs.get(name, default)


class Report:
    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def error(self, path: str, line: int, msg: str) -> None:
        self.errors.append("%s:%d: [ERROR] %s" % (rel(path), line, msg))

    def warn(self, path: str, line: int, msg: str) -> None:
        self.warnings.append("%s:%d: [WARN] %s" % (rel(path), line, msg))

    def info(self, msg: str) -> None:
        print("  " + msg)


def rel(path: str) -> str:
    return os.path.relpath(path, REPO_ROOT)


def res_to_disk(res_path: str) -> str:
    """res://scenes/x.tscn -> /abs/game/scenes/x.tscn"""
    if res_path.startswith("res://"):
        return os.path.join(GAME_ROOT, res_path[len("res://"):])
    if res_path.startswith("user://"):
        return ""  # пользовательские файлы проверяются в рантайме
    return ""


def parse_sections(text: str) -> List[Section]:
    sections: List[Section] = []
    current: Optional[Section] = None
    for lineno, raw in enumerate(text.split("\n"), start=1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith(";"):
            if current is not None:
                current.body.append(line)
            continue
        m = SECTION_RE.match(line)
        if m:
            attrs = {}
            for am in ATTR_RE.finditer(m.group(2) or ""):
                attrs[am.group(1)] = am.group(2) if am.group(2) is not None else am.group(3)
            current = Section(m.group(1), attrs, lineno, [])
            sections.append(current)
            continue
        if current is not None:
            current.body.append(line)
    return sections


# ---------------------------------------------------------------------------
#  Проверка имён свойств по API движка
#
#  ЗАЧЕМ. Godot МОЛЧА игнорирует неизвестное свойство в .tres/.tscn: файл
#  загружается, игра работает, а параметр просто не применяется. Найти это
#  по поведению почти невозможно — симптом выглядит как «настройка не
#  действует», а причина в опечатке или в значении, относящемся к другому
#  перечислению.
#
#  Реальный случай из этого проекта (military_env.tres):
#    radiance_size = 4           означало 512, хотя комментарий обещал 256
#    reflected_light_source = 1  означало DISABLED вместо SKY — отражения
#                                отключились бы полностью
#    tonemap_mode = 3            это ACES, а не FILMIC (= 2)
#  Все три значения движок принял без единого предупреждения.
#
#  Что эта проверка НЕ делает: не сверяет ЗНАЧЕНИЯ перечислений. Число 4 в
#  radiance_size — допустимое значение свойства, и отличить «4 вместо 3»
#  можно только зная намерение автора. Поэтому значения проверяются вручную
#  по extension_api.json, а имена — автоматически.
# ---------------------------------------------------------------------------

API_JSON = os.path.join(
    REPO_ROOT, "gdextension", "godot-cpp", "gdextension", "extension_api.json")

# Структурные ключи секций — это не свойства классов.
STRUCTURAL_KEYS: Set[str] = {
    "name", "type", "parent", "instance", "owner", "index", "id", "path",
    "format", "load_steps", "groups", "unique_name_in_owner", "editable",
    "uid", "bindable", "signal", "method", "from", "to", "flags",
}

_API_CACHE: Optional[Dict[str, Set[str]]] = None


def load_api_properties() -> Optional[Dict[str, Set[str]]]:
    """Класс -> множество допустимых имён свойств, включая унаследованные."""
    global _API_CACHE
    if _API_CACHE is not None:
        return _API_CACHE
    if not os.path.isfile(API_JSON):
        # Нет подмодуля godot-cpp — сверять не с чем. Это не ошибка сцены,
        # поэтому возвращаем None и пропускаем проверку, а не падаем.
        return None
    try:
        with open(API_JSON, "r", encoding="utf-8") as fh:
            api = json.load(fh)
    except (OSError, ValueError):
        return None

    own: Dict[str, Set[str]] = {}
    inherits: Dict[str, str] = {}
    for cls in api.get("classes", []):
        name = cls.get("name", "")
        if not name:
            continue
        own[name] = {prop.get("name", "") for prop in cls.get("properties", [])}
        # Родительское поле — inherits, НЕ super. Это частая ошибка при
        # ручном чтении extension_api.json.
        parent = cls.get("inherits", "")
        if parent and parent != name:
            inherits[name] = parent

    # Разворачиваем цепочку наследования. Без этого cast_shadow у
    # MeshInstance3D (объявлено в GeometryInstance3D) выглядело бы
    # неизвестным свойством.
    resolved: Dict[str, Set[str]] = {}
    for name in own:
        collected: Set[str] = set()
        current = name
        guard = 0
        while current and guard < 32:
            guard += 1
            collected |= own.get(current, set())
            current = inherits.get(current, "")
        resolved[name] = collected

    _API_CACHE = resolved
    return resolved


def section_class(section: Section, header_type: str = "") -> str:
    """Тип класса, к которому относятся свойства секции.

    header_type нужен для секции [resource] в .tres: у неё НЕТ атрибута
    type, тип объявлен в заголовке [gd_resource type="Environment"].
    Без передачи заголовка такая секция пропускалась целиком, и проверка
    молча не работала ровно для того файла, ради которого её добавили.
    """
    if section.kind == "resource":
        return section.attr("type") or header_type
    if section.kind in ("sub_resource", "node", "ext_resource"):
        return section.attr("type")
    return ""


def section_has_script(section: Section) -> bool:
    """Назначен ли секции скрипт."""
    for line in section.body:
        stripped = line.strip()
        if stripped.startswith("script =") or stripped.startswith("script="):
            return True
    return False


# Виртуальные префиксы свойств. Это НЕ имена свойств класса, а способ,
# которым Godot сериализует динамические данные: uniform-переменные шейдера
# и переопределения темы. Их нет в extension_api.json, и требовать их там
# нельзя — но и пропускать целиком все ключи со слэшем нельзя, иначе
# опечатка в настоящем свойстве вида «rendering/…» проскочит.
VIRTUAL_PREFIXES: Tuple[str, ...] = (
    "shader_parameter/",
    "theme_override_colors/",
    "theme_override_constants/",
    "theme_override_fonts/",
    "theme_override_font_sizes/",
    "theme_override_icons/",
    "theme_override_styles/",
    "metadata/",
    "node_paths/",
)

PROPERTY_ASSIGN_RE = re.compile(r"^([a-zA-Z_][\w/]*)\s*=")


def is_virtual_property(key: str) -> bool:
    """Относится ли ключ к виртуальным префиксам движка."""
    return key.startswith(VIRTUAL_PREFIXES)


# Сериализация массивов в Godot: «bus/0/name», «bus/1/volume_db». Первый
# сегмент — имя массива, второй — индекс, дальше — поле элемента. Индекс
# всегда числовой, и это отличает массив от виртуального префикса.
ARRAY_PROPERTY_RE = re.compile(r"^[\w]+/\d+(/|$)")


def is_array_property(key: str) -> bool:
    """Является ли ключ элементом сериализованного массива."""
    return bool(ARRAY_PROPERTY_RE.match(key))


def check_section_properties(
    path: str, section: Section, report: Report, header_type: str = ""
) -> None:
    """Сверяет имена свойств секции с API движка."""
    api = load_api_properties()
    if not api:
        return
    cls = section_class(section, header_type)
    if not cls or cls not in api:
        # Неизвестный класс: ресурс с пользовательским скриптом или тип из
        # дополнения. Сверять не с чем — это не ошибка.
        return
    if section_has_script(section):
        # У секции со скриптом бывают @export-переменные, которых нет в API
        # движка. Строгая проверка дала бы десятки ложных срабатываний,
        # поэтому такие секции пропускаются целиком.
        return
    allowed = api[cls]
    if not allowed:
        # У класса нет ни одного объявленного свойства (например,
        # AudioBusLayout: его данные сериализуются как массив, а не как
        # свойства). Сверять не с чем — пропускаем, а не объявляем всё
        # неизвестным.
        return
    for offset, line in enumerate(section.body):
        stripped = line.strip()
        if not stripped or stripped.startswith(";"):
            continue
        match = PROPERTY_ASSIGN_RE.match(stripped)
        if not match:
            continue
        key = match.group(1)
        base_key = key.split("/")[0]
        if key in STRUCTURAL_KEYS or base_key in STRUCTURAL_KEYS:
            continue
        # Виртуальные префиксы и служебные ключи редактора (_edit_lock,
        # _edit_description_) свойствами класса не являются.
        if is_virtual_property(key) or key.startswith("_"):
            continue
        # Элементы сериализованного массива: «bus/0/name». Имя массива
        # («bus») в extension_api.json не объявлено, поэтому сверять его
        # не с чем — а отбрасывать по этому признаку можно безопасно:
        # числовой второй сегмент не встречается у обычных свойств.
        if is_array_property(key):
            continue
        if key not in allowed and base_key not in allowed:
            report.error(
                path, section.line + offset + 1,
                "%s: у класса %s нет свойства «%s» — движок молча его "
                "проигнорирует" % (os.path.basename(path), cls, key))


def check_scene(path: str, report: Report) -> None:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    sections = parse_sections(text)
    if not sections:
        report.error(path, 1, "файл пуст или не содержит секций")
        return

    header = sections[0]
    ext = os.path.splitext(path)[1]

    if ext == ".tscn" and header.kind != "gd_scene":
        report.error(path, header.line, "ожидался [gd_scene], найден [%s]" % header.kind)
        return
    if ext == ".tres" and header.kind != "gd_resource":
        report.error(path, header.line, "ожидался [gd_resource], найден [%s]" % header.kind)
        return

    fmt = header.attr("format")
    if fmt != "3":
        report.error(path, header.line,
                     "format=%s, для Godot 4 требуется format=3" % (fmt or "отсутствует"))

    # Имена свойств сверяются с API движка для КАЖДОЙ секции, а не только
    # для заголовка: неизвестное свойство движок игнорирует молча.
    header_type = header.attr("type")
    for section in sections:
        check_section_properties(path, section, report, header_type)

    ext_resources: Dict[str, Section] = {}
    sub_resources: Dict[str, Section] = {}
    nodes: List[Section] = []
    connections: List[Section] = []
    editable: List[Section] = []

    for sec in sections[1:]:
        if sec.kind == "ext_resource":
            rid = sec.attr("id")
            if not rid:
                report.error(path, sec.line, "ext_resource без id")
                continue
            if rid in ext_resources:
                report.error(path, sec.line, "дублирующийся id ext_resource '%s'" % rid)
            ext_resources[rid] = sec
        elif sec.kind == "sub_resource":
            rid = sec.attr("id")
            if not rid:
                report.error(path, sec.line, "sub_resource без id")
                continue
            if rid in sub_resources:
                report.error(path, sec.line, "дублирующийся id sub_resource '%s'" % rid)
            sub_resources[rid] = sec
        elif sec.kind == "node":
            nodes.append(sec)
        elif sec.kind == "connection":
            connections.append(sec)
        elif sec.kind in ("editable", "group", "resource"):
            editable.append(sec)
        elif sec.kind in ("gd_scene", "gd_resource"):
            report.error(path, sec.line, "повторный заголовок [%s]" % sec.kind)
        else:
            report.warn(path, sec.line, "неизвестная секция [%s]" % sec.kind)

    # --- load_steps --------------------------------------------------------
    # Семантика Godot: load_steps = ext_resource + sub_resource + 1, и атрибут
    # ОТСУТСТВУЕТ, когда ресурсов нет вовсе. Это нормальный файл, а не брак:
    # так ResourceSaver/SceneSaver пишут .tres с одним [resource] и .tscn
    # с одним узлом. Требовать load_steps в этом случае — значит валить
    # проверку на корректных файлах, и её начинают игнорировать.
    load_steps_raw = header.attr("load_steps")
    expected_steps = len(ext_resources) + len(sub_resources) + 1
    if load_steps_raw:
        try:
            declared = int(load_steps_raw)
            if declared != expected_steps:
                report.error(
                    path, header.line,
                    "load_steps=%d, но ресурсов %d + 1 = %d"
                    % (declared, len(ext_resources) + len(sub_resources), expected_steps),
                )
        except ValueError:
            report.error(path, header.line, "load_steps не число: %s" % load_steps_raw)
    elif expected_steps > 1:
        # Ресурсы есть, а счётчика нет — движок может оборвать загрузку.
        report.warn(path, header.line,
                    "есть ресурсы (%d ext + %d sub), но нет load_steps"
                    % (len(ext_resources), len(sub_resources)))

    # --- существование ext_resource на диске -------------------------------
    for rid, sec in ext_resources.items():
        rpath = sec.attr("path")
        if not rpath:
            report.error(path, sec.line, "ext_resource '%s' без path" % rid)
            continue
        disk = res_to_disk(rpath)
        if not disk:
            continue
        if not os.path.isfile(disk):
            report.error(path, sec.line,
                         "ext_resource '%s' -> ФАЙЛ НЕ СУЩЕСТВУЕТ: %s" % (rid, rpath))
        rtype = sec.attr("type")
        if rtype == "Script" and not rpath.endswith(".gd"):
            report.warn(path, sec.line,
                        "type=Script, но файл не .gd: %s" % rpath)

    # --- ссылки на ресурсы в телах секций ----------------------------------
    body_text = "\n".join("\n".join(sec.body) for sec in sections)
    for m in EXT_REF_RE.finditer(body_text):
        rid = m.group(1)
        if rid not in ext_resources:
            line = _line_of(text, m.start() + sum(
                len("\n".join(s.body)) + 1 for s in sections[:0]))
            report.error(path, line or 1,
                         "ExtResource(\"%s\") не определён в файле" % rid)
    for m in SUB_REF_RE.finditer(body_text):
        rid = m.group(1)
        if rid not in sub_resources:
            report.error(path, 1, "SubResource(\"%s\") не определён в файле" % rid)

    # --- дерево узлов -------------------------------------------------------
    if ext == ".tscn":
        if not nodes:
            report.error(path, 1, "в сцене нет ни одного [node]")
        node_paths: Set[str] = set()
        root_seen = False
        for sec in nodes:
            name = sec.attr("name")
            parent = sec.attr("parent")
            if not name:
                report.error(path, sec.line, "[node] без name")
                continue
            if parent == "" and "." not in sec.attrs:
                # Корневой узел: в Godot 4 у него атрибут parent ОТСУТСТВУЕТ.
                if root_seen:
                    report.error(path, sec.line,
                                 "второй корневой узел '%s' (root может быть один)" % name)
                root_seen = True
                node_paths.add(name)
                continue
            if parent == ".":
                node_paths.add(name)
                continue
            if not parent:
                continue
            # parent="Path/To/Parent" — родитель должен существовать.
            if parent not in node_paths:
                report.error(path, sec.line,
                             "узел '%s' ссылается на несуществующего родителя '%s'"
                             % (name, parent))
                continue
            node_paths.add(parent + "/" + name)
        if not root_seen:
            report.error(path, 1, "не найден корневой узел (без атрибута parent)")

        # --- connection -----------------------------------------------------
        for sec in connections:
            frm = sec.attr("from")
            to = sec.attr("to")
            sig = sec.attr("signal")
            method = sec.attr("method")
            if not sig or not method:
                report.error(path, sec.line,
                             "[connection] без signal или method")
            for ref, label in ((frm, "from"), (to, "to")):
                if not ref:
                    continue
                if ref == ".":
                    continue
                if ref not in node_paths:
                    report.warn(path, sec.line,
                                "[connection] %s='%s' не найден среди узлов" % (label, ref))

    # --- .tres: секция [resource] обязательна ------------------------------
    if ext == ".tres":
        kinds = [s.kind for s in sections[1:]]
        if "resource" not in kinds:
            report.error(path, 1, "в .tres нет секции [resource]")


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def find_files(roots: List[str]) -> List[str]:
    found: List[str] = []
    for root in roots:
        full = root if os.path.isabs(root) else os.path.join(REPO_ROOT, root)
        if os.path.isfile(full):
            found.append(full)
            continue
        for dirpath, dirnames, filenames in os.walk(full):
            # addons/ исключён: это вендоренный GUT, его .tscn написаны
            # самим автором плагина и нашим конвенциям не подчиняются.
            dirnames[:] = [d for d in dirnames if d not in
                           {".git", ".godot", "node_modules", ".venv", "addons"}]
            for name in filenames:
                if name.endswith((".tscn", ".tres")):
                    found.append(os.path.join(dirpath, name))
    return sorted(set(found))


def check_project_godot(report: Report) -> None:
    """Отдельно проверяем project.godot: пути автозагрузок и главной сцены."""
    path = os.path.join(GAME_ROOT, "project.godot")
    if not os.path.isfile(path):
        report.error(path, 1, "project.godot отсутствует")
        return
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    if "config_version=5" not in text:
        report.error(path, 1, "нет config_version=5 (требуется Godot 4)")

    res_path_re = re.compile(r'"?\*?(res://[^"]+?)"')
    for lineno, line in enumerate(text.split("\n"), start=1):
        stripped = line.strip()
        if stripped.startswith(";") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0]
        # Проверяем только те ключи, где путь обязан существовать.
        path_keys = ("main_scene", "config/icon", "default_environment")
        is_autoload = lineno > 0 and stripped.startswith(tuple(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ")) and '="*res://' in stripped
        if not (any(k in key for k in path_keys) or is_autoload):
            continue
        for m in res_path_re.finditer(stripped.split("=", 1)[1]):
            rpath = m.group(1)
            disk = res_to_disk(rpath)
            if disk and not os.path.isfile(disk):
                report.error(path, lineno,
                             "%s -> ФАЙЛ НЕ СУЩЕСТВУЕТ: %s" % (key.strip(), rpath))


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="файлы/каталоги (по умолчанию game/)")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    report = Report()
    files = find_files(args.paths or [GAME_ROOT])
    for path in files:
        check_scene(path, report)
    check_project_godot(report)

    if not args.quiet:
        print("Godot scene/resource check: %d файлов" % len(files))
    for line in report.errors + report.warnings:
        print("  " + line)

    if report.errors:
        print("\nОШИБОК: %d, предупреждений: %d" % (len(report.errors), len(report.warnings)))
        return 1
    if report.warnings and args.strict:
        print("\nПРЕДУПРЕЖДЕНИЙ (strict): %d" % len(report.warnings))
        return 1
    if not args.quiet:
        print("\nOK: сцены и ресурсы структурно корректны (предупреждений: %d)"
              % len(report.warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

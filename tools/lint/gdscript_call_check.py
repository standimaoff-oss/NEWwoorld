#!/usr/bin/env python3
"""
gdscript_call_check.py — проверка ВЫЗОВОВ в GDScript: число и типы аргументов.

ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ ИНСТРУМЕНТ
------------------------------
godot_api_check.py отвечает на вопрос «существует ли такой метод/свойство».
Он НЕ отвечает на вопрос «правильно ли метод вызван». Разница принципиальна:

    AudioService.play_sfx(break_sound, global_position)

Метод play_sfx существует, проверка проходит. Но сигнатура у него
play_sfx(stream, volume_db: float, pitch_scale: float, priority) — то есть
Vector3 уходит в параметр volume_db. Godot упадёт на этом в рантайме, и
упадёт ровно в тот момент, когда впервые сломается стена: то есть у игрока,
а не у разработчика. В песочнице без Godot такую ошибку не увидеть больше
никем, кроме статического анализа.

ЧТО ПРОВЕРЯЕТСЯ
---------------
1. Арность. Число аргументов в вызове должно попадать в
   [обязательные параметры, все параметры]. Учитываются значения по
   умолчанию и многострочные сигнатуры (gdformat их переносит).
2. Типы аргументов, когда тип ВЫВОДИТСЯ ОДНОЗНАЧНО:
     * литералы (1, 1.5, "текст", true, Vector3(...), Color(...)),
     * объявленные типы локальных и членов класса (var x: Camera3D),
     * свойства движка у self (в Node3D global_position: Vector3),
     * параметры самой функции.
   Несовместимость — ошибка. Совместимое расширение (int -> float) — нет.
3. Несуществующий метод у известного получателя.

ЧТО СОЗНАТЕЛЬНО НЕ ПРОВЕРЯЕТСЯ
------------------------------
* Типы, которые нельзя вывести (результаты вызовов, элементы массивов,
  Variant). Молчим, а не гадаем: ложные срабатывания убивают доверие
  к проверке быстрее, чем она приносит пользы.
* Утилитарные функции с varargs (print, push_error, ...) — пропущены.
* Динамические вызовы call()/call_deferred() — по строке не проверить.

ИСПОЛЬЗОВАНИЕ
-------------
    python3 tools/lint/gdscript_call_check.py            # весь проект
    python3 tools/lint/gdscript_call_check.py --strict   # warning = ошибка
    python3 tools/lint/gdscript_call_check.py file.gd    # конкретные файлы
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional, Set, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_API = os.path.join(
    REPO_ROOT, "gdextension", "godot-cpp", "gdextension", "extension_api.json")
DEFAULT_GAME = os.path.join(REPO_ROOT, "game")
DEFAULT_PROJECT_GODOT = os.path.join(DEFAULT_GAME, "project.godot")

# Методы движка с переменным числом аргументов. В extension_api.json они
# выглядят обычными, но арность у них не фиксирована.
VARARGS_METHODS: Set[str] = {
    "print", "print_rich", "print_verbose", "print_debug", "print_or_rich",
    "push_error", "push_warning", "str", "var_to_str", "type_string",
    "emit_signal", "call", "call_deferred", "callv", "call_multilevel",
    "set", "get", "set_deferred", "get_indexed", "set_indexed",
    "connect", "disconnect", "is_connected",
    "bind", "unbind", "rpc", "rpc_id",
    "max", "min", "maxf", "minf", "absf", "sign", "wrap", "wrapf",
    "lerp", "lerpf", "clamp", "clampf", "clampi",
    "tween_property", "tween_method", "tween_callback",
}

# Методы, которые объявлены в Object и переопределяются где угодно.
# Их арность неинформативна, а ложных срабатываний они дают много.
SKIP_METHODS: Set[str] = {"_init", "_ready", "_process", "_physics_process",
                          "_input", "_unhandled_input", "_exit_tree", "_notification",
                          "_get_property_list", "_set", "_get", "_to_string"}

# Типы-контейнеры: элемент может быть чем угодно, проверять бессмысленно.
# Типы, о совместимости которых нельзя судить по имени. Object сюда НЕ
# входит: это настоящий класс с наследованием, и любая нода ему совместима.
OPAQUE_TYPES: Set[str] = {"Variant", "Array", "Dictionary", "Callable", "Signal",
                          "StringName", "NodePath", "RID"}

# Числовая башня GDScript: int неявно расширяется до float.
# Неявные расширения, которые GDScript выполняет сам:
#   int  -> float  (1 в параметр float)
#   bool -> int    (duplicate(true) — канонический вызов глубокого копирования)
NUMERIC_COMPATIBLE: Set[Tuple[str, str]] = {("int", "float"), ("bool", "int")}

CONSTRUCTOR_TYPES: Dict[str, str] = {
    "Vector2": "Vector2", "Vector2i": "Vector2i", "Vector3": "Vector3",
    "Vector3i": "Vector3i", "Vector4": "Vector4", "Color": "Color",
    "Rect2": "Rect2", "Rect2i": "Rect2i", "Transform2D": "Transform2D",
    "Transform3D": "Transform3D", "Basis": "Basis", "Quaternion": "Quaternion",
    "Plane": "Plane", "AABB": "AABB", "Projection": "Projection",
    "Array": "Array", "Dictionary": "Dictionary", "String": "String",
    "PackedByteArray": "PackedByteArray", "PackedInt32Array": "PackedInt32Array",
    "PackedInt64Array": "PackedInt64Array", "PackedFloat32Array": "PackedFloat32Array",
    "PackedFloat64Array": "PackedFloat64Array", "PackedStringArray": "PackedStringArray",
    "PackedVector2Array": "PackedVector2Array", "PackedVector3Array": "PackedVector3Array",
    "PackedColorArray": "PackedColorArray", "PackedByteArray": "PackedByteArray",
}


# ============================================================== токенизация ==

class Scanner:
    """Обход исходника с учётом строк и комментариев.

    Без этого подсчёт запятых ломается на первом же тексте с запятой внутри
    («Загрузка, подготовка…») или на комментарии с несбалансированной
    скобкой. Длины и переносы строк сохраняются, поэтому номер строки
    вычисляется простым делением смещения.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.length = len(text)

    def code_mask(self) -> bytearray:
        """Одним проходом помечает, какие позиции относятся к КОДУ.

        Маска, а не проверка позиции по запросу: во-первых, это O(n) вместо
        O(n^2) на файле, во-вторых, состояние можно напечатать и отладить.

        Порядок правил важен. Комментарий начинается с «#» только ВНЕ строки;
        строка начинается с кавычки только ВНЕ комментария. Если перепутать,
        русская документация с кавычками («в группе &"destructible"») ломает
        разбор на весь остаток файла — и проверка начинает находить вызовы
        внутри комментариев.
        """
        mask = bytearray(self.length)
        position = 0
        quote = ""
        while position < self.length:
            char = self.text[position]
            if quote:
                if char == "\\":
                    position += 2
                    continue
                if char == quote:
                    quote = ""
                position += 1
                continue
            if char == "#":
                newline = self.text.find("\n", position)
                position = self.length if newline < 0 else newline
                continue
            if char in "\"'":
                quote = char
                position += 1
                continue
            mask[position] = 1
            position += 1
        return mask

    def is_code(self, mask: bytearray, index: int) -> bool:
        return bool(mask[index]) if 0 <= index < len(mask) else False

    def match_bracket(self, open_index: int) -> int:
        """Индекс закрывающей скобки для открывающей на open_index, или -1."""
        depth = 0
        position = open_index
        quote = ""
        while position < self.length:
            char = self.text[position]
            if quote:
                if char == "\\":
                    position += 2
                    continue
                if char == quote:
                    quote = ""
                position += 1
                continue
            if char in "\"'":
                quote = char
            elif char == "#":
                newline = self.text.find("\n", position)
                position = self.length if newline < 0 else newline
                continue
            elif char in "([{":
                depth += 1
            elif char in ")]}":
                depth -= 1
                if depth == 0:
                    return position
            position += 1
        return -1

    def split_top_level(self, text: str, separator: str = ",") -> List[str]:
        """Разбивает текст по разделителю верхнего уровня."""
        parts: List[str] = []
        depth = 0
        quote = ""
        current: List[str] = []
        index = 0
        while index < len(text):
            char = text[index]
            if quote:
                current.append(char)
                if char == "\\" and index + 1 < len(text):
                    current.append(text[index + 1])
                    index += 2
                    continue
                if char == quote:
                    quote = ""
                index += 1
                continue
            if char in "\"'":
                quote = char
                current.append(char)
            elif char == "#":
                newline = text.find("\n", index)
                index = len(text) if newline < 0 else newline
                continue
            elif char in "([{":
                depth += 1
                current.append(char)
            elif char in ")]}":
                depth -= 1
                current.append(char)
            elif char == separator and depth == 0:
                parts.append("".join(current))
                current = []
            else:
                current.append(char)
            index += 1
        parts.append("".join(current))
        return [part.strip() for part in parts]

    def line_of(self, offset: int) -> int:
        return self.text.count("\n", 0, offset) + 1


# ======================================================== модель сигнатуры ==

class Param:
    """Параметр функции: имя, аннотация типа, есть ли значение по умолчанию."""

    __slots__ = ("name", "type", "has_default")

    def __init__(self, name: str, param_type: str, has_default: bool) -> None:
        self.name = name
        self.type = param_type
        self.has_default = has_default

    def __repr__(self) -> str:  # pragma: no cover — отладка
        return "<Param %s: %s%s>" % (self.name, self.type or "?",
                                     " =…" if self.has_default else "")


class FuncInfo:
    __slots__ = ("name", "params", "static", "line")

    def __init__(self, name: str, params: List[Param],
                 static: bool = False, line: int = 0) -> None:
        self.name = name
        self.params = params
        self.static = static
        self.line = line

    @property
    def min_args(self) -> int:
        return sum(1 for p in self.params if not p.has_default)

    @property
    def max_args(self) -> int:
        return len(self.params)


class ClassInfo:
    """Сведения о классе: движковом или проектном."""

    __slots__ = ("name", "inherits", "methods", "properties", "path", "is_engine")

    def __init__(self, name: str, inherits: str = "",
                 path: str = "", is_engine: bool = False) -> None:
        self.name = name
        self.inherits = inherits
        self.methods: Dict[str, FuncInfo] = {}
        self.properties: Dict[str, str] = {}
        self.path = path
        self.is_engine = is_engine


class Issue:
    __slots__ = ("path", "line", "level", "message")

    def __init__(self, path: str, line: int, level: str, message: str) -> None:
        self.path = path
        self.line = line
        self.level = level
        self.message = message

    def render(self, root: str) -> str:
        relative = os.path.relpath(self.path, root)
        tag = "ERROR" if self.level == "error" else "WARN"
        return "%s:%d: [%s] %s" % (relative, self.line, tag, self.message)


# ========================================================= индекс движка ====

def build_engine_index(api_path: str) -> Dict[str, ClassInfo]:
    if not os.path.isfile(api_path):
        print("ВНИМАНИЕ: extension_api.json не найден (%s)" % api_path, file=sys.stderr)
        return {}
    with open(api_path, "r", encoding="utf-8") as handle:
        api = json.load(handle)
    index: Dict[str, ClassInfo] = {}
    for entry in api.get("classes", []):
        info = ClassInfo(entry["name"], entry.get("inherits", "") or "",
                         is_engine=True)
        for method in entry.get("methods", []):
            params: List[Param] = []
            for argument in method.get("arguments", []):
                default = argument.get("default_value", "")
                params.append(Param(argument.get("name", ""),
                                    argument.get("type", ""),
                                    bool(default)))
            info.methods[method["name"]] = FuncInfo(method["name"], params,
                                                    method.get("is_static", False))
        for prop in entry.get("properties", []):
            info.properties[prop["name"]] = prop.get("type", "")
        index[entry["name"]] = info
    for entry in api.get("builtin_classes", []):
        info = ClassInfo(entry["name"], "", is_engine=True)
        for method in entry.get("methods", []):
            params = [Param(a.get("name", ""), a.get("type", ""),
                            bool(a.get("default_value", "")))
                      for a in method.get("arguments", [])]
            info.methods[method["name"]] = FuncInfo(method["name"], params)
        for member in entry.get("members", []):
            info.properties[member["name"]] = member.get("type", "")
        index[entry["name"]] = info
    return index


def lookup_method(index: Dict[str, ClassInfo], class_name: str,
                  method: str, seen: Optional[Set[str]] = None) -> Optional[FuncInfo]:
    """Ищет метод с учётом наследования."""
    if seen is None:
        seen = set()
    if not class_name or class_name in seen or class_name not in index:
        return None
    seen.add(class_name)
    info = index[class_name]
    if method in info.methods:
        return info.methods[method]
    return lookup_method(index, info.inherits, method, seen)


def lookup_property(index: Dict[str, ClassInfo], class_name: str,
                    prop: str, seen: Optional[Set[str]] = None) -> str:
    if seen is None:
        seen = set()
    if not class_name or class_name in seen or class_name not in index:
        return ""
    seen.add(class_name)
    info = index[class_name]
    if prop in info.properties:
        return info.properties[prop]
    return lookup_property(index, info.inherits, prop, seen)


# ======================================================= индекс проекта =====

FUNC_HEAD_RE = re.compile(r"\b(static\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
CLASS_NAME_RE = re.compile(r"^\s*class_name\s+([A-Za-z0-9_]+)", re.MULTILINE)
EXTENDS_RE = re.compile(r"^\s*extends\s+([A-Za-z0-9_]+)", re.MULTILINE)
# Имя типа допускает «Array[String]» и «Dictionary»: без скобок вывод
# обрезался бы до «Array» и не совпал бы с аннотацией параметра.
TYPE_NAME = r"[A-Za-z_][A-Za-z0-9_]*(?:\s*\[\s*[A-Za-z_][A-Za-z0-9_]*\s*\])?"

VAR_DECL_RE = re.compile(
    r"\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(%s)" % TYPE_NAME)

# Вывод через «:=» — самая частая форма объявления локальной переменной.
# Тип берётся из конструктора справа: var config := ConfigFile.new().
INFERRED_VAR_RE = re.compile(
    r"\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*:=\s*([A-Z][A-Za-z0-9_]*)\s*\.\s*new\s*\(")
ONREADY_VAR_RE = re.compile(
    r"@onready\s+var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(%s)" % TYPE_NAME)
CONST_DECL_RE = re.compile(r"\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(%s)"
                           % TYPE_NAME)
PARAM_DECL_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"
                           r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*$")


def parse_params(argument_text: str) -> List[Param]:
    """Разбирает список параметров функции из исходника.

    Работает и с однострочными, и с перенесёнными gdformat сигнатурами:
    на вход приходит ВЕСЬ текст между скобками.
    """
    if not argument_text.strip():
        return []
    scanner = Scanner(argument_text)
    params: List[Param] = []
    for chunk in scanner.split_top_level(argument_text):
        if not chunk:
            continue
        has_default = False
        body = chunk
        if "=" in chunk:
            # Первый «=» верхнего уровня отделяет имя/тип от значения.
            equals = _find_top_level_equals(chunk, scanner)
            if equals >= 0:
                body = chunk[:equals]
                has_default = True
        body = body.strip()
        name = body
        param_type = ""
        if ":" in body:
            name, _, param_type = body.partition(":")
            name = name.strip()
            param_type = param_type.strip()
        # varargs в GDScript нет, но «_unused» без типа встречается постоянно.
        params.append(Param(name, param_type, has_default))
    return params


def _find_top_level_equals(chunk: str, scanner: Scanner) -> int:
    depth = 0
    quote = ""
    index = 0
    while index < len(chunk):
        char = chunk[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in "\"'":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "=" and depth == 0:
            # «==» и «>=» разделителем значения по умолчанию не являются.
            following = chunk[index + 1:index + 2]
            preceding = chunk[index - 1:index]
            if following != "=" and preceding not in "<>=!+-*/%":
                return index
        index += 1
    return -1


def parse_project_file(path: str) -> Tuple[str, ClassInfo, Dict[str, str]]:
    """Возвращает (class_name, ClassInfo, переменные-члены -> типы)."""
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    scanner = Scanner(text)
    mask = scanner.code_mask()

    class_match = None
    extends_match = None
    for candidate in CLASS_NAME_RE.finditer(text):
        if scanner.is_code(mask, candidate.start()):
            class_match = candidate
            break
    for candidate in EXTENDS_RE.finditer(text):
        if scanner.is_code(mask, candidate.start()):
            extends_match = candidate
            break
    class_name = class_match.group(1) if class_match else ""
    inherits = extends_match.group(1) if extends_match else ""

    info = ClassInfo(class_name or os.path.basename(path), inherits, path=path)
    for match in FUNC_HEAD_RE.finditer(text):
        if not scanner.is_code(mask, match.start()):
            continue
        open_paren = text.index("(", match.end() - 1)
        close_paren = scanner.match_bracket(open_paren)
        if close_paren < 0:
            continue
        params = parse_params(text[open_paren + 1:close_paren])
        info.methods[match.group(2)] = FuncInfo(
            match.group(2), params, bool(match.group(1)),
            scanner.line_of(match.start()))

    # Только ЧЛЕНЫ класса: локальные переменные функций собираются в Scope,
    # иначе одно имя в разных функциях даёт неверный тип на весь файл.
    variables: Dict[str, str] = {}
    first_func = FUNC_BOUNDARY_RE.search(text)
    header_end = first_func.start() if first_func else len(text)
    header = text[:header_end]
    for regex in (VAR_DECL_RE, ONREADY_VAR_RE, CONST_DECL_RE):
        for match in regex.finditer(header):
            if not scanner.is_code(mask, match.start()):
                continue
            variables[match.group(1)] = match.group(2)
    return class_name, info, variables


def parse_autoloads(project_godot: str) -> Dict[str, str]:
    """autoload-имя -> путь скрипта (res://...)."""
    result: Dict[str, str] = {}
    if not os.path.isfile(project_godot):
        return result
    in_section = False
    with open(project_godot, "r", encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if stripped.startswith("["):
                in_section = stripped == "[autoload]"
                continue
            if not in_section or "=" not in stripped or stripped.startswith(";"):
                continue
            name, _, value = stripped.partition("=")
            value = value.strip().strip('"')
            if value.startswith("*"):
                value = value[1:]
            result[name.strip()] = value
    return result


# ============================================================ вывод типов ===

LITERAL_INT_RE = re.compile(r"^-?\d+$")
LITERAL_FLOAT_RE = re.compile(r"^-?\d*\.\d+([eE][-+]?\d+)?$|^-?\d+\.\d*$")
CONSTRUCTOR_CALL_RE = re.compile(r"^([A-Z][A-Za-z0-9_]*)\s*\(")
TYPED_CONST_RE = re.compile(r"^([A-Z][A-Za-z0-9_]*)\.([A-Z0-9_]+)$")


def infer_arg_type(argument: str, local_types: Dict[str, str],
                   engine_index: Dict[str, ClassInfo], base_class: str,
                   project_props: Dict[str, str]) -> str:
    """Однозначный вывод типа аргумента. Пустая строка = «не знаю».

    Возвращать «не знаю» важнее, чем угадать: угаданный тип даёт ложное
    срабатывание, после которого проверку начинают обходить.
    """
    text = argument.strip()
    if not text:
        return ""
    # Отбрасываем приведения «as Type» — тип известен из самого приведения.
    as_match = re.search(r"\bas\s+([A-Z][A-Za-z0-9_]*)\s*$", text)
    if as_match:
        return as_match.group(1)

    if text in ("true", "false"):
        return "bool"
    if text.startswith('"') or text.startswith("'"):
        return "String"
    if text.startswith("&\"") or text.startswith("&'"):
        return "StringName"
    if text.startswith('^"') or text.startswith("^'"):
        return "NodePath"
    if text.startswith("$") or text.startswith("%"):
        return ""
    if LITERAL_INT_RE.match(text):
        return "int"
    if LITERAL_FLOAT_RE.match(text):
        return "float"

    constructor = CONSTRUCTOR_CALL_RE.match(text)
    if constructor:
        return constructor.group(1)

    typed_const = TYPED_CONST_RE.match(text)
    if typed_const:
        owner = typed_const.group(1)
        # Vector3.INF, Color.RED — константы известных встроенных типов.
        if owner in CONSTRUCTOR_TYPES:
            return CONSTRUCTOR_TYPES[owner]
        return ""

    identifier = re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", text)
    if not identifier:
        return ""
    name = text
    if name in local_types:
        return local_types[name]
    if name in project_props:
        return project_props[name]
    engine_type = lookup_property(engine_index, base_class, name)
    if engine_type:
        return engine_type
    # Константы типа KEY_NONE, TAU, PI, INF.
    if name in ("PI", "TAU", "INF", "NAN"):
        return "float"
    return ""


def is_known_engine_class(type_name: str, engine_index: Dict[str, ClassInfo]) -> bool:
    """Класс присутствует в extension_api.json.

    Нужна, чтобы отличать «тип не подошёл» от «тип вообще не существует».
    Второе — ошибка другого рода, и её ловит godot_api_check, а не проверка
    совместимости: утверждать несовместимость класса, о котором мы ничего
    не знаем, нельзя.
    """
    return type_name in engine_index


def _base_container(type_name: str) -> Tuple[str, str]:
    """«Array[String]» -> («Array», «String»); «Vector3» -> («Vector3», «»)."""
    bracket = type_name.find("[")
    if bracket < 0:
        return type_name.strip(), ""
    return type_name[:bracket].strip(), type_name[bracket + 1:].rstrip("]").strip()


def types_compatible(actual: str, expected: str,
                     engine_index: Dict[str, ClassInfo],
                     project_classes: Optional[Dict[str, ClassInfo]] = None) -> bool:
    """Проверяет совместимость типов аргумента и параметра.

    Правило одно: сообщаём об ошибке, только когда несовместимость
    ДОКАЗАНА. Variant, пустой вывод и контейнеры без параметров элемента
    считаются совместимыми — ложное срабатывание стоит дороже пропущенного.
    """
    if not actual or not expected:
        return True
    # Variant в GDScript принимает и отдаёт всё: проверка происходит в
    # рантайме. `var target: Variant = dict.get("target")` и передача его
    # в параметр Node3D — легальный и повсеместный код.
    if actual == "Variant" or expected == "Variant":
        return True
    actual_base, actual_param = _base_container(actual)
    expected_base, expected_param = _base_container(expected)
    # Строковые типы приводятся друг к другу неявно и повсеместно:
    # set_shader_parameter("width", …) легален, хотя параметр StringName.
    # Это правило ДОЛЖНО стоять до проверки контейнеров, иначе StringName
    # попадает в OPAQUE_TYPES и ветка возвращает «несовместимо».
    string_family = {"String", "StringName", "NodePath"}
    if actual_base in string_family and expected_base in string_family:
        return True
    # Object — корень всей иерархии движка, в него приводится любой класс.
    if expected_base == "Object":
        return True
    if actual_base in OPAQUE_TYPES or expected_base in OPAQUE_TYPES:
        # Array без параметра совместим с Array[String]: аннотация элемента
        # в GDScript не проверяется на присваивании контейнера целиком.
        if actual_base == expected_base:
            return True
        return expected_base == "Variant" or actual_base == "Variant"
    if actual_base != expected_base:
        pass  # проверяем ниже по башне чисел и наследованию
    elif actual_param and expected_param and actual_param != expected_param:
        return False
    else:
        return True
    if (actual_base, expected_base) in NUMERIC_COMPATIBLE:
        return True
    if expected_base == "String" and actual_base == "StringName":
        return True
    if expected_base == "StringName" and actual_base == "String":
        return True
    # Наследование движковых классов: Camera3D подходит под Node3D.
    #
    # Две особенности extension_api.json, без которых проверка врёт:
    #   1. у корневого класса поле inherits указывает НА НЕГО ЖЕ («Node»
    #      -> «Node»), поэтому обрывать нужно по самоциклу, а не по пустоте;
    #   2. Object в файле описан, но до него цепочка не доходит — значит
    #      любой класс движка совместим с Object.
    if expected_base == "Object" and actual_base in engine_index:
        return True
    seen: Set[str] = set()
    walker = actual_base
    # Цепочка может начинаться в проекте и заканчиваться в движке:
    # SettingsForm -> VBoxContainer -> BoxContainer -> Control -> ... -> Node.
    # Обходить нужно ОБА индекса, иначе каждый собственный класс выглядит
    # несовместимым с Node, и проверка тонет в ложных срабатываниях.
    while walker and walker not in seen:
        seen.add(walker)
        if walker == expected_base:
            return True
        holder = engine_index.get(walker)
        if holder is None and project_classes:
            holder = project_classes.get(walker)
        if holder is None:
            return False
        parent = holder.inherits
        if parent == walker:
            break
        walker = parent
    return False


# ============================================================== области =====

FUNC_BOUNDARY_RE = re.compile(r"^(?:static\s+)?func\s+[A-Za-z_][A-Za-z0-9_]*",
                              re.MULTILINE)


class Scope:
    """Область видимости одной функции: её параметры и локальные переменные."""

    __slots__ = ("start", "end", "types", "base_class")

    def __init__(self, start: int, end: int, base_class: str) -> None:
        self.start = start
        self.end = end
        self.types: Dict[str, str] = {}
        self.base_class = base_class

    def contains(self, offset: int) -> bool:
        return self.start <= offset < self.end


def build_scopes(text: str, scanner: Scanner, mask: bytearray,
                 member_types: Dict[str, str], base_class: str) -> List[Scope]:
    """Разбивает файл на области видимости функций.

    Область ВИДА ПО ФУНКЦИЯМ обязательна. Файл-уровневый словарь переменных
    даёт ложные срабатывания двух видов:
      1. одно имя в разных функциях имеет разные типы
         (var text: String в _load_data и var text := RichTextLabel.new()
          в _build_about) — проверка берёт не тот тип;
      2. имя параметра совпадает со свойством движка
         (parent: Control против Node.parent: Node) — и аргумент получает
          тип свойства вместо типа параметра.
    """
    boundaries = [m.start() for m in FUNC_BOUNDARY_RE.finditer(text)
                  if scanner.is_code(mask, m.start())]
    scopes: List[Scope] = []
    for index, start in enumerate(boundaries):
        end = boundaries[index + 1] if index + 1 < len(boundaries) else len(text)
        scope = Scope(start, end, base_class)
        scope.types.update(member_types)
        # Параметры функции — они в области видимости первыми.
        paren = text.find("(", start)
        if paren >= 0:
            close = scanner.match_bracket(paren)
            if close > paren:
                for param in parse_params(text[paren + 1:close]):
                    if param.type:
                        scope.types[param.name] = param.type
        body = text[start:end]
        for regex in (VAR_DECL_RE, ONREADY_VAR_RE, INFERRED_VAR_RE):
            for match in regex.finditer(body):
                absolute = start + match.start()
                if not scanner.is_code(mask, absolute):
                    continue
                scope.types[match.group(1)] = match.group(2)
        scopes.append(scope)
    return scopes


def scope_at(scopes: List[Scope], offset: int,
             member_types: Dict[str, str], base_class: str) -> Scope:
    for scope in scopes:
        if scope.contains(offset):
            return scope
    fallback = Scope(0, 0, base_class)
    fallback.types.update(member_types)
    return fallback


# =============================================================== проверка ===

CALL_RE = re.compile(r"([A-Za-z_%$][A-Za-z0-9_%.:/]*)\s*\(")

# Конструктор: «ClassName.new(» или «ClassName(» для встроенных типов.
CONSTRUCTOR_RE = re.compile(r"\b([A-Z][A-Za-z0-9_]*)\s*\.\s*new\s*\(")

# Встроенные типы GDScript, которые не являются классами extension_api.
BUILTIN_TYPE_NAMES: Set[str] = {
    "bool", "int", "float", "String", "Vector2", "Vector2i", "Vector3",
    "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i",
    "Transform2D", "Transform3D", "Basis", "Quaternion", "Plane", "AABB",
    "Projection", "Array", "Dictionary", "PackedByteArray", "PackedInt32Array",
    "PackedInt64Array", "PackedFloat32Array", "PackedFloat64Array",
    "PackedStringArray", "PackedVector2Array", "PackedVector3Array",
    "PackedColorArray", "StringName", "NodePath", "RID", "Callable", "Signal",
    "Variant", "Object", "PackedDataContainer",
}


def resolve_receiver(receiver: str, autoloads: Dict[str, str],
                     project_classes: Dict[str, ClassInfo],
                     local_types: Dict[str, str],
                     self_class: ClassInfo) -> str:
    """Возвращает имя класса получателя или пустую строку."""
    if not receiver:
        return self_class.name if self_class else ""
    if receiver in ("self",):
        return self_class.name if self_class else ""
    if receiver in project_classes:
        return receiver
    if receiver in autoloads:
        return autoloads[receiver]
    if receiver in local_types:
        return local_types[receiver]
    return ""


def check_file(path: str, engine_index: Dict[str, ClassInfo],
               project_classes: Dict[str, ClassInfo],
               project_index: Dict[str, Tuple[str, Dict[str, str]]],
               autoloads: Dict[str, str]) -> List[Issue]:
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    scanner = Scanner(text)
    mask = scanner.code_mask()
    issues: List[Issue] = []

    _, self_info, member_types = parse_project_file(path)
    base_class = self_info.inherits if self_info.inherits else self_info.name
    own_name = self_info.name
    all_classes = dict(project_classes)
    if own_name and own_name not in all_classes:
        all_classes[own_name] = self_info

    scopes = build_scopes(text, scanner, mask, member_types, base_class)

    # Конструкторы несуществующих классов. Отдельный проход, потому что
    # «LinkLabel.new()» синтаксически безупречен, gdparse его пропускает,
    # а падает игра уже в рантайме с «Nonexistent signal» или
    # «Cannot instantiate». В Godot нет LinkLabel — есть RichTextLabel с
    # bbcode-ссылками и Button. Статический анализ ловит это до запуска.
    for constructor in CONSTRUCTOR_RE.finditer(text):
        if not scanner.is_code(mask, constructor.start()):
            continue
        type_name = constructor.group(1)
        if type_name in BUILTIN_TYPE_NAMES:
            continue
        if type_name in all_classes or type_name in engine_index:
            continue
        issues.append(Issue(
            path, scanner.line_of(constructor.start()), "error",
            "класс «%s» не существует ни в движке (4.5.stable), ни в проекте"
            % type_name))

    for match in CALL_RE.finditer(text):
        if not scanner.is_code(mask, match.start()):
            continue
        receiver_text = match.group(1)
        open_paren = match.end() - 1
        close_paren = scanner.match_bracket(open_paren)
        if close_paren < 0:
            continue
        method = receiver_text.rsplit(".", 1)[-1].lstrip("%$")
        if not method or method in SKIP_METHODS or method in VARARGS_METHODS:
            continue
        # Ключевые слова и конструкторы: if (, match (, Vector3( — не вызовы.
        if method in ("if", "elif", "while", "for", "match", "func", "return",
                      "assert", "await", "not", "and", "or", "in", "is"):
            continue
        if method[:1].isupper():
            continue

        scope = scope_at(scopes, match.start(), member_types, base_class)
        local_types = scope.types

        receiver = receiver_text[:len(receiver_text) - len(
            receiver_text.rsplit(".", 1)[-1])].rstrip(".")
        if "." in receiver:
            receiver = receiver.rsplit(".", 1)[-1]
        if receiver.startswith("%") or receiver.startswith("$"):
            # Уникальные узлы (%Name) и пути ($Path): тип не выводится.
            continue

        argument_text = text[open_paren + 1:close_paren]
        arguments = scanner.split_top_level(argument_text)
        if arguments == [""]:
            arguments = []
        arg_count = len(arguments)

        owner_name = resolve_receiver(receiver, autoloads, all_classes,
                                      local_types, self_info)
        func = _resolve_function(owner_name, method, all_classes,
                                 engine_index, self_info, base_class)
        if func is None:
            continue

        line = scanner.line_of(match.start())
        if arg_count < func.min_args:
            issues.append(Issue(path, line, "error",
                                "%s(): передано %d аргументов, минимум %d (%s)"
                                % (method, arg_count, func.min_args,
                                   _describe_params(func))))
            continue
        if arg_count > func.max_args:
            issues.append(Issue(path, line, "error",
                                "%s(): передано %d аргументов, максимум %d (%s)"
                                % (method, arg_count, func.max_args,
                                   _describe_params(func))))
            continue

        for position, argument in enumerate(arguments):
            if position >= len(func.params):
                break
            param = func.params[position]
            if not param.type:
                continue
            actual = infer_arg_type(argument, local_types, engine_index,
                                    base_class, member_types)
            if not actual:
                continue
            if not types_compatible(actual, param.type, engine_index,
                                    all_classes):
                issues.append(Issue(
                    path, line, "error",
                    "%s(): аргумент %d «%s» имеет тип %s, а параметр %s "
                    "ожидает %s"
                    % (method, position + 1, _short(argument), actual,
                       param.name, param.type)))
    return issues


def _resolve_function(owner_name: str, method: str,
                      all_classes: Dict[str, ClassInfo],
                      engine_index: Dict[str, ClassInfo],
                      self_info: ClassInfo, base_class: str
                      ) -> Optional[FuncInfo]:
    """Ищет сигнатуру метода по имени класса-получателя.

    Порядок обхода: собственный класс получателя -> проектные родители ->
    движковые родители. Останавливаемся на первом найденном: переопределение
    в потомке имеет приоритет, как и в самом GDScript.
    """
    if not owner_name:
        own = self_info.methods.get(method)
        if own is not None:
            return own
        return lookup_method(engine_index, base_class, method)
    owner_info = all_classes.get(owner_name)
    if owner_info is None:
        return lookup_method(engine_index, owner_name, method)
    if method in owner_info.methods:
        return owner_info.methods[method]
    walker = owner_info.inherits
    seen: Set[str] = set()
    while walker and walker not in seen:
        seen.add(walker)
        parent = all_classes.get(walker)
        if parent is None:
            return lookup_method(engine_index, walker, method)
        if method in parent.methods:
            return parent.methods[method]
        walker = parent.inherits
    return None


def _describe_params(func: FuncInfo) -> str:
    parts = ["%s%s%s" % (p.name, ": " + p.type if p.type else "",
                         " = …" if p.has_default else "")
             for p in func.params]
    return "сигнатура: (%s)" % ", ".join(parts)


def _short(text: str, limit: int = 42) -> str:
    compact = " ".join(text.split())
    return compact if len(compact) <= limit else compact[:limit - 1] + "…"


# ================================================================== запуск ==

def collect_files(root: str) -> List[str]:
    result: List[str] = []
    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in
                       {".git", ".godot", "addons", "node_modules", ".venv",
                        "gdextension", "build", "export"}]
        for filename in filenames:
            if filename.endswith(".gd"):
                result.append(os.path.join(current, filename))
    return sorted(result)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Проверка числа и типов аргументов в вызовах GDScript")
    parser.add_argument("paths", nargs="*", help="файлы или каталоги")
    parser.add_argument("--api", default=DEFAULT_API,
                        help="путь к extension_api.json")
    parser.add_argument("--project", default=DEFAULT_PROJECT_GODOT,
                        help="путь к project.godot (для autoload)")
    parser.add_argument("--strict", action="store_true",
                        help="считать предупреждения ошибками")
    parser.add_argument("--quiet", action="store_true", help="меньше вывода")
    args = parser.parse_args()

    engine_index = build_engine_index(args.api)
    autoload_paths = parse_autoloads(args.project)

    targets = args.paths or [DEFAULT_GAME]
    files: List[str] = []
    for target in targets:
        if os.path.isdir(target):
            files.extend(collect_files(target))
        elif os.path.isfile(target):
            files.append(target)
        else:
            print("НЕ НАЙДЕНО: %s" % target, file=sys.stderr)
            return 2
    files = sorted(set(files))

    # Индекс ВСЕХ классов проекта строится до проверки: вызов может идти
    # в класс, лежащий в другом файле.
    project_classes: Dict[str, ClassInfo] = {}
    project_index: Dict[str, Tuple[str, Dict[str, str]]] = {}
    all_project_files = collect_files(DEFAULT_GAME)
    for path in all_project_files:
        class_name, info, variables = parse_project_file(path)
        project_index[path] = (class_name, variables)
        if class_name:
            project_classes[class_name] = info

    autoloads: Dict[str, str] = {}
    for name, script_path in autoload_paths.items():
        if not script_path.startswith("res://"):
            continue
        absolute = os.path.join(DEFAULT_GAME, script_path[len("res://"):])
        if absolute in project_index and project_index[absolute][0]:
            autoloads[name] = project_index[absolute][0]
        else:
            # Автолоад без class_name: регистрируем под собственным именем,
            # чтобы вызовы SettingsService.foo() всё равно разрешались.
            synthetic = "_autoload_%s" % name
            if os.path.isfile(absolute):
                _, info, _ = parse_project_file(absolute)
                info.name = synthetic
                project_classes[synthetic] = info
                autoloads[name] = synthetic

    issues: List[Issue] = []
    for path in files:
        issues.extend(check_file(path, engine_index, project_classes,
                                 project_index, autoloads))

    errors = [i for i in issues if i.level == "error"]
    warnings = [i for i in issues if i.level == "warning"]
    if not args.quiet:
        print("Проверка вызовов GDScript: %d файлов, %d классов проекта"
              % (len(files), len(project_classes)))
    for issue in issues:
        print("  " + issue.render(REPO_ROOT))

    failed = bool(errors) or (args.strict and bool(warnings))
    if failed:
        print("\nОШИБОК: %d, предупреждений: %d" % (len(errors), len(warnings)))
        return 1
    if not args.quiet:
        print("\nOK: вызовы корректны (предупреждений: %d)" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

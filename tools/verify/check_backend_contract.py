#!/usr/bin/env python3
"""
check_backend_contract.py — сверка контракта между GDScript и C++.

ЗАДАЧА
------
Нарезку меша на осколки умеют делать два бэкенда:
  * GDScript-фолбэк  game/scripts/systems/destruction_service.gd
  * C++ GDExtension  gdextension/src/newwoorld_fracturer.cpp

DestructionService выбирает бэкенд в рантайме по наличию класса
NewwoorldFracturer. Это значит, что ОБА обязаны возвращать словарь
одинаковой формы: если C++ отдаёт ключ «voxel», а фолбэк нет, то поведение
игры меняется в зависимости от того, собрана ли библиотека расширения.
На машине разработчика без собранного .so работает фолбэк, у игрока —
расширение, и баг воспроизводится только у игрока.

Такой класс расхождений не ловится ни одним линтером по отдельности:
каждый из них видит только свой язык. Поэтому сверка вынесена сюда.

ЧТО СВЕРЯЕТСЯ
-------------
1. Ключи словаря осколка: PIECE_KEYS в GDScript против ключей, которые
   C++ кладёт в entry[...] перед возвратом.
2. Имя точки входа расширения: entry_symbol в .gdextension против функции
   в register_types.cpp.
3. Имя класса и сигнатура fracture(): D_METHOD в C++ против того, что
   вызывает GDScript.
4. Имена глобальных шейдерных параметров: то, что публикует WindSystem,
   против того, что объявляют шейдеры. (Проверяется shader_check.py, здесь
   только дублируется для полноты отчёта.)

ИСПОЛЬЗОВАНИЕ
-------------
    python3 tools/verify/check_backend_contract.py
    python3 tools/verify/check_backend_contract.py --strict   # warn = ошибка
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Dict, List, Set, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DESTRUCTION_GD = os.path.join(
    REPO_ROOT, "game", "scripts", "systems", "destruction_service.gd")
FRACTURER_CPP = os.path.join(REPO_ROOT, "gdextension", "src", "newwoorld_fracturer.cpp")
REGISTER_CPP = os.path.join(REPO_ROOT, "gdextension", "src", "register_types.cpp")
FRACTURER_H = os.path.join(REPO_ROOT, "gdextension", "src", "newwoorld_fracturer.h")
GDEXTENSION_FILE = os.path.join(REPO_ROOT, "game", "bin", "newwoorld.gdextension")
WIND_GD = os.path.join(REPO_ROOT, "game", "scripts", "systems", "wind_system.gd")
SHADERS_DIR = os.path.join(REPO_ROOT, "game", "shaders")

PIECE_KEYS_BLOCK_RE = re.compile(
    r"const\s+PIECE_KEYS\s*:\s*Array\[String\]\s*=\s*\[(?P<body>[^\]]*)\]", re.S)
CPP_ENTRY_ASSIGN_RE = re.compile(r'entry\[\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\]\s*=')
D_METHOD_RE = re.compile(r'D_METHOD\(\s*"([A-Za-z_][A-Za-z0-9_]*)"((?:\s*,\s*"[^"]*")*)')
BIND_METHOD_RE = re.compile(r'ClassDB::bind_method\(\s*D_METHOD\(([^;]*?)\)\s*,', re.S)
ENTRY_SYMBOL_RE = re.compile(r'^\s*entry_symbol\s*=\s*"([^"]+)"', re.M)
LIB_INIT_RE = re.compile(r'\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*gdextension_interface_t')
REGISTER_CLASS_RE = re.compile(
    r'ClassDB::register_class\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>')
GD_CALL_RE = re.compile(r'_native_fracturer\.call\(\s*&?"?([A-Za-z_][A-Za-z0-9_]*)')
# WindSystem публикует параметры через КОНСТАНТЫ (_add_param(PARAM_DIRECTION, …)),
# а не строковыми литералами. Искать только &"wind_…" — значит получить
# пустой список и ложно заявить, что шейдеры читают необъявленные uniforms.
GD_ADD_PARAM_RE = re.compile(
    r'_add_param\(\s*(?:&"([A-Za-z_][A-Za-z0-9_]*)"|([A-Z_][A-Z0-9_]*))')
GD_STRINGNAME_CONST_RE = re.compile(
    r'^\s*const\s+([A-Z_][A-Z0-9_]*)\s*:\s*StringName\s*=\s*&"([a-z_][a-z0-9_]*)"',
    re.M)
SHADER_UNIFORM_RE = re.compile(r'^\s*uniform\s+\w+\s+(wind_[a-z0-9_]*)', re.M)

# Uniform'ы с префиксом wind_, которые НАМЕРЕННО не являются глобальными
# параметрами движка, а задаются у материала конкретного объекта.
#
# wind_response — индивидуальная отзывчивость растения на ветер: у травы
# она одна, у куста другая. Делать её глобальным параметром означало бы
# заставить всю растительность мира качаться одинаково.
MATERIAL_LOCAL_WIND_UNIFORMS: Set[str] = {"wind_response"}


def read(path: str) -> str:
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def gd_piece_keys(text: str) -> List[str]:
    """Ключи осколка из константы PIECE_KEYS."""
    match = PIECE_KEYS_BLOCK_RE.search(text)
    if match is None:
        return []
    return re.findall(r'"([A-Za-z_][A-Za-z0-9_]*)"', match.group("body"))


def cpp_piece_keys(text: str) -> List[str]:
    """Ключи, которые C++ кладёт в словарь осколка, в порядке присваивания."""
    keys: List[str] = []
    for match in CPP_ENTRY_ASSIGN_RE.finditer(text):
        key = match.group(1)
        if key not in keys:
            keys.append(key)
    return keys


def cpp_bound_methods(text: str) -> Dict[str, List[str]]:
    """Метод -> список имён аргументов из D_METHOD в ClassDB::bind_method."""
    result: Dict[str, List[str]] = {}
    for body in BIND_METHOD_RE.findall(text):
        method = D_METHOD_RE.search("D_METHOD(" + body + ")")
        if method is None:
            continue
        name = method.group(1)
        args = re.findall(r'"([A-Za-z_][A-Za-z0-9_]*)"', method.group(2))
        result[name] = args
    return result


def gd_native_call(text: str) -> List[Tuple[str, int]]:
    """Вызовы нативного бэкенда из GDScript: (имя метода, число аргументов).

    Обрабатывает и `_native.call("fracture", a, b)`, и многострочный
    перенос, который делает gdformat:
        _native.call(
            "fracture",
            mesh,
            …
        )
    Во втором случае имя метода стоит на ОТДЕЛЬНОЙ строке, а после него
    остаётся закрывающая кавычка. Если её не пропустить, разбор аргументов
    начнётся внутри «строки» и насчитает один аргумент вместо семи.
    """
    calls: List[Tuple[str, int]] = []
    for match in GD_CALL_RE.finditer(text):
        start = match.end()
        if start < len(text) and text[start] == '"':
            start += 1
        depth = 0
        index = start
        while index < len(text):
            char = text[index]
            if char == "(":
                depth += 1
            elif char == ")":
                if depth == 0:
                    break
                depth -= 1
            index += 1
        argument_text = text[start:index]
        # После имени метода остаётся запятая-разделитель. Если её не
        # убрать, список аргументов начнётся с пустой части и вызов с
        # семью аргументами будет посчитан как восемь.
        argument_text = argument_text.lstrip()
        if argument_text.startswith(","):
            argument_text = argument_text[1:]
        count = 0 if not argument_text.strip() else len(
            _split_top_level(argument_text))
        calls.append((match.group(1), count))
    return calls


def _split_top_level(text: str) -> List[str]:
    parts: List[str] = []
    depth = 0
    quote = ""
    current: List[str] = []
    for char in text:
        if quote:
            current.append(char)
            if char == quote:
                quote = ""
            continue
        if char in "\"'":
            quote = char
            current.append(char)
        elif char in "([{":
            depth += 1
            current.append(char)
        elif char in ")]}":
            depth -= 1
            current.append(char)
        elif char == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def resolve_wind_params(text: str) -> Set[str]:
    """Имена глобальных параметров ветра, которые публикует WindSystem.

    Разрешает обе формы вызова: литеральную `_add_param(&"wind_time", …)`
    и через константу `_add_param(PARAM_TIME, …)`.
    """
    constants = {name: value for name, value in GD_STRINGNAME_CONST_RE.findall(text)}
    published: Set[str] = set()
    for literal, constant in GD_ADD_PARAM_RE.findall(text):
        if literal:
            published.add(literal)
        elif constant in constants:
            published.add(constants[constant])
        elif constant:
            # Константа не StringName — ищем любое объявление с таким именем.
            fallback = re.search(
                r'^\s*const\s+%s\s*(?::\s*\w+)?\s*=\s*&?"([a-z_][a-z0-9_]*)"'
                % re.escape(constant), text, re.M)
            if fallback:
                published.add(fallback.group(1))
    return published


def shader_wind_uniforms() -> Dict[str, Set[str]]:
    result: Dict[str, Set[str]] = {}
    if not os.path.isdir(SHADERS_DIR):
        return result
    for name in sorted(os.listdir(SHADERS_DIR)):
        if not name.endswith(".gdshader"):
            continue
        text = read(os.path.join(SHADERS_DIR, name))
        result[name] = set(SHADER_UNIFORM_RE.findall(text))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict", action="store_true",
                        help="считать предупреждения ошибками")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    errors: List[str] = []
    warnings: List[str] = []
    checks: List[str] = []

    gd_text = read(DESTRUCTION_GD)
    cpp_text = read(FRACTURER_CPP)
    register_text = read(REGISTER_CPP)
    header_text = read(FRACTURER_H)
    gdextension_text = read(GDEXTENSION_FILE)
    wind_text = read(WIND_GD)

    for required in (DESTRUCTION_GD, FRACTURER_CPP, REGISTER_CPP, GDEXTENSION_FILE):
        if not os.path.isfile(required):
            errors.append("нет файла: %s" % os.path.relpath(required, REPO_ROOT))
    if errors:
        for line in errors:
            print("  [ERROR] " + line)
        return 1

    # ---- 1. Ключи осколка ------------------------------------------------
    gd_keys = gd_piece_keys(gd_text)
    cpp_keys = cpp_piece_keys(cpp_text)
    if not gd_keys:
        errors.append("в destruction_service.gd не найдена константа PIECE_KEYS")
    elif not cpp_keys:
        errors.append("в newwoorld_fracturer.cpp не найдены присваивания entry[...]")
    else:
        missing_in_cpp = [k for k in gd_keys if k not in cpp_keys]
        missing_in_gd = [k for k in cpp_keys if k not in gd_keys]
        if missing_in_cpp:
            errors.append("C++ не отдаёт ключи, объявленные в PIECE_KEYS: %s"
                          % ", ".join(missing_in_cpp))
        if missing_in_gd:
            errors.append("GDScript-фолбэк не отдаёт ключи C++: %s"
                          % ", ".join(missing_in_gd))
        if not missing_in_cpp and not missing_in_gd:
            checks.append("ключи осколка совпадают: %s" % ", ".join(gd_keys))
        if gd_keys != cpp_keys:
            warnings.append("ПОРЯДОК ключей различается (GDScript: %s; C++: %s). "
                            "На работу не влияет, но мешает читать оба файла рядом"
                            % (", ".join(gd_keys), ", ".join(cpp_keys)))

    # ---- 2. Точка входа расширения ---------------------------------------
    entry_symbol = ENTRY_SYMBOL_RE.search(gdextension_text)
    if entry_symbol is None:
        errors.append("в newwoorld.gdextension нет entry_symbol")
    else:
        symbol = entry_symbol.group(1)
        if not re.search(r"\b%s\s*\(" % re.escape(symbol), register_text):
            errors.append("entry_symbol «%s» не определён в register_types.cpp"
                          % symbol)
        else:
            checks.append("entry_symbol «%s» определён в register_types.cpp" % symbol)

    # ---- 3. Зарегистрированные классы ------------------------------------
    registered = set(REGISTER_CLASS_RE.findall(register_text))
    if not registered:
        errors.append("register_types.cpp не регистрирует ни одного класса")
    native_class = re.search(r'const NATIVE_CLASS: StringName = &"([^"]+)"', gd_text)
    if native_class is None:
        errors.append("в destruction_service.gd нет NATIVE_CLASS")
    elif native_class.group(1) not in registered:
        errors.append("GDScript ждёт класс «%s», а register_types.cpp регистрирует %s"
                      % (native_class.group(1), sorted(registered)))
    else:
        checks.append("класс «%s» зарегистрирован и ожидается GDScript"
                      % native_class.group(1))

    # bind_method в .cpp против объявления в .h
    bound = cpp_bound_methods(register_text)
    if not bound:
        bound = cpp_bound_methods(cpp_text)
    if not bound:
        errors.append("не найдено ни одного ClassDB::bind_method(D_METHOD(...))")
    for method_name, method_args in bound.items():
        if not re.search(r"\b%s\s*\(" % re.escape(method_name), header_text):
            errors.append("bind_method(«%s») есть, а объявления в .h нет"
                          % method_name)

    # ---- 4. Вызовы нативного бэкенда против сигнатур C++ -----------------
    for method_name, arg_count in gd_native_call(gd_text):
        if method_name not in bound:
            errors.append("GDScript вызывает «%s», но он не привязан в C++"
                          % method_name)
            continue
        expected = len(bound[method_name])
        if arg_count != expected:
            errors.append("GDScript вызывает «%s» с %d аргументами, "
                          "а D_METHOD объявляет %d"
                          % (method_name, arg_count, expected))
        else:
            checks.append("вызов «%s»: %d аргументов совпадают с D_METHOD"
                          % (method_name, arg_count))

    # ---- 5. Глобальные параметры ветра -----------------------------------
    published = resolve_wind_params(wind_text)
    if not published:
        warnings.append("WindSystem не публикует глобальные параметры "
                        "(_add_param не найден)")
    shaders = shader_wind_uniforms()
    used: Set[str] = set()
    for uniforms in shaders.values():
        used |= uniforms
    undeclared = sorted(used - published - MATERIAL_LOCAL_WIND_UNIFORMS)
    if undeclared:
        warnings.append("шейдеры объявляют wind_* uniforms, которых нет "
                        "среди публикуемых WindSystem: %s" % ", ".join(undeclared))
    unused_published = sorted(published - used)
    if unused_published:
        warnings.append("WindSystem публикует параметры, которые не читает "
                        "ни один шейдер: %s" % ", ".join(unused_published))
    if published and used and not undeclared:
        checks.append("глобальные параметры ветра согласованы (%d)" % len(published))

    # ---- отчёт ------------------------------------------------------------
    if not args.quiet:
        print("Сверка контракта GDScript <-> C++")
        for line in checks:
            print("  [OK   ] " + line)
    for line in warnings:
        print("  [WARN ] " + line)
    for line in errors:
        print("  [ERROR] " + line)

    failed = bool(errors) or (args.strict and bool(warnings))
    if failed:
        print("\nКОНТРАКТ НАРУШЕН: ошибок %d, предупреждений %d"
              % (len(errors), len(warnings)))
        return 1
    if not args.quiet:
        print("\nOK: контракт согласован (предупреждений: %d)" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

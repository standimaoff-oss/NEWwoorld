#!/usr/bin/env python3
"""
check_data.py — проверка данных проекта: JSON, .tres, project.godot.

ЗАЧЕМ ОТДЕЛЬНО ОТ ЛИНТЕРОВ
--------------------------
Линтеры проверяют КОД. Данные лежат рядом и ломаются так же легко, но
иначе: JSON с хвостовой запятой не открывается вообще, credits.json без
поля license проходит как валидный JSON и создаёт юридическую проблему,
project.godot с удалённым автолоадом запускает игру и падает в _ready().

Эта проверка отвечает на вопрос «можно ли эти данные прочитать и
доверяют ли они друг другу», не запуская Godot.

КОДЫ ВОЗВРАТА
-------------
    0   всё корректно
    1   найдены ошибки
    2   нет файла (проверка не может быть выполнена)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Set, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GAME = os.path.join(REPO_ROOT, "game")

CREDITS_JSON = os.path.join(GAME, "data", "credits.json")
GUTCONFIG_JSON = os.path.join(GAME, ".gutconfig.json")
PROJECT_GODOT = os.path.join(GAME, "project.godot")

# ---------------------------------------------------------------------------
#  Списки лицензий ЧИТАЮТСЯ ИЗ game/scripts/util/validators.gd, а не
#  дублируются здесь.
#
#  Почему это важно. Раньше списки были скопированы в этот файл с
#  комментарием «совпадают с Validators.FREE_LICENSES». Комментарий врал:
#  сверки не было, и добавление лицензии в GDScript не меняло поведение
#  проверки — она продолжала предупреждать об уже разрешённой лицензии.
#  Два источника истины расходятся всегда, вопрос только в том, когда это
#  заметят.
#
#  Разбор намеренно простой: ищем `const <ИМЯ>: Array[String] = [` и
#  собираем строковые литералы до парной закрывающей скобки. Полноценный
#  парсер GDScript не нужен — в этих константах только строки и комментарии.
# ---------------------------------------------------------------------------
VALIDATORS_GD = os.path.join(GAME, "scripts", "util", "validators.gd")


def parse_string_array(source: str, const_name: str) -> Set[str]:
    """Достаёт значения `const <name>: Array[String] = [...]` из GDScript."""
    start = source.find("const %s" % const_name)
    if start < 0:
        return set()
    # Ищем скобку ПОСЛЕ знака равенства, а не первую попавшуюся.
    # Объявление выглядит как
    #     const FREE_LICENSES: Array[String] = [
    # и в аннотации типа Array[String] есть своя пара квадратных скобок.
    # Первая скобка от начала строки принадлежит именно ей, а не телу
    # списка — из-за этого разбор возвращал пустой набор, и проверка
    # падала с «константы не найдены или пусты».
    equals = source.find("=", start)
    if equals < 0:
        return set()
    bracket = source.find("[", equals)
    if bracket < 0:
        return set()
    depth = 0
    end = -1
    for index in range(bracket, len(source)):
        if source[index] == "[":
            depth += 1
        elif source[index] == "]":
            depth -= 1
            if depth == 0:
                end = index
                break
    if end < 0:
        return set()
    body = source[bracket + 1:end]
    # Комментарии внутри списка допустимы — вырезаем, иначе их текст
    # попадёт в значения.
    body = re.sub(r"#[^\n]*", "", body)
    return set(re.findall(r'"([^"]+)"', body))


def load_license_lists() -> Tuple[Set[str], Set[str], Set[str]]:
    """Возвращает (свободные, требующие атрибуции, запрещённые)."""
    try:
        with open(VALIDATORS_GD, "r", encoding="utf-8") as handle:
            source = handle.read()
    except OSError as error:
        raise SystemExit(
            "ОШИБКА: не удалось прочитать %s (%s).\n"
            "Списки лицензий берутся оттуда, поэтому без файла проверка "
            "невозможна." % (VALIDATORS_GD, error))

    lists = {
        name: parse_string_array(source, name)
        for name in ("FREE_LICENSES", "ATTRIBUTION_LICENSES", "FORBIDDEN_LICENSES")
    }
    missing = [name for name, values in lists.items() if not values]
    if missing:
        raise SystemExit(
            "ОШИБКА: в validators.gd не найдены или пусты константы: %s.\n"
            "Проверка лицензий опирается на них. Без значений она либо "
            "пропустит запрещённый ассет, либо заблокирует свободный."
            % ", ".join(missing))

    return (lists["FREE_LICENSES"],
            lists["ATTRIBUTION_LICENSES"],
            lists["FORBIDDEN_LICENSES"])


FREE_LICENSES, ATTRIBUTION_LICENSES, FORBIDDEN_LICENSES = load_license_lists()

# Ключи, которые GDScript читает из credits.json. Расхождение здесь —
# это пустой раздел в меню контактов.
REQUIRED_CREDIT_SECTIONS: List[str] = [
    "game", "contacts", "roles", "used_assets", "asset_sources_approved",
]

# res://-пути из project.godot, которые обязаны существовать.
CRITICAL_SETTINGS: List[str] = ["run/main_scene"]

AUTOLOAD_SECTION = "[autoload]"
INPUT_SECTION = "[input]"

RES_PATH_RE = re.compile(r'"(res://[^"]+)"')


def rel(path: str) -> str:
    return os.path.relpath(path, REPO_ROOT)


def load_json(path: str, errors: List[str]) -> Dict:
    if not os.path.isfile(path):
        errors.append("нет файла %s" % rel(path))
        return {}
    with open(path, "r", encoding="utf-8") as handle:
        text = handle.read()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        errors.append("%s: JSON не разобран — %s (строка %d, колонка %d)"
                      % (rel(path), exc.msg, exc.lineno, exc.colno))
        return {}
    if not isinstance(data, dict):
        errors.append("%s: ожидался объект, получен %s" % (rel(path), type(data).__name__))
        return {}
    return data


def check_credits(data: Dict, errors: List[str], warnings: List[str]) -> None:
    if not data:
        return
    for section in REQUIRED_CREDIT_SECTIONS:
        if section not in data:
            errors.append("credits.json: нет раздела «%s»" % section)

    game = data.get("game", {})
    if isinstance(game, dict):
        for field in ("title", "engine", "engine_license"):
            if field not in game:
                errors.append("credits.json: game.%s отсутствует" % field)
        license_text = str(game.get("engine_license", "")).lower()
        if license_text and "mit" not in license_text:
            warnings.append("credits.json: лицензия движка «%s» — Godot "
                            "распространяется под MIT" % game.get("engine_license"))

    contacts = data.get("contacts", [])
    if not isinstance(contacts, list):
        errors.append("credits.json: contacts должен быть массивом")
        contacts = []
    if not contacts:
        errors.append("credits.json: contacts пуст — ТЗ требует меню с контактами")
    for index, contact in enumerate(contacts):
        if not isinstance(contact, dict):
            errors.append("credits.json: contacts[%d] не объект" % index)
            continue
        for field in ("label", "kind", "value"):
            if field not in contact:
                errors.append("credits.json: contacts[%d].%s отсутствует"
                              % (index, field))
        if not contact.get("optional", False) and not str(
                contact.get("value", "")).strip():
            errors.append("credits.json: contacts[%d] «%s» — обязательный "
                          "контакт без значения"
                          % (index, contact.get("label", "?")))
        if contact.get("kind") == "url":
            url = str(contact.get("value", ""))
            if url and not url.startswith("https://"):
                errors.append("credits.json: contacts[%d] «%s» не https"
                              % (index, url))

    assets = data.get("used_assets", [])
    if not isinstance(assets, list):
        errors.append("credits.json: used_assets должен быть массивом")
        assets = []
    for index, asset in enumerate(assets):
        context = "credits.json: used_assets[%d]" % index
        if not isinstance(asset, dict):
            errors.append("%s не объект" % context)
            continue
        for field in ("name", "author", "license", "url"):
            if field not in asset:
                errors.append("%s: нет поля «%s»" % (context, field))
        license_name = str(asset.get("license", "")).strip()
        if not license_name:
            errors.append("%s: пустая лицензия — ассет нельзя использовать" % context)
        elif license_name in FORBIDDEN_LICENSES:
            errors.append("%s: лицензия «%s» ЗАПРЕЩЕНА в проекте"
                          % (context, license_name))
        elif license_name not in FREE_LICENSES:
            warnings.append("%s: лицензия «%s» не в списке разрешённых — "
                            "добавьте осознанно" % (context, license_name))
        if license_name in ATTRIBUTION_LICENSES:
            author = str(asset.get("author", "")).strip()
            if not author or author.lower() in ("unknown", "n/a", "неизвестно"):
                errors.append("%s: лицензия «%s» требует автора, а поле author "
                              "пусто или бессодержательно" % (context, license_name))
        url = str(asset.get("url", ""))
        if url and not url.startswith("https://"):
            warnings.append("%s: url «%s» не https" % (context, url))

    sources = data.get("asset_sources_approved", [])
    if isinstance(sources, list):
        if not sources:
            warnings.append("credits.json: asset_sources_approved пуст")
        for index, source in enumerate(sources):
            if not isinstance(source, dict):
                errors.append("credits.json: asset_sources_approved[%d] не объект"
                              % index)
                continue
            for field in ("name", "license"):
                if field not in source:
                    errors.append("credits.json: asset_sources_approved[%d]: "
                                  "нет «%s»" % (index, field))
    else:
        errors.append("credits.json: asset_sources_approved должен быть массивом")


def check_gutconfig(data: Dict, errors: List[str]) -> None:
    if not data:
        return
    dirs = data.get("dirs", [])
    if not isinstance(dirs, list) or not dirs:
        errors.append(".gutconfig.json: dirs пуст — GUT не найдёт тесты")
        return
    for directory in dirs:
        if not str(directory).startswith("res://"):
            errors.append(".gutconfig.json: каталог «%s» должен начинаться с res://"
                          % directory)
            continue
        absolute = os.path.join(GAME, str(directory)[len("res://"):])
        if not os.path.isdir(absolute):
            errors.append(".gutconfig.json: каталог «%s» не существует" % directory)
            continue
        tests = [f for f in os.listdir(absolute)
                 if f.startswith(str(data.get("prefix", "test_")))
                 and f.endswith(str(data.get("suffix", ".gd")))]
        if not tests:
            errors.append(".gutconfig.json: в «%s» нет ни одного теста" % directory)
    if data.get("double_strategy") not in (None, "script-only", "include-native"):
        errors.append(".gutconfig.json: неизвестная double_strategy «%s»"
                      % data.get("double_strategy"))


def parse_ini_sections(text: str) -> Dict[str, Dict[str, str]]:
    """Минимальный разбор project.godot: секция -> ключ -> значение.

    Значения в Godot БЫВАЮТ МНОГОСТРОЧНЫМИ. В секции [input] каждое
    действие записано так:

        move_forward={
        "deadzone": 0.5,
        "events": [Object(InputEventKey,...)]
        }

    Наивный парсер «строка = ключ/значение» видит здесь значение «{» и
    теряет events — после чего проверка заявляет, что ни одно действие не
    привязано. Поэтому строки склеиваются, пока не сбалансируются скобки.
    """
    sections: Dict[str, Dict[str, str]] = {}
    current = ""
    pending_key = ""
    pending_value: List[str] = []
    depth = 0

    def flush() -> None:
        if pending_key and current:
            sections[current][pending_key] = "\n".join(pending_value).strip()

    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if depth > 0:
            # Продолжение многострочного значения.
            pending_value.append(stripped)
            depth += stripped.count("{") + stripped.count("[") + stripped.count("(")
            depth -= stripped.count("}") + stripped.count("]") + stripped.count(")")
            if depth <= 0:
                depth = 0
                flush()
                pending_key = ""
                pending_value = []
            continue
        if not stripped or stripped.startswith(";") or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current = stripped[1:-1]
            sections.setdefault(current, {})
            continue
        if "=" not in stripped or not current:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip()
        depth = value.count("{") + value.count("[") + value.count("(")
        depth -= value.count("}") + value.count("]") + value.count(")")
        if depth > 0:
            pending_key = key
            pending_value = [value]
            continue
        sections[current][key] = value
    flush()
    return sections


def check_project_godot(errors: List[str], warnings: List[str]) -> Dict[str, Dict[str, str]]:
    if not os.path.isfile(PROJECT_GODOT):
        errors.append("нет %s — выполните tools/setup/setup.sh"
                      % rel(PROJECT_GODOT))
        return {}
    with open(PROJECT_GODOT, "r", encoding="utf-8") as handle:
        text = handle.read()
    sections = parse_ini_sections(text)

    if "application" not in sections:
        errors.append("project.godot: нет секции [application]")
    application = sections.get("application", {})
    main_scene = application.get("run/main_scene", "").strip('"')
    if not main_scene:
        errors.append("project.godot: run/main_scene не задана")
    elif not _res_exists(main_scene):
        errors.append("project.godot: run/main_scene «%s» не существует" % main_scene)

    autoloads = sections.get("autoload", {})
    if not autoloads:
        errors.append("project.godot: нет ни одного автолоада")
    for name, value in autoloads.items():
        path = value.strip('"')
        if path.startswith("*"):
            path = path[1:]
        if not path.startswith("res://"):
            errors.append("project.godot: автолоад %s -> «%s» не res://-путь"
                          % (name, path))
            continue
        if not _res_exists(path):
            errors.append("project.godot: автолоад %s указывает на несуществующий %s"
                          % (name, path))

    inputs = sections.get("input", {})
    if not inputs:
        errors.append("project.godot: нет секции [input] — управление не настроено")
    empty_actions: List[str] = []
    for action, body in inputs.items():
        if "events" not in body:
            empty_actions.append(action)
    if empty_actions:
        warnings.append("project.godot: действия без привязок: %s"
                        % ", ".join(sorted(empty_actions)))

    # Висячие res://-пути во всём файле.
    for match in RES_PATH_RE.finditer(text):
        path = match.group(1)
        if path.endswith(("/", ".")):
            continue
        if not _res_exists(path):
            errors.append("project.godot: ссылка на несуществующий %s" % path)
    return sections


def _res_exists(path: str) -> bool:
    if not path.startswith("res://"):
        return False
    absolute = os.path.join(GAME, path[len("res://"):])
    if os.path.exists(absolute):
        return True
    # Каталоги в res:// не обязаны существовать физически (user:// и т.п.),
    # но res:// обязан. Проверяем также вариант с .import.
    return os.path.exists(absolute + ".import")


def check_quality_profiles(errors: List[str], warnings: List[str]) -> None:
    directory = os.path.join(GAME, "resources", "quality")
    if not os.path.isdir(directory):
        errors.append("нет каталога resources/quality — профили качества отсутствуют")
        return
    found = sorted(f for f in os.listdir(directory) if f.endswith(".tres"))
    expected = ["quality_low.tres", "quality_medium.tres",
                "quality_high.tres", "quality_ultra.tres"]
    for name in expected:
        if name not in found:
            errors.append("нет профиля качества %s" % name)
    budgets: List[Tuple[str, int]] = []
    for name in found:
        text = open(os.path.join(directory, name), "r", encoding="utf-8").read()
        match = re.search(r'destruction_chunk_budget\s*=\s*(\d+)', text)
        if match is None:
            warnings.append("%s: нет destruction_chunk_budget" % name)
            continue
        budgets.append((name, int(match.group(1))))
    order = ["quality_low.tres", "quality_medium.tres",
             "quality_high.tres", "quality_ultra.tres"]
    ordered = [b for n, b in budgets if n in order]
    ordered_by_name = sorted(budgets, key=lambda item: order.index(item[0])
                             if item[0] in order else 99)
    values = [b for _, b in ordered_by_name]
    if values != sorted(values):
        errors.append("бюджеты осколков не возрастают от low к ultra: %s"
                      % ", ".join("%s=%d" % (n, b) for n, b in ordered_by_name))
    _ = ordered


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict", action="store_true",
                        help="считать предупреждения ошибками")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    errors: List[str] = []
    warnings: List[str] = []

    credits = load_json(CREDITS_JSON, errors)
    check_credits(credits, errors, warnings)

    gutconfig = load_json(GUTCONFIG_JSON, errors)
    check_gutconfig(gutconfig, errors)

    check_project_godot(errors, warnings)
    check_quality_profiles(errors, warnings)

    if not args.quiet:
        print("Проверка данных: credits.json, .gutconfig.json, project.godot, "
              "профили качества")
    for line in warnings:
        print("  [WARN ] " + line)
    for line in errors:
        print("  [ERROR] " + line)

    failed = bool(errors) or (args.strict and bool(warnings))
    if failed:
        print("\nДАННЫЕ: ошибок %d, предупреждений %d" % (len(errors), len(warnings)))
        return 1
    if not args.quiet:
        print("\nOK: данные корректны (предупреждений: %d)" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

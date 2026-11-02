#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Приводит отступы GDScript к табам (требование gdlint: tab-characters: 1).

Зачем отдельный инструмент:
  * Godot принимает и пробелы, и табы, но gdlint требует табы, а редактор
    Godot по умолчанию ставит табы. Смешанный стиль = вечные конфликты
    в diff'ах и «mixed-tabs-and-spaces» в линтере.
  * Файлы пишутся людьми и ИИ в пробелах — прогон этого скрипта в pre-commit
    делает стиль одинаковым независимо от автора.

Что делает:
  * ведущие группы из N пробелов (N кратно 4) -> N/4 табов;
  * внутри строк (в т.ч. многострочных) ничего не трогает;
  * убирает пробелы в конце строк;
  * гарантирует ровно один перевод строки в конце файла;
  * конвертирует CRLF -> LF.

Безопасность: скрипт отслеживает многострочные строковые литералы
(\"\"\" ... \"\"\"), чтобы не сломать их содержимое.

Запуск:
    python3 tools/lint/normalize_gdscript.py            # проверить все
    python3 tools/lint/normalize_gdscript.py --write    # исправить
    python3 tools/lint/normalize_gdscript.py path/to/x.gd --write
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import List, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GAME_ROOT = os.path.join(REPO_ROOT, "game")
EXCLUDED_DIRS = {".git", ".godot", "node_modules", ".venv", "addons", "build", "export"}

INDENT_UNIT = 4


def find_gd_files(root: str) -> List[str]:
    found: List[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            if name.endswith(".gd"):
                found.append(os.path.join(dirpath, name))
    found.sort()
    return found


def normalize_text(text: str) -> Tuple[str, List[str]]:
    """Возвращает (новый_текст, список_замечаний)."""
    notes: List[str] = []
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out_lines: List[str] = []
    in_triple: bool = False

    for lineno, line in enumerate(text.split("\n"), start=1):
        stripped = line.rstrip()

        # Отслеживаем тройные кавычки, чтобы не трогать их содержимое.
        triple_count = line.count('"""')
        if in_triple:
            out_lines.append(stripped)
            if triple_count % 2 == 1:
                in_triple = False
            continue
        if triple_count % 2 == 1:
            in_triple = True
            out_lines.append(stripped)
            continue

        if not stripped:
            out_lines.append("")
            continue

        # Считаем ведущие пробелы.
        lead = 0
        while lead < len(stripped) and stripped[lead] == " ":
            lead += 1
        if lead == 0:
            out_lines.append(stripped)
            continue

        tabs = lead // INDENT_UNIT
        remainder = lead % INDENT_UNIT
        if remainder:
            notes.append(
                "строка %d: отступ %d пробелов не кратен %d — оставлено %d таб(ов) "
                "+ %d пробел(ов)" % (lineno, lead, INDENT_UNIT, tabs, remainder)
            )
            out_lines.append("\t" * tabs + " " * remainder + stripped[lead:])
        else:
            out_lines.append("\t" * tabs + stripped[lead:])

    # Убираем пустые строки в конце, добавляем ровно одну.
    while out_lines and out_lines[-1] == "":
        out_lines.pop()
    result = "\n".join(out_lines)
    if result:
        result += "\n"
    return result, notes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="файлы или каталоги (по умолчанию game/)")
    parser.add_argument("--write", action="store_true", help="перезаписать файлы")
    parser.add_argument("--quiet", action="store_true", help="меньше вывода")
    args = parser.parse_args()

    targets: List[str] = args.paths or [GAME_ROOT]
    files: List[str] = []
    for target in targets:
        full = target if os.path.isabs(target) else os.path.join(REPO_ROOT, target)
        if os.path.isdir(full):
            files.extend(find_gd_files(full))
        elif os.path.isfile(full):
            files.append(full)
        else:
            print("ПУТЬ НЕ НАЙДЕН: %s" % target, file=sys.stderr)
            return 2

    changed: List[str] = []
    all_notes: List[str] = []
    for path in files:
        with open(path, "r", encoding="utf-8") as fh:
            original = fh.read()
        normalized, notes = normalize_text(original)
        rel = os.path.relpath(path, REPO_ROOT)
        for note in notes:
            all_notes.append("%s: %s" % (rel, note))
        if normalized != original:
            changed.append(rel)
            if args.write:
                with open(path, "w", encoding="utf-8", newline="") as fh:
                    fh.write(normalized)

    if all_notes and not args.quiet:
        print("Замечания по отступам:")
        for note in all_notes:
            print("  " + note)

    if args.write:
        if not args.quiet:
            print("Приведено к табам: %d из %d файлов" % (len(changed), len(files)))
    else:
        if changed:
            print("Нужна нормализация (%d файлов):" % len(changed))
            for rel in changed:
                print("  " + rel)
            print("Запустите с --write, чтобы исправить.")
            return 1
        if not args.quiet:
            print("Отступы в норме: %d файлов" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())

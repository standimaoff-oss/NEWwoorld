#!/usr/bin/env python3
"""
check_repo_hygiene.py — гигиена репозитория.

ЗАЧЕМ. Артефакты сборки, попавшие в git, ломают проект незаметно и надолго:
  * .godot/ содержит абсолютные пути машины разработчика — на другой
    машине проект открывается с ошибкой импорта;
  * собранный .so под Linux не загружается на Windows, а лежащий в git
    выглядит как «готовая библиотека», из-за чего её перестают пересобирать;
  * node_modules и .venv увеличивают клон в сотни раз;
  * obj-файлы из синтаксической проверки C++ — это мусор, который
    появляется после каждого прогона tools/cpp/syntax_check.sh.

Проверка смотрит и на РАБОЧЕЕ ДЕРЕВО (что реально лежит на диске), и на
ИНДЕКС git (что реально будет отправлено). Это разные вещи: файл может
быть в .gitignore, но уже добавленным в индекс, и тогда ignore не спасает.

КОДЫ ВОЗВРАТА: 0 — чисто, 1 — найдено, 2 — нет git.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from typing import List, Set, Tuple

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Каталоги, которые не должны попадать ни в индекс, ни в рабочее дерево
# как отслеживаемые.
FORBIDDEN_TRACKED_PREFIXES: Tuple[str, ...] = (
    ".godot/", "game/.godot/", "node_modules/", "tools/asset-pipeline/node_modules/",
    ".venv/", "venv/", "gdextension/build/", "gdextension/godot-cpp/bin/",
    "gdextension/godot-cpp/gen/", "build/", "dist/", "export/", "out/",
    "__pycache__/", ".mypy_cache/", ".pytest_cache/", ".ruff_cache/",
)

# Расширения бинарных артефактов сборки.
FORBIDDEN_TRACKED_EXTENSIONS: Tuple[str, ...] = (
    ".o", ".obj", ".so", ".dll", ".dylib", ".wasm", ".lib", ".a", ".exp",
    ".pdb", ".ilk", ".pyc", ".pyo",
)

# Файлы, которые ОБЯЗАНЫ быть в репозитории: без них проект не собирается
# и не проверяется. Их отсутствие — та же ошибка, что и лишний мусор.
REQUIRED_FILES: Tuple[str, ...] = (
    ".gitignore", ".gitattributes", ".editorconfig", ".gdlintrc",
    "game/project.godot", "game/icon.svg", "game/default_bus_layout.tres",
    "game/.gutconfig.json", "game/data/credits.json",
    "game/bin/newwoorld.gdextension",
    "gdextension/SConstruct", "gdextension/src/register_types.cpp",
    "tools/setup/generate_project_godot.py",
    "tools/lint/lint_gdscript.sh", "tools/lint/godot_api_check.py",
    "tools/lint/gdscript_call_check.py", "tools/lint/godot_scene_check.py",
    "tools/lint/shader_check.py", "tools/cpp/syntax_check.sh",
    "tools/verify/verify_all.sh", "tools/verify/check_data.py",
    "tools/verify/check_backend_contract.py",
    "ТЗ.md",
)

# Паттерны, которые обязаны быть в .gitignore.
REQUIRED_IGNORE_PATTERNS: Tuple[str, ...] = (
    ".godot/", "node_modules/", ".venv/", "*.so", "*.dll", "*.dylib",
    "*.wasm", "*.o", "gdextension/build/", "__pycache__/",
)

# Файлы, которые ДОЛЖНЫ попадать под LFS: бинарные ассеты в обычном git
# раздувают историю необратимо — удалить большой файл из истории можно
# только переписыванием всех коммитов.
LFS_PATTERNS: Tuple[str, ...] = (
    "*.glb", "*.gltf", "*.fbx", "*.blend", "*.ktx", "*.psd", "*.kra",
)


def run_git(*args: str) -> Tuple[int, str]:
    try:
        result = subprocess.run(["git", *args], cwd=REPO_ROOT,
                                capture_output=True, text=True, timeout=120)
        return result.returncode, (result.stdout or "") + (result.stderr or "")
    except (OSError, subprocess.SubprocessError) as exc:
        return 2, str(exc)


def tracked_files() -> List[str]:
    code, output = run_git("ls-files")
    if code != 0:
        return []
    return [line for line in output.splitlines() if line.strip()]


def ignore_patterns() -> Set[str]:
    path = os.path.join(REPO_ROOT, ".gitignore")
    if not os.path.isfile(path):
        return set()
    with open(path, "r", encoding="utf-8") as handle:
        return {line.strip() for line in handle
                if line.strip() and not line.strip().startswith("#")}


def gitattributes_text() -> str:
    path = os.path.join(REPO_ROOT, ".gitattributes")
    if not os.path.isfile(path):
        return ""
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def rel(path: str) -> str:
    return os.path.relpath(path, REPO_ROOT)


def is_git_ignored(paths: List[str]) -> Set[str]:
    """Подмножество путей, которые git уже игнорирует.

    Без этого проверка предупреждает о каждом __pycache__/*.pyc, хотя он
    корректно проигнорирован. Предупреждение, которое всегда ложное,
    перестают читать — и настоящее теряется среди него.
    """
    if not paths:
        return set()
    ignored: Set[str] = set()
    # Пакетный вызов: check-ignore --stdin отдаёт только те пути, которые
    # проигнорированы, и завершается с кодом 1, если таких нет вовсе.
    # Код 128 означает «один из путей лежит в подмодуле» — тогда пакет
    # не даёт ответа ни по одному пути, и приходится спрашивать по одному.
    try:
        result = subprocess.run(
            ["git", "check-ignore", "--stdin"], cwd=REPO_ROOT,
            input="\n".join(paths), capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return set()
    if result.returncode in (0, 1):
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}
    for path in paths:
        try:
            single = subprocess.run(["git", "check-ignore", "--", path],
                                    cwd=REPO_ROOT, capture_output=True,
                                    text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            continue
        if single.returncode == 0:
            ignored.add(path)
    return ignored


def check_tracked(files: List[str], errors: List[str], warnings: List[str]) -> None:
    for path in files:
        normalized = path.replace(os.sep, "/")
        for prefix in FORBIDDEN_TRACKED_PREFIXES:
            if normalized.startswith(prefix):
                errors.append("в git отслеживается артефакт сборки: %s" % normalized)
                break
        lowered = normalized.lower()
        for extension in FORBIDDEN_TRACKED_EXTENSIONS:
            if lowered.endswith(extension):
                errors.append("в git отслеживается бинарный артефакт: %s" % normalized)
                break


def check_required_files(errors: List[str]) -> None:
    for path in REQUIRED_FILES:
        absolute = os.path.join(REPO_ROOT, path)
        if not os.path.isfile(absolute):
            errors.append("нет обязательного файла: %s" % path)


def check_gitignore(errors: List[str], warnings: List[str]) -> None:
    path = os.path.join(REPO_ROOT, ".gitignore")
    if not os.path.isfile(path):
        errors.append("нет .gitignore — артефакты сборки попадут в коммит")
        return
    patterns = ignore_patterns()
    joined = "\n".join(patterns)
    for required in REQUIRED_IGNORE_PATTERNS:
        # Паттерн может быть записан как «*.so», «/**/*.so» или «build/*.so».
        needle = required.lstrip("*").lstrip("/")
        if required in patterns or needle in joined:
            continue
        errors.append(".gitignore не покрывает «%s»" % required)
    # user://-данные и логи тоже не должны попадать в репозиторий.
    for extra in ("*.log", ".DS_Store", "Thumbs.db"):
        if extra not in joined:
            warnings.append(".gitignore не содержит «%s»" % extra)


def check_lfs(errors: List[str], warnings: List[str]) -> None:
    text = gitattributes_text()
    if not text:
        warnings.append("нет .gitattributes — бинарные ассеты пойдут в историю git")
        return
    for pattern in LFS_PATTERNS:
        if not re.search(re.escape(pattern) + r"\b", text):
            warnings.append(".gitattributes не отправляет «%s» в LFS" % pattern)
        elif "filter=lfs" not in text:
            errors.append(".gitattributes упоминает «%s», но filter=lfs не задан"
                          % pattern)
            break


def submodule_paths() -> Set[str]:
    """Относительные пути подмодулей.

    Содержимое подмодуля governed его собственным .gitignore: артефакты
    сборки внутри gdextension/godot-cpp нас не касаются, и сообщать о них
    — значит шуметь по поводу, который нельзя исправить в этом репозитории.
    """
    paths: Set[str] = set()
    gitmodules = os.path.join(REPO_ROOT, ".gitmodules")
    if os.path.isfile(gitmodules):
        with open(gitmodules, "r", encoding="utf-8") as handle:
            for line in handle:
                stripped = line.strip()
                if stripped.startswith("path"):
                    _, _, value = stripped.partition("=")
                    value = value.strip()
                    if value:
                        paths.add(value.rstrip("/"))
    return paths


def check_working_tree(errors: List[str], warnings: List[str]) -> None:
    """Мусор в рабочем дереве: в индекс не попал, но место занимает."""
    offenders: List[str] = []
    submodules = submodule_paths()
    for current, dirnames, filenames in os.walk(REPO_ROOT):
        # В .git не заходим никогда.
        dirnames[:] = [d for d in dirnames if d != ".git"]
        relative_dir = rel(current).replace(os.sep, "/")
        if relative_dir in submodules or any(
                relative_dir.startswith(sub + "/") for sub in submodules):
            dirnames[:] = []
            continue
        for prefix in FORBIDDEN_TRACKED_PREFIXES:
            if (relative_dir + "/").startswith(prefix.rstrip("/")) \
                    or relative_dir == prefix.rstrip("/"):
                # Каталог существует — это нормально (сборка работала),
                # важно лишь, чтобы он не отслеживался git.
                dirnames[:] = []
                break
        for filename in filenames:
            lowered = filename.lower()
            for extension in FORBIDDEN_TRACKED_EXTENSIONS:
                if lowered.endswith(extension):
                    offenders.append(os.path.join(relative_dir, filename))
                    break
    # Исключаем то, что git уже игнорирует: это штатные артефакты сборки.
    offenders = [item for item in offenders if item not in is_git_ignored(offenders)]
    if offenders:
        shown = offenders[:8]
        suffix = "" if len(offenders) <= 8 else " …и ещё %d" % (len(offenders) - 8)
        warnings.append("в рабочем дереве %d артефактов сборки (%s%s) — "
                        "убедитесь, что они в .gitignore"
                        % (len(offenders), ", ".join(shown), suffix))


def check_scripts_executable(errors: List[str]) -> None:
    """Обязательное: исполняемость .sh. Потерянный бит +x ломает CI молча."""
    for path in ("tools/lint/lint_gdscript.sh", "tools/cpp/syntax_check.sh",
                 "tools/verify/verify_all.sh", "tools/setup/setup.sh"):
        absolute = os.path.join(REPO_ROOT, path)
        if not os.path.isfile(absolute):
            continue
        if not os.access(absolute, os.X_OK):
            errors.append("%s не исполняемый (нужен chmod +x)" % path)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--strict", action="store_true",
                        help="считать предупреждения ошибками")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--no-git", action="store_true",
                        help="не проверять индекс git")
    args = parser.parse_args()

    errors: List[str] = []
    warnings: List[str] = []

    if not os.path.isdir(os.path.join(REPO_ROOT, ".git")) and not args.no_git:
        warnings.append("нет .git — проверяется только рабочее дерево")

    if not args.no_git:
        files = tracked_files()
        if files:
            check_tracked(files, errors, warnings)
        else:
            code, output = run_git("rev-parse", "--is-inside-work-tree")
            if code != 0:
                warnings.append("git недоступен: %s" % output.strip().splitlines()[-1:])

    check_required_files(errors)
    check_gitignore(errors, warnings)
    check_lfs(errors, warnings)
    check_working_tree(errors, warnings)
    check_scripts_executable(errors)

    if not args.quiet:
        tracked = len(tracked_files()) if not args.no_git else 0
        print("Гигиена репозитория: отслеживается %d файлов" % tracked)
    for line in warnings:
        print("  [WARN ] " + line)
    for line in errors:
        print("  [ERROR] " + line)

    failed = bool(errors) or (args.strict and bool(warnings))
    if failed:
        print("\nРЕПОЗИТОРИЙ: ошибок %d, предупреждений %d"
              % (len(errors), len(warnings)))
        return 1
    if not args.quiet:
        print("\nOK: репозиторий чист (предупреждений: %d)" % len(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())

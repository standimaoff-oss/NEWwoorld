#!/usr/bin/env bash
# ============================================================
#  NEWwoorld — установка рабочего окружения
#
#  Делает всё, что нужно для проверки и запуска проекта, ОДНОЙ командой:
#    bash tools/setup/setup.sh
#
#  Скрипт ИДЕМПОТЕНТЕН: повторный запуск ничего не ломает и не качает
#  заново. Прерванный на середине запуск можно просто повторить.
#
#  Что ставится:
#    1. Python venv + gdtoolkit (gdparse/gdlint/gdformat) + SCons
#    2. Node-зависимости ассет-конвейера (@gltf-transform, gltf-validator…)
#    3. godot-cpp (git submodule) + генерация привязок
#    4. GUT (тестовый фреймворк) в game/addons/gut
#    5. game/project.godot — ГЕНЕРИРУЕТСЯ, руками его править не нужно
#
#  Что НЕ ставится и почему:
#    * Godot Engine (редактор/экспорт-шаблоны). Дистрибутивы лежат на
#      objects.githubusercontent.com, а в изолированных средах этот хост
#      часто закрыт. Скрипт проверяет доступность и честно сообщает,
#      что можно и чего нельзя, вместо того чтобы упасть на середине.
#      Без Godot недоступны: запуск игры, прогон GUT, экспорт.
#      Доступно всё остальное — см. tools/verify/verify_all.sh.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

VENV="$REPO_ROOT/.venv"
PYTHON="${PYTHON:-python3}"
GODOT_CPP="$REPO_ROOT/gdextension/godot-cpp"
GUT_DIR="$REPO_ROOT/game/addons/gut"
GUT_VERSION="${GUT_VERSION:-9.6.1}"
GODOT_CPP_TAG="${GODOT_CPP_TAG:-godot-4.5-stable}"

STEP_FAIL=0

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; D=""; N=""
fi

step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '   %s!%s %s\n' "$Y" "$N" "$1"; }
fail() { printf '   %s✗%s %s\n' "$R" "$N" "$1"; STEP_FAIL=1; }
note() { printf '   %s·%s %s\n' "$D" "$N" "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

echo "${B}NEWwoorld — установка окружения${N}"
echo "каталог: $REPO_ROOT"

# --- 0. базовые инструменты ------------------------------------------------
step "Проверка базовых инструментов"
for tool in git python3; do
  if have "$tool"; then ok "$tool: $($tool --version 2>&1 | head -1)"; else fail "$tool не найден"; fi
done
if have node; then ok "node: $(node --version)"; else warn "node не найден — ассет-конвейер не установится"; fi
if have npm;  then ok "npm: $(npm --version)";   else warn "npm не найден"; fi
if have g++;  then ok "g++: $(g++ -dumpversion 2>/dev/null || g++ --version | head -1)"
elif have clang++; then ok "clang++: $(clang++ --version | head -1)"
else warn "нет C++-компилятора — GDExtension собрать не получится"; fi
if have scons; then ok "scons: $(scons --version 2>&1 | grep -o 'v[0-9.]*' | head -1)"
else note "scons будет установлен в venv"; fi

# --- 1. Python venv -------------------------------------------------------
step "Python venv + gdtoolkit + SCons"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV" && ok "venv создан: $VENV" || fail "не удалось создать venv"
else
  ok "venv уже существует"
fi
if [ -x "$VENV/bin/python" ]; then
  "$VENV/bin/python" -m pip install --quiet --upgrade pip >/dev/null 2>&1 \
    && note "pip обновлён" || note "pip не обновлён (не критично)"
  if "$VENV/bin/python" -c "import gdtoolkit" 2>/dev/null; then
    ok "gdtoolkit установлен: $("$VENV/bin/gdlint" --version 2>&1 | head -1)"
  else
    "$VENV/bin/pip" install --quiet "gdtoolkit==4.5.0" \
      && ok "gdtoolkit 4.5.0 установлен" || fail "не удалось установить gdtoolkit"
  fi
  if "$VENV/bin/python" -c "import SCons" 2>/dev/null; then
    ok "SCons установлен"
  else
    "$VENV/bin/pip" install --quiet "scons==4.11.1" \
      && ok "SCons 4.11.1 установлен" || warn "SCons не установлен — сборка GDExtension недоступна"
  fi
fi

# --- 2. Node-зависимости ассет-конвейера ----------------------------------
step "Ассет-конвейер (Node)"
if [ -f tools/asset-pipeline/package.json ]; then
  if [ -d tools/asset-pipeline/node_modules ]; then
    ok "node_modules уже установлены ($(du -sh tools/asset-pipeline/node_modules 2>/dev/null | cut -f1))"
  elif have npm; then
    if ( cd tools/asset-pipeline && npm install --no-audit --no-fund --loglevel=error ); then
      ok "зависимости установлены"
    else
      fail "npm install не удался — оптимизация .glb будет недоступна"
    fi
  else
    warn "npm нет — пропускаем"
  fi
else
  warn "нет tools/asset-pipeline/package.json"
fi

# --- 3. godot-cpp ---------------------------------------------------------
step "godot-cpp (C++ привязки)"
if [ -f "$GODOT_CPP/SConstruct" ]; then
  ok "подмодуль уже получен"
else
  note "инициализация подмодуля (tag $GODOT_CPP_TAG)…"
  if git submodule update --init --recursive gdextension/godot-cpp 2>/dev/null; then
    ok "подмодуль инициализирован"
  else
    warn "git submodule update не удался — пробуем clone"
    if git clone --depth 1 --branch "$GODOT_CPP_TAG" \
        https://github.com/godotengine/godot-cpp "$GODOT_CPP" 2>/dev/null; then
      ok "godot-cpp склонирован"
    else
      fail "godot-cpp не получен — сборка GDExtension невозможна"
    fi
  fi
fi

if [ -f "$GODOT_CPP/gdextension/extension_api.json" ]; then
  VERSION=$(python3 -c "
import json,sys
try:
    print(json.load(open('$GODOT_CPP/gdextension/extension_api.json'))['header']['version_full_name'])
except Exception:
    print('неизвестно')
" 2>/dev/null)
  ok "extension_api.json: $VERSION"
  note "все линтеры API сверяются именно с этой версией"
else
  fail "нет extension_api.json — проверки API работать не будут"
fi

if [ -d "$GODOT_CPP/gen/include" ] && [ -d "$GODOT_CPP/gen/src" ]; then
  ok "привязки уже сгенерированы"
elif [ -x "$VENV/bin/python" ] && [ -f "$GODOT_CPP/binding_generator.py" ]; then
  note "генерация привязок (занимает минуту-две)…"
  if ( cd "$GODOT_CPP" && "$VENV/bin/python" -c "
import binding_generator, pathlib
api = pathlib.Path('gdextension/extension_api.json')
binding_generator.generate_bindings(str(api), True, '32', 'single', str(pathlib.Path('.')))
" >/dev/null 2>&1 ); then
    ok "привязки сгенерированы"
  else
    warn "генерация привязок не удалась — понадобится для сборки GDExtension"
  fi
else
  warn "нельзя сгенерировать привязки (нет venv или binding_generator.py)"
fi

# --- 4. GUT ---------------------------------------------------------------
step "GUT — тестовый фреймворк"
if [ -f "$GUT_DIR/plugin.cfg" ]; then
  # plugin.cfg — это INI, а не JSON: строка выглядит как version="9.6.1",
  # без пробелов вокруг «=». Раньше здесь искался JSON-шаблон
  # '"version": "..."', он не совпадал никогда, и версия в отчёте просто
  # не печаталась. Само по себе безобидно, но из-за этого проверка не
  # замечала устаревший GUT: скрипт рапортовал «уже установлен» и шёл
  # дальше, а тесты потом падали на отличиях API фреймворка.
  VERSION=$(sed -n 's/^[[:space:]]*version[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1/p' \
    "$GUT_DIR/plugin.cfg" | head -1)
  if [ -z "$VERSION" ]; then
    fail "не удалось прочитать версию из $GUT_DIR/plugin.cfg"
  elif [ "$VERSION" != "$GUT_VERSION" ]; then
    note "установлен GUT $VERSION, ожидается $GUT_VERSION"
    note "тесты написаны под API $GUT_VERSION — при расхождении возможны"
    note "несуществующие assert-функции. Обновить: rm -rf $GUT_DIR и перезапуск"
    ok "уже установлен (версия $VERSION — отличается от ожидаемой)"
  else
    ok "уже установлен (версия $VERSION)"
  fi
else
  TMP=$(mktemp -d)
  note "скачивание GUT $GUT_VERSION…"
  if curl -sSL "https://codeload.github.com/bitwes/Gut/tar.gz/refs/heads/main" \
      -o "$TMP/gut.tar.gz" 2>/dev/null && tar -xzf "$TMP/gut.tar.gz" -C "$TMP" 2>/dev/null; then
    SRC=$(find "$TMP" -maxdepth 2 -type d -name gut | head -1)
    if [ -n "$SRC" ] && [ -d "$SRC/addons/gut" ]; then
      mkdir -p "$REPO_ROOT/game/addons"
      cp -R "$SRC/addons/gut" "$GUT_DIR"
      ok "GUT установлен"
    else
      fail "архив GUT не содержит addons/gut"
    fi
  else
    fail "не удалось скачать GUT — тесты не запустятся"
  fi
  rm -rf "$TMP"
fi

# --- 5. project.godot -----------------------------------------------------
step "project.godot"
if python3 tools/setup/generate_project_godot.py; then
  ok "сгенерирован (источник правды — tools/setup/generate_project_godot.py)"
  note "руками этот файл править НЕ нужно: правки теряются при перегенерации"
else
  fail "генерация project.godot не удалась"
fi

# --- 6. каталоги, которые должны существовать ---------------------------
step "Структура каталогов"
for dir in game/assets/models game/assets/textures game/assets/audio \
           game/assets/fonts game/data game/tests/unit game/tests/integration \
           game/tests/smoke game/resources/quality gdextension/src; do
  mkdir -p "$REPO_ROOT/$dir"
done
ok "каталоги созданы/проверены"

# --- 7. исполняемость скриптов -------------------------------------------
step "Права на исполнение"
chmod +x tools/lint/*.sh tools/cpp/*.sh tools/verify/*.sh tools/setup/*.sh 2>/dev/null
ok "chmod +x применён к tools/**/*.sh"

# --- 8. Godot Engine ------------------------------------------------------
step "Godot Engine"
if have godot; then
  ok "godot в PATH: $(godot --version 2>/dev/null | head -1)"
elif have godot4; then
  ok "godot4 в PATH: $(godot4 --version 2>/dev/null | head -1)"
else
  warn "Godot Engine не найден в PATH"
  note "Нужен Godot 4.5 или новее (целевая версия проекта — 4.7.2-stable)."
  note "Скачать: https://godotengine.org/download — архив или self-contained binary."
  note "Без Godot НЕДОСТУПНО: запуск игры, прогон GUT, экспорт сборки."
  note "Без Godot ДОСТУПНО: линтеры GDScript, проверка API движка по"
  note "extension_api.json, проверка сцен и ресурсов, проверка шейдеров,"
  note "компиляция C++ до объектных файлов, валидация данных и контрактов."
  note "Полный список: bash tools/verify/verify_all.sh"
fi

# --- итог -----------------------------------------------------------------
echo
echo "${B}════════════════════════════════════════════════════════${N}"
if [ "$STEP_FAIL" = "0" ]; then
  echo "${G}Окружение готово.${N}"
  echo
  echo "Дальше:"
  echo "  bash tools/verify/verify_all.sh              # проверить всё"
  echo "  bash tools/verify/verify_all.sh --with-godot # + тесты GUT (нужен Godot)"
  echo "  make help                                    # список команд"
  exit 0
else
  echo "${R}Окружение установлено ЧАСТИЧНО — см. отметки ✗ выше.${N}"
  echo "Повторите запуск: bash tools/setup/setup.sh (скрипт идемпотентен)."
  exit 1
fi

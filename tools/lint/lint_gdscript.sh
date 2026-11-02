#!/usr/bin/env bash
# ============================================================
#  NEWwoorld — проверка GDScript: синтаксис + стиль + формат
#
#  Три инструмента из gdtoolkit, прогнанные по всему проекту:
#    gdparse   — грамматика. Падает на любой синтаксической ошибке,
#                то есть это минимум, без которого Godot проект не откроет.
#    gdlint    — стиль по .gdlintrc (порядок объявлений, имена, длина
#                строк, сложность функций).
#    gdformat  — каноническое форматирование. --check ничего не правит,
#                только сообщает, где файл «поехал».
#
#  Использование:
#    tools/lint/lint_gdscript.sh              # проверить всё
#    tools/lint/lint_gdscript.sh --fix        # переформатировать
#    tools/lint/lint_gdscript.sh path1 path2  # проверить выборочно
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="$REPO_ROOT/.venv"
GAME="$REPO_ROOT/game"

FIX=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --fix) FIX=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

# --- инструменты ---------------------------------------------------------
if [ ! -x "$VENV/bin/gdparse" ]; then
  echo "ОШИБКА: нет $VENV/bin/gdparse" >&2
  echo "Установка: bash tools/setup/setup.sh" >&2
  exit 2
fi
GDPARSE="$VENV/bin/gdparse"
GDLINT="$VENV/bin/gdlint"
GDFORMAT="$VENV/bin/gdformat"

# --- список файлов -------------------------------------------------------
# addons/ исключён намеренно: это вендоренный GUT, его стиль нам не принадлежит.
if [ ${#ARGS[@]} -eq 0 ]; then
  mapfile -t FILES < <(find "$GAME" -name '*.gd' \
      -not -path '*/addons/*' -not -path '*/.godot/*' | sort)
else
  FILES=()
  for a in "${ARGS[@]}"; do
    target="${a/#game\//$GAME/}"
    [ -d "$target" ] || target="$REPO_ROOT/$a"
    if [ -d "$target" ]; then
      while IFS= read -r f; do FILES+=("$f"); done < <(
        find "$target" -name '*.gd' -not -path '*/addons/*' -not -path '*/.godot/*' | sort)
    elif [ -f "$target" ]; then
      FILES+=("$target")
    else
      echo "ПРОПУЩЕНО (не найдено): $a" >&2
    fi
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "Не найдено ни одного .gd файла."
  exit 0
fi

echo "GDScript lint: ${#FILES[@]} файлов"
FAIL=0

# --- 1. синтаксис --------------------------------------------------------
echo
echo "[1/5] gdparse — синтаксис"
if "$GDPARSE" "${FILES[@]}" >/tmp/gdparse.log 2>&1; then
  echo "      OK"
else
  echo "      ПРОВАЛ:"
  sed 's/^/      /' /tmp/gdparse.log
  FAIL=1
fi

# --- 2. форматирование ---------------------------------------------------
echo
echo "[2/5] gdformat — канонический формат"
if [ "$FIX" = "1" ]; then
  "$GDFORMAT" "${FILES[@]}" >/tmp/gdformat.log 2>&1 && echo "      переформатировано" \
    || { echo "      ПРОВАЛ:"; sed 's/^/      /' /tmp/gdformat.log; FAIL=1; }
else
  if "$GDFORMAT" --check "${FILES[@]}" >/tmp/gdformat.log 2>&1; then
    echo "      OK"
  else
    echo "      Формат отличается (запустите с --fix):"
    sed 's/^/      /' /tmp/gdformat.log | head -30
    FAIL=1
  fi
fi

# --- 3. стиль ------------------------------------------------------------
# gdlint запускается ДВАЖДЫ с разными конфигами:
#   прод-код -> .gdlintrc             (max-public-methods: 22)
#   тесты    -> game/tests/.gdlintrc  (max-public-methods: 80)
# gdlint не принимает путь к конфигу — он ищет .gdlintrc от cwd вверх.
# Поэтому для тестов меняется рабочий каталог, а правило для всего проекта
# НЕ ослабляется: в GUT каждый тест это публичный test_*-метод, и файл из
# 25 независимых проверок формально «божественный класс», хотя связности
# между методами нет никакой.
echo
echo "[3/5] gdlint — стиль (.gdlintrc)"
PROD_FILES=()
TEST_FILES=()
for f in "${FILES[@]}"; do
  case "$f" in
    */game/tests/*) TEST_FILES+=("$f") ;;
    *)              PROD_FILES+=("$f") ;;
  esac
done

LINT_FAILED=0
: >/tmp/gdlint.log
if [ ${#PROD_FILES[@]} -gt 0 ]; then
  ( cd "$REPO_ROOT" && "$GDLINT" "${PROD_FILES[@]}" ) >>/tmp/gdlint.log 2>&1 || LINT_FAILED=1
fi
if [ ${#TEST_FILES[@]} -gt 0 ]; then
  ( cd "$GAME/tests" && "$GDLINT" "${TEST_FILES[@]}" ) >>/tmp/gdlint.log 2>&1 || LINT_FAILED=1
fi

if [ "$LINT_FAILED" = "0" ]; then
  echo "      OK  (прод: ${#PROD_FILES[@]}, тесты: ${#TEST_FILES[@]})"
else
  echo "      ЗАМЕЧАНИЯ:"
  sed 's/^/      /' /tmp/gdlint.log
  FAIL=1
fi

# --- 4. API движка -------------------------------------------------------
echo
echo "[4/5] godot_api_check — существование API"
if python3 "$REPO_ROOT/tools/lint/godot_api_check.py" --quiet "${FILES[@]}" >/tmp/gdapi.log 2>&1; then
  echo "      OK"
else
  echo "      ОШИБКИ API:"
  sed 's/^/      /' /tmp/gdapi.log
  FAIL=1
fi

# --- 5. Вызовы: арность и типы аргументов --------------------------------
# godot_api_check отвечает на «существует ли метод», этот этап — на
# «правильно ли он вызван». Без него вызов play_sfx(stream, Vector3)
# проходит все проверки и падает в рантайме у игрока.
echo
echo "[5/5] call_check — число и типы аргументов"
if python3 "$REPO_ROOT/tools/lint/gdscript_call_check.py" --quiet "${FILES[@]}" >/tmp/gdcall.log 2>&1; then
  echo "      OK"
else
  echo "      ОШИБКИ ВЫЗОВОВ:"
  sed 's/^/      /' /tmp/gdcall.log
  FAIL=1
fi

echo
if [ "$FAIL" = "0" ]; then
  echo "GDScript: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ"
else
  echo "GDScript: ЕСТЬ ЗАМЕЧАНИЯ (см. выше)"
fi
exit "$FAIL"

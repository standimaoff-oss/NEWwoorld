#!/usr/bin/env bash
# ============================================================
#  NEWwoorld — ЕДИНАЯ точка проверки проекта
#
#  Запускает всё, что можно проверить БЕЗ Godot, и (опционально) то,
#  что требует Godot. Принцип один: если проверка не запускается
#  одной командой, она не запускается вообще.
#
#  Использование:
#    tools/verify/verify_all.sh                 # всё, что доступно здесь
#    tools/verify/verify_all.sh --quick         # только линтеры (быстро)
#    tools/verify/verify_all.sh --with-godot    # + запуск GUT в Godot
#    tools/verify/verify_all.sh --strict        # предупреждения = ошибки
#
#  КОД ВОЗВРАТА: 0 — всё зелёное, 1 — есть провалы, 2 — нет инструмента.
#  Именно поэтому скрипт пригоден для CI и для pre-commit.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT" || exit 2

WITH_GODOT=0
QUICK=0
STRICT=0
GODOT_BIN="${GODOT_BIN:-}"

for arg in "$@"; do
  case "$arg" in
    --with-godot) WITH_GODOT=1 ;;
    --quick)      QUICK=1 ;;
    --strict)     STRICT=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

# --- оформление отчёта ---------------------------------------------------
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_FAIL=$'\033[31m'; C_WARN=$'\033[33m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_FAIL=""; C_WARN=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi

PASSED=0
FAILED=0
SKIPPED=0
FAILED_STEPS=()

# run_step "название" "что проверили" команда...
run_step() {
  local title="$1"; shift
  local summary="$1"; shift
  printf '\n%s── %s%s\n' "$C_BOLD" "$title" "$C_OFF"
  printf '   %s%s%s\n' "$C_DIM" "$summary" "$C_OFF"

  local output
  local status=0
  output="$("$@" 2>&1)" || status=$?

  if [ "$status" -eq 0 ]; then
    printf '   %s✓ ПРОЙДЕНО%s\n' "$C_OK" "$C_OFF"
    PASSED=$((PASSED + 1))
  elif [ "$status" -eq 125 ]; then
    # 125 — «инструмент недоступен». Это не провал: в песочнице без Godot
    # проверка сцен в редакторе невозможна физически. Отличать провал от
    # недоступности обязательно, иначе скрипт игнорируют как «вечно красный».
    printf '   %s○ ПРОПУЩЕНО%s (нет инструмента)\n' "$C_WARN" "$C_OFF"
    SKIPPED=$((SKIPPED + 1))
    [ -n "$output" ] && printf '     %s%s%s\n' "$C_DIM" "$output" "$C_OFF"
  else
    printf '   %s✗ ПРОВАЛ%s (код %d)\n' "$C_FAIL" "$C_OFF" "$status"
    FAILED=$((FAILED + 1))
    FAILED_STEPS+=("$title")
    printf '%s\n' "$output" | sed 's/^/     /'
  fi
}

# Инструмент доступен?
have() { command -v "$1" >/dev/null 2>&1; }

echo "${C_BOLD}NEWwoorld — проверка проекта${C_OFF}"
echo "каталог: $REPO_ROOT"
echo "дата:    $(date '+%Y-%m-%d %H:%M:%S')"

# ============================================================ 1. GDScript ==
run_step "GDScript: синтаксис, формат, стиль, API, вызовы" \
  "gdparse + gdformat + gdlint + godot_api_check + call_check" \
  bash tools/lint/lint_gdscript.sh

# ================================================== 2. Сцены и ресурсы =====
SCENE_ARGS=()
[ "$STRICT" = "1" ] && SCENE_ARGS+=("--strict")
run_step "Сцены и ресурсы: структура и ссылки" \
  "заголовки, ext_resource/sub_resource, висячие res://-пути" \
  python3 tools/lint/godot_scene_check.py "${SCENE_ARGS[@]}"

# ========================================================= 3. Шейдеры ======
run_step "Шейдеры: синтаксис и соглашения" \
  "uniform'ы, hints, совпадение с параметрами WindSystem" \
  python3 tools/lint/shader_check.py

# ============================================ 4. Контракт GDScript <-> C++ =
CONTRACT_ARGS=()
[ "$STRICT" = "1" ] && CONTRACT_ARGS+=("--strict")
run_step "Контракт бэкендов разрушения" \
  "ключи осколков, entry_symbol, bind_method, параметры ветра" \
  python3 tools/verify/check_backend_contract.py "${CONTRACT_ARGS[@]}"

# ============================================================ 5. C++ =======
if have g++ || have clang++; then
  CPP_MODE="--objects"
  [ "$QUICK" = "1" ] && CPP_MODE="--syntax"
  run_step "C++ GDExtension: компиляция" \
    "godot-cpp заголовки + gdextension/src ($CPP_MODE)" \
    bash tools/cpp/syntax_check.sh "$CPP_MODE"
else
  echo
  printf '%s── C++ GDExtension: компиляция%s\n' "$C_BOLD" "$C_OFF"
  printf '   %s○ ПРОПУЩЕНО%s (нет g++/clang++)\n' "$C_WARN" "$C_OFF"
  SKIPPED=$((SKIPPED + 1))
fi

# ========================================================= 6. Данные =======
run_step "Данные: JSON и схема настроек" \
  "credits.json, .gutconfig.json, project.godot" \
  python3 tools/verify/check_data.py

# ============================================== 7. Ассет-конвейер (Node) ====
if have node && [ -d tools/asset-pipeline/node_modules ]; then
  run_step "Ассет-конвейер: glTF/GLB" \
    "валидатор и оптимизатор запускаются" \
    node tools/asset-pipeline/scripts/check_pipeline.mjs
else
  echo
  printf '%s── Ассет-конвейер: glTF/GLB%s\n' "$C_BOLD" "$C_OFF"
  printf '   %s○ ПРОПУЩЕНО%s (нет node или node_modules)\n' "$C_WARN" "$C_OFF"
  SKIPPED=$((SKIPPED + 1))
fi

# ================================================ 8. Целостность репозитория
run_step "Репозиторий: гигиена" \
  "нет бинарного мусора в git, .gitignore покрывает артефакты сборки" \
  python3 tools/verify/check_repo_hygiene.py

# ================================================== 9. Godot + GUT ==========
if [ "$WITH_GODOT" = "1" ]; then
  if [ -z "$GODOT_BIN" ] && have godot; then GODOT_BIN="godot"; fi
  if [ -z "$GODOT_BIN" ] && have godot4; then GODOT_BIN="godot4"; fi
  if [ -n "$GODOT_BIN" ]; then
    run_step "Godot: импорт ресурсов" \
      "$GODOT_BIN --headless --import" \
      "$GODOT_BIN" --headless --path game --import --quit

    run_step "Godot: тесты GUT" \
      "smoke + unit + integration" \
      "$GODOT_BIN" --headless --path game -s addons/gut/gut_cmdln.gd \
        -gconfig=res://.gutconfig.json -gexit
  else
    echo
    printf '%s── Godot: тесты GUT%s\n' "$C_BOLD" "$C_OFF"
    printf '   %s○ ПРОПУЩЕНО%s (нет godot в PATH; укажите GODOT_BIN=...)\n' \
      "$C_WARN" "$C_OFF"
    SKIPPED=$((SKIPPED + 1))
  fi
fi

# ============================================================== итог =======
TOTAL=$((PASSED + FAILED + SKIPPED))
echo
echo "${C_BOLD}════════════════════════════════════════════════════════${C_OFF}"
printf '%sИТОГ:%s пройдено %d, провалено %d, пропущено %d (всего %d)\n' \
  "$C_BOLD" "$C_OFF" "$PASSED" "$FAILED" "$SKIPPED" "$TOTAL"

if [ "$FAILED" -gt 0 ]; then
  printf '%sПРОВАЛЫ:%s\n' "$C_FAIL" "$C_OFF"
  for step in "${FAILED_STEPS[@]}"; do
    printf '  · %s\n' "$step"
  done
  echo
  echo "Как чинить:"
  echo "  bash tools/lint/lint_gdscript.sh --fix   # формат и стиль"
  echo "  bash tools/verify/verify_all.sh --quick  # быстрый повтор"
  exit 1
fi

if [ "$SKIPPED" -gt 0 ]; then
  echo
  printf '%sПропущено %d проверок: нет инструмента в этой среде.%s\n' \
    "$C_DIM" "$SKIPPED" "$C_OFF"
  printf '%sЭто НЕ «всё хорошо»: на машине с Godot запустите --with-godot.%s\n' \
    "$C_DIM" "$C_OFF"
fi

echo
printf '%sВСЕ ПРОВЕРКИ ПРОЙДЕНЫ%s\n' "$C_OK" "$C_OFF"
exit 0

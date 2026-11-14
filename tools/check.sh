#!/usr/bin/env bash
# check.sh — все проверки шага 5.3x, которые можно выполнить без браузера.
#
#   ./tools/check.sh            # диалект шейдеров + синтаксис JS + логика сцены
#   GLSLANG=/path/to/glslang ./tools/check.sh
#
# Что покрывается (и чего здесь нет): здесь проверяются шейдеры (компиляция двумя
# конвейерами), контракт uniform/атрибут между GLSL и JS, геометрия города и
# числами — трава/слои/GI/вывески. То, что требует GPU, — в живом превью:
#   python3 -m http.server 8000 --bind 0.0.0.0   →  /web/?freeze=1&clean=1
# и в эталонном CPU-рендере:
#   node tools/dump_scene.js --view ... --out build/preview/scene.json
#   python3 tools/shader_preview.py scene --scene build/preview/scene.json --out docs/screenshots/x.png
set -u
cd "$(dirname "$0")/.."
fail=0
step() {
  printf '\n\033[1m▶ %s\033[0m\n' "$1"
  shift
  if "$@"; then printf '  \033[32mok\033[0m\n'; else printf '  \033[31mПРОВАЛ: %s\033[0m\n' "$*"; fail=1; fi
}

# 1. Шейдеры: единый источник → web (300 es) и native (330 core), плюс glslang.
glslang_args=()
if [ -n "${GLSLANG:-}" ] && [ -x "${GLSLANG}" ]; then glslang_args+=(--validate); fi
step "шейдеры: диалект + контракт JS ${glslang_args[*]:-(glslang не задан — только сборка)}" \
  python3 tools/shader_dialect.py --check-js "${glslang_args[@]}"

# 2. Синтаксис всех скриптов (web — ESM, tools — ESM/CJS как задумано).
for f in web/js/*.js web/*.js tools/*.js; do
  step "node --check $f" node --check "$f"
done
for f in tools/*.py; do
  step "python -c compile $f" python3 -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$f"
done

# 3. Логика сцены и договорённости (без браузера и без GPU).
step "тесты веб-сборки" node tests/test_web_logic.mjs

printf '\n'
if [ "$fail" = 0 ]; then printf '\033[32mвсе проверки прошли\033[0m\n'; else
  printf '\033[31mесть провалы — см. выше\033[0m\n'; fi
exit "$fail"

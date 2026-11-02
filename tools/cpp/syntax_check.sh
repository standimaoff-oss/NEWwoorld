#!/usr/bin/env bash
# ============================================================
#  NEWwoorld — проверка C++ GDExtension БЕЗ полной сборки
#
#  Полная сборка расширения требует скомпилировать весь godot-cpp
#  (~1000 единиц трансляции). На машине разработчика это минуты, в CI —
#  тоже минуты. А ответ на вопрос «мой C++ вообще компилируется?» нужен
#  за секунды.
#
#  Этот скрипт даёт два уровня:
#    --syntax   (по умолчанию) g++ -fsyntax-only: заголовки, типы,
#               сигнатуры, макросы godot-cpp. Секунды.
#    --objects  реальная компиляция в .o: ловит ещё и ошибки кодогена,
#               шаблонов и ODR. Десятки секунд.
#
#  Что НЕ проверяется: линковка (нужны объекты godot-cpp) и работа
#  расширения в движке. Для этого — `make cpp` и запуск Godot.
#
#  Требования: g++ (или clang++) с C++17, распакованный подмодуль
#  godot-cpp и сгенерированные биндинги (делает setup.sh).
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GDE="$REPO_ROOT/gdextension"
CPP_DIR="$GDE/godot-cpp"

MODE="syntax"
case "${1:-}" in
  --syntax) MODE="syntax" ;;
  --objects) MODE="objects" ;;
  "") MODE="syntax" ;;
  *) echo "Использование: $0 [--syntax|--objects]" >&2; exit 2 ;;
esac

# --- компилятор -----------------------------------------------------------
CXX_BIN="${CXX:-}"
if [ -z "$CXX_BIN" ]; then
  for candidate in g++ clang++ c++; do
    if command -v "$candidate" >/dev/null 2>&1; then CXX_BIN="$candidate"; break; fi
  done
fi
if [ -z "$CXX_BIN" ]; then
  echo "ОШИБКА: не найден C++ компилятор (нужен g++ или clang++)." >&2
  exit 2
fi

# --- подмодуль и биндинги --------------------------------------------------
if [ ! -f "$CPP_DIR/SConstruct" ]; then
  echo "ОШИБКА: godot-cpp отсутствует ($CPP_DIR)." >&2
  echo "        git submodule update --init --recursive" >&2
  exit 2
fi
if [ ! -d "$CPP_DIR/gen/include/godot_cpp/classes" ]; then
  echo "ОШИБКА: не сгенерированы биндинги godot-cpp (gen/include)." >&2
  echo "        bash tools/setup/setup.sh" >&2
  exit 2
fi
if [ ! -f "$CPP_DIR/gdextension/extension_api.json" ]; then
  echo "ОШИБКА: нет gdextension/extension_api.json в godot-cpp." >&2
  exit 2
fi

# -isystem для godot-cpp: его заголовки дают десятки предупреждений на
# -Wall -Wextra. Они не наши и только топят реально важные сообщения.
# Наш код при этом проверяется строго.
INCLUDES=(
  "-isystem$CPP_DIR/include"
  "-isystem$CPP_DIR/gen/include"
  "-isystem$CPP_DIR/gdextension"
  "-I$GDE/src"
)

# Флаги как у godot-cpp для template_debug, чтобы проверка соответствовала
# реальной сборке.
#
# ВАЖНО про -fno-rtti: его здесь НЕТ сознательно. godot::Object::cast_to<T>()
# реализован через dynamic_cast, поэтому расширение без RTTI не компилируется
# вообще (проверено: ошибка 'dynamic_cast not permitted with -fno-rtti' в
# godot-cpp/include/godot_cpp/core/object.hpp). -fno-exceptions, наоборот,
# godot-cpp использует, и мы его повторяем.
FLAGS=(-std=c++17 -fno-exceptions -Wall -Wextra -Wno-unused-parameter)
if [ "$MODE" = "syntax" ]; then
  FLAGS+=(-fsyntax-only)
fi

mapfile -t SOURCES < <(find "$GDE/src" -name '*.cpp' | sort)
if [ ${#SOURCES[@]} -eq 0 ]; then
  echo "Нет .cpp файлов в $GDE/src"
  exit 0
fi

OUT_DIR="$GDE/build/check"
if [ "$MODE" = "objects" ]; then
  mkdir -p "$OUT_DIR"
  FLAGS+=(-O0 -g0)
fi

echo "C++ проверка ($MODE): компилятор $CXX_BIN, файлов ${#SOURCES[@]}"
FAIL=0
for src in "${SOURCES[@]}"; do
  rel="${src#"$REPO_ROOT"/}"
  printf '  %-46s ' "$rel"
  if [ "$MODE" = "objects" ]; then
    obj="$OUT_DIR/$(basename "${src%.cpp}").o"
    if "$CXX_BIN" "${FLAGS[@]}" "${INCLUDES[@]}" -c "$src" -o "$obj" 2>/tmp/nw_cxx.err; then
      printf 'OK  (%s)\n' "$(du -h "$obj" | cut -f1)"
    else
      echo "FAIL"; sed 's/^/      /' /tmp/nw_cxx.err | head -25; FAIL=1
    fi
  else
    if "$CXX_BIN" "${FLAGS[@]}" "${INCLUDES[@]}" "$src" 2>/tmp/nw_cxx.err; then
      echo "OK"
    else
      echo "FAIL"; sed 's/^/      /' /tmp/nw_cxx.err | head -25; FAIL=1
    fi
  fi
done

# --- предупреждения отдельно: -Wall -Wextra на чистом прогоне ------------
echo
if [ "$FAIL" = "0" ]; then
  echo "C++: КОМПИЛИРУЕТСЯ ($MODE)"
else
  echo "C++: ЕСТЬ ОШИБКИ КОМПИЛЯЦИИ"
fi
exit "$FAIL"

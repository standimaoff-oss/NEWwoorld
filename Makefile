# ============================================================
#  NEWwoorld — Makefile
#
#  Все команды проекта в одном месте. Правило простое: если действие
#  нельзя выполнить одной короткой командой, его не будут выполнять
#  вообще — ни разработчик, ни CI.
#
#  Начните с `make help`.
#
#  Переменные:
#    GODOT_BIN=/path/to/godot   — где искать Godot (иначе ищем в PATH)
#    JOBS=4                     — параллельность сборки C++
#    PLATFORM=linux             — целевая платформа GDExtension
# ============================================================

SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

REPO_ROOT := $(shell pwd)
VENV      := $(REPO_ROOT)/.venv
GODOT_BIN ?= $(shell command -v godot 2>/dev/null || command -v godot4 2>/dev/null)
JOBS      ?= 2
PLATFORM  ?= linux
TARGET    ?= template_debug
ARCH      ?= x86_64

# SCons берём из venv, если он там есть: системный может быть другой версии.
SCONS := $(if $(wildcard $(VENV)/bin/scons),$(VENV)/bin/scons,$(shell command -v scons))
# Python из venv предпочтителен: там стоит pillow, нужный схеме карты.
PYTHON := $(if $(wildcard $(VENV)/bin/python),$(VENV)/bin/python,$(shell command -v python3))

VERIFY := bash tools/verify/verify_all.sh

# Цвета — только для терминала, иначе CI-логи пестрят escape-кодами.
ifneq (,$(findstring xterm,$(TERM)))
C_B := $(shell printf '\033[1m')
C_G := $(shell printf '\033[32m')
C_N := $(shell printf '\033[0m')
else
C_B :=
C_G :=
C_N :=
endif

# ============================================================ справка ======

.PHONY: help
help: ## Показать эту справку
	@echo
	@echo "$(C_B)NEWwoorld — команды проекта$(C_N)"
	@echo
	@awk 'BEGIN {FS = ":.*##"} \
		/^[a-zA-Z0-9_-]+:.*##/ { \
			cmd = $$1; sub(/^[^a-zA-Z0-9_-]*/, "", cmd); \
			printf "  $(C_G)%-18s$(C_N) %s\n", cmd, $$2 }' $(MAKEFILE_LIST)
	@echo
	@echo "$(C_B)Группы:$(C_N)"
	@echo "  setup      установка окружения (идемпотентно)"
	@echo "  check      все проверки без Godot"
	@echo "  test       тесты GUT (нужен Godot)"
	@echo "  ext        сборка C++ GDExtension"
	@echo "  assets     оптимизация .glb/.gltf"
	@echo
	@echo "$(C_B)Переменные:$(C_N)"
	@echo "  GODOT_BIN=$(if $(GODOT_BIN),$(GODOT_BIN),<не найден>)"
	@echo "  JOBS=$(JOBS)  PLATFORM=$(PLATFORM)  TARGET=$(TARGET)  ARCH=$(ARCH)"
	@echo

# ========================================================= установка ======

.PHONY: setup venv deps godot-cpp gut project
setup: ## Установить всё окружение (идемпотентно)
	@bash tools/setup/setup.sh

venv: ## Только Python venv + gdtoolkit + SCons
	@test -x $(VENV)/bin/python || python3 -m venv $(VENV)
	@$(VENV)/bin/pip install --quiet --upgrade pip
	@$(VENV)/bin/pip install --quiet "gdtoolkit==4.5.0" "scons==4.11.1"
	@echo "  ✓ venv готов"

deps: ## Только Node-зависимости ассет-конвейера
	@cd tools/asset-pipeline && npm install --no-audit --no-fund
	@echo "  ✓ node_modules готовы"

godot-cpp: ## Только godot-cpp + генерация привязок
	@git submodule update --init --recursive gdextension/godot-cpp
	@test -d gdextension/godot-cpp/gen/include || \
		(cd gdextension/godot-cpp && $(VENV)/bin/python -c \
		"import binding_generator, pathlib; \
		binding_generator.generate_bindings('gdextension/extension_api.json', True, '32', 'single', '.')")
	@echo "  ✓ godot-cpp готов"

gut: ## Только тестовый фреймворк GUT
	@bash -c 'test -f game/addons/gut/plugin.cfg && echo "  ✓ GUT уже установлен" || bash tools/setup/setup.sh'

project: ## Перегенерировать game/project.godot
	@python3 tools/setup/generate_project_godot.py

# =========================================================== проверки =====

.PHONY: check verify quick strict lint format scenes shaders contract data hygiene cpp all-checks
check: verify ## Все проверки, доступные без Godot

verify: ## Полная проверка (tools/verify/verify_all.sh)
	@$(VERIFY)

quick: ## Быстрая проверка: только линтеры GDScript
	@$(VERIFY) --quick

strict: ## Полная проверка, предупреждения считаются ошибками
	@$(VERIFY) --strict

lint: ## GDScript: синтаксис + формат + стиль + API + вызовы
	@bash tools/lint/lint_gdscript.sh

format: ## То же, но с автоисправлением формата (--fix)
	@bash tools/lint/lint_gdscript.sh --fix

scenes: ## Сцены и ресурсы: структура, ссылки, висячие res://-пути
	@python3 tools/lint/godot_scene_check.py

shaders: ## Шейдеры: синтаксис и соглашения
	@python3 tools/lint/shader_check.py

api: ## Только проверка API движка по extension_api.json
	@python3 tools/lint/godot_api_check.py

calls: ## Только проверка арности и типов аргументов в вызовах
	@python3 tools/lint/gdscript_call_check.py

contract: ## Контракт GDScript <-> C++ (ключи осколков, entry_symbol, bind_method)
	@python3 tools/verify/check_backend_contract.py --strict

data: ## Данные: JSON, project.godot, профили качества
	@python3 tools/verify/check_data.py

hygiene: ## Гигиена репозитория: артефакты, .gitignore, LFS
	@python3 tools/verify/check_repo_hygiene.py

cpp: ## C++ GDExtension: компиляция до объектных файлов
	@bash tools/cpp/syntax_check.sh --objects

cpp-syntax: ## C++ GDExtension: только синтаксис (быстрее)
	@bash tools/cpp/syntax_check.sh --syntax

assets-check: ## Ассет-конвейер: проверка работоспособности
	@node tools/asset-pipeline/scripts/check_pipeline.mjs

all-checks: lint scenes shaders contract data hygiene cpp ## Всё по отдельности, с выводами

# ============================================================== тесты ======

.PHONY: test test-smoke test-unit test-integration test-list godot-import
.PHONY: run run-map run-editor viz-map
test: ## Тесты GUT в Godot (нужен GODOT_BIN)
	@test -n "$(GODOT_BIN)" || { \
		echo "  ✗ Godot не найден. Укажите GODOT_BIN=/path/to/godot make test"; exit 2; }
	@$(GODOT_BIN) --headless --path game -s addons/gut/gut_cmdln.gd \
		-gconfig=res://.gutconfig.json -gexit

test-smoke: ## Только смоук-тесты: всё критичное загружается
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --headless --path game -s addons/gut/gut_cmdln.gd \
		-gdir=res://tests/smoke -gprefix=test_ -gsuffix=.gd -gexit

test-unit: ## Только модульные тесты
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --headless --path game -s addons/gut/gut_cmdln.gd \
		-gdir=res://tests/unit -gprefix=test_ -gsuffix=.gd -gexit

test-integration: ## Только интеграционные тесты
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --headless --path game -s addons/gut/gut_cmdln.gd \
		-gdir=res://tests/integration -gprefix=test_ -gsuffix=.gd -gexit

godot-import: ## Импорт ресурсов Godot (нужен GODOT_BIN)
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --headless --path game --import --quit

run: ## Запустить игру с главного меню (нужен GODOT_BIN)
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --path game

# Карта запускается ОТДЕЛЬНОЙ целью, а не через меню: это рабочая тестовая
# сцена этапов 1–2. Игрок появляется прямо у деревенского дома
# (start_poi = 0, spawn_at_start_poi = true в сцене), поэтому интерьер
# виден сразу, без прохождения меню и без поиска точки на 500 метрах.
run-map: ## Запустить карту 500×500 м напрямую, минуя меню
	@test -n "$(GODOT_BIN)" || { \
		echo "  ✗ Godot не найден. Укажите GODOT_BIN=/path/to/godot make run-map"; exit 2; }
	@echo "  игрок появится у деревенского дома; F10 — деревня, F11 — бункер"
	@$(GODOT_BIN) --path game res://scenes/game/military_map.tscn

# Схема карты — честная замена снимку игры: песочница не может запустить
# Godot, но план карты целиком описан числами в map_config.gd, и из них
# строится чертёж. Числа читаются из исходника, поэтому схема не отстаёт.
viz-map: ## Перерисовать схему карты из констант map_config.gd
	@$(PYTHON) tools/viz/map_schematic.py

run-editor: ## Открыть проект в редакторе Godot
	@test -n "$(GODOT_BIN)" || { echo "  ✗ нужен Godot"; exit 2; }
	@$(GODOT_BIN) --editor --path game

# ============================================== сборка C++ расширения =====

.PHONY: ext ext-clean ext-check
ext: ## Собрать GDExtension (нужны scons и C++-компилятор)
	@test -n "$(SCONS)" || { echo "  ✗ scons не найден (make venv)"; exit 2; }
	@test -d gdextension/godot-cpp/gen/include || { \
		echo "  ✗ привязки не сгенерированы (make godot-cpp)"; exit 2; }
	@cd gdextension && $(SCONS) platform=$(PLATFORM) target=$(TARGET) arch=$(ARCH) -j$(JOBS)
	@echo "  ✓ библиотека собрана"
	@ls -lh game/bin/*.so game/bin/*.dll game/bin/*.dylib 2>/dev/null || true

ext-clean: ## Очистить артефакты сборки C++
	@cd gdextension && rm -rf build .sconsign.dblite
	@rm -f game/bin/*.so game/bin/*.dll game/bin/*.dylib game/bin/*.wasm
	@echo "  ✓ очищено"

ext-check: ## Проверить C++ без полной сборки (компиляция до .o)
	@bash tools/cpp/syntax_check.sh --objects

# ============================================================== ассеты ====

.PHONY: assets-optimize assets-validate
assets-optimize: ## Оптимизировать все .glb/.gltf в game/assets/models
	@node tools/asset-pipeline/scripts/optimize_models.mjs game/assets/models

assets-validate: ## Проверить все модели на соответствие glTF 2.0
	@node tools/asset-pipeline/scripts/validate_models.mjs game/assets/models

# ============================================================== очистка ===

.PHONY: clean clean-all
clean: ## Удалить артефакты сборки и кэши
	@find . -type d -name __pycache__ -not -path './.venv/*' -not -path './.git/*' \
		-not -path './gdextension/godot-cpp/*' -exec rm -rf {} + 2>/dev/null || true
	@rm -rf gdextension/build game/.godot/imported 2>/dev/null || true
	@echo "  ✓ кэши и артефакты удалены"

clean-all: clean ext-clean ## Удалить всё перегенерируемое, включая node_modules
	@rm -rf tools/asset-pipeline/node_modules
	@echo "  ✓ полная очистка (venv и подмодули сохранены)"

# ============================================================== релиз =====

.PHONY: version
version: ## Показать версию проекта и целевую версию Godot
	@python3 - <<'PY'
	import re, pathlib
	text = pathlib.Path("game/scripts/autoload/game_config.gd").read_text(encoding="utf-8")
	parts = dict(re.findall(r"const VERSION_(MAJOR|MINOR|PATCH): int = (\d+)", text))
	schema = re.search(r"const SAVE_SCHEMA_VERSION: int = (\d+)", text)
	print("  версия игры:  %s.%s.%s" % (parts.get("MAJOR","?"), parts.get("MINOR","?"), parts.get("PATCH","?")))
	print("  схема сейва:  %s" % (schema.group(1) if schema else "?"))
	features = pathlib.Path("game/project.godot").read_text(encoding="utf-8")
	match = re.search(r'config/features=PackedStringArray\(([^)]*)\)', features)
	print("  движок:       %s" % (match.group(1).strip() if match else "?"))
	PY

.PHONY: ci
ci: lint scenes shaders contract data hygiene cpp ## То же, что запускает CI
	@echo
	@echo "$(C_G)CI-набор проверок пройден$(C_N)"

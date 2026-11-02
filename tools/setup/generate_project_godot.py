#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Генератор game/project.godot для NEWwoorld.

Зачем скрипт, а не ручной файл:
  * сериализация Object(InputEventKey, ...) в Godot — формат строгий и
    многословный; руками в нём легко ошибиться, а редактор потом молча
    пересохранит файл иначе и получится шумный diff;
  * input map описывается декларативной таблицей ACTIONS — добавил строку,
    перегенерировал, получил клавиатуру + геймпад сразу;
  * файл идемпотентен: повторный запуск даёт байт-в-байт тот же результат.

Запуск:  python3 tools/setup/generate_project_godot.py
"""

from __future__ import annotations

import os
import sys
from typing import Dict, List, Sequence, Tuple

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_PATH = os.path.join(REPO_ROOT, "game", "project.godot")

# ---------------------------------------------------------------------------
#  Коды клавиш Godot 4 (enum Key). Буквы совпадают с ASCII.
# ---------------------------------------------------------------------------
KEY: Dict[str, int] = {
    "ESCAPE": 4194305,
    "TAB": 4194306,
    "BACKSPACE": 4194308,
    "ENTER": 4194309,
    "KP_ENTER": 4194310,
    "INSERT": 4194311,
    "DELETE": 4194312,
    "HOME": 4194317,
    "END": 4194318,
    "LEFT": 4194319,
    "UP": 4194320,
    "RIGHT": 4194321,
    "DOWN": 4194322,
    "PAGEUP": 4194323,
    "PAGEDOWN": 4194324,
    "SHIFT": 4194325,
    "CTRL": 4194326,
    "ALT": 4194328,
    "F1": 4194332,
    "F2": 4194333,
    "F3": 4194334,
    "F4": 4194335,
    "F5": 4194336,
    "F6": 4194337,
    "F7": 4194338,
    "F8": 4194339,
    "F9": 4194340,
    "F10": 4194341,
    "F11": 4194342,
    "F12": 4194343,
    "QUOTELEFT": 96,     # ` — клавиша под Esc, консоль разработчика
    "MINUS": 45,
    "EQUAL": 61,
    "BRACKETLEFT": 91,
    "BRACKETRIGHT": 93,
    "SEMICOLON": 59,
    "COMMA": 44,
    "PERIOD": 46,
    "SLASH": 47,
    "SPACE": 32,
}
for _i, _c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
    KEY[_c] = ord(_c)
for _i in range(10):
    KEY[str(_i)] = ord(str(_i))

# Кнопки геймпада (enum JoyButton)
JOY: Dict[str, int] = {
    "A": 0, "B": 1, "X": 2, "Y": 3,
    "BACK": 4, "GUIDE": 5, "START": 6,
    "LEFT_STICK": 7, "RIGHT_STICK": 8,
    "LEFT_SHOULDER": 9, "RIGHT_SHOULDER": 10,
    "DPAD_UP": 11, "DPAD_DOWN": 12, "DPAD_LEFT": 13, "DPAD_RIGHT": 14,
}
# Оси геймпада (enum JoyAxis)
JOY_AXIS: Dict[str, int] = {"LEFT_X": 0, "LEFT_Y": 1, "RIGHT_X": 2, "RIGHT_Y": 3}


def key_event(code: int, *, shift: bool = False, ctrl: bool = False,
              alt: bool = False, echo: bool = False, keycode: bool = False) -> str:
    """Сериализация InputEventKey в формат config-файла Godot 4."""
    field_kc = code if keycode else 0
    field_pk = 0 if keycode else code
    unicode_val = 0
    if not shift and not ctrl and not alt and 32 <= code < 127:
        unicode_val = code
    return (
        'Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"",'
        f'"device":-1,"window_id":0,"alt_pressed":{str(alt).lower()},'
        f'"shift_pressed":{str(shift).lower()},'
        f'"ctrl_pressed":{str(ctrl).lower()},'
        f'"meta_pressed":false,"pressed":false,'
        f'"keycode":{field_kc},"physical_keycode":{field_pk},'
        f'"key_label":0,"unicode":{unicode_val},"location":0,'
        f'"echo":{str(echo).lower()},"script":null)'
    )


def mouse_event(button_index: int, *, double_click: bool = False) -> str:
    """1 = left, 2 = right, 3 = middle, 4/5 = wheel."""
    return (
        'Object(InputEventMouseButton,"resource_local_to_scene":false,'
        '"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,'
        '"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,'
        f'"button_mask":{1 << (button_index - 1)},"position":Vector2(0, 0),'
        '"global_position":Vector2(0, 0),"factor":1.0,'
        f'"button_index":{button_index},"canceled":false,'
        f'"pressed":true,"double_click":{str(double_click).lower()},"script":null)'
    )


def joy_button_event(button_index: int) -> str:
    return (
        'Object(InputEventJoypadButton,"resource_local_to_scene":false,'
        f'"resource_name":"","device":-1,"button_index":{button_index},'
        '"pressure":0.0,"pressed":true,"script":null)'
    )


def joy_axis_event(axis: int, value: float) -> str:
    return (
        'Object(InputEventJoypadMotion,"resource_local_to_scene":false,'
        f'"resource_name":"","device":-1,"axis":{axis},'
        f'"axis_value":{value},"script":null)'
    )


# ---------------------------------------------------------------------------
#  Таблица действий. Каждое действие: (deadzone, [события]).
#  Принцип: каждое действие получает И клавиатуру/мышь, И геймпад.
#  Игрок не должен переназначать базовое управление, чтобы играть.
# ---------------------------------------------------------------------------
def build_actions() -> List[Tuple[str, float, List[str]]]:
    a: List[Tuple[str, float, List[str]]] = []

    def add(name: str, deadzone: float, *events: str) -> None:
        a.append((name, deadzone, list(events)))

    # --- Движение -------------------------------------------------------
    add("move_forward", 0.2, key_event(KEY["W"]),
        joy_axis_event(JOY_AXIS["LEFT_Y"], -1.0))
    add("move_back", 0.2, key_event(KEY["S"]),
        joy_axis_event(JOY_AXIS["LEFT_Y"], 1.0))
    add("move_left", 0.2, key_event(KEY["A"]),
        joy_axis_event(JOY_AXIS["LEFT_X"], -1.0))
    add("move_right", 0.2, key_event(KEY["D"]),
        joy_axis_event(JOY_AXIS["LEFT_X"], 1.0))
    add("sprint", 0.2, key_event(KEY["SHIFT"]), joy_button_event(JOY["LEFT_STICK"]))
    add("crouch", 0.2, key_event(KEY["CTRL"]), joy_button_event(JOY["B"]))
    add("jump", 0.2, key_event(KEY["SPACE"]), joy_button_event(JOY["A"]))
    add("interact", 0.2, key_event(KEY["E"]), joy_button_event(JOY["X"]))

    # --- Взгляд (мышь + правый стик) ------------------------------------
    add("look", 0.15,
        joy_axis_event(JOY_AXIS["RIGHT_X"], 1.0),
        joy_axis_event(JOY_AXIS["RIGHT_Y"], 1.0))

    # --- Действия -------------------------------------------------------
    add("primary_action", 0.2, mouse_event(1),
        joy_button_event(JOY["RIGHT_SHOULDER"]))
    add("secondary_action", 0.2, mouse_event(2),
        joy_button_event(JOY["LEFT_SHOULDER"]))
    add("reload", 0.2, key_event(KEY["R"]), joy_button_event(JOY["Y"]))
    add("drop", 0.2, key_event(KEY["G"]), joy_button_event(JOY["DPAD_DOWN"]))

    # --- Системные / UI --------------------------------------------------
    add("pause", 0.2, key_event(KEY["ESCAPE"]), joy_button_event(JOY["START"]))
    add("inventory", 0.2, key_event(KEY["TAB"]), joy_button_event(JOY["BACK"]))
    add("map", 0.2, key_event(KEY["M"]), joy_button_event(JOY["DPAD_UP"]))
    add("menu_accept", 0.2, key_event(KEY["ENTER"]), key_event(KEY["SPACE"]),
        joy_button_event(JOY["A"]))
    add("menu_cancel", 0.2, key_event(KEY["ESCAPE"]), joy_button_event(JOY["B"]))
    add("menu_up", 0.2, key_event(KEY["UP"]), joy_button_event(JOY["DPAD_UP"]),
        joy_axis_event(JOY_AXIS["LEFT_Y"], -1.0))
    add("menu_down", 0.2, key_event(KEY["DOWN"]), joy_button_event(JOY["DPAD_DOWN"]),
        joy_axis_event(JOY_AXIS["LEFT_Y"], 1.0))
    add("menu_left", 0.2, key_event(KEY["LEFT"]), joy_button_event(JOY["DPAD_LEFT"]),
        joy_axis_event(JOY_AXIS["LEFT_X"], -1.0))
    add("menu_right", 0.2, key_event(KEY["RIGHT"]), joy_button_event(JOY["DPAD_RIGHT"]),
        joy_axis_event(JOY_AXIS["LEFT_X"], 1.0))

    # --- Сохранения ------------------------------------------------------
    add("quick_save", 0.2, key_event(KEY["F5"]))
    add("quick_load", 0.2, key_event(KEY["F9"]))
    add("screenshot", 0.2, key_event(KEY["F12"]))

    # --- Отладка (выключается в релизном экспорте) ----------------------
    add("debug_fps", 0.2, key_event(KEY["F3"]))
    add("debug_physics", 0.2, key_event(KEY["F6"]))
    add("debug_wireframe", 0.2, key_event(KEY["F4"]))
    add("debug_console", 0.2, key_event(KEY["QUOTELEFT"]))
    add("debug_reload_shaders", 0.2, key_event(KEY["F7"]))

    return a


AUTOLOADS: Sequence[Tuple[str, str]] = (
    # Порядок = порядок инициализации. Зависимости стоят раньше зависимых.
    ("GameConfig",      "res://scripts/autoload/game_config.gd"),
    ("EventBus",        "res://scripts/autoload/event_bus.gd"),
    ("Diagnostics",     "res://scripts/autoload/diagnostics.gd"),
    ("PerfMonitor",     "res://scripts/autoload/perf_monitor.gd"),
    ("SettingsService", "res://scripts/autoload/settings_service.gd"),
    ("SaveService",     "res://scripts/autoload/save_service.gd"),
    ("AudioService",    "res://scripts/autoload/audio_service.gd"),
    ("SceneService",    "res://scripts/autoload/scene_service.gd"),
    ("QualityService",  "res://scripts/autoload/quality_service.gd"),
    ("ThemeService",    "res://scripts/ui/theme_builder.gd"),
    ("DestructionService", "res://scripts/systems/destruction_service.gd"),
)

RENDER_LAYERS_3D = ("Default", "FirstPerson", "Ghost", "Outline", "Fx",
                    "", "", "")
PHYSICS_LAYERS_3D = ("World", "Player", "Enemy", "Projectile", "Interactable",
                     "Debris", "Trigger", "Ragdoll")


def render() -> str:
    out: List[str] = []
    p = out.append

    p("; Engine configuration file.")
    p("; Файл сгенерирован: tools/setup/generate_project_godot.py")
    p("; НЕ править руками — правь генератор, иначе diff будет шумным.")
    p(";")
    p("; Он BEST-effort описывает проект NEWwoorld: Godot 4.5+ (тестировалось на 4.7.2),")
    p("; рендер Forward Plus, GDExtension на C++, GUT для тестов.")
    p("")
    p("config_version=5")
    p("")

    # ---------------- [application] ----------------
    p("[application]")
    p("")
    p('config/name="NEWwoorld"')
    p('config/description="Игровой проект на Godot 4: 3D, Forward Plus, '
      'C++ GDExtension для тяжёлых систем (разрушение, процедурный ветер), '
      'полный цикл меню -> настройки -> игра. Спецификация: TZ.md"')
    p('config/version="0.1.0"')
    p('run/main_scene="res://scenes/boot/boot.tscn"')
    p('config/features=PackedStringArray("4.5", "Forward Plus")')
    p('config/icon="res://icon.svg"')
    p('boot_splash/show_image=true')
    p('boot_splash/bg_color=Color(0.055, 0.063, 0.082, 1)')
    p('run/max_fps=0')
    p('run/low_processor_mode=false')
    p("")

    # ---------------- [autoload] ----------------
    p("[autoload]")
    p("")
    for name, path in AUTOLOADS:
        p(f'{name}="*{path}"')
    p("")

    # ---------------- [debug] ----------------
    p("[debug]")
    p("")
    p("settings/stdout/verbose_stdout=false")
    p("settings/gdscript/max_warnings_per_line=32")
    p('settings/gdscript/warnings/untyped_declaration="warning"')
    p('settings/gdscript/warnings/inferred_declaration="ignore"')
    p('settings/gdscript/warnings/unsafe_property_access="warning"')
    p('settings/gdscript/warnings/unsafe_method_access="warning"')
    p('settings/gdscript/warnings/unsafe_cast="warning"')
    p('settings/gdscript/warnings/unsafe_call_argument="warning"')
    p('settings/gdscript/warnings/integer_division="warning"')
    p("")

    # ---------------- [display] ----------------
    p("[display]")
    p("")
    p("window/size/viewport_width=1920")
    p("window/size/viewport_height=1080")
    p("window/size/window_width_override=1280")
    p("window/size/window_height_override=720")
    p("window/size/mode=0")
    p("window/size/resizable=true")
    p("window/size/borderless=false")
    p("window/stretch/mode=\"canvas_items\"")
    p("window/stretch/aspect=\"expand\"")
    p("window/stretch/scale_mode=\"integer\"")
    p("window/vsync/vsync_mode=1")
    p("window/handheld/orientation=0")
    p("")

    # ---------------- [editor_plugins] ----------------
    p("[editor_plugins]")
    p("")
    p('enabled=PackedStringArray("res://addons/gut/plugin.cfg")')
    p("")

    # ---------------- [gui] ----------------
    p("[gui]")
    p("")
    p("theme/custom_font_size=16")
    p("timers/tooltip_delay=0.35")
    p("")

    # ---------------- [input] ----------------
    p("[input]")
    p("")
    for name, deadzone, events in build_actions():
        p(f"{name}={{")
        p(f'"deadzone": {deadzone},')
        p('"events": [' + ", ".join(events))
        p("]")
        p("}")
    p("")

    # ---------------- [input_devices] ----------------
    p("[input_devices]")
    p("")
    p("pointing/emulate_touch_from_mouse=false")
    p("pointing/emulate_mouse_from_touch=false")
    p("")

    # ---------------- [internationalization] ----------------
    p("[internationalization]")
    p("")
    p('locale/fallback="en"')
    p('locale/test=""')
    p("")

    # ---------------- [layer_names] ----------------
    p("[layer_names]")
    p("")
    for i, layer in enumerate(RENDER_LAYERS_3D, start=1):
        if layer:
            p(f'3d_render/layer_{i}="{layer}"')
    for i, layer in enumerate(PHYSICS_LAYERS_3D, start=1):
        p(f'3d_physics/layer_{i}="{layer}"')
    p("")

    # ---------------- [physics] ----------------
    p("[physics]")
    p("")
    p("common/physics_ticks_per_second=60")
    p("common/max_physics_steps_per_frame=16")
    p("3d/default_gravity=9.81")
    p("3d/default_linear_damp=0.1")
    p("3d/default_angular_damp=0.1")
    p("3d/run_on_separate_thread=false")
    p("2d/run_on_separate_thread=false")
    p("")

    # ---------------- [rendering] ----------------
    p("[rendering]")
    p("")
    p('renderer/rendering_method="forward_plus"')
    p('renderer/rendering_method.mobile="mobile"')
    p("textures/canvas_textures/default_texture_filter=1")
    p("textures/vram_compression/import_etc2_astc=true")
    p("textures/vram_compression/import_s3tc_bptc=true")
    p("anti_aliasing/quality/msaa_2d=0")
    p("anti_aliasing/quality/msaa_3d=2")
    p("anti_aliasing/quality/screen_space_aa=1")
    p("anti_aliasing/quality/use_taa=true")
    p("lights_and_shadows/directional_shadow/size=4096")
    p("lights_and_shadows/directional_shadow/soft_shadow_filter_quality=2")
    p("lights_and_shadows/positional_shadow/soft_shadow_filter_quality=2")
    p("occlusion_culling/use_occlusion_culling=true")
    p("occlusion_culling/occlusion_rays_per_thread=1024")
    p("scaling_3d/mode=1")
    p("scaling_3d/scale=1.0")
    p("scaling_3d/fsr_sharpness=0.2")
    p("environment/defaults/default_clear_color=Color(0.055, 0.063, 0.082, 1)")
    p('environment/defaults/default_environment="res://resources/environment/default_env.tres"')
    p("2d/snap/snap_2d_transforms_to_pixel=true")
    p("2d/snap/snap_2d_vertices_to_pixel=false")
    p("global_illumination/gi/use_half_resolution=false")
    p("batching/lights/max_lights_per_item=64")
    p("")

    p("; ---- Сгенерировано. Не редактировать вручную. ----")
    return "\n".join(out) + "\n"


def check() -> int:
    """Сверяет project.godot на диске с тем, что выдал бы генератор.

    Зачем. Файл сгенерирован, но его МОЖНО отредактировать вручную — и
    редактор Godot делает это сам при любом изменении настроек проекта.
    Правка не ломает игру сразу: она молча расходится с генератором, и
    следующая регенерация стирает её без следа. Хуже того, расхождение
    может жить месяцами, и тогда невозможно понять, что из файла правда,
    а что — устаревший артефакт.

    Возвращает код процесса: 0 — совпадает, 1 — разошлось, 2 — файла нет.
    """
    expected = render()
    rel = os.path.relpath(OUT_PATH, REPO_ROOT)

    if not os.path.isfile(OUT_PATH):
        print(f"ОШИБКА  {rel} отсутствует. Выполните:")
        print(f"        python3 {os.path.relpath(__file__, REPO_ROOT)}")
        return 2

    with open(OUT_PATH, "r", encoding="utf-8", newline="") as fh:
        actual = fh.read()

    if actual == expected:
        print(f"OK  {rel} совпадает с генератором "
              f"({len(expected.splitlines())} строк)")
        return 0

    # Печатаем конкретные разошедшиеся строки: «файлы отличаются» без
    # указания, где именно, заставляет запускать diff вручную.
    expected_lines = expected.splitlines()
    actual_lines = actual.splitlines()
    diffs: List[str] = []
    for index in range(max(len(expected_lines), len(actual_lines))):
        want = expected_lines[index] if index < len(expected_lines) else "<нет строки>"
        got = actual_lines[index] if index < len(actual_lines) else "<нет строки>"
        if want != got:
            diffs.append(f"  строка {index + 1}:\n"
                         f"    генератор: {want}\n"
                         f"    в файле  : {got}")

    print(f"ОШИБКА  {rel} разошёлся с генератором "
          f"({len(diffs)} расхождений):")
    for line in diffs[:15]:
        print(line)
    if len(diffs) > 15:
        print(f"  ...и ещё {len(diffs) - 15}")
    print()
    print("Возможные причины:")
    print("  * файл правили вручную — перенесите правку в генератор;")
    print("  * редактор Godot пересохранил проект — перегенерируйте файл;")
    print("  * изменили генератор, но не запустили его.")
    print()
    print(f"Исправление: python3 {os.path.relpath(__file__, REPO_ROOT)}")
    return 1


def main(argv: Sequence[str]) -> int:
    if "--check" in argv:
        return check()
    if "--help" in argv or "-h" in argv:
        print(__doc__.strip())
        print()
        print("Флаги:")
        print("  --check   не записывать файл, а сверить существующий с")
        print("            результатом генератора (код 1 при расхождении)")
        print("  --help    эта справка")
        return 0

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    text = render()
    with open(OUT_PATH, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    actions = len(build_actions())
    print(f"OK  {os.path.relpath(OUT_PATH, REPO_ROOT)}  "
          f"({len(text.splitlines())} строк, {actions} input actions, "
          f"{len(AUTOLOADS)} autoloads)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

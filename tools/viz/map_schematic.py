#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Рисует схему карты 500×500 м по КОНСТАНТАМ из исходника.

ЗАЧЕМ ЭТОТ СКРИПТ СУЩЕСТВУЕТ. Снимок игры в песочнице сделать нельзя: там нет
ни бинарника Godot, ни дисплея. Зато план карты целиком описан числами в
`game/scripts/world/map_config.gd`, и из этих чисел можно построить честный
чертёж — не иллюстрацию «как примерно выглядит», а проекцию того, что игра
действительно построит.

Все числа ЧИТАЮТСЯ из исходника, а не зашиты сюда. Иначе схема начала бы
врать после первой же правки баланса — ровно тот класс ошибки, против
которого построен весь репозиторий.

Запуск:  python3 tools/viz/map_schematic.py [-o docs/images/map-schematic.png]
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys
from typing import Dict, Tuple

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG = os.path.join(REPO, "game", "scripts", "world", "map_config.gd")

# Палитра: тёмный чертёж. Акценты разделены по смыслу — тёплый для жилья,
# холодный для фортификации, красный только для разрушения.
BG = (14, 17, 22)
PANEL = (19, 23, 30)
GRID = (30, 37, 48)
GRID_MAJOR = (44, 53, 68)
OUTLINE = (86, 100, 120)
TEXT = (199, 208, 218)
MUTED = (110, 122, 136)
VILLAGE = (201, 162, 39)
BUNKER = (79, 163, 199)
BLAST = (226, 87, 76)
STREAM = (126, 178, 122)
ROAD = (150, 138, 112)

SS = 2  # Суперсэмплинг: рисуем вдвое крупнее и уменьшаем — линии без «ступенек».


def parse_stage3() -> Dict[str, float]:
    """Константы разрушения этапа 3 — из тех файлов, где они объявлены.

    Легенда схемы обязана совпадать с игрой, а не с воспоминанием о ней:
    порог обрушения и ячейка нарезки стекла уже менялись по ходу этапа.
    """
    targets = {
        "BEARING_LOSS_RATIO": "game/scripts/world/structure.gd",
        "SLAB_LOSS_RATIO": "game/scripts/world/structure.gd",
        "GLASS_FRACTURE_CELL": "game/scripts/world/interior_builder.gd",
        "GLASS_SHARD_SIZE": "game/scripts/world/interior_builder.gd",
        "FUSE_SECONDS": "game/scripts/systems/grenade.gd",
    }
    out: Dict[str, float] = {}
    for name, rel in targets.items():
        path = os.path.join(REPO, rel)
        with open(path, "r", encoding="utf-8") as fh:
            match = re.search(r"^const %s:\s*float\s*=\s*([\d.]+)" % name, fh.read(), re.M)
        if match is None:
            raise SystemExit("%s больше не содержит const %s" % (rel, name))
        out[name] = float(match.group(1))
    return out


def parse_config(path: str) -> Dict[str, object]:
    """Достаёт константы карты из GDScript-исходника.

    Поддерживает и скаляры, и Vector3, потому что центры точек интереса
    заданы вектором, а не парой чисел.
    """
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()

    out: Dict[str, object] = {}
    scalar = re.compile(r"^const\s+([A-Z][A-Z0-9_]*)\s*:\s*float\s*=\s*([-\d.]+)", re.M)
    integer = re.compile(r"^const\s+([A-Z][A-Z0-9_]*)\s*:\s*int\s*=\s*([-\d]+)", re.M)
    vector = re.compile(
        r"^const\s+([A-Z][A-Z0-9_]*)\s*:\s*Vector3\s*=\s*"
        r"Vector3\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)",
        re.M,
    )
    for m in scalar.finditer(text):
        out[m.group(1)] = float(m.group(2))
    for m in integer.finditer(text):
        out[m.group(1)] = int(m.group(2))
    for m in vector.finditer(text):
        out[m.group(1)] = (float(m.group(2)), float(m.group(3)), float(m.group(4)))

    required = [
        "MAP_SIZE", "CHUNK_SIZE", "STREAM_RADIUS", "VILLAGE_RADIUS",
        "VILLAGE_CENTER", "BUNKER_CENTER", "BUNKER_SIZE", "EXPLOSION_RADIUS",
    ]
    missing = [k for k in required if k not in out]
    if missing:
        raise SystemExit(
            "map_config.gd больше не содержит %s — схема не может быть построена "
            "по устаревшим числам" % ", ".join(missing)
        )
    return out


class Sheet:
    """Холст с суперсэмплингом и одной системой координат для панелей."""

    def __init__(self, width: int, height: int):
        from PIL import Image

        self.size = (width, height)
        self.img = Image.new("RGB", (width * SS, height * SS), BG)
        from PIL import ImageDraw

        self.d = ImageDraw.Draw(self.img)
        self.fonts: Dict[int, object] = {}

    def font(self, size: int, bold: bool = False) -> object:
        from PIL import ImageFont

        key = (size, bold)
        if key not in self.fonts:
            name = "DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"
            path = "/usr/share/fonts/truetype/dejavu/" + name
            self.fonts[key] = ImageFont.truetype(path, size * SS)
        return self.fonts[key]

    def line(self, a: Tuple[float, float], b: Tuple[float, float], color, w: int = 1) -> None:
        self.d.line([a[0] * SS, a[1] * SS, b[0] * SS, b[1] * SS], fill=color, width=w * SS)

    def rect(self, a, b, color, w: int = 1, fill=None) -> None:
        self.d.rectangle(
            [a[0] * SS, a[1] * SS, b[0] * SS, b[1] * SS], outline=color, width=w * SS, fill=fill
        )

    def ellipse(self, cx: float, cy: float, r: float, color, w: int = 1, fill=None) -> None:
        self.d.ellipse(
            [(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS],
            outline=color, width=w * SS, fill=fill,
        )

    def text(self, at, s: str, color=TEXT, size: int = 9, bold: bool = False,
             anchor: str = "la") -> None:
        self.d.text((at[0] * SS, at[1] * SS), s, fill=color,
                    font=self.font(size, bold), anchor=anchor)

    def dash_circle(self, cx: float, cy: float, r: float, color, w: int = 1,
                    segments: int = 72) -> None:
        """Пунктирная окружность: сплошная reserved за границами панели."""
        step = (math.tau / segments)
        for i in range(0, segments, 2):
            a0, a1 = i * step, (i + 1) * step
            self.d.arc(
                [(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS],
                math.degrees(a0), math.degrees(a1), fill=color, width=w * SS,
            )

    def save(self, path: str) -> None:
        from PIL import Image

        out = self.img.resize(self.size, Image.LANCZOS)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        out.save(path, optimize=True)


def draw_map_panel(s: Sheet, cfg: Dict[str, object], box: Tuple[int, int, int, int]) -> None:
    """Вид сверху на всю карту: сетка чанков и обе точки интереса."""
    x0, y0, x1, y1 = box
    s.rect((x0, y0), (x1, y1), OUTLINE, 1, PANEL)
    s.text((x0 + 12, y0 + 9), "КАРТА  ·  вид сверху", TEXT, 10, True)

    map_size = float(cfg["MAP_SIZE"])
    chunk = float(cfg["CHUNK_SIZE"])
    pad = 34
    px0, py0 = x0 + pad, y0 + pad + 6
    side = min(x1 - px0 - pad, y1 - py0 - pad - 14)
    k = side / map_size

    def to_px(wx: float, wz: float) -> Tuple[float, float]:
        # Мировой +Z смотрит ВНИЗ по изображению: так схема совпадает с тем,
        # что видит игрок, стоящий лицом на север (-Z).
        return px0 + (wx + map_size * 0.5) * k, py0 + (wz + map_size * 0.5) * k

    steps = int(round(map_size / chunk))
    for i in range(steps + 1):
        wx = -map_size * 0.5 + i * chunk
        a = to_px(wx, -map_size * 0.5)
        b = to_px(wx, map_size * 0.5)
        major = i % 4 == 0
        s.line(a, b, GRID_MAJOR if major else GRID, 1 if major else 1)
        a = to_px(-map_size * 0.5, wx)
        b = to_px(map_size * 0.5, wx)
        s.line(a, b, GRID_MAJOR if major else GRID, 1)

    cx, cy = to_px(-map_size * 0.5, -map_size * 0.5)
    s.rect((cx, cy), (cx + side, cy + side), OUTLINE, 2)

    # Деревня: круг радиуса размещения и отметка центра.
    vx, vy = to_px(*[cfg["VILLAGE_CENTER"][0], cfg["VILLAGE_CENTER"][2]])
    vr = float(cfg["VILLAGE_RADIUS"]) * k
    s.dash_circle(vx, vy, vr, VILLAGE, 2)
    s.ellipse(vx, vy, 3.5, VILLAGE, 1, VILLAGE)
    s.text((vx + 7, vy - 15), "ДЕРЕВНЯ", VILLAGE, 9, True)
    s.text((vx + 7, vy - 4), "%d домов · r=%.0f м"
           % (int(cfg.get("VILLAGE_HOUSE_COUNT", 0)), float(cfg["VILLAGE_RADIUS"])),
           MUTED, 8)

    # Бункер: прямоугольник реальных габаритов в плане.
    bx, by = to_px(*[cfg["BUNKER_CENTER"][0], cfg["BUNKER_CENTER"][2]])
    bw = float(cfg["BUNKER_SIZE"][0]) * k
    bh = float(cfg["BUNKER_SIZE"][2]) * k
    # Габариты бункера меньше пикселя на общем виде — рисуем с увеличением,
    # иначе точка интереса превратится в невидимую точку, а она обязательна.
    bw, bh = max(bw, 7.0), max(bh, 5.0)
    s.rect((bx - bw / 2, by - bh / 2), (bx + bw / 2, by + bh / 2), BUNKER, 2)
    s.text((bx + 9, by - 13), "БУНКЕР", BUNKER, 9, True)
    s.text((bx + 9, by - 2), "%.0f×%.0f м · заглублён на %.1f м"
           % (float(cfg["BUNKER_SIZE"][0]), float(cfg["BUNKER_SIZE"][2]),
              float(cfg.get("BUNKER_DEPTH", 0.0))), MUTED, 8)

    # Масштабная линейка и подписи осей.
    bar = 100.0 * k
    lx, ly = px0 + 8, cy + side + 11
    s.line((lx, ly), (lx + bar, ly), TEXT, 2)
    s.line((lx, ly - 3), (lx, ly + 3), TEXT, 2)
    s.line((lx + bar, ly - 3), (lx + bar, ly + 3), TEXT, 2)
    s.text((lx + bar / 2, ly - 12), "100 м", TEXT, 8, anchor="ma")
    s.text((px0 + side / 2, y0 + 9), "-Z  север", MUTED, 8, anchor="ma")
    s.text((x1 - 12, py0 + side / 2), "+X", MUTED, 8, anchor="rm")
    s.text((px0 - 22, py0 + side / 2), "-X", MUTED, 8, anchor="lm")

    s.text((px0 + side + 12, py0 + 4), "чанк %g м" % chunk, MUTED, 8)
    s.text((px0 + side + 12, py0 + 16), "%d×%d = %d чанков"
           % (steps, steps, int(cfg.get("CHUNK_COUNT", steps * steps))), MUTED, 8)
    s.text((px0 + side + 12, py0 + 34), "деревьев %d" % int(cfg.get("TREE_COUNT", 0)), MUTED, 8)
    s.text((px0 + side + 12, py0 + 46), "кустарника %d" % int(cfg.get("SCRUB_COUNT", 0)), MUTED, 8)
    return


def draw_detail_panel(s: Sheet, cfg: Dict[str, object],
                      box: Tuple[int, int, int, int]) -> None:
    """Приближение на деревню: окно стриминга и радиус взрыва в масштабе."""
    x0, y0, x1, y1 = box
    s.rect((x0, y0), (x1, y1), OUTLINE, 1, PANEL)
    s.text((x0 + 12, y0 + 9), "ДЕРЕВНЯ  ·  приближение", TEXT, 10, True)

    chunk = float(cfg["CHUNK_SIZE"])
    radius = int(cfg["STREAM_RADIUS"])
    window = (2 * radius + 1) * chunk
    half = window * 0.5 + chunk
    pad = 26
    px0, py0 = x0 + pad, y0 + pad + 8
    side = min(x1 - px0 - pad, y1 - py0 - pad - 12)
    k = side / (half * 2.0)

    vcx, vcz = cfg["VILLAGE_CENTER"][0], cfg["VILLAGE_CENTER"][2]

    def to_px(wx: float, wz: float) -> Tuple[float, float]:
        return px0 + (wx - vcx + half) * k, py0 + (wz - vcz + half) * k

    for i in range(2 * radius + 2):
        wx = vcx - half + i * chunk
        a = to_px(wx, vcz - half)
        b = to_px(wx, vcz + half)
        s.line(a, b, GRID, 1)
        wz = vcz - half + i * chunk
        a = to_px(vcx - half, wz)
        b = to_px(vcx + half, wz)
        s.line(a, b, GRID, 1)

    # Окно стриминга: чанки, которые держатся в памяти вокруг игрока.
    ax, ay = to_px(vcx - radius * chunk, vcz - radius * chunk)
    bx, by = to_px(vcx + radius * chunk, vcz + radius * chunk)
    s.rect((ax, ay), (bx, by), STREAM, 2)
    s.text((ax, ay - 12), "в памяти: %d чанков (%g м)"
           % (int(cfg.get("STREAM_ACTIVE_CHUNKS", (2 * radius + 1) ** 2)), window),
           STREAM, 8)

    # Радиус взрыва гранаты — в том же масштабе, что и карта.
    vx, vy = to_px(vcx, vcz)
    er = float(cfg["EXPLOSION_RADIUS"]) * k
    s.ellipse(vx, vy, er, BLAST, 2)
    s.ellipse(vx, vy, 2.5, BLAST, 1, BLAST)
    s.text((vx + er + 6, vy - 5), "взрыв r=%.1f м" % float(cfg["EXPLOSION_RADIUS"]), BLAST, 8)

    vr = float(cfg["VILLAGE_RADIUS"]) * k
    s.dash_circle(vx, vy, vr, VILLAGE, 1)
    s.text((vx, vy + vr + 8), "граница размещения деревни r=%.0f м"
           % float(cfg["VILLAGE_RADIUS"]), VILLAGE, 8, anchor="ma")

    # Заметки — вниз панели: справа сверху они висели в пустоте, а окно
    # стриминга и без того занимает центр.
    s.text((x1 - 12, y1 - 30), "масштаб: %.3g м/пикс" % (1.0 / k), MUTED, 8, anchor="ra")
    s.text((x1 - 12, y1 - 18), "граница окна на %d чанка" % radius, MUTED, 8, anchor="ra")


def draw_legend(s: Sheet, cfg: Dict[str, object], stage: Dict[str, float],
                box: Tuple[int, int, int, int]) -> None:
    """Подпись: что именно нарисовано и откуда взяты числа."""
    x0, y0, x1, y1 = box
    s.rect((x0, y0), (x1, y1), OUTLINE, 1, PANEL)
    s.text((x0 + 12, y0 + 8), "ПРОЧНОСТЬ И ВЗРЫВ", TEXT, 9, True)

    rows = [
        ("стекло", cfg.get("INTEGRITY_GLASS"), BLAST),
        ("дерево", cfg.get("INTEGRITY_WOOD"), ROAD),
        ("кирпич", cfg.get("INTEGRITY_BRICK"), VILLAGE),
        ("металл. дверь", cfg.get("INTEGRITY_METAL_DOOR"), BUNKER),
        ("бетон", cfg.get("INTEGRITY_CONCRETE"), OUTLINE),
        ("железобетон", cfg.get("INTEGRITY_REINFORCED"), MUTED),
    ]
    values = [float(v) for _, v, _ in rows if v is not None]
    top = max(values) if values else 1.0
    y = y0 + 26
    for label, value, color in rows:
        if value is None:
            continue
        w = max(3.0, float(value) / top * 150.0)
        s.rect((x0 + 108, y), (x0 + 108 + w, y + 7), color, 1, color)
        s.text((x0 + 12, y - 1), label, TEXT, 8)
        s.text((x0 + 116 + w, y - 1), "%g" % float(value), MUTED, 8)
        y += 13

    s.text((x0 + 290, y0 + 8), "ЭНЕРГИЯ ВЗРЫВА", TEXT, 9, True)
    s.text((x0 + 290, y0 + 24), "%g ед. при радиусе %g м"
           % (float(cfg.get("EXPLOSION_ENERGY", 0.0)), float(cfg["EXPLOSION_RADIUS"])), TEXT, 8)
    s.text((x0 + 290, y0 + 38), "затухание (1 − d/r)²", MUTED, 8)
    s.text((x0 + 290, y0 + 50), "энергия = сила × затухание²", MUTED, 8)
    s.text((x0 + 290, y0 + 66), "стекло сдаётся первым:", MUTED, 8)
    s.text((x0 + 290, y0 + 78), "прочность на порядок ниже стены", MUTED, 8)
    s.text((x0 + 290, y0 + 94), "семя раскладки: %d" % int(cfg.get("DEFAULT_SEED", 0)), MUTED, 8)

    # То, что этап 3 добавил в разрушение, — второй строкой легенды. Третьим
    # столбцом он не помещается: панель 524 px, а строки длиннее столбца.
    # Числа приходят из кода, поэтому легенда не может отстать от игры.
    ry = y0 + 112
    s.line((x0 + 12, ry - 6), (x1 - 12, ry - 6), GRID_MAJOR, 1)
    s.text((x0 + 12, ry), "РАЗРУШЕНИЕ · ЭТАП 3", TEXT, 9, True)
    items = [
        "граната: ЛКМ, запал %g с" % stage["FUSE_SECONDS"],
        "осколок стекла по размеру %g м" % stage["GLASS_SHARD_SIZE"],
        "ячейка нарезки стекла %g м" % stage["GLASS_FRACTURE_CELL"],
        "порог несущих стен %d%%" % int(stage["BEARING_LOSS_RATIO"] * 100),
        "порог перекрытий %d%%" % int(stage["SLAB_LOSS_RATIO"] * 100),
        "перегородки ничего не обрушают",
    ]
    for i, item in enumerate(items):
        col = x0 + 12 + (i % 2) * 268
        s.text((col, ry + 16 + (i // 2) * 13), item, MUTED, 8)


def build(path: str, width: int = 1180, height: int = 700) -> None:
    cfg = parse_config(CONFIG)
    stage = parse_stage3()
    s = Sheet(width, height)
    s.text((20, 14), "NEWwoorld · план военной карты", TEXT, 15, True)
    s.text((20, 34),
           "построено по константам game/scripts/world/map_config.gd · "
           "не снимок игры: в песочнице нет бинарника Godot",
           MUTED, 8)
    draw_map_panel(s, cfg, (20, 52, 620, 616))
    draw_detail_panel(s, cfg, (636, 52, 1160, 396))
    draw_legend(s, cfg, stage, (636, 412, 1160, 616))
    s.text((20, height - 22),
           "Godot 4.5 · GDScript · карта %g×%g м, чанк %g м, поток %d×%d"
           % (float(cfg["MAP_SIZE"]), float(cfg["MAP_SIZE"]), float(cfg["CHUNK_SIZE"]),
              2 * int(cfg["STREAM_RADIUS"]) + 1, 2 * int(cfg["STREAM_RADIUS"]) + 1),
           MUTED, 8)
    s.save(path)
    print("схема карты записана: %s (%d×%d)" % (path, width, height))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-o", "--output",
        default=os.path.join(REPO, "docs", "images", "map-schematic.png"),
        help="куда сохранить PNG",
    )
    args = parser.parse_args()
    build(args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Трава ShopSim: атлас листовых лент и дёрн. Шаг 5.33.

Атлас grass_blade.png — 4 колонки × 2 строки, по ячейке на вид:
  0 овсяница, 1 мятлик, 2 пырей, 3 разнотравье с цветами, 4 сухостой.
Травинка рисуется лентой: силуэт задаёт alpha (шейдер режет им геометрию),
в rgb — только вариация «тканни» листа (0.7..1.0), цвет даёт шейдер по виду
и сезону. Так один и тот же атлас работает и летом, и в октябре.

Что делает лист «настоящим»:
  • прожилка светлее по центру, края темнее и чуть прозрачнее;
  • микроразрывы по кромке (надгрызы, засохшие кончики) — край не идеальный;
  • затемнение у основания (там нет света) и выцветание у верхушки;
  • кремнезёмные точки-крапинки, лёгкая продольная полосатость;
  • 4 варианта в ряду различаются изгибом, шириной и высотой.

Дёрн grass_turf.png — albedo (почва + ветошь + ростки) и шероховатость в alpha,
сшивается без шва (все шумы периодические).
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, "assets", "textures")

SPECIES = [
    # имя, изгиб, ширина, разрыв края, сухость кончика, частота прожилок
    ("овсяница", 0.35, 1.00, 0.35, 0.15),
    ("мятлик", 0.18, 0.72, 0.20, 0.05),
    ("пырей", 0.55, 0.86, 0.55, 0.45),
    ("разнотравье", 0.28, 1.15, 0.70, 0.10),
    ("сухостой", 0.62, 0.60, 0.85, 1.00),
]

CELL = 256
COLS = 4


def blade_cell(rng: np.random.Generator, bend: float, width: float,
               tear: float, dry: float, variant: int) -> np.ndarray:
    """Одна травинка: RGBA 256×256, y=0 снизу (основание), y=1 сверху."""
    n = CELL
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    v = 1.0 - yy / (n - 1.0)              # 0 у основания, 1 на верхушке
    u = xx / (n - 1.0)

    # вариация в ряду: наклон, ширина, высота
    phase = variant * 0.37
    bendv = bend * (0.75 + 0.5 * ((variant % 3) * 0.25))
    curve = 0.5 + bendv * np.sin(v ** 1.25 * np.pi * 0.62 + phase) + 0.16 * v * v
    wave = 0.018 * np.sin(v * 9.0 + phase * 3.0)
    curve += wave

    # Ширина ленты: у основания лист свёрнут в трубочку, максимум на 1/4 высоты,
    # к верхушке сходит на ноль. Экспонента 2.6 — «травинка», а не «флаг».
    vv = np.clip((v - 0.02) / 0.98, 0.0, 1.0)
    taper = np.clip(1.0 - vv ** 2.6, 0.0, 1.0) * np.clip(vv / 0.10 + 0.55, 0.0, 1.0)
    base = 0.185 * width
    hw = base * taper

    # край: микронеровности, надгрызы, засохшая верхушка
    edge_noise = proc.blur(proc.periodic_noise(n, n, 24, rng), 2) * 2.0 - 1.0
    hw = hw * (1.0 + 0.16 * edge_noise * (0.35 + 0.65 * v))
    teeth = proc.periodic_noise(n, n, 96, rng)
    notch = (teeth > 0.90 - 0.06 * tear) * (np.sign(u - curve) > 0)
    hw = hw * (1.0 - 0.42 * tear * notch)
    drytip = dry * (0.55 + 0.45 * teeth)
    tip_cut = 1.0 - smoothstep01(0.86 - 0.20 * dry, 0.985, v + 0.05 * drytip)
    d = np.abs(u - curve)
    a = smoothstep01(hw * 1.14, hw * 0.62, d) * tip_cut
    a = a * smoothstep01(0.0, 0.012, 1.0 - v)                   # основание не обрывается
    a = np.clip(a, 0.0, 1.0)

    # ---- «тканнь» листа
    # центральная жилка чуть темнее, по бокам — светлее; продольные борозды
    dn = (u - curve) / np.maximum(hw, 1e-3)
    vein = np.exp(-(dn * 1.6) ** 2)
    stripes = 0.5 + 0.5 * np.sin(dn * 34.0 + v * 5.0)
    mottle = proc.periodic_noise(n, n, 12, rng)
    fine = proc.periodic_noise(n, n, 96, rng)
    rgb = np.ones((n, n, 3), dtype=np.float32) * 0.86
    rgb -= (vein[..., None] * 0.10)                        # жилка
    rgb *= (0.92 + 0.10 * stripes[..., None])             # бороздки
    rgb *= (0.90 + 0.16 * mottle[..., None])              # пятна хлороза
    rgb += (fine - 0.5)[..., None] * 0.04
    # основание в темноте, верхушка выцветшая и сухая
    darkbase = smoothstep01(0.42, 0.0, v)
    rgb *= (1.0 - 0.55 * darkbase[..., None])
    drytip = smoothstep01(0.55, 0.95, v) * dry
    rgb *= (1.0 - 0.28 * drytip[..., None])
    rgb += (np.array([0.20, 0.13, -0.02], np.float32) * drytip[..., None])
    # кремнезёмные точки
    speck = (proc.periodic_noise(n, n, 128, rng) > 0.965)[..., None]
    rgb += speck * 0.22 * (1.0 - darkbase[..., None])
    rgb = np.clip(rgb, 0.0, 1.0)

    out = np.zeros((n, n, 4), dtype=np.float32)
    out[..., :3] = rgb
    out[..., 3] = np.clip(a, 0.0, 1.0)
    return out


def smoothstep01(e0, e1, x):
    """Гладкая граница; e0 может быть больше e1 (тогда «убывающая» кромка)."""
    e0 = np.asarray(e0, dtype=np.float32); e1 = np.asarray(e1, dtype=np.float32)
    d = e1 - e0
    d = np.where(d >= 0, np.maximum(d, 1e-5), np.minimum(d, -1e-5))
    t = np.clip((x - e0) / d, 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def stepish(e, x):
    return (x > e).astype(np.float32)


def make_blade_atlas(size: int) -> np.ndarray:
    """Сетка 4 × 3 ячейки: 5 видов × 2 варианта ленты = 10 занятых ячеек."""
    rng = np.random.default_rng(20260)
    cell = size // COLS
    rows = 3
    atlas = np.zeros((cell * rows, cell * COLS, 4), dtype=np.float32)
    idx = 0
    for (name, bend, width, tear, dry) in SPECIES:
        for variant in range(2):
            r, c = divmod(idx, COLS)
            blk = blade_cell(rng, bend, width, tear, dry, variant)
            atlas[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell] = blk
            idx += 1
    print(f"  атлас трав: {idx} ячеек по {cell} px ({', '.join(n for n, *_ in SPECIES)})")
    return np.clip(atlas, 0, 1)


def make_turf(size: int) -> np.ndarray:
    """Дёрн: сухая подложка, войлок корней, ростки. RGBA: a — шероховатость."""
    rng = np.random.default_rng(7)
    n = size
    soil = proc.periodic_noise(n, n, 4, rng) * 0.5 + proc.periodic_noise(n, n, 16, rng) * 0.35 + \
        proc.periodic_noise(n, n, 64, rng) * 0.15
    soil = proc.blur(soil, max(1, n // 128))
    thatch = proc.ridged(n, n, 4, 8, rng=rng, wrap=True)
    # Травяные «штрихи»: короткие мазки в случайную сторону, их много.
    strokes = np.zeros((n, n), np.float32)
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float32)
    cnt = n * 3
    px = rng.integers(0, n, cnt).astype(np.float32)
    py = rng.integers(0, n, cnt).astype(np.float32)
    ang = rng.uniform(0, np.pi * 2, cnt).astype(np.float32)
    ln = rng.uniform(3.0, 11.0, cnt).astype(np.float32)
    tone = rng.uniform(0.25, 1.0, cnt).astype(np.float32)
    # Рисуем короткими линиями с периодическим оборотом (шва не будет).
    step = max(1, n // 256)
    for t in np.arange(0, 1.0, 0.16):
        dx = (np.cos(ang) * ln * t).astype(np.int32)
        dy = (np.sin(ang) * ln * t).astype(np.int32)
        ix = ((px + dx).astype(np.int32)) % n
        iy = ((py + dy).astype(np.int32)) % n
        strokes[iy, ix] = np.maximum(strokes[iy, ix], tone)
    strokes = proc.blur(strokes, max(1, n // 192))
    strokes = strokes / max(strokes.max(), 1e-5)

    green = np.clip(0.25 + 0.9 * strokes - 0.35 * thatch, 0, 1)
    rgb = np.zeros((n, n, 3), np.float32)
    soil_rgb = np.stack([0.115 + 0.05 * soil, 0.095 + 0.04 * soil, 0.062 + 0.03 * soil], -1)
    grass_rgb = np.stack([0.055 + 0.06 * soil, 0.100 + 0.10 * soil + 0.05 * strokes,
                          0.030 + 0.03 * soil], -1)
    rgb = soil_rgb * (1 - green[..., None]) + grass_rgb * green[..., None]
    # Сухая ветошь между ростками
    drymask = smoothstep01(0.45, 0.85, thatch)
    rgb = rgb * (1 - 0.5 * drymask[..., None]) + np.array([0.115, 0.098, 0.058], np.float32) * drymask[..., None]
    rgb = np.clip(rgb, 0.0, 1.0) ** (1 / 2.2)     # в файле sRGB, шейдер декодирует
    rough = np.clip(0.86 - 0.10 * strokes + 0.06 * soil, 0.55, 0.98)
    out = np.concatenate([rgb, rough[..., None]], -1)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=1024, help="ширина атласа лент (256×4)")
    ap.add_argument("--turf", type=int, default=1024, help="сторона текстуры дёрна")
    ap.add_argument("--out", default=OUTDIR)
    a = ap.parse_args()

    blade = make_blade_atlas(a.size)
    proc.save_png(os.path.join(a.out, "grass_blade.png"), blade)
    turf = make_turf(a.turf)
    proc.save_png(os.path.join(a.out, "grass_turf.png"), turf)
    # Телефонный вариант: ту же длину стороны вдвое меньше (в игре --maxtex 1024).
    import PIL.Image as I
    small = np.array(I.fromarray((turf * 255).astype(np.uint8)).resize(
        (a.turf // 2, a.turf // 2), I.LANCZOS), np.float32) / 255.0
    proc.save_png(os.path.join(a.out, "grass_turf_1k.png"), small)

    st = proc.material_stats(turf[..., :3], turf[..., 3])
    print(f"grass_blade.png {blade.shape[1]}x{blade.shape[0]} — 5 видов × 2 варианта ленты")
    print(f"grass_turf.png  {a.turf}x{a.turf}  яркость {st['albedo_mean']:.3f} "
          f"(дёрн: цель 0.06..0.16), шероховатость {st['rough_mean']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

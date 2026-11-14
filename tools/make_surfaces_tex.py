#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Покрытия и вода ShopSim: атлас земли, пена, рябь, карта глубины. Шаг 5.33.

ground_atlas.png — 4 × 4 ячейки по 512 px, alpha = шероховатость:
  0 асфальт (линейное альбедо 0.055..0.115 — самый тёмный материал города),
  1 плитка тротуара, 2 дёрн (совпадает с grass_turf по цвету), 3 бетон,
  4 грунт/разрытая земля, 5 песок пляжа, 6 старый асфальт с коркой,
  7 разметка и пешеходная плитка.
Каждая ячейка строится слоями: заполнитель/фактура → швы и стыки → выкрашивание
и ямы → масло и копоть → старая разметка → грязь в порах. Никакого «равномерного
серого»: у настоящего асфальта контраст по яркости в 2 раза.

water_foam.png — пена и барашки (r — пена, g — мелкая рябь для нормали,
b — мыльные разводы), тайлится в обе стороны.
water_depth.png — учебная карта глубины озера для превью: r — метры,
gb — течение, a — маска берега. Игровой мир строит свою карту тем же кодом
(web/js/water.js), поэтому снимок и игра совпадают.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "textures")
COLS = 4


def sat(x):
    return np.clip(x, 0, 1)


def sstep(e0, e1, x):
    e0 = np.asarray(e0, np.float32); e1 = np.asarray(e1, np.float32)
    d = e1 - e0
    d = np.where(d >= 0, np.maximum(d, 1e-5), np.minimum(d, -1e-5))
    t = sat((x - e0) / d)
    return (t * t * (3 - 2 * t)).astype(np.float32)


def to_srgb(lin):
    lin = sat(lin)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055).astype(np.float32)


def to_lin(srgb):
    c = sat(srgb)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


# --------------------------------------------------------------- покрытия
def asphalt(n, rng, old=False):
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    # щебень: много мелких «камешков» разного тона + песок между ними
    grit = proc.periodic_noise(n, n, 220, rng)
    pebble = proc.blur(proc.periodic_noise(n, n, 96, rng), 1)
    bitumen = proc.periodic_noise(n, n, 8, rng)
    base = 0.062 if not old else 0.085
    lin = np.full((n, n), base, np.float32)
    lin += (pebble - 0.5) * (0.055 if not old else 0.085)
    lin += (grit - 0.5) * 0.030
    lin *= 0.75 + 0.55 * bitumen
    if old:
        # корка, заделка трещин, яма с водой
        crack = sstep(0.20, 0.0, np.abs(proc.ridged(n, n, 3, 4, rng=rng) - 0.5) * 3.0)
        lin *= 1 - 0.45 * crack
        patch = sstep(0.62, 0.70, proc.periodic_noise(n, n, 5, rng))
        lin = lin * (1 - patch * 0.5) + patch * 0.030
    # масляное пятно и копоть у бордюра
    oil = sstep(0.80, 0.95, proc.periodic_noise(n, n, 7, rng))
    lin *= 1 - 0.45 * oil
    rough = np.clip((0.72 if not old else 0.60) + 0.14 * (bitumen - 0.5) * 2 - 0.15 * oil, 0.35, 0.95)
    tint = np.array([1.00, 1.01, 1.03], np.float32) if not old else np.array([1.02, 1.00, 0.96], np.float32)
    rgb = to_srgb(lin[..., None] * tint[None, None, :])
    return sat(rgb), rough


def paving(n, rng):
    yy, xx = mgrid(n)
    tile = 8
    tx = (xx % (n / tile)) / (n / tile)
    ty = (yy % (n / tile)) / (n / tile)
    seam = sstep(0.06, 0.0, np.minimum(tx, ty)) + sstep(0.94, 1.0, np.maximum(tx, ty))
    tone = rng.uniform(-0.35, 0.35, size=(tile, tile)).astype(np.float32)
    per = tone[(yy // (n // tile)).astype(int), (xx // (n // tile)).astype(int)]
    base = 0.150 + 0.035 * per
    grit = proc.periodic_noise(n, n, 160, rng)
    base += (grit - 0.5) * 0.03
    base *= 1 - 0.55 * np.clip(seam, 0, 1)
    # выгорание верхнего слоя бетона и местами — пыль
    wear = sstep(0.35, 0.75, proc.periodic_noise(n, n, 6, rng))
    base *= 1 + 0.18 * wear
    rough = np.clip(0.68 + 0.10 * (grit - 0.5) * 2 + 0.12 * np.clip(seam, 0, 1) - 0.08 * wear, 0.3, 0.95)
    rgb = to_srgb(base[..., None] * np.array([1.0, 0.985, 0.95], np.float32)[None, None, :])
    return sat(rgb), rough


def turf(n, rng):
    t = proc.load_png(os.path.join(OUT, "grass_turf.png"), "RGBA") if os.path.exists(
        os.path.join(OUT, "grass_turf.png")) else None
    if t is not None and t.shape[0] == n:
        return t[..., :3], t[..., 3]
    if t is not None:
        import PIL.Image as I
        a = np.array(I.fromarray((t * 255).astype(np.uint8)).resize((n, n), I.LANCZOS), np.float32) / 255
        return a[..., :3], a[..., 3]
    return np.full((n, n, 3), 0.28, np.float32), np.full((n, n), 0.86, np.float32)


def concrete(n, rng):
    grit = proc.periodic_noise(n, n, 40, rng)
    fine = proc.periodic_noise(n, n, 200, rng)
    base = 0.235 + 0.06 * (grit - 0.5) * 2 + 0.02 * (fine - 0.5) * 2
    # опалубка: вертикальные полосы и наплывы, шапки самодельных заплаток
    yy, xx = mgrid(n)
    streak = 0.5 + 0.5 * np.sin(xx / n * np.pi * 2 * 9 + grit * 3)
    base *= 0.95 + 0.08 * streak
    holes = (proc.periodic_noise(n, n, 120, rng) > 0.985)
    base[holes] *= 0.55
    rough = np.clip(0.74 + 0.10 * (fine - 0.5) * 2, 0.4, 0.95)
    rgb = to_srgb(base[..., None] * np.array([1.0, 0.99, 0.96], np.float32)[None, None, :])
    return sat(rgb), rough


def soil(n, rng):
    f = proc.fbm(n, n, 5, 6, rng=rng, wrap=True)
    g = proc.periodic_noise(n, n, 150, rng)
    base = 0.10 + 0.09 * (f + 1) * 0.5 + 0.03 * (g - 0.5)
    clod = sstep(0.62, 0.78, proc.periodic_noise(n, n, 26, rng))
    base *= 1 + 0.35 * clod
    rough = np.clip(0.88 - 0.12 * clod + 0.05 * (g - 0.5), 0.5, 0.99)
    rgb = to_srgb(base[..., None] * np.array([1.0, 0.86, 0.66], np.float32)[None, None, :])
    return sat(rgb), rough


def sand(n, rng):
    ripple = np.sin(np.arange(n) * 0.22)[None, :] * 0.5 + proc.periodic_noise(n, n, 30, rng) * 0.5
    g = proc.periodic_noise(n, n, 240, rng)
    base = 0.30 + 0.06 * ripple + 0.02 * (g - 0.5)
    foot = sstep(0.72, 0.86, proc.periodic_noise(n, n, 14, rng))
    base *= 1 - 0.12 * foot
    rough = np.clip(0.80 - 0.10 * ripple + 0.05 * (g - 0.5), 0.45, 0.95)
    rgb = to_srgb(base[..., None] * np.array([1.0, 0.93, 0.78], np.float32)[None, None, :])
    return sat(rgb), rough


def marking(n, rng):
    yy, xx = mgrid(n)
    # стоп-линия и «зебра»: белая краска, выцветшая, с полосами от покрышек
    band = ((yy % (n // 3)) < n // 12).astype(np.float32)
    wear = sstep(0.35, 0.75, proc.periodic_noise(n, n, 9, rng))
    base = 0.070 + band * (0.30 - 0.070) * (0.45 + 0.55 * wear)
    tyre = np.exp(-((xx % (n // 2) - n // 4) ** 2) / (n * 1.4)) * band
    base *= 1 - 0.45 * tyre
    grit = proc.periodic_noise(n, n, 190, rng)
    base += (grit - 0.5) * 0.02
    rough = np.clip(0.68 - 0.28 * band + 0.1 * (grit - 0.5), 0.3, 0.95)
    rgb = to_srgb(base[..., None] * np.array([1.0, 0.995, 0.96], np.float32)[None, None, :])
    return sat(rgb), rough


def mgrid(n):
    return np.mgrid[0:n, 0:n].astype(np.float32)


def make_ground(size, rng):
    n = size // COLS
    alb = np.zeros((n * COLS, n * COLS, 4), np.float32)
    rows = [("асфальт", asphalt, 0.085), ("плитка тротуара", paving, 0.185),
            ("дёрн", turf, 0.115), ("бетон", concrete, 0.235),
            ("грунт", soil, 0.115), ("песок пляжа", sand, 0.300),
            ("старый асфальт", lambda k, r: asphalt(k, r, old=True), 0.105),
            ("разметка", marking, 0.135)]
    rep = []
    for i, (name, fn, target) in enumerate(rows):
        r, c = divmod(i, COLS)
        rgb, rough = fn(n, rng)
        lin = to_lin(rgb)
        lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        k = target / max(float(lum.mean()), 1e-5)            # яркость — по замерам
        rgb = to_srgb(sat(lin * k))
        alb[r * n:(r + 1) * n, c * n:(c + 1) * n] = np.concatenate([rgb, rough[..., None]], -1)
        lum = rgb2lin(rgb) @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        rep.append({"material": name, "albedo": round(float(lum.mean()), 4),
                    "albedo_p95": round(float(np.quantile(lum, 0.95)), 4),
                    "rough": round(float(np.mean(rough)), 3)})
    return alb, rep


def rgb2lin(x):
    return to_lin(x)


# --------------------------------------------------------------------- вода
def make_water(size, rng):
    n = size
    foam = np.zeros((n, n, 3), np.float32)
    # r — пенистые хлопья: ридж-шум, продырявленный мелким шумом
    clumps = proc.ridged(n, n, 4, 6, rng=rng, wrap=True)
    bubbles = proc.periodic_noise(n, n, 180, rng)
    f = sstep(0.50, 0.86, clumps) * (0.55 + 0.45 * bubbles)
    f += sstep(0.90, 0.99, bubbles) * 0.4
    foam[..., 0] = sat(f)
    # g — рябь: две диагональные решётки шума с производной (для нормали)
    r1 = proc.fbm(n, n, 4, 12, rng=rng)
    r2 = proc.fbm(n, n, 3, 24, rng=rng)
    foam[..., 1] = sat(0.5 + 0.5 * (r1 * 0.65 + r2 * 0.35))
    # b — мыльные разводы: очень редкие крупные пятна с каймой
    film = sstep(0.72, 0.80, proc.fbm(n, n, 3, 4, rng=rng)) * \
        (0.5 + 0.5 * np.sin(proc.fbm(n, n, 2, 8, rng=rng) * 6.0))
    foam[..., 2] = sat(film * 0.8)
    # нормаль из ряда «ряби»: чтобы у воды была своя деталь, а не только Герстнер
    h = 0.5 * (r1 + r2)
    dy, dx = np.gradient(h.astype(np.float32))
    nrm = np.stack([-dx * 3.0, -dy * 3.0, np.ones_like(h)], -1)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
    return foam, (nrm * 0.5 + 0.5).astype(np.float32)


def make_depth(size, rng, seed_shape="lake"):
    """Учебная карта глубины: озеро с извилистым берегом и протокой."""
    n = size
    yy, xx = mgrid(n)
    u = (xx / (n - 1) - 0.5) * 2
    v = (yy / (n - 1) - 0.5) * 2
    wob = 0.22 * np.sin(np.arctan2(v, u) * 3.0) + 0.12 * np.sin(np.arctan2(v, u) * 7.0 + 1.3)
    d0 = np.hypot(u * 1.05, v * 1.35) + wob
    depth = sat((0.92 - d0) / 0.55) * 7.5
    # протока: лента, уходящая за край
    chan = np.exp(-((v - 0.25 * np.sin(u * 2.4) - 0.72) ** 2) / 0.045)
    depth = np.maximum(depth, chan * 2.6)
    flow = np.gradient(depth)[::-1]
    sp = np.clip(np.hypot(flow[0], flow[1]) * 6.0, 0, 1)
    dirx = np.where(np.abs(flow[1]) > 1e-6, flow[1] / np.maximum(np.abs(flow[1]), 1e-6), 0.0)
    shore = sat(depth / 0.35)
    out = np.stack([sat(depth / 8.0), 0.5 + 0.5 * np.clip(-dirx, -1, 1) * sp,
                    0.5 + 0.5 * np.clip(flow[0] * 4.0, -1, 1), shore], -1).astype(np.float32)
    return out, depth


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ground", type=int, default=2048)
    ap.add_argument("--water", type=int, default=1024)
    ap.add_argument("--depth", type=int, default=512)
    ap.add_argument("--out", default=OUT)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(4242)
    alb, rep = make_ground(a.ground, rng)
    proc.save_png(os.path.join(a.out, "ground_atlas.png"), alb)
    import PIL.Image as I
    small = np.array(I.fromarray((alb * 255).astype(np.uint8)).resize((1024, 1024), I.LANCZOS), np.float32) / 255
    proc.save_png(os.path.join(a.out, "ground_atlas_1k.png"), small)
    foam, wnorm = make_water(a.water, rng)
    proc.save_png(os.path.join(a.out, "water_foam.png"),
                  np.concatenate([foam, np.ones((a.water, a.water, 1), np.float32)], -1))
    proc.save_png(os.path.join(a.out, "water_normal.png"),
                  np.concatenate([wnorm, np.ones((a.water, a.water, 1), np.float32)], -1))
    depth, _ = make_depth(a.depth, rng)
    proc.save_png(os.path.join(a.out, "water_depth_preview.png"), depth)
    with open(os.path.join(ROOT, "docs", "material_report_surfaces.json"), "w", encoding="utf-8") as f:
        json.dump({"step": "5.33", "ground": rep}, f, ensure_ascii=False, indent=1)
    print(f"ground_atlas.png {a.ground}² (8 покрытий), water_foam/water_normal {a.water}², "
          f"water_depth_preview {a.depth}²")
    for r in rep:
        print(f"  {r['material']:<18} альбедо {r['albedo']:.3f}  шерох {r['rough']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

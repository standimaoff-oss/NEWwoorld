#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Листва и древесина ShopSim: атлас листовых карт, стволы, хвоя. Шаг 5.33.

Что делается и зачем (по ТЗ: «растительность», «бамбуковый парк», «пальмы»,
«ёлка», «заменить старые деревья на пальмы»):

  veg_atlas.png   4 × 3 ячейки: 9 видов зелёнки (куст, бирючина, папоротник,
                  бамбук, пальмовое перо, луговые цветы, еловая лапа, сухостой,
                  самшит). Каждая ячейка — «веер» листьев на стебле: силуэт в
                  alpha, ткань листа в rgb (0.7..1.0, цвет даёт шейдер).
  veg_rough.png   шероховатость и подповерхностное свечение (g) тех же карт.
  bamboo_culm.png стебель: междоузлие с сизым налётом, узел с рубцом, пятна
                  от грибница, восковой блик — и нормалью из высоты.
  palm_trunk.png  ствол пальмы: ромбические рубцы от обрезанных листьев,
                  сухие волокна, мох с теневой стороны.
  bamboo_nrm.png, palm_nrm.png, spruce_bark_nrm.png — нормали из тех же карт
                  высот; еловая лапа (вид 6 в атласе) — для новогодней ёлки.

Всё периодическое по горизонтали, чтобы тайлиться без шва.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "textures")
CELL = 256
COLS = 4


def sat(x):
    return np.clip(x, 0.0, 1.0)


def sstep(e0, e1, x):
    """Гладкая граница; поддержаны массивные e0/e1 и «убывающая» кромка."""
    e0 = np.asarray(e0, np.float32); e1 = np.asarray(e1, np.float32)
    d = e1 - e0
    d = np.where(d >= 0, np.maximum(d, 1e-5), np.minimum(d, -1e-5))
    t = sat((x - e0) / d)
    return (t * t * (3 - 2 * t)).astype(np.float32)


# ------------------------------------------------------------------ листовая карта
def leaf_fan(rng, n, kind, leaves, spread, droop, serrate, holes):
    """Веер листьев: возврат (rgb, alpha, rough, sss)."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1)
    v = 1 - yy / (n - 1)                    # 0 внизу (крепление), 1 наверху
    a = np.zeros((n, n), np.float32)
    for i in range(leaves):
        t = (i + 0.5) / leaves
        ang = (t - 0.5) * spread
        # каждый лист — удлинённый эллипс, повёрнутый на свой угол и слегка провисающий
        ox, oy = 0.5, 0.02
        c, s = np.cos(ang), np.sin(ang)
        lx = (u - ox) * c + (v - oy) * s
        ly = -(u - ox) * s + (v - oy) * c
        L = 0.62 + 0.3 * np.sin(i * 2.1)
        W = 0.13 + 0.05 * np.cos(i * 1.7)
        along = sat(ly / L)
        wid = W * np.sin(np.pi * np.clip(along, 0, 1) ** 0.75)
        edge = 1.0 + serrate * 0.35 * np.sin(along * 26.0 + i)
        d = np.abs(lx) / np.maximum(wid * edge, 1e-4)
        one = sstep(1.0, 0.65, d) * sstep(1.02, 0.9, along) * sstep(-0.02, 0.06, along)
        if holes > 0:
            bug = (proc.periodic_noise(n, n, 72, rng) > 1.0 - holes * 0.08)
            one = one * (1 - bug * (along > 0.15))
        a = np.maximum(a, one)
    # ткань листа: жилка, бороздки, пятна хлороза
    vein = np.exp(-((u - (0.5 + (v - 0.5) * spread * 0.4)) / 0.012) ** 2)
    stripes = 0.5 + 0.5 * np.sin((u - v * spread * 0.3) * 220.0)
    mottle = proc.periodic_noise(n, n, 10, rng)
    fine = proc.periodic_noise(n, n, 120, rng)
    rgb = np.ones((n, n, 3), np.float32) * 0.88
    rgb -= vein[..., None] * 0.08
    rgb *= (0.94 + 0.08 * stripes[..., None])
    rgb *= (0.88 + 0.20 * mottle[..., None])
    rgb += (fine - 0.5)[..., None] * 0.05
    rgb *= (0.65 + 0.35 * sstep(0.0, 0.35, v))[..., None]   # у крепления темнее
    # шероховатость: у листа 0.5, у восковых (бамбук, самшит) — 0.3
    wax = {3: 0.22, 8: 0.30}.get(kind, 0.5)
    rough = np.full((n, n), wax, np.float32) + 0.12 * (fine - 0.5) + 0.16 * (1 - mottle)
    sss = np.full((n, n), 0.55, np.float32)
    if kind == 6:                     # ель: хвоя почти не светится насквозь
        sss[:] = 0.16
    if kind == 3:
        sss[:] = 0.35
    return sat(rgb), sat(a), sat(rough), sss


def pine_bough(rng, n):
    """Еловая лапа: ось + хвоинки двух рядов, разной длины, с просветами."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1); v = 1 - yy / (n - 1)
    axis = 0.5 + 0.06 * np.sin(v * 4.0)
    a = np.zeros((n, n), np.float32)
    dens = np.zeros((n, n), np.float32)
    for row in range(46):
        t = (row + 0.5) / 46
        y = 0.03 + 0.94 * t
        for side in (-1, 1):
            ln = (0.30 + 0.16 * np.sin(row * 1.7)) * (1 - 0.55 * abs(t - 0.45))
            ang = side * (1.05 + 0.35 * np.sin(row * 2.3)) + 0.25
            dx, dy = np.cos(ang) * ln, np.sin(ang) * ln * 0.55
            # хвоинка как тонкий отрезок: расстояние до него
            px = u - axis; py = v - y
            proj = sat((px * dx + py * dy) / max(dx * dx + dy * dy, 1e-6))
            cx = px - dx * proj; cy = py - dy * proj
            d = np.hypot(cx, cy) / 0.010
            one = sstep(1.0, 0.45, d) * (proj > 0) * (proj < 1.0)
            a = np.maximum(a, one)
            dens = np.maximum(dens, one * (1 - proj))
    rgb = np.ones((n, n, 3), np.float32) * 0.86
    rgb *= (0.75 + 0.3 * proc.periodic_noise(n, n, 40, rng)[..., None])
    rgb *= (0.85 + 0.25 * sstep(0.0, 0.5, v))[..., None]
    rgb += (dens[..., None] * 0.12)                     # в глубине лапы светлее (рассеяние)
    rough = np.full((n, n), 0.42, np.float32) + 0.1 * (proc.periodic_noise(n, n, 64, rng) - 0.5)
    return sat(rgb), sat(a), sat(rough), np.full((n, n), 0.16, np.float32)


def flower_meadow(rng, n):
    """Луговое разнотравье: ленты + головки цветов (для вида «разнотравье»)."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1); v = 1 - yy / (n - 1)
    a = np.zeros((n, n), np.float32)
    rgb = np.ones((n, n, 3), np.float32) * 0.86
    flower = np.zeros((n, n), np.float32)
    for i in range(14):
        x0 = 0.06 + 0.88 * rng.random()
        bend = (rng.random() - 0.5) * 0.35
        top = 0.45 + 0.5 * rng.random()
        hw = 0.012 + 0.014 * rng.random()
        for k in range(24):
            t = k / 23.0
            y = t * top
            x = x0 + bend * t * t
            d = np.abs(u - x) / hw
            one = sstep(1.0, 0.5, d) * sstep(-0.02, 0.05, y) * sstep(top + 0.02, top - 0.05, y)
            a = np.maximum(a, one)
        # головка: ромашка/лютик — светлая точка с лепестками
        if rng.random() < 0.5:
            pet = np.hypot(u - (x0 + bend), v - top)
            ang = np.arctan2(v - top, u - (x0 + bend))
            star = 0.030 + 0.012 * np.cos(ang * 8.0)
            head = sstep(star * 1.6, star, pet)
            flower = np.maximum(flower, head)
            a = np.maximum(a, head)
    rgb = rgb * (1 - flower[..., None]) + np.array([0.95, 0.92, 0.55], np.float32) * flower[..., None]
    rough = np.full((n, n), 0.6, np.float32)
    return sat(rgb), sat(a), sat(rough), np.full((n, n), 0.6, np.float32)


def make_veg(size: int, rng):
    n = size // COLS
    # ширина = COLS ячеек, высота = 3 ряда (9 видов)
    alb = np.zeros((n * 3, n * COLS, 4), np.float32)
    rgh = np.zeros((n * 3, n * COLS, 2), np.float32)
    # 0 спирея, 1 бирючина, 2 папоротник, 3 бамбук, 4 пальма, 5 цветы,
    # 6 ель, 7 сухостой, 8 самшит
    params = [
        dict(kind=0, leaves=9, spread=2.0, droop=0.2, serrate=0.2, holes=0.4),
        dict(kind=1, leaves=13, spread=1.5, droop=0.1, serrate=0.1, holes=0.7),
        dict(kind=2, leaves=17, spread=2.4, droop=0.5, serrate=0.6, holes=0.1),
        dict(kind=3, leaves=11, spread=1.1, droop=0.1, serrate=0.0, holes=0.2),
        dict(kind=4, leaves=7, spread=2.6, droop=0.9, serrate=0.9, holes=0.5),
        dict(kind=5, leaves=0, spread=0, droop=0, serrate=0, holes=0),
        dict(kind=6, leaves=0, spread=0, droop=0, serrate=0, holes=0),
        dict(kind=7, leaves=15, spread=1.2, droop=0.8, serrate=0.4, holes=0.9),
        dict(kind=8, leaves=18, spread=1.2, droop=0.0, serrate=0.0, holes=0.1),
    ]
    for i, p in enumerate(params):
        r, c = divmod(i, COLS)
        if p["kind"] == 5:
            rgb, a, rough, sss = flower_meadow(rng, n)
        elif p["kind"] == 6:
            rgb, a, rough, sss = pine_bough(rng, n)
        else:
            q = {k: v for k, v in p.items() if k != "kind"}
            rgb, a, rough, sss = leaf_fan(rng, n, p["kind"], **q)
        alb[r * n:(r + 1) * n, c * n:(c + 1) * n] = np.concatenate([rgb, a[..., None]], -1)
        rgh[r * n:(r + 1) * n, c * n:(c + 1) * n] = np.stack([rough, sss], -1)
    return alb, rgh


# ------------------------------------------------------------------ стволы
def bamboo_culm(size, rng):
    n = size
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1); v = yy / (n - 1)
    # междоузлие: один узел на высоту тайла, рубец вверху
    node = np.exp(-((v - 0.08) * n / 7.0) ** 2)
    base = np.array([0.30, 0.42, 0.14], np.float32)
    stripe = 0.5 + 0.5 * np.sin(u * np.pi * 2.0 * 14.0)
    wax = proc.periodic_noise(n, n, 6, rng)
    spots = (proc.periodic_noise(n, n, 48, rng) > 0.90)
    rgb = np.ones((n, n, 3), np.float32)
    rgb *= (0.82 + 0.30 * stripe[..., None]) * (0.85 + 0.30 * wax[..., None])
    rgb = rgb * base[None, None, :] * 2.6
    rgb = rgb * (1 - 0.35 * node[..., None]) + np.array([0.36, 0.36, 0.24], np.float32) * node[..., None]
    rgb[spots] *= np.array([0.62, 0.68, 0.5], np.float32)      # пятна грибница
    # цилиндрическое затенение по горизонтали — «круглый» ствол даже без света
    cyl = np.sin(u * np.pi) ** 0.6
    rgb *= (0.35 + 0.65 * cyl[..., None])
    h = 0.55 + 0.35 * stripe * 0.1 - 0.5 * node + 0.05 * wax
    rough = np.clip(0.34 - 0.10 * wax + 0.25 * (1 - cyl), 0.1, 0.8)
    alb = np.concatenate([sat(rgb ** (1 / 2.2)), (1 - 0.4 * cyl)[..., None] * 0.0 + np.ones((n, n, 1), np.float32)], -1)
    return alb[..., :3], h.astype(np.float32), rough.astype(np.float32)


def palm_trunk(size, rng, mossy=0.6):
    n = size
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1); v = yy / (n - 1)
    rows = 9
    vr = (v * rows) % 1.0
    # рубец от обрезанного листа: ромбическая «чешуя»
    diamond = np.abs(u - 0.5) * 1.6 + np.abs(vr - 0.5) * 1.25
    scale = sstep(0.95, 0.55, diamond)
    deep = sstep(0.55, 0.95, diamond)
    fiber = 0.5 + 0.5 * np.sin(u * n * 1.2 + v * 6.0)
    rgb = np.ones((n, n, 3), np.float32)
    rgb *= (0.20 + 0.13 * scale[..., None] + 0.05 * fiber[..., None])
    rgb *= np.array([1.0, 0.86, 0.66], np.float32)[None, None, :]
    # мох с теневой стороны и в углублениях
    moss = proc.periodic_noise(n, n, 12, rng)
    moss_m = sat((moss - 0.55) * 3.0) * deep * mossy
    rgb = rgb * (1 - moss_m[..., None]) + np.array([0.085, 0.135, 0.055], np.float32) * moss_m[..., None]
    rgb *= (0.75 + 0.35 * proc.periodic_noise(n, n, 60, rng))[..., None]
    h = 0.3 + 0.5 * scale - 0.35 * deep
    rough = np.clip(0.72 + 0.16 * deep - 0.10 * moss_m + 0.05 * fiber, 0.2, 0.98)
    return sat(rgb ** (1 / 2.2)), h.astype(np.float32), rough.astype(np.float32)


def spruce_bark(size, rng):
    n = size
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    u = xx / (n - 1) * 6; v = yy / (n - 1) * 6
    plate = proc.ridged(n, n, 4, 12, rng=rng)
    flake = proc.periodic_noise(n, n, 90, rng)
    rgb = np.stack([0.135 + 0.10 * plate, 0.095 + 0.07 * plate, 0.062 + 0.05 * plate], -1)
    rgb *= (0.85 + 0.3 * flake[..., None])
    lichen = sat((proc.periodic_noise(n, n, 20, rng) - 0.72) * 5)
    rgb = rgb * (1 - lichen[..., None]) + np.array([0.30, 0.32, 0.24], np.float32) * lichen[..., None]
    h = plate * 0.7 + flake * 0.3
    rough = np.clip(0.75 + 0.2 * (1 - plate) - 0.15 * lichen, 0.3, 0.99)
    return sat(rgb ** (1 / 2.2)), h.astype(np.float32), rough.astype(np.float32)


def normal_from_height(h, strength=2.2):
    dy, dx = np.gradient(h.astype(np.float32))
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    return (n * 0.5 + 0.5).astype(np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--veg", type=int, default=1024)
    ap.add_argument("--bark", type=int, default=512)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--seed", type=int, default=2026)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rng = np.random.default_rng(a.seed)

    alb, rgh = make_veg(a.veg, rng)
    proc.save_png(os.path.join(a.out, "veg_atlas.png"), alb)
    # r — шероховатость, g — просвет. Два канала Pillow не любит, кладём в RGB (b = 0).
    proc.save_png(os.path.join(a.out, "veg_rough.png"),
                  np.concatenate([rgh, np.zeros(rgh.shape[:2] + (1,), np.float32)], -1), mode="RGB")
    for stem, fn in (("bamboo_culm", bamboo_culm), ("palm_trunk", palm_trunk),
                     ("spruce_bark", spruce_bark)):
        rgb, h, rough = fn(a.bark, rng)
        proc.save_png(os.path.join(a.out, f"{stem}.png"), np.concatenate([rgb, rough[..., None]], -1))
        nrm = normal_from_height(h, 2.4)
        proc.save_png(os.path.join(a.out, f"{stem}_nrm.png"),
                      np.concatenate([nrm, np.ones(nrm.shape[:2] + (1,), np.float32)], -1))
    st = proc.material_stats(srgb2lin(alb[..., :3]), alb[..., 3])
    print(f"veg_atlas.png {alb.shape[1]}x{alb.shape[0]} (9 видов), veg_rough.png, "
          f"bamboo_culm/palm_trunk/spruce_bark + нормали ({a.bark}²)")
    print(f"  листва: яркость {st['albedo_mean']:.3f}, шероховатость {st['rough_mean']:.2f}")
    return 0


def srgb2lin(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


if __name__ == "__main__":
    sys.exit(main())

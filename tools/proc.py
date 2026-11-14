#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Процедурные текстуры ShopSim: общие функции.

Всё, что нужно генераторам (tools/make_*_tex.py) и проверке материалов:
периодический шум (чтобы текстура сшивалась без шва), фрактальный шум,
покраска по маске, мягкие пятна-грязь, запись PNG и мерки «реальности»
материала (средняя яркость, насыщенность, контраст, шероховатость).

Числовые ориентиры взяты из фотографий улиц (Самара, Пекин, Берлин) и
измеряются tools/check_materials.py. Цель — не «красивая картинка», а
материал, который не светится: альбедо стены 0.18..0.38, асфальта 0.055..0.12,
дёрна 0.06..0.16.
"""
from __future__ import annotations

import numpy as np

# ------------------------------------------------------------------ шум
def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * (3.0 - 2.0 * t)


def periodic_noise(h: int, w: int, period: int, rng: np.random.Generator,
                   wrap: bool = True) -> np.ndarray:
    """Значения на решётке period×period, билинейная интерполяция с оборотом.

    wrap=False даёт обычный шум без требования сшивки (для масок, а не тайлов).
    """
    gy, gx = period, period
    grid = rng.random((gy, gx)).astype(np.float32)
    # wrap=True: конец диапазона ровно на клетку дальше, координата h/n*period
    # пробегает [0, period) — при переходе через границу решётка повторяется,
    # поэтому текстура сшивается без шва.
    ys = np.linspace(0.0, gy, h, endpoint=False, dtype=np.float32) if wrap else \
        np.linspace(0.0, gy - 1, h, dtype=np.float32)
    xs = np.linspace(0.0, gx, w, endpoint=False, dtype=np.float32) if wrap else \
        np.linspace(0.0, gx - 1, w, dtype=np.float32)
    y0 = np.floor(ys).astype(np.int32)
    x0 = np.floor(xs).astype(np.int32)
    fy = _smooth(ys - y0)
    fx = _smooth(xs - x0)
    y1 = (y0 + 1) % gy if wrap else np.minimum(y0 + 1, gy - 1)
    x1 = (x0 + 1) % gx if wrap else np.minimum(x0 + 1, gx - 1)
    a = grid[np.ix_(y0, x0)]
    b = grid[np.ix_(y0, x1)]
    c = grid[np.ix_(y1, x0)]
    d = grid[np.ix_(y1, x1)]
    top = a + (b - a) * fx[None, :]
    bot = c + (d - c) * fx[None, :]
    return (top + (bot - top) * fy[:, None]).astype(np.float32)


def fbm(h: int, w: int, oct: int = 4, base: int = 4, lac: float = 2.0,
         gain: float = 0.5, rng: np.random.Generator | None = None,
         wrap: bool = True) -> np.ndarray:
    """Фрактальный шум в [-1, 1]. base — ячеек шумовой решётки на первый октаву."""
    rng = rng or np.random.default_rng(0)
    out = np.zeros((h, w), dtype=np.float32)
    amp = 1.0
    total = 0.0
    p = base
    for i in range(oct):
        n = periodic_noise(h, w, max(2, int(p)), rng, wrap=wrap)
        # Каждая следующая октава короче по стороне: при lac=2 решётка 4,8,16,32.
        out += amp * (n - 0.5) * 2.0
        total += amp
        amp *= gain
        p *= lac
    return (out / max(total, 1e-6)).astype(np.float32)


def ridged(h: int, w: int, oct: int = 4, base: int = 4, rng=None, wrap: bool = True) -> np.ndarray:
    f = fbm(h, w, oct, base, rng=rng, wrap=wrap)
    r = 1.0 - np.abs(f)
    return (r * r).astype(np.float32)


def domain_warp(n: np.ndarray, k: float, rng, oct: int = 2) -> np.ndarray:
    f = fbm(n.shape[0], n.shape[1], oct, 8, rng=rng, wrap=False)
    g = fbm(n.shape[0], n.shape[1], oct, 8, rng=rng, wrap=False)
    h, w = n.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dx = (f - 0.5) * k * w
    dy = (g - 0.5) * k * h
    return bilinear(n, xx + dx, yy + dy)


def bilinear(img: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Выборка img (H,W) или (H,W,C) в плавающих координатах с краем «зеркало»."""
    h, w = img.shape[:2]
    x = np.clip(xs, 0, w - 1.001)
    y = np.clip(ys, 0, h - 1.001)
    x0 = x.astype(np.int32); y0 = y.astype(np.int32)
    x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[..., None] if img.ndim == 3 else (x - x0)
    fy = (y - y0)[..., None] if img.ndim == 3 else (y - y0)
    a = img[y0, x0]; b = img[y0, x1]; c = img[y1, x0]; d = img[y1, x1]
    return (a + (b - a) * fx + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy).astype(np.float32)


# ------------------------------------------------------------- морфология
def _box1(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    """Скользящее среднее по оси: cumsum с нулём спереди, край — «продолжить»."""
    n = a.shape[axis]
    k = 2 * r + 1
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    ap = np.pad(a, pad, mode="edge").astype(np.float32)
    cs = np.cumsum(ap, axis=axis)
    z = np.take(ap, [0], axis=axis) * 0.0
    cs = np.concatenate([z, cs], axis=axis)
    hi = [slice(None)] * a.ndim
    lo = [slice(None)] * a.ndim
    hi[axis] = slice(k, k + n)
    lo[axis] = slice(0, n)
    return (cs[tuple(hi)] - cs[tuple(lo)]) / np.float32(k)


def blur(n: np.ndarray, r: int, passes: int = 3) -> np.ndarray:
    """Гауссево приближение: три прохода box-фильтра по обеим осям."""
    if r <= 0:
        return n.astype(np.float32)
    out = n.astype(np.float32)
    for _ in range(passes):
        for ax in (0, 1):
            out = _box1(out, r, ax)
    return out


def grey(n: np.ndarray) -> np.ndarray:
    m, M = float(n.min()), float(n.max())
    return ((n - m) / max(M - m, 1e-6)).astype(np.float32)


def tint(rgb: np.ndarray, mul: np.ndarray | tuple, add: np.ndarray | tuple | None = None) -> np.ndarray:
    out = rgb * np.asarray(mul, dtype=np.float32)
    if add is not None:
        out = out + np.asarray(add, dtype=np.float32)
    return out.astype(np.float32)


# ------------------------------------------------------------------ ввод/вывод
def save_png(path: str, arr: np.ndarray, mode: str = "RGBA") -> None:
    """arr — float 0..1 или uint8; режим RGBA/RGB/L."""
    from PIL import Image
    import os
    if arr.dtype != np.uint8:
        a = np.clip(arr, 0.0, 1.0)
        arr = (a * 255.0 + 0.5).astype(np.uint8)
    img = Image.fromarray(arr, mode=mode)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True, compress_level=9)


def load_png(path: str, mode: str = "RGB") -> np.ndarray:
    from PIL import Image
    a = np.array(Image.open(path).convert(mode), dtype=np.float32) / 255.0
    return a


# --------------------------------------------------- мерки «настоящести»
def material_stats(rgb: np.ndarray, rough: np.ndarray | None = None) -> dict:
    """Средняя яркость, насыщенность, контраст и шероховатость материала.

    L* здесь — не CIE, а простая яркость по Rec.709 в линейном пространстве:
    для проверки «не ярче 0.38» этого достаточно и совпадает с тем, как
    материал видит шейдер (он работает в линейных числах).
    """
    lin = np.clip(rgb, 0, 1) ** 2.2
    lum = (lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722)
    mx = lin.max(axis=-1)
    mn = lin.min(axis=-1)
    sat = np.where(mx > 1e-4, (mx - mn) / np.maximum(mx, 1e-4), 0)
    st = {
        "albedo_mean": float(lum.mean()),
        "albedo_p05": float(np.quantile(lum, 0.05)),
        "albedo_p95": float(np.quantile(lum, 0.95)),
        "saturation": float(sat.mean()),
        "contrast": float(np.quantile(lum, 0.95) - np.quantile(lum, 0.05)),
        "hot_p999": float(np.quantile(lum, 0.999)),
    }
    if rough is not None:
        st["rough_mean"] = float(np.mean(rough))
        st["rough_p05"] = float(np.quantile(rough, 0.05))
        st["rough_p95"] = float(np.quantile(rough, 0.95))
    return st

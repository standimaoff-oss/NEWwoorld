#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Эталонный (CPU) рендер шейдеров ShopSim — снимки для README и проверка чисел.

Зачем. В песочнице нет ни GPU, ни браузера, поэтому «скриншот» игры получить
нечем. Но весь свет и все формы считаются формулами из shaders/glsl, и эти же
формулы здесь продублированы построчно. Значит картинка, которую печатает этот
скрипт, совпадает с тем, что выдаст видеокарта: та же геометрия ленты, тот же
ветер, тот же наклон фронта волны, та же кривая ACES. Это не «arty-мокап»,
а контрольный прогон чисел — он ловит NaN, почерневшие материалы и случайные
«слишком ярко» до того, как сборка доедет до телефона.

Режимы:
    grass   — поле травинок (атлас + ветер + AO + сезон)
    water   — вода: волны Герстнера, Френель, пена, мелководье
    clouds  — небо и облака (тот же проход, что в игре)
    rain    — дождь на стекле (пост-проход витрины)
    scene   — сцена из дампа веб-сборки (build/preview/scene.json)

Запуск:
    python3 tools/shader_preview.py grass --out docs/screenshots/5_33_grass.png
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import proc  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ============================================================== общие функции
# Перенос один-в-один из shaders/glsl/common.glsl. Если правка там — прави здесь.
PI = math.pi
TAU = 2 * math.pi


def h12(p: np.ndarray) -> np.ndarray:
    """hash12: p — (…,2)."""
    px = np.stack([p[..., 0], p[..., 1], p[..., 0]], -1) * 0.1031
    f = px - np.floor(px)
    f3 = f + np.sum(f * np.roll(f, 1, axis=-1) + 33.33, axis=-1, keepdims=True)
    g = (f3[..., 0] + f3[..., 1]) * f3[..., 2]
    return g - np.floor(g)


def vnoise2(p: np.ndarray) -> np.ndarray:
    i = np.floor(p); f = p - i
    u = f * f * (3 - 2 * f)
    a = h12(i); b = h12(i + [1, 0]); c = h12(i + [0, 1]); d = h12(i + [1, 1])
    return (a + (b - a) * u[..., 0]) * (1 - u[..., 1]) + \
           ((c + (d - c) * u[..., 0]) - (a + (b - a) * u[..., 0])) * u[..., 1]


def fbm2(p: np.ndarray, oct: int = 3) -> np.ndarray:
    s = np.zeros(p.shape[:-1], np.float32); a = 0.5
    m = np.array([[1.6, 1.2], [-1.2, 1.6]], np.float32)
    for _ in range(oct):
        s = s + a * (vnoise2(p.astype(np.float32)) * 2 - 1)
        p = p @ m.T
        a *= 0.5
    return s


def ridge2(p: np.ndarray, oct: int = 3) -> np.ndarray:
    s = np.zeros(p.shape[:-1], np.float32); a = 0.5
    m = np.array([[1.7, 1.3], [-1.3, 1.7]], np.float32)
    for _ in range(oct):
        n = 1 - np.abs(vnoise2(p.astype(np.float32)) * 2 - 1)
        s = s + a * n * n
        p = p @ m.T
        a *= 0.5
    return s


def sat(x):
    return np.clip(x, 0.0, 1.0)


def smoothstep(e0, e1, x):
    t = sat((x - e0) / max(e1 - e0, 1e-6))
    return t * t * (3 - 2 * t)


def srgb2lin(c):
    c = np.asarray(c, np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def aces(x):
    return sat((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))


def to_srgb(c):
    c = np.clip(c, 1e-5, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def shade_out(col, exposure=1.0):
    return to_srgb(aces(np.clip(col, 0.0, 8.0) * exposure))


def ggx(n, v, l, rough):
    h = v + l
    h = h / np.maximum(np.linalg.norm(h, axis=-1, keepdims=True), 1e-8)
    a = max(rough * rough, 0.0025)
    nh = np.maximum(n @ h.T if n.ndim == 1 else (n * h).sum(-1), 0.0)
    nv = np.maximum((n * v).sum(-1) if n.ndim > 1 else n @ v, 1e-4)
    nl = np.maximum((n * l).sum(-1) if n.ndim > 1 else n @ l, 1e-4)
    a2 = a * a
    dd = a2 / (np.square(nh * nh * (a2 - 1) + 1) + 1e-7)
    k = a * 0.5
    return dd * (nv / (nv * (1 - k) + k)) * (nl / (nl * (1 - k) + k)) / (4 * nv * nl + 1e-6)


def fresnel(u, f0=0.04):
    return f0 + (1 - f0) * (1 - u) ** 5


def sky_color(rd, sun, day, turbidity=1.2):
    """Небо как в common.glsl: зенит/горизонт от высоты солнца, диск и гало."""
    rd = np.asarray(rd, np.float32)
    h = np.clip(rd[..., 1], -0.2, 1.0)
    zen = (1 - day) * np.array([0.012, 0.020, 0.043]) + day * np.array([0.148, 0.286, 0.524])
    hor = (1 - day) * np.array([0.030, 0.040, 0.068]) + day * np.array([0.540, 0.640, 0.760])
    sunset = (1 - day) ** 1.6 * day * 4.0
    hor = hor + np.array([0.55, 0.20, 0.03]) * sunset
    t = (1 - np.maximum(h, 0)) ** turbidity
    c = zen[None] * (1 - t[..., None]) + hor[None] * t[..., None]
    d = np.maximum(rd @ sun, 0.0)
    sunc = (1 - day) * np.array([1.0, 0.62, 0.30]) + day * np.array([1.0, 0.96, 0.88])
    c = c + sunc[None] * (smoothstep(0.9985, 0.9993, d)[..., None] * 24 * day)
    c = c + sunc[None] * (d ** 64 * 0.45 * day)[..., None]
    c = c + sunc[None] * (d ** 6 * 0.06 * day)[..., None]
    return np.maximum(c, 0.002)


def gerstner(xz, t, direction, amp, length, speed=1.0, steep=0.9):
    k = TAU / max(length, 0.5)
    c = math.sqrt(9.81 / k) * speed
    ph = k * (xz @ direction - c * t)
    a = amp * k
    sf, cf = np.sin(ph), np.cos(ph)
    grad = np.stack([direction[0] * a * cf, direction[1] * a * cf], -1)
    disp = np.stack([direction[0] * steep * (amp / k) * sf, a / k * cf,
                     direction[1] * steep * (amp / k) * sf], -1)
    return disp, grad


WAVES = None  # заполняется в init_waves()


def init_waves(amp_scale: float = 1.0):
    dirs = [np.array([1.0, 0.22]), np.array([-0.35, 1.0]), np.array([0.82, -0.58]),
            np.array([-0.9, -0.3]), np.array([0.3, 0.95])]
    lens = [42.0, 21.0, 9.5, 4.2, 1.7]
    amps = [0.62, 0.34, 0.17, 0.075, 0.028]
    speeds = [1.0, 1.0, 1.05, 1.1, 1.2]
    steep = [0.85, 0.90, 0.95, 1.0, 1.0]
    return [(d / np.linalg.norm(d), a * amp_scale, l, s, st) for d, a, l, s, st in
            zip(dirs, amps, lens, speeds, steep)]


def water_sum(xz: np.ndarray, t: float, amp: float):
    """Сумма волн: (dx, dy, dz) и наклон фронта — как waterSum() в GLSL."""
    acc = np.zeros(xz.shape[:-1] + (3,), np.float32)
    grad = np.zeros(xz.shape[:-1] + (2,), np.float32)
    for (d, a, l, s, st) in init_waves(amp):
        disp, g = gerstner(xz, t, d, a, l, s, st)
        acc += disp
        grad += g
    acc[..., 0] += grad[..., 0]
    acc[..., 2] += grad[..., 1]
    return acc


# ================================================================== рендерер
class Renderer:
    """Очень простой трассировщик треугольников с z-буфером и альфа-тестом."""

    def __init__(self, w: int, h: int, cam: dict, near: float = 0.05, far: float = 900.0):
        self.w, self.h = w, h
        self.color = np.zeros((h, w, 3), np.float32)
        self.z = np.full((h, w), np.inf, np.float32)
        self.depth = np.ones((h, w), np.float32)
        self.cam = cam
        self.near, self.far = near, far
        self.view = look_at(np.array(cam["pos"], np.float32),
                            np.array(cam["pos"], np.float32) + dir_from(cam["yaw"], cam["pitch"]),
                            np.array([0, 1, 0], np.float32))
        self.proj = perspective(math.radians(cam.get("fov", 55.0)), w / h, near, far)
        self.vp = self.proj @ self.view
        self.stats = {"tris": 0, "px": 0, "discarded": 0}
        # запечённый GI (uGIVol в веб-сборке); mode_scene подкладывает объём
        # из дампа, остальные режимы светят «по-старому» — ambient только от неба
        self.gi = None

    # --- растеризация: подаём треугольники пачками, перекрываем по bbox
    NEAR_EPS = 1e-4

    def clip_near(self, verts, idx, attrs):
        """Обрезка геометрии по near-плоскости.

        Простейший растеризатор без клиппинга обязан либо отбрасывать треугольник,
        у которого хоть одна вершина за камерой (так и было — и потому земля
        «под ногами» пропадала: на 7224 треугольника сети земли 3758 пересекали
        near-плоскость, и нижний угол кадра показывал небо), либо обрезать его.
        Здесь — обрезка: многоугольник отсекается полуплоскостью w > eps, а новая
        вершина интерполируется в МИРОВЫХ координатах с тем же параметром t.
        Это корректно: w — аффинная функция мировой позиции (четвёртая строка
        матрицы проекции), поэтому пересечение отрезка с near-плоскостью в
        мировых координатах и в clip-координатах происходит в одной точке.
        Ошибка на этом месте (записать в вершины NDC вместо мира) даёт ровно тот
        «белый прямоугольник в углу кадра», который ловили на снимке газона.
        """
        clip = np.concatenate([verts, np.ones((len(verts), 1), np.float32)], -1) @ self.vp.T
        cw = clip[:, 3]
        tri_w = cw[idx]
        eps = self.NEAR_EPS
        ok = tri_w > eps
        if ok.all():
            return verts, idx, attrs
        keep = idx[ok.all(1)]
        extraV, extraA, ni = [], [], [keep] if len(keep) else [np.zeros((0, 3), np.int32)]
        for k in np.nonzero(~ok.all(1))[0]:
            ids = idx[k]
            src = [(ids[a], cw[ids[a]]) for a in range(3)]
            poly = []
            for a in range(3):
                (ia, wa), (ib, wb) = src[a], src[(a + 1) % 3]
                ain, bin_ = wa > eps, wb > eps
                if ain:
                    poly.append(ia)
                if ain != bin_:
                    t = (eps - wa) / (wb - wa)
                    pw = verts[ia] + t * (verts[ib] - verts[ia])
                    aw = None if attrs is None else attrs[ia] + t * (attrs[ib] - attrs[ia])
                    poly.append((-1, pw, aw))
            if len(poly) < 3:
                continue
            base = len(verts) + len(extraV)
            ids2, nnew = [], 0
            for e in poly:
                if isinstance(e, tuple):
                    extraV.append(e[1])
                    if attrs is not None:
                        extraA.append(e[2])
                    ids2.append(base + nnew)
                    nnew += 1
                else:
                    ids2.append(e)
            for q in range(1, len(ids2) - 1):
                ni.append(np.array([[ids2[0], ids2[q], ids2[q + 1]]], np.int32))
        v2 = verts if not extraV else np.concatenate([verts, np.array(extraV, np.float32)], 0)
        a2 = attrs
        if extraA and attrs is not None:
            a2 = np.concatenate([attrs, np.array(extraA, np.float32)], 0)
        i2 = np.concatenate(ni, 0).astype(np.int32)
        return v2, i2, a2

    def draw(self, verts: np.ndarray, idx: np.ndarray, shade, alpha_test: float | None = None,
             attrs: np.ndarray | None = None, cull: bool = False):
        """verts (N,3) world, idx (M,3) int, shade(pos, uv, attr) -> (rgb, a)."""
        verts, idx, attrs = self.clip_near(verts, idx, attrs)
        clip = np.concatenate([verts, np.ones((len(verts), 1), np.float32)], -1) @ self.vp.T
        wclip = np.maximum(clip[:, 3:4], 1e-6)
        ndc = clip[:, :3] / wclip
        sx = (ndc[:, 0] * 0.5 + 0.5) * self.w
        sy = (1 - (ndc[:, 1] * 0.5 + 0.5)) * self.h
        sz = ndc[:, 2] * 0.5 + 0.5
        scr = np.stack([sx, sy, sz], -1).astype(np.float32)
        i0, i1, i2 = idx[:, 0], idx[:, 1], idx[:, 2]
        valid = (clip[i0, 3] > 0) & (clip[i1, 3] > 0) & (clip[i2, 3] > 0)
        ax, ay = scr[i0, 0], scr[i0, 1]
        bx, by = scr[i1, 0], scr[i1, 1]
        cx, cy = scr[i2, 0], scr[i2, 1]
        area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
        if cull:
            valid &= np.abs(area2) > 1e-6
        else:
            valid &= np.abs(area2) > 1e-6
        sel = np.nonzero(valid)[0]
        for k in sel:
            a2 = area2[k]
            A, B, C = i0[k], i1[k], i2[k]
            p0, p1, p2 = scr[A], scr[B], scr[C]
            x0 = max(int(math.floor(min(p0[0], p1[0], p2[0]))), 0)
            x1 = min(int(math.ceil(max(p0[0], p1[0], p2[0]))), self.w - 1)
            y0 = max(int(math.floor(min(p0[1], p1[1], p2[1]))), 0)
            y1 = min(int(math.ceil(max(p0[1], p1[1], p2[1]))), self.h - 1)
            if x1 < x0 or y1 < y0:
                continue
            # От «бесконечных» треугольников защищать bbox НЕ надо: он уже
            # зажат размерами кадра, и растеризуется не больше w*h пикселей.
            # Раньше здесь стоял потолок по площади ДО зажатия — и ближайшая к
            # камере клетка земли (её проекция шире экрана) молча пропадала,
            # оставляя в углу кадра дыру в цвете неба. Проверяем только, что
            # координаты конечны: nan/inf приходят из битой геометрии, а не из
            # больших треугольников.
            if not (math.isfinite(p0[0]) and math.isfinite(p1[0]) and math.isfinite(p2[0])
                    and math.isfinite(p0[1]) and math.isfinite(p1[1]) and math.isfinite(p2[1])):
                continue
            xs = np.arange(x0, x1 + 1, dtype=np.float32) + 0.5
            ys = np.arange(y0, y1 + 1, dtype=np.float32) + 0.5
            gx, gy = np.meshgrid(xs, ys)
            w0 = ((gx - p1[0]) * (p1[1] - p2[1]) - (gy - p1[1]) * (p1[0] - p2[0])) / a2
            w1 = ((gx - p2[0]) * (p2[1] - p0[1]) - (gy - p2[1]) * (p2[0] - p0[0])) / a2
            w2 = 1 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            bary = np.stack([w0, w1, w2], -1)[inside]              # (K,3)
            z = bary @ np.array([p0[2], p1[2], p2[2]], np.float32)
            # координаты пикселей берём из того же булева маски: meshgrid идёт
            # (строка=y, столбец=x), поэтому np.nonzero даёт согласованный порядок
            ny, nx = np.nonzero(inside)
            pix_y = ny + y0
            pix_x = nx + x0
            zbuf = self.z[pix_y, pix_x]
            keep = z < zbuf
            if not keep.any():
                continue
            # стек по оси 0: (3, nchan), тогда bary (K,3) @ (3,nchan) → (K,nchan)
            # для любого числа каналов атрибутов (uv, id грани, материал, цвет)
            pos = bary @ np.stack([verts[A], verts[B], verts[C]], 0)   # (K,3)
            uv = None
            at = None
            if attrs is not None:
                at = bary @ np.stack([attrs[A], attrs[B], attrs[C]], 0)
            rgb, a = shade(pos, uv, at)
            if alpha_test is not None:
                m = keep & (a >= alpha_test)
                self.stats["discarded"] += int((keep & (a < alpha_test)).sum())
            else:
                m = keep
            if not m.any():
                continue
            self.stats["tris"] += 1
            self.stats["px"] += int(m.sum())
            yy, xx = pix_y[m], pix_x[m]
            self.z[yy, xx] = z[m]
            self.depth[yy, xx] = z[m]
            self.color[yy, xx] = rgb[m]

    def fill_sky(self, sun: np.ndarray, day: float, clouds: float = 0.0, fog=(0.42, 0.48, 0.55),
                 exposure: float | None = None):
        ys, xs = np.mgrid[0:self.h, 0:self.w].astype(np.float32)
        ndcx = (xs + 0.5) / self.w * 2 - 1
        ndcy = 1 - (ys + 0.5) / self.h * 2
        fwd = dir_from(self.cam["yaw"], self.cam["pitch"])
        right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        aspect = self.w / self.h
        tf = math.tan(math.radians(self.cam.get("fov", 55.0)) / 2)
        rd = fwd[None, None] * 1.0 + \
            (right[None, None] * (ndcx * tf * aspect)[..., None]) + \
            (up[None, None] * (ndcy * tf)[..., None])
        rd = rd / np.linalg.norm(rd, axis=-1, keepdims=True)
        col = sky_color(rd.reshape(-1, 3), sun, day, 1.25).reshape(self.h, self.w, 3)
        if clouds > 0.001:
            col = self._clouds(rd, col, sun, day, clouds)
        # В HDR-таргете небо линейное, а ACES+sRGB навешивает post.frag. Здесь
        # тот же порядок: иначе небо на снимке светлее объектов в 2-3 раза.
        if exposure is not None:
            col = shade_out(np.clip(col, 0.0, 8.0), exposure)
        self.color = col.astype(np.float32)
        self.z[:] = np.inf
        return self.color

    def _clouds(self, rd, col, sun, day, cover):
        h_base, h_top = 900.0, 1500.0
        t = np.maximum((h_top - 0.0) / np.maximum(rd[..., 1], 1e-3), 0.0)
        acc = np.zeros(rd.shape[:2] + (3,), np.float32)
        trans = np.ones(rd.shape[:2], np.float32)
        tt = np.zeros(rd.shape[:2], np.float32)
        for i in range(6):
            frac = (i + 0.5) / 6.0
            p = rd * (tt + frac * t)[..., None]
            h = (p[..., 1] - h_base) / (h_top - h_base)
            q = p[..., [0, 2]]
            dens = cloud_density(q, h, cover, i * 3.3)
            lit = np.exp(-dens * 0.9)
            a = 1 - np.exp(-dens * 0.35)
            tint = np.array([0.62, 0.64, 0.68], np.float32)[None, None, :] * (0.35 + 0.65 * lit)[..., None]
            sun_tint = ((1 - day) * np.array([0.3, 0.34, 0.45], np.float32) +
                        day * np.array([1.0, 0.97, 0.9], np.float32))[None, None, :]
            acc = acc + trans[..., None] * a[..., None] * tint * sun_tint
            trans *= 1 - a
            if trans.max() < 0.02:
                break
        return col * trans[..., None] + acc

    def save(self, path: str, pool: int = 1):
        """pool > 1 — усреднение блоков: тот же эффект, что мультисэмплинг на GPU.
        Без него треугольник в 1-2 пикселя (травинка в 15 м) попадает между
        центрами пикселей и исчезает, а снимок начинает врать про плотность травы."""
        os.makedirs(os.path.dirname(path), exist_ok=True)
        col = self.color
        if pool > 1:
            h, w = col.shape[:2]
            col = col[:h // pool * pool, :w // pool * pool].reshape(h // pool, pool, w // pool, pool, 3)
            col = col.mean(axis=(1, 3))
            self.color = col.astype(np.float32)
            self.w, self.h = col.shape[1], col.shape[0]
        img = (np.clip(self.color, 0, 1) * 255 + 0.5).astype(np.uint8)
        from PIL import Image
        Image.fromarray(img).save(path, optimize=True)
        print(f"  → {os.path.relpath(path, ROOT)}  {self.w}x{self.h}  "
              f"треуг. {self.stats['tris']}  пикс. {self.stats['px']:,}")


def cloud_density(p, h, cover, seed):
    if np.any(h < 0) or np.all(h > 1):
        return np.zeros(p.shape[:-1], np.float32)
    q = p + 0.0
    base = vnoise2(q * 0.0016 + np.array([0.0, h * 0.4]))
    det = fbm2(q * 0.0062 + np.array([h * 1.7, -h * 0.9]), 4)
    d = base * 0.75 + det * 0.35 - (1 - cover) * 0.62
    d -= np.abs(h - 0.5) * 0.55
    return np.maximum(d, 0) * 2.2


# --------------------------------------------------------------- камера
def dir_from(yaw: float, pitch: float) -> np.ndarray:
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    return np.array([sy * cp, sp, cy * cp], np.float32)


def look_at(eye, target, up):
    f = target - eye
    f = f / np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r) + 1e-9
    u = np.cross(r, f)
    m = np.eye(4, dtype=np.float32)
    m[0, :3] = r
    m[1, :3] = u
    m[2, :3] = -f
    m[0, 3] = -r @ eye
    m[1, 3] = -u @ eye
    m[2, 3] = f @ eye
    return m


def perspective(fovy, aspect, near, far):
    f = 1 / math.tan(fovy / 2)
    m = np.zeros((4, 4), np.float32)
    m[0, 0] = f / aspect
    m[1, 1] = f
    m[2, 2] = (far + near) / (near - far)
    m[2, 3] = 2 * far * near / (near - far)
    m[3, 2] = -1
    return m


# ============================================================== режим: трава
def blade_mesh(segments: int = 4):
    """Лента: (segments+1)*2 вершин, атрибуты (u, v, 0). Локальные координаты."""
    vs, ii, at = [], [], []
    for i in range(segments + 1):
        v = i / segments
        w = 1.0 - 0.72 * v * v
        for s in (-1, 1):
            vs.append([s * w, v, 0.0])
            at.append([0.5 + 0.5 * s * 1.0, v])
    for i in range(segments):
        a = i * 2
        ii += [[a, a + 1, a + 3], [a, a + 3, a + 2]]
    return np.array(vs, np.float32), np.array(ii, np.int32), np.array(at, np.float32)


TINTS = [np.array([0.150, 0.230, 0.085], np.float32),   # овсяница
         np.array([0.135, 0.205, 0.095], np.float32),   # мятлик
         np.array([0.190, 0.215, 0.080], np.float32),   # пырей
         np.array([0.205, 0.220, 0.110], np.float32),   # разнотравье
         np.array([0.330, 0.290, 0.150], np.float32)]   # сухостой


def mode_grass(args):
    atlas = srgb2lin(proc.load_png(os.path.join(ROOT, "assets/textures/grass_blade.png"), "RGBA"))
    ah, aw = atlas.shape[:2]
    turf = srgb2lin(proc.load_png(os.path.join(ROOT, "assets/textures/grass_turf.png"), "RGBA"))
    cells = 4
    rows = 3
    cw, ch = aw / cells, ah / rows

    rng = np.random.default_rng(args.seed)
    cam = {"pos": [0.0, 1.05, -6.0], "yaw": 0.0, "pitch": -0.10, "fov": 58}
    R = Renderer(args.w, args.h, cam)
    sun = np.array([0.42, 0.55, 0.72], np.float32); sun /= np.linalg.norm(sun)
    day = 0.92
    R.fill_sky(sun, day, clouds=args.clouds)

    t = args.time
    wind_dir = np.array([0.86, 0.51], np.float32); wind_dir /= np.linalg.norm(wind_dir)
    strength = args.wind
    V, I, A = blade_mesh(5)

    # земля под травой: дёрн
    ground_quad(R, turf, args.ground)

    n_blades = args.blades
    span = args.ground
    px = (rng.random(n_blades) - 0.5) * span
    pz = (rng.random(n_blades) - 0.5) * span * 0.9 + span * 0.18
    sp = rng.integers(0, 5, n_blades)
    var = rng.integers(0, 2, n_blades)
    height = rng.uniform(0.22, 0.62, n_blades).astype(np.float32) * args.height_mul
    width = (height * rng.uniform(0.055, 0.10, n_blades)).astype(np.float32)
    rot = rng.uniform(0, TAU, n_blades).astype(np.float32)
    curve = rng.uniform(-0.5, 0.5, n_blades).astype(np.float32)
    phase = rng.random(n_blades).astype(np.float32)
    wet = np.full(n_blades, args.wet, np.float32)

    dist = np.hypot(px - cam["pos"][0], pz - cam["pos"][2])
    order = np.argsort(-dist)                      # дальние раньше: меньше перезаписей
    px, pz, sp, var, height, width, rot, curve, phase, wet = [
        a[order] for a in (px, pz, sp, var, height, width, rot, curve, phase, wet)]

    season = np.array([args.summer, args.autumn, args.winter, args.spring], np.float32)
    for i in range(n_blades):
        gust = fbm2(np.stack([px[i], pz[i]])[None] * 0.018 + np.array([t * 0.55, t * 0.21]), 2)[0]
        g2 = float(vnoise2(np.array([px[i] * 0.0032 - t * 0.09, pz[i] * 0.0032 - t * 0.05])) * 2 - 1)
        d = math.hypot(px[i] - cam["pos"][0], pz[i] - cam["pos"][2])
        travel = 0.5 + 0.5 * math.sin(d * 0.09 - t * 3.1)
        bend_amt = strength * (0.55 + 0.45 * travel) * (0.6 + 0.4 * g2) * (gust * 0.75 + g2 * 0.55 +
                   0.18 * math.sin(t * 2.7 + phase[i] * TAU)) * 0.5 + 0.35 * strength
        bend_amt = float(np.clip(bend_amt, 0, 1.35))
        h = height[i]
        w = width[i]
        verts = np.zeros((len(V), 3), np.float32)
        yy = V[:, 1]
        bw = (1 - 0.42 * bend_amt * bend_amt)
        verts[:, 1] = h * yy * bw
        off = wind_dir * bend_amt * h * 0.62 * np.power(yy, 1.7)[:, None]
        lean = np.array([math.cos(rot[i] + 1.1), math.sin(rot[i] + 1.1)], np.float32) * 0.10 * h
        verts[:, 0] = px[i] + off[:, 0] + lean[0] + np.cos(rot[i]) * V[:, 0] * w
        verts[:, 2] = pz[i] + off[:, 1] + lean[1] + np.sin(rot[i]) * V[:, 0] * w
        verts[:, 1] += curve * np.power(yy, 1.7) * h * 0.10
        attrs = np.zeros((len(V), 4), np.float32)
        attrs[:, :2] = A
        attrs[:, 2] = sp[i]
        attrs[:, 3] = var[i]

        def shade(pos, _uv, at, atlas=atlas, cw=cw, ch=ch, t=t, sun=sun, day=day,
                  season=season, wet=wet[i], cells=cells, rows=rows):
            u, v, species, variant = at[:, 0], at[:, 1], at[:, 2], at[:, 3]
            idx = species * 2 + variant
            col_id = (idx % cells)
            row_id = np.floor(idx / cells)
            su = np.clip((col_id + u) / cells, 0, 1)
            sv = np.clip((row_id + (1 - v)) / rows, 0, 1)     # v=0 внизу, в атласе y сверху вниз
            xi = np.clip((su * aw).astype(np.int32), 0, aw - 1)
            yi = np.clip((sv * ah).astype(np.int32), 0, ah - 1)
            tex = atlas[yi, xi]                                 # (K,4) линейный sRGB-декод
            a = tex[:, 3]
            ao = np.where(v < 0.5, 0.18 + 0.82 * np.sqrt(np.maximum(v, 0) * 2), 1.0)
            tint = np.array([TINTS[int(s)] for s in species.astype(int)])
            seas = (season[0] * 1.0 + season[1] * np.array([1.10, 0.92, 0.55]) * 0.9 +
                    season[2] * np.array([0.72, 0.80, 0.72]) * 0.55 +
                    season[3] * np.array([0.85, 1.06, 0.80]))
            alb = tex[:, :3] * tint * seas * (0.42 + 0.58 * ao)[:, None]
            wfac = np.clip(wet * 0.65 + (1 - v) * 0.25, 0, 1)
            alb = alb * (1 - 0.34 * wfac)[:, None]
            n = np.zeros((len(v), 3), np.float32)
            fa = rot[i]
            n[:, 0] = np.cos(fa) * 0.75
            n[:, 1] = 0.62 + 0.35 * v
            n[:, 2] = np.sin(fa) * 0.75
            n /= np.linalg.norm(n, axis=-1, keepdims=True)
            vview = np.array(cam["pos"], np.float32)[None] - pos
            vview /= np.linalg.norm(vview, axis=-1, keepdims=True)
            ndv = np.abs((n * vview).sum(-1))
            ndl = (n * sun).sum(-1)
            wrap = sat((ndl + 0.35) / 1.35)
            sunc = (1 - day) * np.array([0.35, 0.42, 0.58]) + day * np.array([1.05, 0.96, 0.82])
            trans = sat(-ndl) * sat(1 - np.abs((vview * sun).sum(-1)))
            back = 0.75 * (trans * 0.85 + (1 - ndv) * 0.25)
            occ = 0.55 + 0.45 * sat(np.exp(-np.maximum(v, 0) * 0.0))
            diff = alb * sunc[None] * (wrap + back) * day * occ[:, None]
            sky_amb = ((1 - day) * np.array([0.030, 0.045, 0.075]) + day * sky_color(
                np.array([[0.0, 1.0, 0.0]], np.float32), sun, day, 1.0)[0] * 1.15)
            amb = alb * (sky_amb[None] * (0.55 + 0.45 * np.clip(n[:, 1], 0, 1))[:, None])
            rough = 0.62 - 0.32 * wfac
            vv = vview
            hl = vv + sun[None]
            hl /= np.linalg.norm(hl, axis=-1, keepdims=True) + 1e-8
            spec = np.zeros(len(v), np.float32)
            for q in range(len(v)):
                spec[q] = float(ggx(n[q], vv[q], sun, float(rough[q])) * max((n[q] @ sun), 0.0))
            col = diff + amb + sunc[None] * spec[:, None] * 0.25 * fresnel(ndv, 0.035)[:, None]
            return col.astype(np.float32), a * 1.0

        R.draw(verts, I, shade, alpha_test=0.42, attrs=attrs, cull=False)
    R.save(args.out)


def ground_quad(R: Renderer, turf: np.ndarray, span: float):
    """Земля — большая плоскость с тайловым дёрном (тот же uv*, что в ground.frag)."""
    th, tw = turf.shape[:2]
    n = 6
    vs, ii, at = [], [], []
    for iz in range(n + 1):
        for ix in range(n + 1):
            x = (-0.5 + ix / n) * span * 2.2
            z = (-0.5 + iz / n) * span * 2.2
            vs.append([x, 0.0, z])
            at.append([x * 0.12, z * 0.12])
    for iz in range(n):
        for ix in range(n):
            a = iz * (n + 1) + ix
            ii += [[a, a + 1, a + n + 2], [a, a + n + 2, a + n + 1]]
    vs = np.array(vs, np.float32); ii = np.array(ii, np.int32); at = np.array(at, np.float32)

    def shade(pos, _uv, attr):
        u = np.mod(attr[:, 0], 1.0) * tw
        v = np.mod(attr[:, 1], 1.0) * th
        xi = np.clip(u.astype(np.int32), 0, tw - 1)
        yi = np.clip(v.astype(np.int32), 0, th - 1)
        c = turf[yi, xi]
        sun = R.sun_dir if hasattr(R, "sun_dir") else np.array([0.42, 0.55, 0.72], np.float32)
        day = 0.92
        sunc = (1 - day) * np.array([0.35, 0.42, 0.58]) + day * np.array([1.05, 0.96, 0.82])
        col = c[:, :3] * sunc[None] * (0.30 + 0.55) + c[:, :3] * 0.03
        return col.astype(np.float32), np.ones(len(pos), np.float32)

    R.draw(vs, ii, shade, attrs=at)


# ============================================================== режим: вода
def mode_water(args):
    cam = {"pos": [0.0, 2.4, -14.0], "yaw": 0.0, "pitch": -0.14, "fov": 55}
    R = Renderer(args.w, args.h, cam)
    sun = np.array([0.30, 0.28, 0.90], np.float32); sun /= np.linalg.norm(sun)
    day = args.day
    R.fill_sky(sun, day, clouds=args.clouds)

    amp = args.amp
    n = args.grid
    xs = np.linspace(-args.size, args.size, n + 1, dtype=np.float32)
    zs = np.linspace(-args.size * 0.55, args.size * 0.85, n + 1, dtype=np.float32)
    gx, gz = np.meshgrid(xs, zs)
    xz = np.stack([gx.ravel(), gz.ravel()], -1)
    sumw = water_sum(xz, args.time, amp)
    y = sumw[:, 1]
    verts = np.stack([xz[:, 0], y, xz[:, 1]], -1).astype(np.float32)
    idx = []
    for iz in range(n):
        for ix in range(n):
            a = iz * (n + 1) + ix
            b = a + 1
            c = a + (n + 1)
            d = c + 1
            idx += [[a, c, b], [b, c, d]]
    idx = np.array(idx, np.int32)
    slope = sumw[:, [0, 2]].astype(np.float32)

    def shade(pos, _uv, _at, slope=slope, verts=verts, idx=idx):
        sl = slope[idx].mean(1)                                  # (M,2) усреднение по трём вершинам
        nrm = np.stack([-sl[:, 0] * 2.2, np.ones(len(sl)), -sl[:, 1] * 2.2], -1)
        # детальный наклон — два слоя шума, как в water.frag
        p = pos[:, [0, 2]]
        n1 = fbm2(p * 0.55 * args.detail + np.array([args.time * 0.85, args.time * 0.42]), 3)
        n2 = ridge2(p * 1.7 - np.array([args.time * 0.42, args.time * 0.85]), 2)
        dx = (fbm2((p + [0.06, 0]) * 0.55 * args.detail + np.array([args.time * 0.85, args.time * 0.42]), 3) - n1)
        dy = (fbm2((p + [0, 0.06]) * 0.55 * args.detail + np.array([args.time * 0.85, args.time * 0.42]), 3) - n1)
        nrm[:, 0] -= (dx * 6.5 + (ridge2((p + [0.06, 0]) * 1.7, 2) - n2) * 3.0)
        nrm[:, 2] -= (dy * 6.5 + (ridge2((p + [0, 0.06]) * 1.7, 2) - n2) * 3.0)
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        vdir = np.array(cam["pos"], np.float32)[None] - pos
        vdir /= np.linalg.norm(vdir, axis=-1, keepdims=True)
        nv = np.maximum((nrm * vdir).sum(-1), 1e-3)
        f = fresnel(nv, 0.02)
        depth = np.clip(3.2 + 0.5 * np.sin(p[:, 0] * 0.05) + 0.3 * np.cos(p[:, 1] * 0.07), 0.2, 6.0)
        if args.shore:
            depth = np.clip(depth * (0.2 + 0.8 * smoothstep(-args.size * 0.2, args.size * 0.75, p[:, 1])), 0.05, 6)
        absorb = np.exp(-depth[:, None] * np.array([0.42, 0.165, 0.075]) * 1.0)
        deep = np.array([0.020, 0.045, 0.048], np.float32) * absorb * 8
        bed = np.array([0.16, 0.135, 0.095], np.float32)
        clear = smoothstep(2.2, 0.15, depth)
        body = deep * (1 - clear[:, None]) + (bed * 0.55 + deep * 0.45) * clear[:, None]
        rr = 2 * (nrm * vdir).sum(-1, keepdims=True) * nrm - vdir
        rr[:, 1] = np.abs(rr[:, 1]) * 0.9 + 0.02
        refl = sky_color(rr / np.maximum(np.linalg.norm(rr, axis=-1, keepdims=True), 1e-5), sun, day, 1.35)
        col = body * (1 - f[:, None]) + refl * f[:, None]
        # блик солнца
        hl = vdir + sun[None]
        hl /= np.linalg.norm(hl, axis=-1, keepdims=True) + 1e-8
        nh = np.maximum((nrm * hl).sum(-1), 0)
        spec = (nh ** 220) * 6.0 * max(float(np.clip(sun @ np.array([0, 1, 0])) * 0 + day, 0, 1))
        col += np.array([1.0, 0.95, 0.85], np.float32)[None] * spec[:, None] * (1 - 0.4 * (f > 0.6))
        # барашки на гребнях
        crest = smoothstep(0.55 * amp, 1.05 * amp, pos[:, 1])
        foam = np.clip(crest * 0.9, 0, 1)
        if args.rain > 0.01:
            foam = np.clip(foam + args.rain * 0.25 * (vnoise2(p * 2.4 + args.time * 1.7) > 0.86), 0, 1)
        col = col * (1 - foam[:, None]) + np.array([0.92, 0.95, 0.97], np.float32) * 0.85 * foam[:, None]
        dist = np.linalg.norm(pos - np.array(cam["pos"], np.float32)[None], axis=-1)
        fogc = np.array([0.42, 0.48, 0.55], np.float32) * (0.35 + 0.65 * day)
        fg = 1 - np.exp(-np.power(dist * 0.0035, 2.0))
        col = col * (1 - fg[:, None]) + fogc[None] * fg[:, None]
        return shade_out(col, args.exposure).astype(np.float32), np.ones(len(pos), np.float32)

    # рисуем пачкой: один «шейдер» на все треугольники сразу
    class Batch:
        pass

    pos_all = verts[idx].reshape(-1, 3)
    idx_fake = np.arange(len(pos_all)).reshape(-1, 3)
    rgb, a = shade(pos_all, None, None)
    # растеризуем вручную, чтобы не звать shade на каждый треугольник
    R.draw_batch(verts, idx, rgb, a, None)
    R.save(args.out)


def draw_batch(self, verts, idx, vrgb, va, _unused):
    clip = np.concatenate([verts, np.ones((len(verts), 1), np.float32)], -1) @ self.vp.T
    w_ = np.maximum(clip[:, 3:4], 1e-6)
    ndc = clip[:, :3] / w_
    sx = (ndc[:, 0] * 0.5 + 0.5) * self.w
    sy = (1 - (ndc[:, 1] * 0.5 + 0.5)) * self.h
    sz = ndc[:, 2] * 0.5 + 0.5
    scr = np.stack([sx, sy, sz], -1).astype(np.float32)
    i0, i1, i2 = idx[:, 0], idx[:, 1], idx[:, 2]
    ok = (clip[i0, 3] > 0) & (clip[i1, 3] > 0) & (clip[i2, 3] > 0)
    a2v = (scr[i1, 0] - scr[i0, 0]) * (scr[i2, 1] - scr[i0, 1]) - \
          (scr[i1, 1] - scr[i0, 1]) * (scr[i2, 0] - scr[i0, 0])
    ok &= np.abs(a2v) > 1e-6
    for k in np.nonzero(ok)[0]:
        A, B, C = i0[k], i1[k], i2[k]
        p0, p1, p2 = scr[A], scr[B], scr[C]
        x0 = max(int(min(p0[0], p1[0], p2[0])), 0); x1 = min(int(max(p0[0], p1[0], p2[0])) + 1, self.w)
        y0 = max(int(min(p0[1], p1[1], p2[1])), 0); y1 = min(int(max(p0[1], p1[1], p2[1])) + 1, self.h)
        if x1 <= x0 or y1 <= y0 or (x1 - x0) * (y1 - y0) > 60000:
            continue
        xs = np.arange(x0, x1, dtype=np.float32) + 0.5
        ys = np.arange(y0, y1, dtype=np.float32) + 0.5
        gxx, gyy = np.meshgrid(xs, ys)
        a2 = a2v[k]
        w0 = ((gxx - p1[0]) * (p1[1] - p2[1]) - (gyy - p1[1]) * (p1[0] - p2[0])) / a2
        w1 = ((gxx - p2[0]) * (p2[1] - p0[1]) - (gyy - p2[1]) * (p2[0] - p0[0])) / a2
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        bary = np.stack([w0, w1, w2], -1)[inside]
        z = bary @ np.array([p0[2], p1[2], p2[2]], np.float32)
        py = np.repeat(ys, len(xs))[inside]; px = np.tile(xs, len(ys))[inside]
        keep = z < self.z[py, px]
        if not keep.any():
            continue
        col = bary @ np.stack([vrgb[A], vrgb[B], vrgb[C]], 0)   # (3,3) → (K,3)
        yy, xx = py[keep], px[keep]
        self.z[yy, xx] = z[keep]
        self.color[yy, xx] = col[keep]


Renderer.draw_batch = draw_batch


# ============================================================== режим: небо
def mode_clouds(args):
    cam = {"pos": [0, 1.7, 0], "yaw": args.yaw, "pitch": 0.35, "fov": 62}
    R = Renderer(args.w, args.h, cam)
    el = math.radians(args.sun_alt)
    sun = np.array([math.cos(el) * 0.6, math.sin(el), math.cos(el) * 0.8], np.float32)
    sun /= np.linalg.norm(sun)
    day = sat(0.15 + 0.95 * math.sin(el))
    col = R.fill_sky(sun, day, clouds=args.clouds)
    R.color = shade_out(np.clip(col, 0, 8) * args.exposure, 1.0)
    R.save(args.out)


# ============================================================== режим: дождь
def mode_rain(args):
    """Витрина: то же, что rain_window.frag, по картинке сцены."""
    src = args.from_img
    if not src or not os.path.exists(src):
        # фон нет: улица как размытые пятна света — этого хватает для проверки капель
        rng = np.random.default_rng(3)
        img = np.zeros((args.h, args.w, 3), np.float32)
        img[:, :, :] = 0.06
        for _ in range(60):
            cx, cy = rng.integers(0, args.w), rng.integers(0, args.h)
            r = rng.uniform(4, 40)
            y0, y1 = max(0, int(cy - r)), min(args.h, int(cy + r))
            x0, x1 = max(0, int(cx - r)), min(args.w, int(cx + r))
            yy, xx = np.mgrid[y0:y1, x0:x1]
            g = np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (r * r * 0.6))
            col = rng.uniform(0.4, 1.0, 3) * rng.choice([1.0, 0.7, 0.55])
            img[y0:y1, x0:x1] += g[..., None] * col[None, None]
    else:
        img = srgb2lin(proc.load_png(src, "RGB"))
    h, w = img.shape[:2]
    uv = np.stack([np.tile(np.linspace(0, 1, w), h), np.repeat(np.linspace(0, 1, h), w)], -1
                  ).reshape(h, w, 2)
    t = args.time
    rain = args.rain

    def dropfield(uv, scale, t):
        g = uv * np.array([scale * w / h, scale], np.float32)
        idc = np.floor(g)
        f = g - idc
        hh = h12(idc)
        life = (hh * 7.13 + t * (0.22 + 0.5 * hh)) % 1.0
        r = (0.06 + 0.36 * life) * (0.5 + 0.5 * h12(idc + 3.7))
        slide = (hh > 0.62) * life
        c = f - np.stack([np.sin(idc[..., 1] * 12 + t * 2) * 0.05, 0.5 + slide * 0.35], -1)
        d = np.linalg.norm(np.stack([c[..., 0], c[..., 1] / 1.25], -1), axis=-1)
        drop = smoothstep(r, r * 0.55, d)
        off = -c * np.maximum(1 - d / np.maximum(r, 1e-4), 0)[..., None] * 0.16 * r[..., None]
        return drop, off

    d1, o1 = dropfield(uv, args.drops, t)
    d2, o2 = dropfield(uv, args.drops * 0.42 + 17.0, t * 0.7)
    drops = np.clip(d1 + d2, 0, 1)
    off = np.clip((o1 + o2 * 0.7) * rain, -0.06, 0.06)
    sidx = np.clip((uv + off) * np.array([w - 1, h - 1], np.float32), 0, None).astype(np.int32)
    bg = img[sidx[..., 1], sidx[..., 0]]
    blur = (1 - drops) * 0.02 * rain
    if blur.max() > 0:
        bg = 0.55 * bg + 0.45 * proc.blur(bg, int(max(1, blur.max() * w)))
    lens = img[np.clip(sidx[..., 1] - 3, 0, h - 1), np.clip(sidx[..., 0] + 2, 0, w - 1)]
    bg = bg * (1 - 0.85 * drops[..., None]) + (lens * 1.12 + 0.008) * (0.85 * drops)[..., None]
    bg += 0.7 * drops[..., None] * np.array([0.7, 0.75, 0.85])[None, None] * rain
    bg = bg * (1 - 0.18 * rain * (vnoise2(uv * np.array([9, 13])) * 0.5))
    out = to_srgb(np.clip(bg, 0, 1))
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    proc.save_png(args.out, out)
    print(f"  → {os.path.relpath(args.out, ROOT)}  дождь {rain:.2f}, капель {int(drops.sum()):,}")


# ============================================================== режим: сцена
def _load_tex(path, mode="RGBA"):
    fp = os.path.join(ROOT, path)
    if not os.path.exists(fp):
        return None
    try:
        return proc.load_png(fp, mode)
    except Exception:                            # noqa: BLE001 — превью не должно падать на тексте
        return None


def _atlas_cells(img, cols, rows):
    """Клетки атласа как линейные альбедо + отдельная карта шероховатости."""
    h, w = img.shape[:2]
    cw, ch = w // cols, h // rows
    out = []
    for r in range(rows):
        for c in range(cols):
            out.append(img[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw])
    return out


def mode_scene(args):
    """Сцена из дампа веб-сборки: те же атласы, те же числа, тот же свет."""
    path = args.scene or os.path.join(ROOT, "build", "preview", "scene.json")
    if not os.path.exists(path):
        raise SystemExit(f"нет дампа сцены {path} — сначала: node tools/dump_scene.js --view ...")
    data = json.load(open(path, encoding="utf-8"))
    scene_dir = os.path.dirname(os.path.abspath(path))     # рядом лежат u8-карты слоёв
    env = data["env"]
    cam = data.get("camera", {})
    def _g(name, default=None):        # атрибута может не быть (вызов из теста)
        return getattr(args, name, default)
    pos = list(_g("cam") or cam.get("pos", [0, 10, 60]))
    if _g("cam"):                     # --cam перебивает ориентацию из дампа
        yaw, pitch = _g("yaw", 0.0), _g("pitch", 0.0)
    else:
        yaw = cam.get("yaw", _g("yaw", 0.0))
        pitch = cam.get("pitch", _g("pitch", 0.0))
    camd = {"pos": pos, "yaw": yaw, "pitch": pitch, "fov": cam.get("fov", _g("fov", 60.0))}
    ss = max(1, int(args.ss))
    R = Renderer(args.w * ss, args.h * ss, camd, far=1500.0)
    R.gi = load_gi(scene_dir, data)            # тот же uGIVol, что в веб-сборке
    sun = np.array(env["sun"], np.float32)
    day = float(env["day"])
    sun_col = np.array(env.get("sunCol", [1.0, 0.95, 0.86]), np.float32)
    sky_col = np.array(env.get("skyCol", [0.12, 0.19, 0.40]), np.float32)
    expo = float(env.get("exposure", _g("exposure", 1.0)))
    wet = float(env.get("wet", 0.0))
    rainv = float(env.get("rain", 0.0))
    snow = float(env.get("snow", 0.0))
    season = np.array(env.get("season", [1, 0, 0, 0]), np.float32)
    R.fill_sky(sun, day, clouds=float(env.get("clouds", 0.0)), exposure=expo)
    R.sun_dir = sun
    ctx = dict(R=R, sun=sun, day=day, sun_col=sun_col, sky_col=sky_col, expo=expo,
               wet=wet, rain=rainv, snow=snow, season=season, t=args.time,
               radius=args.scene_radius, look=data.get("look", {}))

    ctx["wind"] = float(env.get("wind", 0.4))
    ground_cells(R, data, ctx, scene_dir)
    draw_boxes(R, data, ctx)
    draw_veg(R, data, ctx)
    draw_water(R, data, ctx)
    draw_blades(R, data["grass"], ctx)
    draw_signs(R, data, ctx)
    if args.out.endswith(".json"):
        rep = {"stats": R.stats, "counts": data.get("counts", {}), "camera": camd,
               "mean_lin": float(R.color.reshape(-1, 3).mean()),
               "p95_lin": float(np.quantile(R.color, 0.95)),
               "black_frac": float((R.color.max(-1) < 0.004).mean())}
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=1)
        print("  отчёт:", json.dumps(rep, ensure_ascii=False))
        return 0
    # пост: лёгкий bloom по ярким пяткам — как у post.frag, но в одну строку
    if args.bloom > 0:
        bloom_pass(R, args.bloom)
    R.save(args.out, pool=ss)
    print(f"  сцена: {data.get('counts', {})}")
    return 0


def bloom_pass(R, strength):
    from PIL import Image, ImageFilter
    lum = R.color.max(-1)
    m = np.clip((lum - 0.72) / 0.5, 0, 1)[..., None]
    src = (R.color * m).astype(np.float32)
    im = Image.fromarray((np.clip(src, 0, 1) * 255 + 0.5).astype(np.uint8))
    im = im.resize((max(1, R.w // 4), max(1, R.h // 4)))
    im = im.filter(ImageFilter.GaussianBlur(2.2)).resize((R.w, R.h))
    glow = (np.array(im, np.float32) / 255.0)
    R.color = np.clip(R.color + glow * strength, 0, 1)


# -------------------------------------------------------------------- земля
def _load_bin_grid(scene_dir, name):
    """Сырой u8-кадр рядом с дампом сцены (LAYERS²×4 или 512²×4)."""
    if not scene_dir:
        return None
    fp = os.path.join(scene_dir, name)
    if not os.path.exists(fp):
        return None
    a = np.fromfile(fp, np.uint8)
    n = int(round(math.sqrt(a.size / 4)))
    return a.reshape(n, n, 4) if n * n * 4 == a.size else None


def ground_cells(R, data, ctx, scene_dir=None):
    """Земля — одна сетка по карте слоёв, ровно как на GPU.

    Кольца с LOD: 2 м под ногами, 48 м у края мира. Материал, дёрн, чаши и
    изношенность читаются из layers_u8.bin — из той же карты, которую сэмплит
    ground.frag, поэтому цвет не «разъезжается» на границе радиуса облома.
    Раньше ближние клетки брались из дампа, а дальние закрывались плоским
    ковром: на шве получалась ступень цвета, а квад, внутри которого стояла
    камера, растеризатор выбрасывал вовсе — оттого внизу кадра белело небо.
    Глубина озера берётся из water_depth_u8.bin, так что чаша есть и на дальних
    кольцах (вода draw_water ложится поверх ровно своей поверхностью).
    """
    lay = _load_bin_grid(scene_dir, "layers_u8.bin")
    dep = _load_bin_grid(scene_dir, "water_depth_u8.bin")
    box = data.get("waterBox") or [0, 0, 1, 1]
    look = (data.get("look") or {}).get("ground") or {}
    tile = float(look.get("tile", [5.2])[0] or 5.2)
    world = float((look.get("tile") + [1536.0])[2] or 1536.0)
    atlas = _load_tex("assets/textures/ground_atlas.png", "RGBA")
    cell_imgs = None
    if atlas is not None:
        cell_imgs = [(srgb2lin(atlas[..., :3]), atlas[..., 3:4])]
    camx, camz = R.cam["pos"][0], R.cam["pos"][2]
    V, I, AT, MT = [], [], [], []

    ln = lay.shape[0] if lay is not None else 0
    dn = dep.shape[0] if dep is not None else 0
    snow = ctx.get("snow", 0.0)

    def at(x, z):
        """(материал, дёрн, чаша, износ, y) в точке мира по картам дампа."""
        mat, turf, basin, wear = 0, 0.0, 0.0, 0.2
        if lay is not None:
            px = int(round((x / world + 0.5) * (ln - 1)))
            py = int(round((z / world + 0.5) * (ln - 1)))
            px = min(max(px, 0), ln - 1); py = min(max(py, 0), ln - 1)
            q = lay[py, px]
            mat = int(round(q[0] / 255.0 * 7))
            turf, basin, wear = q[1] / 255.0, q[2] / 255.0, q[3] / 255.0
        y = 0.0
        if dep is not None and box[2] > 0 and box[3] > 0:
            u = (x - box[0]) / box[2]; v = (z - box[1]) / box[3]
            if -0.002 <= u <= 1.002 and -0.002 <= v <= 1.002:
                j = min(max(int(round(u * (dn - 1))), 0), dn - 1)
                i = min(max(int(round(v * (dn - 1))), 0), dn - 1)
                depth = dep[i, j, 0] / 255.0 * 11.0
                if depth > 0.05:
                    y = -min(depth, 6.5)
                    if mat not in (4, 5):
                        mat = 5                        # илистый берег под водой
                        turf = max(turf, 0.16)
        return mat, turf, basin, wear, y

    if lay is None:
        # старого дампа хватает и на это: просто берём клетки как есть
        for c in (data.get("ground") or []):
            x, z, step, mat, turf, basin, wear, y = c[0], c[1], c[2], int(c[3]), c[4], c[5], c[6], c[7]
            bi = len(V) // 4
            for ox, oz in ((0, 0), (step, 0), (step, step), (0, step)):
                V.append([x + ox, y, z + oz])
                MT.append([mat, turf, basin, wear])
                AT.append([(x + ox) / tile, (z + oz) / tile, 0, 0])
            I += [[bi * 4, bi * 4 + 1, bi * 4 + 2], [bi * 4, bi * 4 + 2, bi * 4 + 3]]
    else:
        rings = [(24.0, 2.0), (52.0, 4.0), (116.0, 8.0), (268.0, 16.0), (792.0, 48.0)]
        covered = 0.0
        for rad, step in rings:
            n = int(2 * rad / step)
            for iz in range(n):
                zz = camz - rad + iz * step
                for ix in range(n):
                    xx = camx - rad + ix * step
                    # клетка целиком внутри прежнего (более мелкого) кольца — не дублируем
                    if max(abs(xx + step / 2 - camx), abs(zz + step / 2 - camz)) <= covered:
                        continue
                    mat, turf, basin, wear, y = at(xx + step / 2, zz + step / 2)
                    bi = len(V) // 4
                    for ox, oz in ((0, 0), (step, 0), (step, step), (0, step)):
                        V.append([xx + ox, y, zz + oz])
                        MT.append([mat, turf, basin, wear])
                        AT.append([(xx + ox) / tile, (zz + oz) / tile, 0, 0])
                    I += [[bi * 4, bi * 4 + 1, bi * 4 + 2], [bi * 4, bi * 4 + 2, bi * 4 + 3]]
            covered = rad
    if not V:
        return
    _shade_ground(R, np.array(V, np.float32), np.array(I, np.int32),
                  np.array(AT, np.float32), np.array(MT, np.float32), ctx, cell_imgs)


# Отражательная способность покрытий — измеренные средние по атласу
# (docs/material_report_surfaces.json); tint — оттенки, которые атлас даёт при
# смешивании, rough — средняя шероховатость. Ключи — индекс материала в
# layer-карте (0 асфальт … 7 разметка), как в ground.frag.
GROUND_LIN = {0: 0.085, 1: 0.185, 2: 0.115, 3: 0.235, 4: 0.115, 5: 0.300, 6: 0.105, 7: 0.135}
GROUND_TINT = {0: (1.0, 1.005, 1.03), 1: (1.0, 0.985, 0.95), 2: (0.62, 1.0, 0.42),
               3: (1.0, 0.99, 0.96), 4: (1.0, 0.86, 0.66), 5: (1.0, 0.93, 0.78),
               6: (1.0, 0.99, 0.98), 7: (1.0, 0.995, 0.96)}
GROUND_ROUGH = {0: 0.70, 1: 0.66, 2: 0.88, 3: 0.74, 4: 0.86, 5: 0.78, 6: 0.58, 7: 0.61}


# ------------------------------------------------------------------------ GI
# Копия giWorld() из shaders/glsl/common.glsl. Превью обязано использовать ТОТ
# ЖЕ запечённый объём, что и веб-сборка (uGIVol): иначе на снимках сумерки
# выглядят чёрными, а в игре у фонарей тёплые пятна, и «эталонный рендер»
# перестаёт быть эталоном. Порядок каналов — (Y, Z, X, 4), как в web/js/gi.js.

def load_gi(scene_dir, data):
    info = (data or {}).get("giVol") or {}
    if not scene_dir or not info.get("file"):
        return None
    fp = os.path.join(scene_dir, info["file"])
    if not os.path.exists(fp):
        return None
    X, Y, Z = (int(v) for v in info["size"])       # gi.js отдаёт size = [X, Y, Z]
    raw = np.fromfile(fp, np.uint8)
    if raw.size != X * Y * Z * 4:
        return None
    # линейный индекс в дампе: ((iy·Z + iz)·X + ix)·4 → форма (Y, Z, X, 4)
    return {"vol": raw.reshape(Y, Z, X, 4).astype(np.float32) / 255.0,
            "size": (X, Y, Z), "world": float(info.get("world", 1536.0)),
            "gain": float(info.get("gain", 1.6))}


def gi_world(gi, pos, nrm):
    """(облучённость, доля неба) для мировых позиций pos (K,3) и нормалей nrm.

    Повторяет GLSL буквально: выборка смещена на 1.5 м вдоль нормали, по высоте
    сетка мельче (Y ярусов по cell метров), объём хранит усиленную в gain раз
    величину, снимается масштабом и лёгким нелинейным подъёмом e²·0.6 + e·0.75.
    """
    K = len(pos)
    if gi is None:
        return np.zeros((K, 3), np.float32), np.ones(K, np.float32)
    X, Y, Z = gi["size"]
    cell = gi["world"] / X
    sc = np.array([gi["world"], Y * cell, gi["world"]], np.float32)
    q = (pos + nrm * 1.5 + np.array([gi["world"] * 0.5, 0.0, gi["world"] * 0.5], np.float32)) / sc
    q = np.clip(q, 0.002, 0.998)
    # трилинейная выборка: texel = q * size - 0.5
    f = q * np.array([X, Y, Z], np.float32) - 0.5
    i0 = np.floor(f).astype(np.int32)
    t = (f - i0).astype(np.float32)
    v = gi["vol"]
    out = np.zeros((K, 4), np.float32)
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                ix = np.clip(i0[:, 0] + dx, 0, X - 1)
                iy = np.clip(i0[:, 1] + dy, 0, Y - 1)
                iz = np.clip(i0[:, 2] + dz, 0, Z - 1)
                wgt = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) \
                    * (t[:, 2] if dz else 1 - t[:, 2])
                out += v[iy, iz, ix] * wgt[:, None]
    e = out[:, :3] * (1.0 / gi["gain"])
    return (e * e * 0.6 + e * 0.75).astype(np.float32), out[:, 3].astype(np.float32)


def ambient(gi, ctx, pos, nrm, night=(0.020, 0.030, 0.052), k=0.6, gain=0.9):
    """Ambient как в шейдерах: mix(ночной_подложки, skyTint, день)·(0.4+0.6·доля
    неба) + gi·0.9. Возвращает (K,3) множитель к альбедо."""
    day = float(ctx["day"])
    g, sv = gi_world(gi, pos, nrm)
    base = (1.0 - day) * np.array(night, np.float32) + day * ctx["sky_col"][None, :]
    return base * (1.0 - k + k * sv[:, None]) + g * gain


def _shade_ground(R, V, I, AT, MT, ctx, cell_imgs, flat=False):
    sun, day = ctx["sun"], ctx["day"]
    sun_col, sky_col = ctx["sun_col"], ctx["sky_col"]
    wet, snow, expo = ctx["wet"], ctx["snow"], ctx["expo"]

    def shade(pos, _uv, at):
        K = len(pos)
        mat = np.clip(np.round(at[:, 0]).astype(int), 0, 7)
        turf = at[:, 1] if at.shape[1] > 1 else np.zeros(K, np.float32)
        basin = at[:, 2] if at.shape[1] > 2 else np.zeros(K, np.float32)
        alb = np.array([GROUND_TINT[m] for m in mat], np.float32) * \
            np.array([GROUND_LIN[m] for m in mat], np.float32)[:, None]
        rough = np.array([GROUND_ROUGH[m] for m in mat], np.float32)
        # дёрн между плитами и во дворах: зелёный подмешивается по плотности травы
        alb = alb * (1 - 0.55 * turf[:, None]) + np.array([0.055, 0.108, 0.030], np.float32) * turf[:, None]
        alb = alb * (1 - 0.22 * snow) + np.array([0.20, 0.215, 0.24], np.float32)[None, :] * (0.55 * snow)
        nrm = np.zeros((K, 3), np.float32)
        nrm[:, 1] = 1.0
        wrap = (0.22 + 0.78 * np.clip(nrm @ sun, 0, 1))[:, None]
        # ambient — тот же, что в ground.frag: небо с учётом запечённой доли неба
        # плюс облучённость из uGIVol (фонари, отражение от стен), а не просто
        # «sky_col × константа»: без этого ночью превью давало чёрный асфальт
        sv = gi_world(R.gi, pos, nrm)[1]
        col = alb * (sun_col[None, :] * (wrap * day) * (0.5 + 0.5 * sv)[:, None]
                     + ambient(R.gi, ctx, pos, nrm, night=(0.020, 0.030, 0.052), k=0.6))
        # лужи: вода темнее и зеркалит небо; мокрый асфальт — то же, но слабее.
        # отражение — по френелю, как в ground.frag: сверху вода почти
        # прозрачная (видно тёмное дно) и зеркальная только под острым углом;
        # «sky_col целиком» давало белый лист озера вместо воды
        pool = np.clip((basin - (0.55 - 0.45 * wet)) / 0.35, 0, 1) * max(wet, 0.05)
        pool = pool[:, None]
        wet_mix = np.clip(wet * (0.35 + 0.65 * pool), 0.0, 1.0)
        col = col * (1.0 - 0.32 * wet_mix)
        eye = np.array(R.cam["pos"], np.float32)
        vv = pos - eye[None, :]
        vv /= np.maximum(np.linalg.norm(vv, axis=-1, keepdims=True), 1e-6)
        nv = np.clip(np.abs(vv[:, 1]), 0.0, 1.0)             # N смотрит вверх
        f0 = 0.03 - 0.01 * pool[:, 0]
        fr = np.clip(fresnel(nv, f0)[:, None] * wet_mix, 0.0, 0.75)
        refl = sky_col[None, :] * (0.55 + 0.85 * day)
        col = col * (1.0 - fr) + refl * 0.8 * fr
        # в луже — тёмная полоса горизонта (город), ночью в ней огоньки
        horizon = ((1.0 - nv) ** 6)[:, None] * pool
        col = col * (1.0 - horizon * 0.8) + np.array([0.02, 0.025, 0.04], np.float32)[None, :] * horizon * 0.8 * day
        col = col + np.array([0.55, 0.36, 0.16], np.float32)[None, :] * horizon * (1.0 - day) * 0.55
        rough_eff = np.clip(rough[:, None] * (1 - 0.75 * pool) * (1 - 0.3 * wet), 0.06, 1.0)
        col = col + sun_col[None, :] * (pool * (1.0 - rough_eff) * 0.5)
        col = np.where(np.isfinite(col), col, 0.0)
        return shade_out(col, expo).astype(np.float32), np.ones(K, np.float32)

    R.draw(V, I, shade, attrs=MT, cull=False)


# ------------------------------------------------------------------ дома
def draw_boxes(R, data, ctx):
    boxes = np.array(data.get("boxes", []), np.float32)
    if not len(boxes):
        return
    sun, day = ctx["sun"], ctx["day"]
    sun_col, sky_col = ctx["sun_col"], ctx["sky_col"]
    wet, snow, expo = ctx["wet"], ctx["snow"], ctx["expo"]
    face = np.array([[0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]], np.float32)
    corners = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], np.float32)
    V, I, AT = [], [], []
    for b in range(len(boxes)):
        x, y, z, sx, sy, sz = boxes[b, :6]
        base = len(V)
        for f in range(6):
            nx, ny, nz = face[f]
            if nx:
                u = np.array([0, 0, 1], np.float32) * sz
                v = np.array([0, 1, 0], np.float32) * sy
            elif ny:
                u = np.array([1, 0, 0], np.float32) * sx
                v = np.array([0, 0, 1], np.float32) * sz
            else:
                u = np.array([1, 0, 0], np.float32) * sx
                v = np.array([0, 1, 0], np.float32) * sy
            ctr = np.array([x, y, z], np.float32) + np.array([sx, sy, sz], np.float32) / 2 \
                + face[f] * np.array([sx, sy, sz], np.float32) / 2
            for ci, c in enumerate(corners):
                p = ctr - u / 2 + u * c[0] - v / 2 + v * c[1]
                V.append(p)
                # uv в метрах + размер грани, чтобы окна были одного шага
                AT.append([c[0] * (sz if nx else sx), c[1] * sy, f, b, (sz if nx else sx), sy])
            I += [[base + f * 4 + 0, base + f * 4 + 1, base + f * 4 + 2],
                  [base + f * 4 + 0, base + f * 4 + 2, base + f * 4 + 3]]
    V = np.array(V, np.float32)
    I = np.array(I, np.int32)
    AT = np.array(AT, np.float32)

    def shade(pos, _uv, at):
        K = len(pos)
        f = np.clip(at[:, 2].astype(int), 0, 5)
        b = np.clip(np.round(at[:, 3]).astype(int), 0, len(boxes) - 1)
        nrm = face[f]                                   # (K,3)
        albs = boxes[b, 6:9]                            # (K,3)
        rough = boxes[b, 9]                             # (K,)
        floors = boxes[b, 10]
        floor_h = np.maximum(boxes[b, 11], 1e-3)
        win_w = np.maximum(boxes[b, 12], 1e-3)
        seed = boxes[b, 13]
        lit = boxes[b, 14]
        # окна: сетка в метрах, тот же шаг, что в facade.frag (окно + простенок)
        uvv = at[:, 0]
        uvy = at[:, 1]
        pitch_x = win_w * 2.35
        cx = np.floor(uvv / pitch_x)
        cellx = uvv / pitch_x - cx
        cy = np.floor((uvy - 1.6) / floor_h)
        celly = (uvy - 1.6) / floor_h - cy
        win = ((cellx > 0.26) & (cellx < 0.74) & (celly > 0.24) & (celly < 0.80) &
               (uvy > 1.5) & (cy >= 0) & (cy < np.maximum(floors - 1, 1)) & (f < 4)).astype(np.float32)
        rnd = np.abs(np.sin(cx * 12.9898 + cy * 78.233 + seed * 37.0 + b * 1.7) * 43758.5453) % 1.0
        lit_on = (rnd < (1 - ctx["day"]) * np.clip(lit, 0, 1) * 0.85).astype(np.float32) * win
        ndl = np.clip(nrm @ sun, 0, 1)
        wrap = (0.25 + 0.75 * ndl)[:, None]
        # ambient фасада = небо × запечённая доля неба + облучённость (gi·0.9),
        # как в facade.frag; раньше — только «sky_col × ny», отчего дворы были
        # темнее, чем в игре, а ночью фасады исчезали совсем
        sv = gi_world(R.gi, pos, nrm)[1]
        sky_amb = ambient(R.gi, ctx, pos, nrm, night=(0.022, 0.032, 0.055), k=0.55)
        h = at[:, 5]
        grime = (1 - 0.22 * np.clip(1 - at[:, 1] / np.maximum(h, 1e-3), 0, 1))[:, None]
        col = albs * grime * (sun_col[None, :] * (wrap * day) * (0.45 + 0.55 * sv)[:, None] + sky_amb)
        col = col * (1 - win[:, None] * 0.55)
        glass = np.array([0.030, 0.038, 0.052], np.float32)
        col = col + win[:, None] * (glass[None, :] * (sun_col[None, :] * (0.35 * day) + sky_col[None, :] * 1.7))
        room = np.array([1.0, 0.72, 0.36], np.float32)
        col = col + lit_on[:, None] * room[None, :] * (0.45 + 0.9 * (1 - day))
        # мокрая стена: блик неба пропорционально (1 − шероховатости)
        col = col + (wet * 0.05) * (1 - rough)[:, None] * sky_col[None, :]
        snowtop = np.clip(at[:, 1] / np.maximum(h, 1e-3) - 0.94, 0, 1)[:, None] * snow
        col = col * (1 - 0.18 * snow) + np.array([0.17, 0.185, 0.21], np.float32)[None, :] * snowtop
        col = np.where(np.isfinite(col), col, 0.0)
        return shade_out(col, expo).astype(np.float32), np.ones(K, np.float32)

    R.draw(V, I, shade, attrs=AT, cull=False)


# ------------------------------------------------------------------- листва
VEG_TINT = {0: (0.058, 0.115, 0.038), 1: (0.048, 0.098, 0.042), 2: (0.062, 0.118, 0.046),
            3: (0.075, 0.135, 0.045), 4: (0.070, 0.128, 0.048), 5: (0.090, 0.140, 0.052),
            6: (0.022, 0.058, 0.024), 7: (0.150, 0.132, 0.078), 8: (0.043, 0.072, 0.030)}


def draw_veg(R, data, ctx):
    items = data.get("veg") or []
    if not items:
        return
    sun, day, expo = ctx["sun"], ctx["day"], ctx["expo"]
    sun_col, sky_col, snow = ctx["sun_col"], ctx["sky_col"], ctx["snow"]
    V, I, AT = [], [], []
    for i, q in enumerate(items):
        x, z, h, w, rot, stiff, typ, tint = q[0], q[1], q[2], q[3], q[4], q[5], int(q[6]), q[7]
        c, s = math.cos(rot), math.sin(rot)
        base = len(V)
        planes = 2 if stiff > 0.6 else 1
        for pl in range(planes):
            a = rot + pl * math.pi / 2
            ca, sa = math.cos(a), math.sin(a)
            bend = 0.35 * (1 - stiff)
            for lx, ly in ((-w, 0), (w, 0), (w * (1 - 0.55), h), (-w * (1 - 0.55), h)):
                V.append([x + lx * ca + sa * bend * h, ly, z - lx * sa + ca * bend * h])
                AT.append([typ, tint, i, pl])
            I += [[base + pl * 4, base + pl * 4 + 1, base + pl * 4 + 2],
                  [base + pl * 4, base + pl * 4 + 2, base + pl * 4 + 3]]
    if not V:
        return
    V = np.array(V, np.float32)
    I = np.array(I, np.int32)
    AT = np.array(AT, np.float32)

    def shade(p, _u, at):
        K = len(p)
        ty = np.clip(np.round(at[:, 0]).astype(int), 0, 8)
        tint = at[:, 1]
        alb = np.array([VEG_TINT[t] for t in ty], np.float32) * (1.35 * tint)[:, None]
        # лента повёрнута вокруг Y на rot + 90°·pl: нормаль считаем из самой ленты
        e1 = p[1::4] - p[0::4] if False else None
        n = np.zeros((K, 3), np.float32)
        n[:, 1] = 0.55
        n[:, 2] = 0.83
        n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
        ndl = n @ sun
        wrap = (0.30 + 0.70 * np.clip(ndl, 0, 1))[:, None]
        back = (np.clip(-ndl, 0, 1) * 0.55)[:, None]          # просвет насквозь
        sv = gi_world(R.gi, p, n)[1]
        amb = ambient(R.gi, ctx, p, n, night=(0.024, 0.034, 0.052), k=0.58)
        col = alb * (sun_col[None, :] * ((wrap + back) * day) * (0.42 + 0.58 * sv)[:, None] + amb)
        col = col * (1 - 0.25 * snow) + np.array([0.055, 0.062, 0.075], np.float32)[None, :] * (snow * 0.8)
        return shade_out(col, expo).astype(np.float32), np.ones(K, np.float32)

    R.draw(V, I, shade, attrs=AT, cull=False)


# --------------------------------------------------------------------- вода
def draw_water(R, data, ctx):
    cells = data.get("water") or []
    if not cells:
        return
    sun, day = ctx["sun"], ctx["day"]
    sun_col, sky_col, expo = ctx["sun_col"], ctx["sky_col"], ctx["expo"]
    snow = ctx["snow"]
    sun_ref = np.array([0.0, 0.9, 0.0], np.float32)     # блик по вертикали: солнце в отражении
    box = data.get("waterBox", [0, 0, 1, 1])
    look = ctx["look"].get("water", {})
    amp = float(look.get("amp", 0.45)) * (1 + ctx["rain"] * 0.4)
    BX = []
    I = []
    for (x, z, step) in cells:
        bi = len(BX)
        for ox, oz in ((0, 0), (step, 0), (step, step), (0, step)):
            BX.append([x + ox, z + oz, step])
        I += [[bi, bi + 1, bi + 2], [bi, bi + 2, bi + 3]]
    bx = np.array(BX, np.float32)
    I = np.array(I, np.int32)
    xz = bx[:, :2]
    eps = np.maximum(bx[:, 2] * 0.5, 0.5)
    zero = np.zeros_like(eps)
    w0 = water_sum(xz, ctx["t"], amp)
    wx = water_sum(xz + np.column_stack([eps, zero]), ctx["t"], amp)
    wz = water_sum(xz + np.column_stack([zero, eps]), ctx["t"], amp)
    # нормаль — из конечных разностей той же высоты волны, что сдвигает вершины:
    # с плоской «вверх» нормалью всё озеро было одним ровным зеркалом, а с
    # наклонной фасетками распадаются и блик, и френель (как waveNormal в water.frag)
    nrm = np.column_stack([-((wx[:, 1] - w0[:, 1]) / eps), np.ones(len(xz)),
                           -((wz[:, 1] - w0[:, 1]) / eps)]).astype(np.float32)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-6)
    V = np.column_stack([xz[:, 0] + w0[:, 0], w0[:, 1] + 0.55, xz[:, 1] + w0[:, 2]]).astype(np.float32)
    AT = np.column_stack([xz, nrm]).astype(np.float32)

    def shade(p, _u, at):
        K = len(p)
        d = np.array(ctx["R"].cam["pos"], np.float32)
        n = at[:, 2:5]
        v = d[None, :] - p
        v = v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-6)
        ndv = np.clip((n * v).sum(-1), 0.0, 1.0)
        f = fresnel(ndv, 0.02)[:, None]
        refl = sky_col[None, :] * (0.55 + 0.85 * day)
        if day < 0.45:
            refl = refl + np.array([0.05, 0.045, 0.03], np.float32)[None, :]
        sun_glint = np.clip((n @ sun_ref)[:, None], 0, 1) ** 8 * (0.6 * day)
        body = np.array([0.026, 0.052, 0.060], np.float32)[None, :] * (0.4 + 0.6 * day)
        col = body + refl * f + sun_ref[None, :] * 0 + sun_glint * sun_col[None, :]
        col = col + np.array([0.17, 0.185, 0.21], np.float32)[None, :] * (snow * 0.6)
        col = np.where(np.isfinite(col), col, 0.0)
        return shade_out(col, expo).astype(np.float32), np.ones(K, np.float32)

    R.draw(V, I, shade, attrs=AT, cull=False)


# ------------------------------------------------------------------ вывески
def _sign_atlas():
    """Атлас вывесок + реестр клеток.

    Контракт один на всех: генератор (tools/make_beijing_tex.py), шейдеры
    (signUV в common.glsl, её зовут facade.frag и emissive.frag) и это превью
    берут сетку из assets/beijing_signs.json, который пишет генератор. Два
    набора в одной квадратной текстуре: верхняя половина — широкие щиты
    cols×rows, нижняя — вертикальные «столбы» vcols×vrows (их id начинаются с
    vertOffset). Разъезд на одну строку превращал вывески в кашу из половинок
    соседних щитов, поэтому сетка читается из файла, а не держится в голове.
    """
    reg = {}
    rp = os.path.join(ROOT, "assets", "beijing_signs.json")
    if os.path.exists(rp):
        reg = json.load(open(rp, encoding="utf-8"))
    img = _load_tex("assets/textures/beijing_signs.png", "RGBA")
    if img is None:
        return None
    return {"lin": srgb2lin(img[..., :3]), "a": np.ascontiguousarray(img[..., 3]),
            "cols": float(reg.get("cols", 4)), "rows": float(reg.get("rows", 8)),
            "vcols": float(reg.get("vertCols", 16)), "vrows": float(reg.get("vertRows", 2)),
            "voff": float(reg.get("vertOffset", 32))}


def sign_uv(atlas, cell, q):
    """Зеркало signUV() из common.glsl: (K,2) координаты в атласе, q — (K,2)
    координата внутри клетки по v СВЕРХУ ВНИЗ (PNG читается сверху, FLIP_Y нет)."""
    cols, rows = atlas["cols"], atlas["rows"]
    vcols, vrows = atlas["vcols"], atlas["vrows"]
    n_wide = cols * rows
    isv = (cell >= n_wide).astype(np.float32)
    k = cell - n_wide * isv
    gx = cols * (1.0 - isv) + vcols * isv
    gy = rows * (1.0 - isv) + vrows * isv
    cx = np.mod(k, gx)
    cy = np.floor(k / gx)
    qq = np.clip(q, 0.0, 1.0)
    u = (cx + qq[:, 0]) / gx
    v = (cy + qq[:, 1]) / (gy * 2.0) + 0.5 * isv
    return np.stack([u, v], -1)


def draw_signs(R, data, ctx):
    """Щиты: тот же атлас, та же сетка, то же discard по альфе, что в шейдерах.

    Раньше превью красило Quad плоским цветом из дампа — на снимках «вывески»
    выглядели розовыми плашками без единого иероглифа, и проверить читабельность
    текста было нельзя. Теперь пиксель берётся из клетки атласа по тому же
    правилу, что и в игре (facade.frag рисует ленту на стене, emissive.frag —
    наложенный планшет; здесь — наложенный планшет, как в дампе).
    """
    items = data.get("signs") or []
    if not items:
        return
    atlas = _sign_atlas()
    V, I, AT = [], [], []
    for i, it in enumerate(items):
        x, y, z, w, h, rot, tilt = it[0], it[1], it[2], it[3], it[4], it[5], it[6]
        col = np.array(it[7:10], np.float32)
        bright = float(it[10])
        cell = float(it[11]) if len(it) > 11 else 0.0
        mode = float(it[12]) if len(it) > 12 else 0.0    # 0 вывеска, 1 фонарь, 2 гирлянда
        c, sn = math.cos(rot), math.sin(rot)
        base = len(V)
        # низ щита (ly = 0) соответствует НИЖНЕЙ строке клетки, то есть vv = 1
        # нормаль щита — туда же, куда она смотрит в шейдере: сзади у светового
        # короба крашёный лист, а не зеркальный текст (emissive.frag, front)
        nrm = [math.sin(rot), math.cos(rot)]
        for lx, ly, qu, qv in ((-w / 2, 0.0, 0.0, 1.0), (w / 2, 0.0, 1.0, 1.0),
                               (w / 2, h, 1.0, 0.0), (-w / 2, h, 0.0, 0.0)):
            V.append([x + lx * c + sn * tilt * ly, y + ly, z - lx * sn + c * tilt * ly])
            AT.append([col[0], col[1], col[2], bright, qu, qv, cell, mode, nrm[0], 0.0, nrm[1]])
        I += [[base, base + 1, base + 2], [base, base + 2, base + 3]]
    V = np.array(V, np.float32)
    I = np.array(I, np.int32)
    AT = np.array(AT, np.float32)
    day = float(ctx["day"])
    night = 1.0 - day

    if atlas is None:
        def shade_flat(_p, _u, at):
            col, br = at[:, :3], at[:, 3]
            glow = (1.1 + 2.6 * night) * 0.35
            out = col * (0.22 + 0.4 * day + glow) * br[:, None]
            return shade_out(out, ctx["expo"]).astype(np.float32), np.ones(len(_p), np.float32)
        R.draw(V, I, shade_flat, attrs=AT[:, [0, 1, 2, 3]], cull=False)
        return

    tex, amask = atlas["lin"], atlas["a"]
    H, W = amask.shape

    def shade(_p, _u, at):
        tint, br = at[:, :3], at[:, 3]
        cell, mode = at[:, 6], at[:, 7]
        uvw = sign_uv(atlas, cell, at[:, 4:6])
        px = np.clip((uvw[:, 0] * W).astype(np.int32), 0, W - 1)
        py = np.clip((uvw[:, 1] * H).astype(np.int32), 0, H - 1)
        rgb, a = tex[py, px], amask[py, px]
        wall = tint * (0.22 + 0.4 * day) + np.array([0.02, 0.02, 0.022], np.float32)
        # вывеска: днём — крашеный пластик по маске альфы, ночью — плюс излучение
        # фонарь и гирлянда — источник света: их клетки несут ФОРМУ свечения,
        # а не текст, и яркость у них своя (0.6 у фонаря, 1.0 у гирлянды)
        mw = np.where(mode < 0.5, 1.0, np.where(mode < 1.5, 0.6, 1.0)).astype(np.float32)
        # изнанка щита: тёмный крашёный лист, эмиссия выключена
        nrm = at[:, 8:11]
        eye = np.array(R.cam["pos"], np.float32)[None, :] - _p
        front = (np.einsum('ij,ij->i', nrm, eye) > 0.0).astype(np.float32)
        front = np.maximum(front, 1.0 - (mode < 0.5).astype(np.float32))
        plate = np.array([0.105, 0.108, 0.115], np.float32)
        rgb = rgb * front[:, None] + plate[None, :] * (1.0 - front)[:, None]
        # изнанка НЕ чёрная: как и в emissive.frag, она остаётся крашеным листом,
        # который получает солнце и небо, но не светит (эмиссия умножается на front)
        lit = (rgb * (0.30 + 0.70 * (0.25 + 0.75 * day)) * br[:, None] \
               + rgb * (1.6 * night) * br[:, None] * front[:, None]) \
            * (0.35 + 0.65 * front)[:, None]
        lamp = rgb * ((1.1 + 2.6 * night) * mw)[:, None] * br[:, None] * front[:, None] + tint * 0.05
        is_sign = (mode < 0.5).astype(np.float32)[:, None]
        out = (wall * (1.0 - a[:, None]) + lit * a[:, None]) * is_sign + lamp * (1.0 - is_sign)
        out = np.where(np.isfinite(out), out, 0.0)
        return shade_out(out, ctx["expo"]).astype(np.float32), np.ones(len(at), np.float32)

    R.draw(V, I, shade, attrs=AT, cull=False)


GRASS_LIN = [np.array([0.088, 0.152, 0.050], np.float32),   # овсяница
             np.array([0.079, 0.136, 0.056], np.float32),   # мятлик
             np.array([0.112, 0.143, 0.047], np.float32),   # пырей
             np.array([0.121, 0.146, 0.066], np.float32),   # разнотравье
             np.array([0.178, 0.152, 0.079], np.float32)]   # сухостой


def draw_blades(R, quads, ctx):
    """quads: x,z,h,w,rot,bend,species — травинки из дампа веб-сборки.

    Лента строится как в grass.vert: ширина сужается кверху (1 − 0.72·v²),
    изгиб растёт как v^1.7, верхушка уходит по ветру. Свет и AO запекаются в
    цвета вершин (солнце на сцену одно — это точно), растеризатор только
    интерполирует их; иначе на 9 тыс. травинок ушло бы полчаса python-цикла.
    """
    if quads is None or len(quads) == 0:
        return
    sun, day, expo = ctx["sun"], ctx["day"], ctx["expo"]
    t = ctx["t"]
    wind = 0.35 + 0.65 * ctx.get("wind", 0.4)
    arr = np.array(quads, np.float32)
    n = len(arr)
    seg = 3
    VS = (seg + 1) * 2
    x0, z0, hh, w = arr[:, 0], arr[:, 1], arr[:, 2], arr[:, 3]
    rot, bend0, sp = arr[:, 4], arr[:, 5], (arr[:, 6].astype(int) % 5)
    tint = np.stack([GRASS_LIN[i] for i in sp], 0)                    # (n,3)
    pos = np.zeros((n * VS, 3), np.float32)
    col = np.zeros((n * VS, 3), np.float32)
    idx = np.zeros((n * seg * 2, 3), np.int32)
    cr, sr = np.cos(rot), np.sin(rot)
    ndl = float(np.dot(np.array([0.0, 0.72, 0.7]) / np.linalg.norm([0.0, 0.72, 0.7]), sun))
    # облучённость поля — из того же GI-объёма, что читает grass.frag
    # (giWorld(vWorld, up, ·) × 0.9): в тени корпуса газон темнее, а ночью его
    # поднимает свет фонарей и вывесок — без этого на снимке «ночью травы нет»,
    # хотя в игре она видна, и превью расходится с шейдером
    up = np.tile(np.array([0.0, 1.0, 0.0], np.float32), (n, 1))
    gp = np.stack([x0, np.full(n, 0.06, np.float32), z0], -1)
    g, sv = gi_world(R.gi, gp, up)
    sky_term = ctx["sky_col"] * 0.95 + np.array([0.006, 0.008, 0.012], np.float32)
    base_lit = ctx["sun_col"] * (0.28 + 0.85 * max(ndl, 0.0)) * day * (0.45 + 0.55 * sv)[:, None] \
        + sky_term[None, :] * (0.4 + 0.6 * sv)[:, None] + g * 0.9
    base_lit = base_lit * (1 - 0.25 * ctx["snow"]) + np.array([0.05, 0.055, 0.065], np.float32) * ctx["snow"]
    rows = np.arange(n)
    k = 0
    for i in range(seg + 1):
        v = i / seg
        ww = w * (1.0 - 0.72 * v * v)
        bend = bend0 * (v ** 1.7) * wind * 0.5 + 0.05 * np.sin(t * 2.4 + x0 * 0.7 + z0 * 0.5) \
            * (v ** 1.4) * wind
        y = hh * v * (1.0 - 0.35 * bend * bend)
        off = bend * hh * 0.6
        for side in (-1, 1):
            sel = rows * VS + k
            pos[sel, 0] = x0 + side * ww * cr + off
            pos[sel, 1] = y
            pos[sel, 2] = z0 - side * ww * sr + off * 0.3
            ao = 0.42 + 0.58 * math.sqrt(v)          # скаляр: AO зависит только от сегмента
            col[sel] = tint * (ao * base_lit)
            k += 1
    s_ = np.arange(seg * 2)                      # 0..2 — номер сегмента, ×2 — вершина
    b = (rows * VS)[:, None]                     # база ленты в общем буфере вершин
    tri = np.stack([b + (s_ // 2) * 2, b + (s_ // 2) * 2 + 1, b + (s_ // 2) * 2 + 3], -1)
    tri2 = np.stack([b + (s_ // 2) * 2, b + (s_ // 2) * 2 + 3, b + (s_ // 2) * 2 + 2], -1)
    idx = np.concatenate([tri.reshape(-1, 3), tri2.reshape(-1, 3)], 0).astype(np.int32)
    lin = np.clip(col * 1.0, 0.0, 4.0)
    lit = shade_out(lin, expo).astype(np.float32)
    R.draw(pos, idx, lambda p, _u, at: (np.clip(at, 0, 1), np.ones(len(p), np.float32)),
           attrs=lit)


# ====================================================================== main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["grass", "water", "clouds", "rain", "scene"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--w", type=int, default=1280)
    ap.add_argument("--h", type=int, default=720)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--time", type=float, default=4.0)
    ap.add_argument("--wind", type=float, default=0.55)
    ap.add_argument("--wet", type=float, default=0.0)
    ap.add_argument("--rain", type=float, default=0.0)
    ap.add_argument("--clouds", type=float, default=0.35)
    ap.add_argument("--exposure", type=float, default=1.0)
    ap.add_argument("--day", type=float, default=0.9)
    ap.add_argument("--sun-alt", dest="sun_alt", type=float, default=34.0)
    ap.add_argument("--yaw", type=float, default=0.0)
    ap.add_argument("--pitch", type=float, default=0.0)
    ap.add_argument("--fov", type=float, default=55.0)
    ap.add_argument("--blades", type=int, default=9000)
    ap.add_argument("--height-mul", dest="height_mul", type=float, default=1.15)
    ap.add_argument("--ground", type=float, default=16.0)
    ap.add_argument("--summer", type=float, default=1.0)
    ap.add_argument("--autumn", type=float, default=0.0)
    ap.add_argument("--winter", type=float, default=0.0)
    ap.add_argument("--spring", type=float, default=0.0)
    ap.add_argument("--amp", type=float, default=0.55)
    ap.add_argument("--size", type=float, default=140.0)
    ap.add_argument("--grid", type=int, default=120)
    ap.add_argument("--detail", type=float, default=1.0)
    ap.add_argument("--shore", action="store_true")
    ap.add_argument("--drops", type=float, default=26.0)
    ap.add_argument("--from-img", dest="from_img", default="")
    ap.add_argument("--scene", default="")
    ap.add_argument("--scene-radius", dest="scene_radius", type=float, default=150.0)
    ap.add_argument("--bloom", type=float, default=0.45)
    ap.add_argument("--ss", type=int, default=2, help="суперсэмплинг (1..3)")
    ap.add_argument("--cam", nargs=3, type=float, default=None,
                    help="x y z — переопределить камеру из дампа")
    args = ap.parse_args()
    {
        "grass": mode_grass,
        "water": mode_water,
        "clouds": mode_clouds,
        "rain": mode_rain,
        "scene": mode_scene,
    }[args.mode](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())

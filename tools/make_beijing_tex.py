#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Пекин ShopSim: атласы фасадов, черепицы, вывесок и крыш. Шаг 5.33.

Восемь материалов стены (atlas 4×4 ячейки, 512 px на ячейку):
  0 серая панель 9-этажная      4 имперская красная стена
  1 панель 5-этажная (хрущёвка) 5 офисное стекло с пылью
  2 красный кирпич              6 рынок: бетон + плитка
  3 серый кирпич хутуна         7 черепица жёлтая (запретный город)

Каждый материал — это фотография стены, собранная процедурно:
  основание (штукатурка/кирпич/панель) → кладка или швы → грязь в порах →
  потёки от карнизов → высолы у земли → выцветание на солнечной стороне →
  сколы и латки. Шероховатость считается отдельно и лежит в alpha: у краски
  0.55..0.8, у стекла 0.08..0.3, у мокрого бетона 0.35.

Нормали — второй атлас (beijing_facade_nrm.png), из тех же карт высот:
швы кладки, фаска панелей, валики краски, борозды штукатурки.

Вывески (beijing_signs.png) — 4 строки × 8 колонок настоящих текстов:
красные с белым, жёлтые с красным, синие, неоновые; шрифт Noto Serif SC
(OFL), фон — пластик/ткань с пылью и выгоранием. Часть знаков мёртвая:
не горит, выцветшая, с закрашенным телефоном — как на реальных улицах.
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
FONTS = os.path.join(ROOT, "assets", "fonts")

SERIF = os.path.join(FONTS, "NotoSerifSC-Regular.ttf")
SANS = os.path.join(FONTS, "NotoSansSC-Regular.ttf")
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

CELL = 512
COLS = 4          # колонок сетки материалов — ровно как в facade.frag (vec2(c, r)/4)
ROWS = 4          # рядов сетки материалов: 8 групп × 2 варианта плотности = 16 ячеек

# ------------------------------------------------------------------ основание
def wall_base(kind: int, n: int, rng: np.random.Generator, dense: int = 1):
    """Возвращает (albedo 0..1 sRGB, высота 0..1, шероховатость 0..1).

    dense = 1 — нормальный масштаб (одна панель/ряд кирпичей на метр так, как на
    реальном доме), dense = 2 — вдвое мельче, для низких корпусов, киосков и
    рядов рынка, где 4-метровый тайл иначе показал бы полтора кирпича.
    """
    p = proc.periodic_noise
    gross = p(n, n, 3, rng) * 0.55 + p(n, n, 7, rng) * 0.3 + p(n, n, 21, rng) * 0.15
    fine = p(n, n, 96, rng)
    very_fine = p(n, n, 240, rng)
    h = gross.copy()
    rough = np.full((n, n), 0.7, np.float32)

    if kind in (0, 1):                                   # бетонная панель
        rgb = np.stack([0.315 + 0.05 * gross, 0.305 + 0.05 * gross, 0.285 + 0.045 * gross], -1)
        # Шов панелебетонного дома — РЕЛЬЕФНЫЙ, а не частая сетка: одна панель =
        # шаг дома (uFacadeTile.x = 4 м) по горизонтали и один этаж по вертикали.
        # Поэтому при dense=1 тайл показывает ровно одну панель, при dense=2 — две
        # (для пятиэтажек и низких корпусов рынка).
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        # 9-этажка: панель на всю ширину комнаты (≈3.2 м); 5-этажка — уже и ниже
        wpan = 1.0 if kind == 0 else 0.74
        hpan = 1.0 if kind == 0 else 0.66
        px, py = n / (2.0 * dense * wpan), n / (1.0 * dense * hpan)
        seamx = np.exp(-np.minimum(np.abs(xx % px - px / 2), px / 2) ** 2 / 9.0)
        seamy = np.exp(-np.minimum(np.abs(yy % py - py / 2), py / 2) ** 2 / 7.0)
        seam = np.clip(seamx + seamy, 0, 1)
        rgb *= 1 - 0.42 * seam[..., None]
        h += 0.10 * seam - 0.30 * seam
        # наплывы раствора, шапка из пыли в порах
        # «пыль в порах»: низкочастотная, иначе бетон читается как дверная сетка
        rgb *= 0.94 + 0.11 * proc.blur(fine, 3)[..., None]
        rough = 0.78 + 0.07 * (fine - 0.5) - 0.12 * seam
        # горизонтальная полоса перекрытия (где панели стыкуются) — всегда темнее
        band = np.exp(-np.minimum(np.abs(yy % py), 5.0) ** 2 / 14.0)
        rgb *= 1 - 0.25 * band[..., None]
        rough += 0.05 * band
    elif kind in (2, 3):                                 # кирпич
        red = kind == 2
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        rows = int(12 * dense)          # рядов кирпича на тайл: 25 мм кирпич × 12
        bh = n / rows
        bw = n / 8
        row = np.floor(yy / bh).astype(np.int32)
        off = (row % 2) * 0.5 * bw
        cx = np.floor((xx + off) / bw).astype(np.int32)
        brick_id = (h12int(cx, row, 64) % 64)
        base = np.array([0.30, 0.115, 0.075] if red else [0.245, 0.245, 0.235], np.float32)
        var = proc.periodic_noise(n, n, 64, rng)
        # цвет каждого отдельного кирпича: детерминированно по id строки/колонки
        lut = rng.uniform(-0.06, 0.075, size=(64 * 32,)).astype(np.float32)
        per_brick = lut[(brick_id * 13 + row * 7) % len(lut)].reshape(n, n)
        rgb = base[None, None, :] * (1.0 + per_brick[..., None] * 1.6)   # каждый кирпич своего тона
        rgb *= (0.86 + 0.3 * var[..., None])
        # раствор: светлее, шершавее, утоплен
        mortar = ((xx + off) % bw < 4.5) | ((yy % bh) < 4.0)
        rgb = np.where(mortar[..., None], np.array([0.40, 0.395, 0.375], np.float32), rgb)
        h += 0.22 * mortar * (1 - red) + 0.18 * (1 - mortar)
        h -= 0.16 * mortar
        # сколы кирпича
        chip = (very_fine > 0.955) & (~mortar)
        rgb[chip] *= 1.28
        rough = np.where(mortar, 0.9, 0.68) + 0.06 * (fine - 0.5)
        rgb *= 0.92 + 0.16 * fine[..., None]
    elif kind == 4:                                       # имперская красная стена
        rgb = np.stack([0.335 + 0.03 * gross, 0.075 + 0.02 * gross, 0.050 + 0.015 * gross], -1)
        yy = np.mgrid[0:n, 0:n][1].astype(np.float32)
        # кладка из крупных блоков с золотистой линией связки
        joint = np.exp(-np.minimum(np.abs(yy % (n / 12) - 2), 10) ** 2 / 8.0)
        rgb *= 1 - 0.25 * joint[..., None]
        h -= 0.2 * joint
        rough = 0.55 - 0.12 * joint + 0.05 * (fine - 0.5)
        rgb *= 0.95 + 0.1 * fine[..., None]
    elif kind == 5:                                       # офисное стекло: рама + пыльное полотно
        rgb = np.stack([0.075 + 0.02 * gross, 0.09 + 0.02 * gross, 0.105 + 0.02 * gross], -1)
        rough = np.full((n, n), 0.16, np.float32)
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        mull = (np.abs(xx % (n / 3) - n / 6) < 5) | (np.abs(yy % (n / 6) - n / 12) < 4)
        rgb[mull] = [0.16, 0.165, 0.17]
        rough[mull] = 0.55
        dust = proc.periodic_noise(n, n, 16, rng)
        rgb *= 1 + 0.4 * dust[..., None] * 0.35
        rough = np.clip(rough + 0.18 * dust - 0.1 * (dust > 0.7), 0.06, 0.85)
        h += 0.1 * (dust > 0.75)
    elif kind == 6:                                       # рынок: плитка + бетон
        rgb = np.stack([0.40 + 0.04 * gross, 0.385 + 0.04 * gross, 0.34 + 0.04 * gross], -1)
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        t = max(6.0, n / (14 * dense))  # плитка рынка/черепичный модуллон
        gap = ((xx % t) < 2.4) | ((yy % t) < 2.4)
        rgb = np.where(gap[..., None], np.array([0.20, 0.195, 0.185], np.float32), rgb)
        h = np.where(gap, -0.35, 0.05 * gross)
        rough = np.where(gap, 0.85, 0.42) + 0.04 * (fine - 0.5)
        # местами плитка отвалилась — видно клей и дыру
        miss = (proc.periodic_noise(n, n, 12, rng) > 0.86)
        rgb[miss] = [0.16, 0.14, 0.115]
        h[miss] = -0.5
        rough[miss] = 0.95
    else:                                                 # 7: жёлтая черепица
        rgb = np.stack([0.60 + 0.03 * gross, 0.42 + 0.03 * gross, 0.075 + 0.02 * gross], -1)
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        # ряды трубчатой черепицы: полукруглые валики + желобки между
        pitch = n / 10
        v = (yy % pitch) / pitch
        ridge = np.abs(xx % (pitch * 0.62) - pitch * 0.31) / (pitch * 0.31)
        prof = np.cos(np.clip(ridge, 0, 1) * np.pi * 0.5)
        rgb *= 0.70 + 0.46 * prof[..., None]
        h = prof * 0.6 - 0.2 * (v > 0.92)
        glaze = proc.periodic_noise(n, n, 24, rng)
        rough = np.clip(0.19 + 0.11 * glaze - 0.07 * prof, 0.07, 0.52)
        # глазурь местами содрана, под ней серая глина
        worn = (proc.periodic_noise(n, n, 48, rng) > 0.9)
        rgb[worn] *= np.array([0.55, 0.5, 0.5], np.float32)
        rough[worn] = 0.8
    # общая «живость»: зерно оставили мелким, но слабым (3%) — на 4-метровом
    # тайле сильнее начинает читаться «шум» вместо фактуры.
    rgb *= 0.985 + 0.03 * very_fine[..., None]
    rgb = np.clip(rgb, 0.001, 1.0).astype(np.float32)
    return rgb, h.astype(np.float32), np.clip(rough, 0.03, 0.99).astype(np.float32)


def h12int(x: np.ndarray, y: np.ndarray, m: int) -> np.ndarray:
    return ((x.astype(np.int64) * 73856093) ^ (y.astype(np.int64) * 19349663)) % m


# --------------------------------------------------------------- обшарпанность
def weather(rgb, h, rough, kind, rng, grime=1.0, damp=1.0, sun_side=0.5, wear=1.0):
    n = rgb.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    # 1) потёки: гребни по вертикали, затухают сверху вниз
    streak_x = proc.periodic_noise(1, n, 48, rng)[0]
    streak = np.repeat(streak_x[None, :], n, 0)
    streak = proc.ridged(n, n, 2, 32, rng=rng, wrap=True) * 0.4 + streak * 0.6
    band = np.clip(1.0 - yy / n, 0, 1) ** 0.5
    grime_m = np.clip(streak * 1.5 - 0.42, 0, 1) * band * grime
    rgb *= 1 - 0.30 * grime_m[..., None]
    rough = np.clip(rough + 0.20 * grime_m, 0.02, 0.99)
    h -= 0.03 * grime_m
    # 2) высолы и сырость у земли
    damp_m = np.clip(1.0 - (yy / n) / 0.28, 0, 1) ** 1.6 * (proc.periodic_noise(n, n, 14, rng) * 0.6 + 0.4)
    damp_m = np.clip(damp_m * 1.5 - 0.25, 0, 1) * damp
    rgb = rgb * (1 - 0.45 * damp_m[..., None]) + np.array([0.020, 0.024, 0.022], np.float32) * damp_m[..., None]
    rough = np.clip(rough * (1 - 0.45 * damp_m), 0.02, 0.99)
    # 3) выцветание на солнечной стороне + облезание краски
    fade = np.clip(sun_side + (proc.periodic_noise(n, n, 6, rng) - 0.5) * 0.6, 0, 1)[..., None] * \
        np.array([0.8, 1.0, 0.9], np.float32)[None, None, :]
    rgb *= 1 + 0.10 * (fade - 0.5)
    peel = np.clip(proc.periodic_noise(n, n, 40, rng) * 0.6 +
                   proc.periodic_noise(n, n, 90, rng) * 0.4 - (0.82 - 0.12 * wear), 0, 1)
    rgb = rgb * (1 - 0.42 * peel[..., None]) + np.array([0.055, 0.05, 0.042], np.float32) * peel[..., None]
    rough = np.clip(rough + 0.18 * peel, 0.02, 0.99)
    h += 0.04 * peel - 0.02 * (peel > 0.2)
    # 4) копоть под карнизом и вокруг труб
    eave = np.exp(-np.minimum(np.abs(yy - n * 0.12), 30) ** 2 / 220.0)
    rgb *= 1 - 0.22 * eave[..., None] * (0.4 + 0.6 * streak)[..., None]
    return np.clip(rgb, 0.001, 1.0), h.astype(np.float32), rough.astype(np.float32)


def normal_from_height(h, strength=2.4):
    """Нормали из карты высот (собер, как в Blender/Substance)."""
    dh = np.zeros_like(h)
    dy, dx = np.gradient(h.astype(np.float32))
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    return ((n * 0.5 + 0.5)).astype(np.float32)


# ------------------------------------------------------------------- вывески
SIGNS = [
    ("北京烤鸭", "JD", (0.62, 0.06, 0.05)), ("全聚德", "SD", (0.75, 0.55, 0.06)),
    ("前门大街", "SR", (0.30, 0.03, 0.03)), ("人民超市", "SS", (0.05, 0.16, 0.40)),
    ("老王面馆", "JS", (0.70, 0.62, 0.10)), ("新华书店", "JS", (0.06, 0.22, 0.14)),
    ("麦当劳", "NE", (0.62, 0.08, 0.06)), ("同仁堂", "SD", (0.55, 0.10, 0.06)),
    ("小吃", "NE", (0.06, 0.30, 0.45)), ("茶叶", "SD", (0.10, 0.28, 0.12)),
    ("理发", "JS", (0.35, 0.05, 0.30)), ("药店", "NE", (0.05, 0.28, 0.35)),
    ("旅馆", "JS", (0.42, 0.06, 0.05)), ("百货大楼", "SD", (0.10, 0.10, 0.12)),
    ("火锅", "NE", (0.66, 0.10, 0.05)), ("饺子馆", "JS", (0.72, 0.60, 0.08)),
    ("裁缝", "SR", (0.30, 0.25, 0.10)), ("手机维修", "SS", (0.07, 0.20, 0.45)),
    ("奶茶", "JS", (0.60, 0.30, 0.10)), ("水果", "NE", (0.10, 0.35, 0.12)),
    ("北京", "SD", (0.60, 0.05, 0.05)), ("服务", "SR", (0.15, 0.15, 0.18)),
    ("面", "JS", (0.66, 0.55, 0.10)), ("粥", "SD", (0.30, 0.08, 0.05)),
    ("烟酒", "SS", (0.06, 0.12, 0.30)), ("复印", "SR", (0.20, 0.20, 0.22)),
    ("按摩", "NE", (0.35, 0.05, 0.20)), ("早点", "JS", (0.70, 0.55, 0.08)),
    ("超市", "SS", (0.05, 0.18, 0.42)), ("发廊", "NE", (0.45, 0.06, 0.28)),
    ("小吃街", "SD", (0.60, 0.10, 0.06)), ("照相", "SR", (0.12, 0.14, 0.16)),
]
SIGN_COLS, SIGN_ROWS = 4, 8      # горизонтальные щиты: клетка 512×128 (аспект 4)
VERT_COLS, VERT_ROWS = 16, 2     # вертикальные «вывески-столбы»: 128×512 (аспект 0.25)


def sign_tile(kind: str, text: str, col, rng, w: int, h: int, vertical: bool = False) -> np.ndarray:
    from PIL import Image, ImageDraw, ImageFont
    base = np.zeros((h, w, 4), np.float32)
    c = np.array(col, np.float32)
    if kind == "JS":                       # жёлтые иероглифы на красном
        bgc = c * 0.35; fgc = np.array([0.85, 0.72, 0.16], np.float32)
    elif kind == "SD":                     # золотые на красном (лакированная доска)
        bgc = c * 0.30; fgc = np.array([0.80, 0.62, 0.18], np.float32)
    elif kind == "SR":                     # белые на красном
        bgc = c * 0.42; fgc = np.array([0.86, 0.85, 0.83], np.float32)
    elif kind == "SS":                     # белые на синем
        bgc = c; fgc = np.array([0.85, 0.87, 0.90], np.float32)
    elif kind == "NE":                     # неон: тёмный фон, цветные трубки
        bgc = np.array([0.055, 0.055, 0.062], np.float32); fgc = c
    else:
        bgc = c; fgc = np.array([0.9, 0.9, 0.9], np.float32)
    img = Image.new("RGBA", (w, h), tuple(int(v * 255) for v in bgc) + (255,))
    d = ImageDraw.Draw(img)
    # фон: грязь, выцветание, потёки
    dirt = (rng.random((h, w)).astype(np.float32))
    dirt = proc.blur(dirt, max(2, w // 40))
    arr = np.array(img).astype(np.float32) / 255.0
    arr[..., :3] *= (0.75 + 0.5 * dirt[..., None]) * (1 - 0.25 * (dirt > 0.72)[..., None])
    arr[..., :3] = np.clip(arr[..., :3], 0, 1)
    img = Image.fromarray((arr * 255).astype(np.uint8), "RGBA")
    d = ImageDraw.Draw(img)
    # рамка
    d.rectangle([2, 2, w - 3, h - 3], outline=(int(fgc[0] * 210), int(fgc[1] * 200), int(fgc[2] * 190), 255),
                width=max(2, w // 60))
    # размер букв — от МЕНЬШЕЙ стороны клетки: при CELL 512×128 шрифт «от
    # высоты» дал бы глифы в 4 раза шире клетки, и их срезало бы по краям
    size = int(min(w * 0.74, h * 0.62)) if not vertical else int(min(w * 0.82, h / (len(text) + 0.6)))
    font_path = SERIF if os.path.exists(SERIF) else (SANS if os.path.exists(SANS) else DEJAVU)
    try:
        fnt = ImageFont.truetype(font_path, max(10, size))
    except Exception:
        fnt = ImageFont.load_default()
    # вертикальную «столбовую» раскладку делаем только там, где клетка и правда
    # выше ширины: в широкой плитке стопка из двух знаков выглядела бы пятном
    vertical = vertical or h > w * 1.6
    if vertical:
        total = len(text) * (size + 4)
        if total > h - 8:                      # не влезает в столб — уменьшаем
            size = int((h - 8) / (len(text) + 0.5))
            fnt = ImageFont.truetype(font_path, max(8, size))
            total = len(text) * (size + 4)
        y = max(4, (h - total) // 2)
        x = max(2, (w - size) // 2)
        for ch in text:
            d.text((x, y), ch, font=fnt, fill=tuple(int(v * 255) for v in fgc) + (255,))
            y += size + 4
    else:
        try:
            bb = d.textbbox((0, 0), text, font=fnt)
            tw = bb[2] - bb[0]
        except Exception:
            tw = len(text) * size
        scale = 1.0
        if tw > w - 16:
            scale = (w - 16) / tw
            fnt = ImageFont.truetype(font_path, max(10, int(size * scale)))
        d.text((max(4, (w - tw) / 2), (h - size) / 2 - 6), text, font=fnt,
               fill=tuple(int(v * 255) for v in fgc) + (255,))
    out = np.array(img).astype(np.float32) / 255.0
    # неон: яркая кромка букв + подсветка
    if kind == "NE":
        lum = out[..., :3].max(-1)
        glow = proc.blur((lum > 0.45).astype(np.float32), max(2, w // 24))
        out[..., :3] = np.clip(out[..., :3] + glow[..., None] * fgc[None, None] * 0.7, 0, 1)
    # выключенные/выцветшие знаки: 30 % тусклее и обесцвечены
    if rng.random() < 0.3:
        l = out[..., :3].mean(-1, keepdims=True)
        out[..., :3] = out[..., :3] * 0.35 + l * 0.65
        out[..., :3] *= 0.75
    return out


# Цель по линейному альбедо (0..1) — по замерам фотографий улиц: панель бетонная
# 0.20, кирпич серый 0.14, красный 0.115, имперская стена 0.075, стекло 0.035,
# плитка 0.24, черепица 0.30. Генератор подстраивает яркость под эти числа,
# поэтому материал не «светится» и не уходит в чёрное.
LIN_TARGET = [0.205, 0.190, 0.115, 0.140, 0.075, 0.035, 0.240, 0.300]


def normalize_albedo(rgb: np.ndarray, target: float) -> np.ndarray:
    lin = ((np.clip(rgb, 0.001, 1) + 0.055) / 1.055) ** 2.4
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    k = target / max(float(lum.mean()), 1e-5)
    lin = np.clip(lin * k, 0.0, 1.0)
    return np.clip(1.055 * lin ** (1 / 2.4) - 0.055, 0.0, 1.0).astype(np.float32)


def make_facades(size: int, rng: np.random.Generator):
    """Атлас материалов: 4 колонки × 4 ряда.

    Строка r = kind // 4 (как в facade.frag: vec2(c, r)/4), но рядов не два, а
    четыре: rows 0-1 — обычные фасады восьми групп, rows 2-3 — те же восемь
    групп, только вдвое мельче (dense=2). Шейдер выбирает половину ряда по seeds
    стены, поэтому у рынка и киосков та же фактура, но в масштабе 2× — иначе
    на трёхметровой стене рынка кирпич выглядит «валуним».
    """
    n = size // COLS
    alb = np.zeros((size, size, 4), np.float32)
    nrm = np.zeros((size, size, 3), np.float32)
    report = []
    for variant in (1, 2):
        for kind in range(8):
            r = kind // COLS + (2 if variant == 2 else 0)
            c = kind % COLS
            rgb, h, rough = wall_base(kind, n, rng, dense=variant)
            rgb = normalize_albedo(rgb, LIN_TARGET[kind])      # яркость — по замерам
            rgb, h, rough = weather(rgb, h, rough, kind, rng,
                                    grime=0.7 + 0.6 * rng.random(),
                                    damp=0.5 + 0.8 * rng.random(),
                                    sun_side=rng.random(),
                                    wear=0.4 + 0.6 * rng.random())
            cell = np.concatenate([rgb, rough[..., None]], -1)
            alb[r * n:(r + 1) * n, c * n:(c + 1) * n] = cell
            nrm[r * n:(r + 1) * n, c * n:(c + 1) * n] = normal_from_height(h, 2.6)
            st = proc.material_stats(rgb, rough)
            report.append({"material": NAME[kind] + ("" if variant == 1 else " (мелкий)"),
                           "cell": [c, r], "albedo": round(st["albedo_mean"], 4),
                           "p95": round(st["albedo_p95"], 4), "rough": round(st["rough_mean"], 3)})
    return alb, nrm, report


NAME = ["панель 9 эт.", "панель 5 эт.", "кирпич красный", "кирпич серый (хутун)",
        "имперская стена", "офисное стекло", "рынок: плитка", "черепица жёлтая"]


def make_signs(size: int, rng: np.random.Generator):
    # Одна квадратная текстура, два набора клеток. Верхняя половина — широкие
    # щиты (4×8 клеток по 512×128 px, аспект 4 ≈ лента 12×3.4 м на стене).
    # Нижняя — вертикальные «столбы» (16×2 по 128×512 px, аспект 0.25 ≈ щит
    # 1.8×9 м). Клетка обязана совпадать по аспекту с панелью, иначе иероглифы
    # растягивает: раньше атлас был 8×8, а шейдер делил координаты на 8×4, и в
    # каждую панель попадали половины двух соседних вывесок.
    half = size // 2
    hw, hh = size // SIGN_COLS, half // SIGN_ROWS
    vw, vh = size // VERT_COLS, half // VERT_ROWS
    atlas = np.zeros((size, size, 4), np.float32)
    for i, (text, kind, col) in enumerate(SIGNS[:SIGN_COLS * SIGN_ROWS]):
        r, c = divmod(i, SIGN_COLS)
        atlas[r * hh:(r + 1) * hh, c * hw:(c + 1) * hw] = sign_tile(kind, text, col, rng, hw, hh, False)
        rv, cv = divmod(i, VERT_COLS)
        atlas[half + rv * vh:half + (rv + 1) * vh, cv * vw:(cv + 1) * vw] = \
            sign_tile(kind, text, col, rng, vw, vh, True)
    # 30 и 31 широкого набора — не текст, а ФОРМА свечения: щиток фонаря и
    # лампочка гирлянды берут именно эти клетки, поэтому вместо иероглифов там
    # мягкий диск и резкая точка (альфа атласа = маска свечения).
    for idx, (r0, g0, b0, hard) in enumerate([(0.98, 0.78, 0.42, 0.30), (1.0, 0.92, 0.66, 0.62)]):
        c = 30 + idx
        y0, y1 = (c // SIGN_COLS) * hh, (c // SIGN_COLS + 1) * hh
        x0, x1 = (c % SIGN_COLS) * hw, (c % SIGN_COLS + 1) * hw
        yy, xx = np.mgrid[0:hh, 0:hw].astype(np.float32)
        d = np.hypot((xx - hw / 2) / (hw / 2), (yy - hh / 2) / (hh / 2))
        core = np.clip(1.0 - d, 0, 1) ** (1.0 + 6.0 * hard)
        halo = np.clip(1.0 - d * 0.92, 0, 1) ** 2
        cell = np.zeros((hh, hw, 4), np.float32)
        cell[..., 0] = np.clip(core * 1.0 + halo * 0.45, 0, 1) * r0
        cell[..., 1] = np.clip(core * 1.0 + halo * 0.45, 0, 1) * g0
        cell[..., 2] = np.clip(core * 1.0 + halo * 0.45, 0, 1) * b0
        cell[..., 3] = np.clip(core + halo * 0.55, 0, 1)
        atlas[y0:y1, x0:x1] = cell
    meta = {"cols": SIGN_COLS, "rows": SIGN_ROWS, "vertCols": VERT_COLS, "vertRows": VERT_ROWS,
            "vertOffset": SIGN_COLS * SIGN_ROWS, "cellPx": [hw, hh], "vertCellPx": [vw, vh]}
    return atlas, meta


def check_font_coverage():
    """Ни один иероглиф не должен превратиться в «тофу»: проверяем по маске."""
    from PIL import Image, ImageDraw, ImageFont
    import numpy as np
    path = SERIF if os.path.exists(SERIF) else DEJAVU
    fnt = ImageFont.truetype(path, 40)
    bad = []
    for text, kind, col in SIGNS:
        for ch in text:
            im = Image.new("L", (52, 52), 0)
            ImageDraw.Draw(im).text((2, 2), ch, font=fnt, fill=255)
            if int(np.array(im).max()) < 40:
                bad.append(ch)
    if bad:
        raise SystemExit("шрифт не покрывает знаки: " + " ".join(sorted(set(bad))) +
                         " — пересоберите подмножество: python3 tools/subset_font.py")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=2048, help="сторона атласа фасадов")
    ap.add_argument("--signs", type=int, default=2048, help="сторона атласа вывесок")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--seed", type=int, default=1103)
    a = ap.parse_args()
    check_font_coverage()
    rng = np.random.default_rng(a.seed)
    os.makedirs(a.out, exist_ok=True)

    alb, nrm, report = make_facades(a.size, rng)
    proc.save_png(os.path.join(a.out, "beijing_facade.png"), alb)
    proc.save_png(os.path.join(a.out, "beijing_facade_nrm.png"), nrm, mode="RGB")
    # мобильный вариант
    import PIL.Image as I
    small = np.array(I.fromarray((alb * 255).astype(np.uint8)).resize((1024, 1024), I.LANCZOS), np.float32) / 255
    proc.save_png(os.path.join(a.out, "beijing_facade_1k.png"), small)

    signs, smeta = make_signs(a.signs, rng)
    proc.save_png(os.path.join(a.out, "beijing_signs.png"), signs)

    # реестр клеток: инструменты (и правка текстов вывесок) берут раскладку отсюда,
    # чтобы «вывеска №17» была одной и той же и в игре, и на снимке.
    data = dict(smeta)
    data["note"] = ("индексы 32..63 — те же тексты в вертикальной раскладке "
                    "(клетка 128×512 в нижней половине текстуры); id клетки = index + vertOffset")
    data["items"] = []
    for i, (text, kind, col) in enumerate(SIGNS[:SIGN_COLS * SIGN_ROWS]):
        data["items"].append({"index": i, "text": text, "kind": kind,
                              "color": [round(float(v), 3) for v in col]})
    with open(os.path.join(a.out, "..", "beijing_signs.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)

    rep_path = os.path.join(ROOT, "docs", "material_report.json")
    os.makedirs(os.path.dirname(rep_path), exist_ok=True)
    with open(rep_path, "w", encoding="utf-8") as f:
        json.dump({"step": "5.33", "beijing_facades": report}, f, ensure_ascii=False, indent=1)
    print(f"атласы: beijing_facade.png {a.size}², beijing_facade_nrm.png {a.size}², "
          f"beijing_signs.png {a.signs}² ({len(SIGNS)} текстов × 2 ориентации)")
    for r in report:
        print(f"  {r['material']:<22} альбедо {r['albedo']:.3f}  p95 {r['p95']:.3f}  "
              f"шерох {r['rough']:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

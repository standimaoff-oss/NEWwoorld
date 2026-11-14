#!/usr/bin/env python3
"""Build the standalone "big street + hutong alleys" map.

Produces, from one deterministic generator:
  docs/china-map/china-map.json   machine-readable plan (metres, x east / z south)
  docs/china-map/china-map.svg    static vector plan
  docs/china-map/china-map.png    static raster plan
  docs/china-map/NotoMap.woff2    embedded font subset (Chinese + Latin)
  China_Map.html                  self-contained interactive map viewer

This is a MAP ONLY. Nothing here is loaded by ShopSim, the WebGL preview,
the APK or the EXE.
"""
import base64
import json
import math
import os
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "china-map"
OUT.mkdir(parents=True, exist_ok=True)
R = random.Random(20261114)

XMIN, XMAX = -900.0, 900.0
ZMIN, ZMAX = -620.0, 620.0
AVENUE_W = 52.0
BOULEVARD_W = 30.0
ARTERIALS = [
    (-660.0, 28.0, "西二环路", "Западное 2-е кольцо"),
    (-330.0, 30.0, "西一环路", "Западное 1-е кольцо"),
    (0.0, 42.0, "中轴路", "Центральная ось"),
    (330.0, 30.0, "东一环路", "Восточное 1-е кольцо"),
    (660.0, 28.0, "东二环路", "Восточное 2-е кольцо"),
]
BANDS = [(-265.0, -75.0, [-215.0, -155.0, -95.0]), (75.0, 265.0, [95.0, 155.0, 215.0])]

CN_PREFIX = ["杏花", "石桥", "纸马", "井儿", "柳荫", "铜锣", "槐树", "雨帘", "南锣", "北锣",
             "砖塔", "绒线", "帽儿", "方砖", "桂花", "枣林", "青瓦", "灯笼", "米市", "茶馆",
             "戏楼", "书局", "染坊", "铁匠", "金鱼", "藕塘", "柏树", "钟楼", "箭杆", "粉房",
             "鲜鱼", "草厂", "榆树", "棋盘", "剪刀", "棉花", "油坊", "糖坊", "竹竿", "石碑"]
CN_SUFFIX = ["胡同", "巷", "里", "条"]
RU_PREFIX = ["Абрикосовый", "Каменный", "Бумажный", "Колодезный", "Ивовый", "Медный", "Акациевый",
             "Дождевой", "Южный", "Северный", "Кирпичный", "Нитяной", "Шляпный", "Плиточный",
             "Османтусовый", "Финиковый", "Черепичный", "Фонарный", "Рисовый", "Чайный",
             "Театральный", "Книжный", "Красильный", "Кузнечный", "Золотой", "Лотосовый",
             "Кипарисовый", "Колокольный", "Стрелковый", "Мучной", "Рыбный", "Сенной", "Вязовый",
             "Шахматный", "Ножничный", "Хлопковый", "Масляный", "Сахарный", "Бамбуковый", "Стела"]
RU_SUFFIX = ["проулок", "переулок", "тупик", "ряд"]

names = []
for a, p in enumerate(CN_PREFIX):
    for b, s in enumerate(CN_SUFFIX):
        names.append((p + s, RU_PREFIX[a] + " " + RU_SUFFIX[b]))
R.shuffle(names)
name_i = 0


def next_name():
    global name_i
    n = names[name_i % len(names)]
    name_i += 1
    return n


def rect(x0, z0, x1, z1):
    return [[round(x0, 1), round(z0, 1)], [round(x1, 1), round(z0, 1)],
            [round(x1, 1), round(z1, 1)], [round(x0, 1), round(z1, 1)]]


def ellipse(cx, cz, rx, rz, n=48):
    return [[round(cx + rx * math.cos(2 * math.pi * i / n), 1),
             round(cz + rz * math.sin(2 * math.pi * i / n), 1)] for i in range(n)]


data = {"roads": [], "alleys": [], "blocks": [], "buildings": [], "courtyards": [],
        "water": [], "parks": [], "plazas": [], "bridges": [], "pois": [], "anchors": [],
        "paths": []}

# ---------------------------------------------------------------- street grid
avenue = {"id": "r-avenue", "name": "京华大街", "nameRu": "Проспект Цзинхуа",
          "cls": "avenue", "width": AVENUE_W, "pts": [[XMIN, 0], [XMAX, 0]],
          "note": "Главная улица: 1,8 км, 52 м, 6 полос, две велодорожки и бульвар посередине."}
data["roads"].append(avenue)
for z, cn, ru in [(-280.0, "北辰路", "Бэйчэнь-лу"), (280.0, "南池路", "Наньчи-лу")]:
    data["roads"].append({"id": f"r-bl-{int(z)}", "name": cn, "nameRu": ru, "cls": "boulevard",
                          "width": BOULEVARD_W, "pts": [[XMIN, z], [XMAX, z]], "note": "Бульвар 30 м."})
for x, w, cn, ru in ARTERIALS:
    data["roads"].append({"id": f"r-ar-{int(x)}", "name": cn, "nameRu": ru, "cls": "arterial",
                          "width": w, "pts": [[x, ZMIN], [x, ZMAX]], "note": f"Магистраль {w:.0f} м, пересекает квартал с севера на юг."})

# Vertical hutong lanes in each arterial-to-arterial segment.
segments = []
for i in range(len(ARTERIALS) - 1):
    a, aw, _, _ = ARTERIALS[i]
    b, bw, _, _ = ARTERIALS[i + 1]
    left, right = a + aw / 2 + 3, b - bw / 2 - 3
    n = max(3, round((right - left) / 100))
    valle = []
    for k in range(1, n):
        x = left + (right - left) * k / n + R.uniform(-9, 9)
        w = R.uniform(5.5, 8.0)
        valle.append((x, w))
        cn, ru = next_name()
        for z0, z1, _ in BANDS:
            data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru,
                                   "cls": "hutong", "width": round(w, 1), "kind": "сквозной",
                                   "pts": [[round(x, 1), z0], [round(x, 1), z1]], "district": i})
    segments.append((left, right, valle))

# Horizontal hutong lanes (per segment, so the arterials really break the grid).
for si, (left, right, _) in enumerate(segments):
    for z0, z1, hz in BANDS:
        for z in hz:
            zz = z + R.uniform(-5, 5)
            w = R.uniform(5.0, 7.5)
            cn, ru = next_name()
            data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru,
                                   "cls": "hutong", "width": round(w, 1), "kind": "сквозной",
                                   "pts": [[left, round(zz, 1)], [right, round(zz, 1)]], "district": si})

# Blocks from the alley grid, with courtyard compounds inside.
for si, (left, right, valle) in enumerate(segments):
    xe = [left]
    for x, w in valle:
        xe += [x - w / 2, x + w / 2]
    xe.append(right)
    x_intervals = [(xe[i] + 1.5, xe[i + 1] - 1.5) for i in range(0, len(xe) - 1, 2)]
    for z0, z1, hz in BANDS:
        ze = [z0]
        for z, w in [(z + R.uniform(-5, 5), 6.5) for z in hz]:
            ze += [z - w / 2, z + w / 2]
        ze.append(z1)
        z_intervals = [(ze[i] + 1.5, ze[i + 1] - 1.5) for i in range(0, len(ze) - 1, 2)]
        for x0, x1 in x_intervals:
            for zz0, zz1 in z_intervals:
                if x1 - x0 < 12 or zz1 - zz0 < 12:
                    continue
                bid = f"b-{len(data['blocks'])}"
                data["blocks"].append({"id": bid, "poly": rect(x0, zz0, x1, zz1),
                                      "district": si, "band": "север" if zz1 < 0 else "юг"})
                nplots = max(1, min(3, round((x1 - x0) / 46)))
                pw = (x1 - x0) / nplots
                for k in range(nplots):
                    px0, px1 = x0 + k * pw + 1.2, x0 + (k + 1) * pw - 1.2
                    if px1 - px0 < 9 or zz1 - zz0 < 16:
                        continue
                    if R.random() < .16:
                        data["buildings"].append({"id": f"h-{len(data['buildings'])}", "block": bid,
                                                  "poly": rect(px0, zz0 + 2, px1, zz1 - 2),
                                                  "floors": R.randint(4, 7), "kind": "midrise"})
                        continue
                    m, wing = 2.0, min(7.0, max(4.0, (zz1 - zz0) * .19))
                    north = rect(px0 + m, zz0 + m, px1 - m, zz0 + m + wing)
                    south = rect(px0 + m, zz1 - m - wing, px1 - m, zz1 - m)
                    west = rect(px0 + m, zz0 + m + wing + 1, px0 + m + 5, zz1 - m - wing - 1)
                    east = rect(px1 - m - 5, zz0 + m + wing + 1, px1 - m, zz1 - m - wing - 1)
                    for poly in (north, south, west, east):
                        data["buildings"].append({"id": f"h-{len(data['buildings'])}", "block": bid,
                                                  "poly": poly, "floors": R.choice([1, 1, 2]),
                                                  "kind": "courtyard"})
                    data["courtyards"].append({"id": f"c-{len(data['courtyards'])}", "block": bid,
                                               "poly": rect(px0 + m + 5, zz0 + m + wing + 1,
                                                            px1 - m - 5, zz1 - m - wing - 1)})
                    if R.random() < .35:
                        cn, ru = next_name()
                        data["pois"].append({"id": f"p-{len(data['pois'])}", "name": "院门", "nameRu": "Ворота двора",
                                             "kind": "gate", "x": round((px0 + px1) / 2, 1), "z": round(zz1 - m, 1)})

# Short dead-end lanes (тупики) punched into random blocks.
for blk in R.sample(data["blocks"], min(46, len(data["blocks"]))):
    x0, z0 = blk["poly"][0]
    x1, z1 = blk["poly"][2]
    if x1 - x0 < 22 or z1 - z0 < 30:
        continue
    x = R.uniform(x0 + 6, x1 - 6)
    cn, ru = next_name()
    data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru, "cls": "hutong",
                           "width": 4.5, "kind": "тупик", "pts": [[round(x, 1), round(z1, 1)],
                           [round(x, 1), round(z1 - R.uniform(20, 38), 1)]], "district": blk["district"]})

# T-junctions and gently bent lanes: the grid must not read as one perfect chessboard.
for si, (left, right, valle) in enumerate(segments):
    for z0, z1, hz in BANDS:
        for _ in range(2):
            x = R.uniform(left + 20, right - 20)
            z = R.choice(hz)
            cn, ru = next_name()
            pts = [[round(x, 1), round(z0, 1)], [round(x, 1), round(z, 1)],
                   [round(x + R.uniform(18, 46), 1), round(z, 1)]]
            pts[-1][0] = min(pts[-1][0], right - 4)
            data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru,
                                   "cls": "hutong", "width": round(R.uniform(4.5, 6.5), 1),
                                   "kind": "T-образный", "pts": pts, "district": si})
for i in range(4):
    x = -820 + i * 270
    z0, z1 = R.choice(BANDS)[:2]
    cn, ru = next_name()
    data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru,
                           "cls": "hutong", "width": 6.0, "kind": "изогнутый",
                           "pts": [[x, z0], [x + 32, (z0 + z1) / 2], [x + 8, z1]], "district": 6})

# High-rise frontage along both sides of the big avenue.
for si, (left, right, _) in enumerate(segments):
    for side in (-1, 1):
        n = 5
        step = (right - left) / n
        for k in range(n):
            x0 = left + k * step + 3
            x1 = left + (k + 1) * step - 3
            if x1 - x0 < 12 or abs((x0 + x1) / 2) < 78:
                continue
            depth = R.uniform(30, 44)
            z0, z1 = (-26 - depth, -26) if side < 0 else (26, 26 + depth)
            data["buildings"].append({"id": f"h-{len(data['buildings'])}", "poly": rect(x0, z0, x1, z1),
                                      "floors": R.randint(7, 17), "kind": "frontage"})
            if R.random() < .6:
                data["pois"].append({"id": f"p-{len(data['pois'])}", "name": "店铺", "nameRu": "Лавка",
                                     "kind": "shop", "x": round((x0 + x1) / 2, 1),
                                     "z": round(-24 if side < 0 else 24, 1)})

# South residential band beyond the canal.
for i in range(12):
    x0 = -860 + i * 145
    for z0 in (440, 520):
        data["buildings"].append({"id": f"h-{len(data['buildings'])}", "poly": rect(x0, z0, x0 + 118, z0 + 58),
                                  "floors": R.randint(2, 5), "kind": "residential"})
for z in (430, 510, 590):
    cn, ru = next_name()
    data["alleys"].append({"id": f"a-{len(data['alleys'])}", "name": cn, "nameRu": ru, "cls": "hutong",
                           "width": 6.0, "kind": "сквозной", "pts": [[-900, z], [900, z]], "district": 5})

# ---------------------------------------------------------------- nature / squares
data["water"].append({"id": "w-canal", "name": "玉带河", "nameRu": "Канал Юйдайхэ",
                      "poly": rect(-900, 382, 900, 418), "kind": "canal"})
data["water"].append({"id": "w-lake", "name": "荷花池", "nameRu": "Лотосовый пруд",
                      "poly": ellipse(-520, -465, 125, 78), "kind": "lake"})
data["parks"].append({"id": "pk-bamboo", "name": "竹园", "nameRu": "Бамбуковый парк",
                      "poly": rect(-900, -620, -110, -300), "kind": "park"})
data["parks"].append({"id": "pk-east", "name": "东苑", "nameRu": "Восточный сад",
                      "poly": rect(140, -620, 900, -300), "kind": "park"})
data["plazas"].append({"id": "pl-central", "name": "天华广场", "nameRu": "Площадь Тяньхуа",
                       "poly": ellipse(0, 0, 68, 68), "kind": "roundabout"})
data["plazas"].append({"id": "pl-market", "name": "夜市", "nameRu": "Ночной рынок",
                       "poly": rect(120, 120, 260, 230), "kind": "market"})
data["plazas"].append({"id": "pl-fir", "name": "岁寒坪", "nameRu": "Праздничная поляна",
                       "poly": ellipse(-430, -470, 42, 42), "kind": "plaza"})
for x, w, _, _ in ARTERIALS:
    data["bridges"].append({"id": f"br-{int(x)}", "name": "桥", "nameRu": "Мост",
                            "poly": rect(x - w / 2 - 3, 378, x + w / 2 + 3, 422), "x": x})
# Promenade and park paths.
data["paths"].append({"id": "path-river", "pts": [[-900, 370], [900, 370]], "width": 5, "kind": "promenade"})
data["paths"].append({"id": "path-park1", "pts": [[-880, -380], [-620, -430], [-400, -500], [-160, -560]], "width": 4, "kind": "walk"})
data["paths"].append({"id": "path-park2", "pts": [[180, -580], [420, -470], [700, -420], [880, -350]], "width": 4, "kind": "walk"})
# Bamboo / tree clusters as small circles.
for i in range(46):
    cx, cz = R.uniform(-880, -140), R.uniform(-600, -320)
    if math.hypot(cx + 520, cz + 465) < 140 or math.hypot(cx + 430, cz + 470) < 55:
        continue
    data["pois"].append({"id": f"p-{len(data['pois'])}", "name": "竹", "nameRu": "Бамбук",
                         "kind": "tree", "x": round(cx, 1), "z": round(cz, 1)})

# ---------------------------------------------------------------- named POIs
fixed_pois = [
    (-880, 0, "牌楼", "Западные ворота пайфан", "gate"), (880, 0, "牌楼", "Восточные ворота пайфан", "gate"),
    (0, 0, "鼓楼", "Барабанная башня", "landmark"),
    (-330, -18, "地铁", "Метро «Западное кольцо»", "metro"),
    (330, 18, "地铁", "Метро «Восточное кольцо»", "metro"),
    (-220, -95, "便民超市", "Магазин «Бяньминь»", "shop"),
    (-520, -465, "荷亭", "Павильон у пруда", "landmark"),
    (-430, -470, "岁寒", "Новогодняя ёлка", "landmark"),
    (190, 175, "夜市", "Ночной рынок", "market"),
    (700, -430, "茶园", "Чайный сад", "landmark"),
    (-700, 430, "码头", "Причал", "landmark"),
    (-330, 0, "牌楼", "Западная арка", "gate"),
    (330, 0, "牌楼", "Восточная арка", "gate"),
    (-660, -280, "书院", "Школа и библиотека", "public"),
    (660, 280, "剧院", "Театр", "public"),
    (0, -330, "钟楼", "Колокольная башня", "landmark"),
    (0, 330, "庙", "Храм", "public"),
    (-120, 155, "茶馆", "Чайная", "shop"),
    (500, 155, "客栈", "Гостиница", "public"),
]
for x, z, cn, ru, kind in fixed_pois:
    data["pois"].append({"id": f"p-{len(data['pois'])}", "name": cn, "nameRu": ru,
                         "kind": kind, "x": x, "z": z})

# ---------------------------------------------------------------- many viewpoints
anchors = [
    ("Весь квартал", 0, -20, 1500, "Аэросъёмка: проспект на 1,8 км, пять магистралей, все проулки, канал и парки."),
    ("Большая улица", -560, 0, 90, "Уровень пешехода на проспекте Цзинхуа: 52 м, шесть полос, фасады 7–17 этажей."),
    ("Центральная площадь", 0, 0, 45, "Кольцо у Барабанной башни, где проспект пересекает Центральную ось."),
    ("Хутун Абрикосовый", -220, -95, 0, "Внутри квартала: дворы-сыхэюань, ворота, тупики шириной 4–8 м."),
    ("Перекрёсток", 330, 0, 180, "Проспект и Восточное 1-е кольцо: арка, метро, поток машин."),
    ("Мост через канал", 330, 400, 270, "Канал Юйдайхэ шириной 36 м и мост по магистрали."),
    ("Бамбуковый парк", -520, -465, 120, "Пруд, бамбуковая роща, дорожки."),
    ("Ночной рынок", 190, 175, 300, "Площадь внутри южных проулков, лотки и фонари."),
            ("Западные ворота", -880, 0, 90, "Пайфан на въезде в квартал с запада."),
    ("Крыша на востоке", 660, -280, 225, "Вид с высоты на сетку проулков и проспект."),
]
for i, (name, x, z, yaw, text) in enumerate(anchors, 1):
    data["anchors"].append({"id": f"v-{i:02d}", "num": f"{i:02d}", "name": name,
                            "x": x, "z": z, "yaw": yaw, "text": text})

data["meta"] = {
    "title": "京华里 · Большая улица и проулки",
    "subtitle": "Карта квартала «Новый Китай» — план, а не игровая сцена",
    "units": "metres", "axes": "x — на восток, z — на юг",
    "bounds": [XMIN, ZMIN, XMAX, ZMAX],
    "scaleNote": "1:10000 при печати 2400 px на 1,8 км",
    "seed": 20261114,
    "note": "Отдельная карта. Не подключена к ShopSim.exe, WebGL-превью, APK или EXE.",
}
data["stats"] = {
    "roads": len(data["roads"]), "alleys": len(data["alleys"]), "blocks": len(data["blocks"]),
    "buildings": len(data["buildings"]), "courtyards": len(data["courtyards"]),
    "pois": len(data["pois"]), "anchors": len(data["anchors"]),
    "avenueLengthM": int(XMAX - XMIN), "avenueWidthM": AVENUE_W,
    "areaKm2": round((XMAX - XMIN) * (ZMAX - ZMIN) / 1e6, 2),
}
(OUT / "china-map.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

# ---------------------------------------------------------------- font subset
all_text = "".join(
    [d["name"] for d in data["roads"] + data["alleys"] + data["water"] + data["parks"] + data["plazas"] + data["pois"]]
    + [d["nameRu"] for d in data["roads"] + data["alleys"] + data["pois"]]
    + [a["name"] for a in data["anchors"]] + ["京华里 · Большая улица и проулки Легенда Масштаб Север"]
    + ["0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя .,:-–—()/«»№°"]
)
from fontTools.ttLib import TTFont
from fontTools import subset
font = TTFont(str(ROOT / ".cache/china-preview/assets/NotoSansSC.ttf"))
opts = subset.Options()
opts.layout_features = ["*"]
opts.name_IDs = ["*"]
sub = subset.Subsetter(options=opts)
sub.populate(text=all_text)
sub.subset(font)
font.flavor = None
font.save(str(OUT / "NotoMap.ttf"))
font.flavor = "woff2"
font.save(str(OUT / "NotoMap.woff2"))
woff2_b64 = base64.b64encode((OUT / "NotoMap.woff2").read_bytes()).decode()
font_license = ROOT / ".cache/china-preview/assets/FONT_OFL.txt"
if font_license.exists():
    (OUT / "FONT_OFL.txt").write_bytes(font_license.read_bytes())

# ---------------------------------------------------------------- rendering
W, H = 2400, 1653
PAD = 66
S = min((W - 2 * PAD) / (XMAX - XMIN), (H - 2 * PAD) / (ZMAX - ZMIN))
TX, TY = PAD - XMIN * S, PAD - ZMIN * S


def P(x, z):
    return (TX + x * S, TY + z * S)


def fmt_poly(poly):
    return " ".join(f"{P(x, z)[0]:.1f},{P(x, z)[1]:.1f}" for x, z in poly)


COL = {
    "bg": "#0d1512", "grid": "#18231e", "park": "#1b3225", "parkLine": "#2a4634",
    "water": "#17434b", "waterLine": "#2b6b73", "plaza": "#3a3527",
    "avenue": "#2b3733", "boulevard": "#25302b", "arterial": "#222c28",
    "hutong": "#1b2620", "lane": "#4a5c4e", "center": "#d4b878",
    "court": "#2a3a2f", "b1": "#3b4a40", "b2": "#46584a", "b3": "#556952",
    "b4": "#657a5e", "bHigh": "#6e806b", "edge": "#7c9079",
    "text": "#e8ecdc", "muted": "#9fb09a", "gold": "#d4b878", "anchor": "#d4b878",
    "poi": "#8fae7a", "bridge": "#5c6b5a",
}

# SVG
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
       f'<style>@font-face{{font-family:NotoMap;src:url(data:font/woff2;base64,{woff2_b64}) format("woff2")}} text{{font-family:NotoMap,DejaVu Sans,sans-serif}}</style>',
       f'<rect width="{W}" height="{H}" fill="{COL["bg"]}"/>']
for x in range(-900, 901, 100):
    px = P(x, ZMIN)[0]
    svg.append(f'<line x1="{px:.1f}" y1="{PAD}" x2="{px:.1f}" y2="{H-PAD}" stroke="{COL["grid"]}" stroke-width="1"/>')
for z in range(-600, 601, 100):
    py = P(XMIN, z)[1]
    svg.append(f'<line x1="{PAD}" y1="{py:.1f}" x2="{W-PAD}" y2="{py:.1f}" stroke="{COL["grid"]}" stroke-width="1"/>')
for d in data["parks"]:
    svg.append(f'<polygon points="{fmt_poly(d["poly"])}" fill="{COL["park"]}" stroke="{COL["parkLine"]}" stroke-width="1.5"/>')
for d in data["water"]:
    svg.append(f'<polygon points="{fmt_poly(d["poly"])}" fill="{COL["water"]}" stroke="{COL["waterLine"]}" stroke-width="2"/>')
for d in data["paths"]:
    svg.append(f'<polyline points="{fmt_poly(d["pts"])}" fill="none" stroke="{COL["parkLine"]}" stroke-width="{d["width"]*S:.1f}" stroke-linecap="round"/>')
for d in data["plazas"]:
    svg.append(f'<polygon points="{fmt_poly(d["poly"])}" fill="{COL["plaza"]}" stroke="{COL["gold"]}" stroke-width="1.5"/>')
for d in reversed(data["roads"]):
    col = COL["avenue"] if d["cls"] == "avenue" else COL["boulevard"] if d["cls"] == "boulevard" else COL["arterial"]
    svg.append(f'<polyline points="{fmt_poly(d["pts"])}" fill="none" stroke="{col}" stroke-width="{d["width"]*S:.1f}" stroke-linecap="butt"/>')
for d in data["alleys"]:
    svg.append(f'<polyline points="{fmt_poly(d["pts"])}" fill="none" stroke="{COL["hutong"]}" stroke-width="{d["width"]*S:.1f}" stroke-linecap="round"/>')
# Centre line of the avenue.
svg.append(f'<line x1="{P(XMIN,0)[0]:.1f}" y1="{P(XMIN,0)[1]:.1f}" x2="{P(XMAX,0)[0]:.1f}" y2="{P(XMAX,0)[1]:.1f}" stroke="{COL["center"]}" stroke-width="2" stroke-dasharray="14 12" opacity=".65"/>')
for c in data["courtyards"]:
    svg.append(f'<polygon points="{fmt_poly(c["poly"])}" fill="{COL["court"]}"/>')
for b in data["buildings"]:
    f = b["floors"]
    fill = COL["bHigh"] if b["kind"] == "frontage" else COL["b4"] if f >= 5 else COL["b3"] if f >= 3 else COL["b2"] if f == 2 else COL["b1"]
    svg.append(f'<polygon points="{fmt_poly(b["poly"])}" fill="{fill}" stroke="{COL["edge"]}" stroke-width=".8"/>')
for d in data["bridges"]:
    svg.append(f'<polygon points="{fmt_poly(d["poly"])}" fill="{COL["bridge"]}" stroke="{COL["gold"]}" stroke-width="1"/>')
# Labels.
def label(x, z, cn, ru, size=15, color=None, dy=0):
    px, py = P(x, z)
    svg.append(f'<text x="{px:.1f}" y="{py+dy:.1f}" font-size="{size}" fill="{color or COL["text"]}" text-anchor="middle">{cn}</text>')
    if ru:
        svg.append(f'<text x="{px:.1f}" y="{py+dy+size+3:.1f}" font-size="{max(9,size-5)}" fill="{COL["muted"]}" text-anchor="middle">{ru}</text>')
label(-560, 0, avenue["name"], avenue["nameRu"], 22, COL["gold"], -16)
label(560, 0, avenue["name"], avenue["nameRu"], 22, COL["gold"], -16)
for d in data["roads"]:
    if d["cls"] == "boulevard":
        label(-760, d["pts"][0][1], d["name"], d["nameRu"], 14, COL["muted"], -8)
    elif d["cls"] == "arterial":
        label(d["pts"][0][0], -560, d["name"], d["nameRu"], 13, COL["muted"], 0)
for d in data["water"] + data["parks"] + data["plazas"]:
    c = d["poly"][0] if d.get("kind") in ("canal", "park", "market") else (0, 0)
    if d["kind"] == "canal":
        label(-760, 400, d["name"], d["nameRu"], 15, COL["waterLine"], -6)
    elif d["kind"] == "lake":
        label(-520, -465, d["name"], d["nameRu"], 14, COL["waterLine"], 0)
    elif d["kind"] == "park":
        px = sum(p[0] for p in d["poly"]) / len(d["poly"]) if len(d["poly"]) < 10 else (-505 if d["id"] == "pk-bamboo" else 520)
        label(px, -430, d["name"], d["nameRu"], 17, COL["poi"], 0)
for d in data["alleys"]:
    if d["kind"] not in ("сквозной", "параллельный"):
        continue
    a, b = d["pts"][0], d["pts"][-1]
    if abs(a[0]-b[0]) < 2:  # only horizontal hutong labels fit inside the dense blocks
        label((a[0]+b[0])/2, (a[1]+b[1])/2, d["name"], "", 8.5, COL["muted"], 0)
for a in data["anchors"]:
    px, py = P(a["x"], a["z"])
    svg.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="13" fill="#101614" stroke="{COL["anchor"]}" stroke-width="2"/>')
    svg.append(f'<text x="{px:.1f}" y="{py+4:.1f}" font-size="12" fill="{COL["anchor"]}" text-anchor="middle">{a["num"]}</text>')
for p in data["pois"]:
    if p["kind"] in ("tree", "shop", "gate"):
        continue
    px, py = P(p["x"], p["z"])
    svg.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3.5" fill="{COL["poi"]}"/>')
# Title / legend / scale.
svg.append(f'<rect x="26" y="20" width="690" height="86" rx="12" fill="#101a15" stroke="#2a3a2f"/>')
svg.append(f'<text x="46" y="55" font-size="26" fill="{COL["gold"]}">京华里 · Большая улица и проулки</text>')
svg.append(f'<text x="46" y="84" font-size="14" fill="{COL["muted"]}">Карта квартала «Новый Китай» · 1,8 × 1,24 км · {len(data["alleys"])} проулков · не добавлена в игру</text>')
lx, ly = W - 320, 24
svg.append(f'<rect x="{lx}" y="{ly}" width="292" height="196" rx="12" fill="#101a15" stroke="#2a3a2f"/>')
items = [("Главная улица 52 м", COL["avenue"]), ("Бульвар 30 м", COL["boulevard"]),
         ("Магистраль 28–42 м", COL["arterial"]), ("Проулок 4–8 м", COL["hutong"]),
         ("Двор сыхэюань", COL["court"]), ("Застройка 1–2 этажа", COL["b1"]),
         ("Фасады 7–17 этажей", COL["bHigh"]), ("Вода", COL["water"]), ("Парк", COL["park"])]
for i, (t, c) in enumerate(items):
    yy = ly + 26 + i * 19
    svg.append(f'<rect x="{lx+16}" y="{yy-10}" width="20" height="11" fill="{c}" stroke="{COL["edge"]}" stroke-width=".6"/>')
    svg.append(f'<text x="{lx+44}" y="{yy}" font-size="12" fill="{COL["text"]}">{t}</text>')
# Scale bar: 500 m.
bx, by, length = 60, H - 58, 500 * S
svg.append(f'<rect x="{bx}" y="{by}" width="{length:.1f}" height="9" fill="{COL["gold"]}"/>')
svg.append(f'<rect x="{bx+length/2:.1f}" y="{by}" width="{length/2:.1f}" height="9" fill="#101614"/>')
svg.append(f'<text x="{bx}" y="{by-8}" font-size="13" fill="{COL["text"]}">0</text>')
svg.append(f'<text x="{bx+length/2:.1f}" y="{by-8}" font-size="13" fill="{COL["text"]}" text-anchor="middle">250</text>')
svg.append(f'<text x="{bx+length:.1f}" y="{by-8}" font-size="13" fill="{COL["text"]}" text-anchor="end">500 м</text>')
svg.append(f'<text x="{W-60}" y="{H-40}" font-size="14" fill="{COL["muted"]}" text-anchor="end">С ↑ · x → восток, z ↓ юг</text>')
svg.append('</svg>')
(OUT / "china-map.svg").write_text("\n".join(svg), encoding="utf-8")

# PNG via PIL
from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (W, H), COL["bg"])
dr = ImageDraw.Draw(im)
cn_big = ImageFont.truetype(str(OUT / "NotoMap.ttf"), 30)
cn_mid = ImageFont.truetype(str(OUT / "NotoMap.ttf"), 20)
cn_small = ImageFont.truetype(str(OUT / "NotoMap.ttf"), 15)
cn_tiny = ImageFont.truetype(str(OUT / "NotoMap.ttf"), 10)
ru_big = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 21)
ru = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
ru_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 11)
for x in range(-900, 901, 100):
    px = int(P(x, ZMIN)[0]); dr.line([(px, PAD), (px, H - PAD)], fill=COL["grid"])
for z in range(-600, 601, 100):
    py = int(P(XMIN, z)[1]); dr.line([(PAD, py), (W - PAD, py)], fill=COL["grid"])
def ppoly(poly): return [tuple(map(int, P(x, z))) for x, z in poly]
for d in data["parks"]:
    dr.polygon(ppoly(d["poly"]), fill=COL["park"], outline=COL["parkLine"])
for d in data["water"]:
    dr.polygon(ppoly(d["poly"]), fill=COL["water"], outline=COL["waterLine"])
for d in data["paths"]:
    dr.line(ppoly(d["pts"]), fill=COL["parkLine"], width=max(2, int(d["width"] * S)), joint="curve")
for d in data["plazas"]:
    dr.polygon(ppoly(d["poly"]), fill=COL["plaza"], outline=COL["gold"])
for d in reversed(data["roads"]):
    col = COL["avenue"] if d["cls"] == "avenue" else COL["boulevard"] if d["cls"] == "boulevard" else COL["arterial"]
    dr.line(ppoly(d["pts"]), fill=col, width=max(2, int(d["width"] * S)))
for d in data["alleys"]:
    dr.line(ppoly(d["pts"]), fill=COL["hutong"], width=max(2, int(d["width"] * S)))
px0, py0 = map(int, P(XMIN, 0)); px1, py1 = map(int, P(XMAX, 0))
for xx in range(px0, px1, 26):
    dr.line([(xx, py0), (xx + 13, py0)], fill=COL["center"], width=2)
for c in data["courtyards"]:
    dr.polygon(ppoly(c["poly"]), fill=COL["court"])
for b in data["buildings"]:
    f = b["floors"]
    fill = COL["bHigh"] if b["kind"] == "frontage" else COL["b4"] if f >= 5 else COL["b3"] if f >= 3 else COL["b2"] if f == 2 else COL["b1"]
    dr.polygon(ppoly(b["poly"]), fill=fill, outline=COL["edge"])
for d in data["bridges"]:
    dr.polygon(ppoly(d["poly"]), fill=COL["bridge"], outline=COL["gold"])
def text_c(x, z, cn, rutext, cnfont, rufont, dy, color):
    px, py = P(x, z)
    dr.text((px, py + dy), cn, font=cnfont, fill=color, anchor="mm")
    if rutext:
        dr.text((px, py + dy + cnfont.size + 4), rutext, font=rufont, fill=COL["muted"], anchor="mm")
text_c(-560, 0, avenue["name"], avenue["nameRu"], cn_big, ru, -22, COL["gold"])
text_c(560, 0, avenue["name"], avenue["nameRu"], cn_big, ru, -22, COL["gold"])
for d in data["roads"]:
    if d["cls"] == "boulevard":
        text_c(-760, d["pts"][0][1], d["name"], d["nameRu"], cn_small, ru_small, -12, COL["text"])
    elif d["cls"] == "arterial":
        text_c(d["pts"][0][0], -560, d["name"], d["nameRu"], cn_small, ru_small, 0, COL["text"])
text_c(-760, 400, "玉带河", "Канал Юйдайхэ", cn_mid, ru_small, -10, COL["waterLine"])
text_c(-520, -465, "荷花池", "Лотосовый пруд", cn_small, ru_small, 0, COL["waterLine"])
text_c(-505, -430, "竹园", "Бамбуковый парк", cn_mid, ru, 0, COL["poi"])
text_c(520, -430, "东苑", "Восточный сад", cn_mid, ru, 0, COL["poi"])
for d in data["alleys"]:
    if d["kind"] not in ("сквозной", "параллельный") or abs(d["pts"][0][0]-d["pts"][-1][0]) < 2:
        continue
    a, b = d["pts"][0], d["pts"][-1]
    px, py = P((a[0]+b[0])/2, (a[1]+b[1])/2)
    dr.text((px, py), d["name"], font=cn_tiny, fill=COL["muted"], anchor="mm")
for p in data["pois"]:
    if p["kind"] in ("tree", "shop", "gate"):
        continue
    px, py = map(int, P(p["x"], p["z"]))
    dr.ellipse((px - 4, py - 4, px + 4, py + 4), fill=COL["poi"])
for a in data["anchors"]:
    px, py = map(int, P(a["x"], a["z"]))
    dr.ellipse((px - 14, py - 14, px + 14, py + 14), fill="#101614", outline=COL["anchor"], width=2)
    dr.text((px, py), a["num"], font=ru_small, fill=COL["anchor"], anchor="mm")
dr.rounded_rectangle((26, 20, 716, 106), radius=12, fill="#101a15", outline="#2a3a2f")
dr.text((46, 48), "京华里 · Большая улица и проулки", font=cn_big, fill=COL["gold"])
dr.text((46, 84), f'Карта квартала «Новый Китай» · 1,8 × 1,24 км · {len(data["alleys"])} проулков · не добавлена в игру', font=ru, fill=COL["muted"])
lx, ly = W - 320, 24
dr.rounded_rectangle((lx, ly, lx + 292, ly + 196), radius=12, fill="#101a15", outline="#2a3a2f")
for i, (t, c) in enumerate(items):
    yy = ly + 20 + i * 19
    dr.rectangle((lx + 16, yy - 10, lx + 36, yy + 1), fill=c, outline=COL["edge"])
    dr.text((lx + 44, yy - 10), t, font=ru_small, fill=COL["text"])
bx, by, length = 60, H - 58, int(500 * S)
dr.rectangle((bx, by, bx + length, by + 9), fill=COL["gold"])
dr.rectangle((bx + length // 2, by, bx + length, by + 9), fill=COL["bg"])
dr.text((bx, by - 18), "0", font=ru, fill=COL["text"])
dr.text((bx + length // 2, by - 18), "250", font=ru, fill=COL["text"], anchor="mm")
dr.text((bx + length, by - 18), "500 м", font=ru, fill=COL["text"], anchor="rm")
dr.text((W - 60, H - 40), "С ↑ · x → восток, z ↓ юг", font=ru, fill=COL["muted"], anchor="rm")
im.save(OUT / "china-map.png", optimize=True)

# ---------------------------------------------------------------- standalone HTML
tpl = (ROOT / "tools" / "china-map-template.html").read_text(encoding="utf-8")
html = (tpl.replace("__MAP_FONT__", woff2_b64)
        .replace("__MAP_DATA__", json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")))
(ROOT / "China_Map.html").write_text(html, encoding="utf-8")

print("map:", json.dumps(data["stats"], ensure_ascii=False))
print("svg", (OUT / "china-map.svg").stat().st_size, "png", (OUT / "china-map.png").stat().st_size,
      "html", (ROOT / "China_Map.html").stat().st_size)

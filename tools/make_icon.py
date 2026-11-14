#!/usr/bin/env python3
"""Иконки PWA — рисуются процедурно, теми же мотивами, что и сцена.

    python3 tools/make_icon.py            # → web/icons/*.png

Никаких сторонних картинок: фон — ночная улица (тёмные корпуса, мокрый асфальт),
главный объект — световой короб с иероглифами из подмножества шрифта
(`assets/fonts/NotoSerifSC-Regular.ttf`, тот же файл, что и в билете). Версия
`icon-maskable-512.png` держит всё важное внутри безопасных 80 %: Android
обрезает maskable-иконку кругом или ромбом, и «书» по краю пропал бы.
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "icons")
FONT = os.path.join(ROOT, "assets", "fonts", "NotoSerifSC-Regular.ttf")
TEXT = "书店"


def _font(px):
    try:
        return ImageFont.truetype(FONT, px)
    except OSError:                     # шрифт не на месте — иконка всё равно соберётся
        return ImageFont.load_default()


def draw_scene(S):
    """Ночная улица с горящим коробом; возвращает RGB размером S×S."""
    img = Image.new("RGB", (S, S), (11, 13, 16))
    d = ImageDraw.Draw(img, "RGBA")
    k = S / 512.0                       # вся геометрия задана от эталонных 512

    # Небо — пыльный сумрак, светлее к горизонту.
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=(int(10 + 34 * t), int(12 + 30 * t), int(18 + 26 * t), 255))

    # Корпусы по краям и тёплые окна в сетке (окна выбирает детерминированный
    # признак, как facade.frag: не «случай на запуске», а узор дома).
    gy = int(0.86 * S)
    for x0, w, h in ((0.00, 0.30, 0.70), (0.70, 0.30, 0.62)):
        bx0, bx1 = int(x0 * S), int((x0 + w) * S)
        by0 = int((1.0 - h) * S)
        d.rectangle([bx0, by0, bx1, gy], fill=(16, 17, 21, 255))
        step = int(26 * k)
        for yy in range(by0 + step, gy - step, step):
            for xx in range(bx0 + step, bx1 - step, step):
                if ((xx * 7 + yy * 13) // max(step, 1)) % 5 < 2:
                    d.rectangle([xx, yy, xx + int(9 * k), yy + int(12 * k)], fill=(236, 214, 158, 210))

    # Асфальт после дождя: тёмная плоскость и размытая полоса отражения короба.
    d.rectangle([0, gy, S, S], fill=(13, 14, 17, 255))

    box = [int(0.19 * S), int(0.30 * S), int(0.81 * S), int(0.62 * S)]
    halo = Image.new("RGB", (S, S), (0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.rectangle(box, fill=(120, 92, 40))
    hd.rectangle([box[0] + 6 * k, gy, box[2] - 6 * k, S], fill=(26, 22, 15))
    halo = halo.filter(ImageFilter.GaussianBlur(22 * k))
    img = ImageChops.screen(img, halo)          # свет ложится аддитивно, как в шейдере
    d = ImageDraw.Draw(img, "RGBA")

    # Сам короб: жёлтая рамка, тёмно-зелёная плашка, иероглифы по центру.
    d.rounded_rectangle(box, radius=int(10 * k), fill=(247, 203, 66, 255))
    inner = [b + int(7 * k) for b in box[:2]] + [b - int(7 * k) for b in box[2:]]
    d.rounded_rectangle(inner, radius=int(6 * k), fill=(14, 40, 30, 255))
    fs = int((inner[3] - inner[1]) * 0.60)
    f = _font(fs)
    tw = d.textlength(TEXT, font=f)
    d.text((int((S - tw) / 2), int(inner[1] + (inner[3] - inner[1] - fs * 1.06) / 2)),
           TEXT, font=f, fill=(246, 236, 190, 255))

    # Фонарь у тротуара — чтобы читалась улица, а не «рамка на синем».
    px = int(0.11 * S)
    d.line([(px, gy), (px, int(0.56 * S))], fill=(26, 27, 31, 255), width=max(2, int(5 * k)))
    d.ellipse([px - int(13 * k), int(0.53 * S), px + int(13 * k), int(0.53 * S) + 26 * k],
              fill=(255, 216, 150, 230))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, maskable in (("icon-192.png", 192, False),
                                 ("icon-512.png", 512, False),
                                 ("icon-maskable-512.png", 512, True)):
        img = draw_scene(size)
        if maskable:                    # безопасная зона 80 %: сцена в центре, поля — фон
            s = int(size * 0.8)
            pad = (size - s) // 2
            canvas = Image.new("RGB", (size, size), (14, 17, 22))
            canvas.paste(img.resize((s, s), Image.LANCZOS), (pad, pad))
            img = canvas
        path = os.path.join(OUT, name)
        img.save(path)
        print(f"  → {os.path.relpath(path, ROOT)}  {size}x{size}")


if __name__ == "__main__":
    main()

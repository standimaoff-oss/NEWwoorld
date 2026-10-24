#!/usr/bin/env python3
"""Генератор ассетов Aquaflux (чистый Python: zlib + struct, без Pillow).

Запуск:  python3 tools/gen_assets.py
Результат: PNG в src/main/resources/assets/aquaflux/textures/**.

Текстуры детерминированные: синусы с целыми частотами дают бесшовный тайл.
"""

import math
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(__file__), "..", "src", "main", "resources", "assets", "aquaflux", "textures")


def write_png(path, width, height, pixels):
    """pixels: список строк, каждая строка - список (r, g, b, a)."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            r, g, b, a = pixels[y][x]
            raw += bytes((r & 255, g & 255, b & 255, a & 255))

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    print("wrote", os.path.relpath(path, os.path.join(os.path.dirname(__file__), "..")), f"{width}x{height}")


def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, int(round(v))))


def transparent_water(path, size=16):
    write_png(path, size, size, [[(0, 0, 0, 0)] * size for _ in range(size)])


def water_surface(path, size=64):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            u = 2.0 * math.pi * x / size
            v = 2.0 * math.pi * y / size
            n = (0.50
                 + 0.22 * math.sin(3 * u + 2 * v)
                 + 0.14 * math.sin(7 * u - 5 * v)
                 + 0.08 * math.sin(11 * u + 9 * v)
                 + 0.06 * math.cos(17 * u - 13 * v))
            n = max(0.0, min(1.0, n))
            r = 30 + 90 * n
            g = 105 + 120 * n
            b = 140 + 105 * n
            a = 205 + 40 * n
            row.append((clamp(r), clamp(g), clamp(b), clamp(a)))
        rows.append(row)
    write_png(path, size, size, rows)


def bucket_item(path):
    size = 16
    rows = [[(0, 0, 0, 0)] * size for _ in range(size)]
    steel = (188, 196, 204, 255)
    dark = (120, 128, 138, 255)
    water = (48, 130, 190, 255)
    water_hi = (110, 190, 235, 255)

    # ручка
    for x in range(4, 12):
        rows[1][x] = dark
    # корпус
    for y in range(2, 15):
        for x in range(3, 13):
            rows[y][x] = steel
    # вода внутри
    for y in range(5, 14):
        for x in range(4, 12):
            rows[y][x] = water
    # блик
    for y in range(6, 10):
        rows[y][4] = water_hi
    # обод и дно
    for x in range(3, 13):
        rows[2][x] = dark
        rows[14][x] = dark
    for y in range(2, 15):
        rows[y][3] = dark
        rows[y][12] = dark
    write_png(path, size, size, rows)


def logo(path, size=128):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            cx, cy = size / 2.0, size / 2.0
            dx, dy = (x - cx) / (size * 0.5), (y - cy) / (size * 0.5)
            d = math.sqrt(dx * dx + dy * dy)
            base = max(0.0, 1.0 - d)
            # капля
            drop_d = math.sqrt((dx * 0.9) ** 2 + (dy + 0.12) ** 2)
            drop = max(0.0, 1.0 - drop_d / 0.62)
            r = 8 + 60 * base + 30 * drop
            g = 30 + 120 * base + 90 * drop
            b = 60 + 160 * base + 120 * drop
            a = clamp(255 * min(1.0, base * 1.4 + drop * 0.5))
            row.append((clamp(r), clamp(g), clamp(b), a))
        rows.append(row)
    write_png(path, size, size, rows)


def main():
    transparent_water(os.path.join(ROOT, "block", "water_still.png"))
    transparent_water(os.path.join(ROOT, "block", "water_flow.png"))
    water_surface(os.path.join(ROOT, "block", "water_surface.png"))
    bucket_item(os.path.join(ROOT, "item", "physical_water_bucket.png"))
    logo(os.path.join(ROOT, "..", "..", "..", "aquaflux_logo.png"))


if __name__ == "__main__":
    main()

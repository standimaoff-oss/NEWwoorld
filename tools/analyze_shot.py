"""Разбор кадра из игры: где в мире находятся чёрные пиксели.

Нужен, чтобы отличить «дырку в меше воды» от «неосвещённой стенки» и от
«чёрной геометрии, нарисованной поверх». Считаем по позе камеры из лога
харнесса (teleport печатает позицию, yaw и pitch).
"""
import math
import struct
import sys
import zlib


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos = 8
    w = h = bitdepth = colortype = None
    idat = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if ctype == b"IHDR":
            w, h, bitdepth, colortype = struct.unpack(">IIBB", chunk[:10])
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
    raw = zlib.decompress(idat)
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    bpp = channels * bitdepth // 8
    stride = w * bpp
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, channels, bytes(out)


def camera(pos, yaw, pitch, eye_offset=1.62):
    yaw = math.radians(yaw)
    pitch = math.radians(pitch)
    ex, ey, ez = pos[0], pos[1] + eye_offset, pos[2]
    fwd = (-math.sin(yaw) * math.cos(pitch), -math.sin(pitch), math.cos(yaw) * math.cos(pitch))
    right = (-math.cos(yaw), 0.0, -math.sin(yaw))
    up = (right[1] * fwd[2] - right[2] * fwd[1],
          right[2] * fwd[0] - right[0] * fwd[2],
          right[0] * fwd[1] - right[1] * fwd[0])
    return (ex, ey, ez), fwd, right, up


def rays(w, h, pos, yaw, pitch, fov=70.0):
    eye, fwd, right, up = camera(pos, yaw, pitch)
    f = (h / 2.0) / math.tan(math.radians(fov) / 2.0)
    cx, cy = w / 2.0, h / 2.0
    dirs = []
    for py in range(h):
        row = []
        for px in range(w):
            a = (px - cx) / f
            b = (cy - py) / f
            d = (fwd[0] + right[0] * a + up[0] * b,
                 fwd[1] + right[1] * a + up[1] * b,
                 fwd[2] + right[2] * a + up[2] * b)
            n = math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
            row.append((d[0] / n, d[1] / n, d[2] / n))
        dirs.append(row)
    return eye, dirs


def plane_hit(eye, d, axis, value):
    denom = d[axis]
    if abs(denom) < 1e-6:
        return None
    t = (value - eye[axis]) / denom
    if t <= 0.05:
        return None
    return t


def classify(eye, d, box, water):
    """Куда луч попадает внутри коробки-ямы: в стенку, в дно, в воду."""
    x0, x1, z0, z1, yfloor, ytop = box
    best = None
    for axis, value, name in ((0, x0, "стенка x0"), (0, x1, "стенка x1"),
                              (2, z0, "стенка z0"), (2, z1, "стенка z1"),
                              (1, yfloor, "дно")):
        t = plane_hit(eye, d, axis, value)
        if t is None:
            continue
        if best is not None and t >= best[0]:
            continue
        hx = eye[0] + d[0] * t
        hy = eye[1] + d[1] * t
        hz = eye[2] + d[2] * t
        if not (x0 - 0.01 <= hx <= x1 + 0.01 and z0 - 0.01 <= hz <= z1 + 0.01
                and yfloor - 0.01 <= hy <= ytop + 0.01):
            continue
        if axis == 1:
            key = f"дно y={yfloor} x={hx:.0f} z={hz:.0f}"
        else:
            key = f"{name} y={hy:.2f} {'над водой' if hy > water else 'под водой'}"
        best = (t, key)
    return best[1] if best else "мимо"


def main():
    path = sys.argv[1]
    px, py, pz = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    yaw, pitch = float(sys.argv[5]), float(sys.argv[6])
    box = tuple(float(v) for v in sys.argv[7].split(","))
    water = float(sys.argv[8])
    w, h, ch, pixels = read_png(path)
    eye, dirs = rays(w, h, (px, py, pz), yaw, pitch)
    print(f"кадр {path} {w}x{h}, глаз ({eye[0]:.2f},{eye[1]:.2f},{eye[2]:.2f}), вода y={water}")
    total = 0
    hits = {}
    for y in range(h):
        base = y * w * ch
        for x in range(w):
            i = base + x * ch
            r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
            if r > 8 or g > 8 or b > 8:
                continue
            total += 1
            key = classify(eye, dirs[y][x], box, water)
            hits[key] = hits.get(key, 0) + 1
    print(f"чёрных пикселей: {total} ({100.0*total/(w*h):.1f}%)")
    for key, n in sorted(hits.items(), key=lambda kv: -kv[1])[:12]:
        print(f"  {n:7d}  {key}")


if __name__ == "__main__":
    main()

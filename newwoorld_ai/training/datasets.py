"""Rich Bilingual & Multi-Domain Synthetic Dataset Generators for Training."""

from __future__ import annotations
import math
from typing import Any, Dict, List, Tuple
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from ..geometry.cad_compiler import ARCHETYPE_PROGRAM_TOKENS, ARCHETYPES
from ..models.cad_gpt import CAD_MATERIAL_NAMES, OP2ID, encode_cad_params
from ..models.photo_part_net import PHOTO_SCENES
from ..models.vision_ocr import OCR_ALPHABET, SCENE_CATEGORIES


FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
]


CAD_TEMPLATES: Dict[str, List[str]] = {
    "involute_gear": [
        "шестерня эвольвентная {teeth} зубьев {holes} отверстий {size}мм",
        "прямозубое колесо стальное {teeth} зубьев с фаской {chamfer}",
        "косозубая шестерня титановая {teeth} зубьев",
        "spur involute gear {teeth} teeth {holes} holes {size}mm steel",
        "helical precision gear {teeth} teeth chamfer {chamfer}mm",
        "зубчатое колесо со ступицей и отверстиями {teeth} зуб",
    ],
    "planetary_gearbox": [
        "планетарный редуктор {teeth} зубьев {holes} сателлита корпус",
        "планетарная передача солнечная шестерня и сателлиты",
        "planetary gearbox sun {teeth} teeth {holes} planets housing",
        "epicyclic planetary gear assembly with carrier plate",
        "редуктор планетарный промышленный титановый",
    ],
    "turbine_impeller": [
        "турбина импеллер {blades} лопаток аэродинамическая",
        "рабочее колесо турбины {blades} лопаток {size}мм",
        "radial aerospace turbine impeller {blades} NACA blades",
        "jet compressor rotor {blades} twisted blades titanium",
        "крыльчатка центробежного насоса {blades} лопастей",
    ],
    "cnc_bracket": [
        "кронштейн фрезерованный силовой с ребрами жесткости {size}мм",
        "алюминиевый кронштейн крепления с проушинами и болтами",
        "aerospace CNC clevis mounting bracket {size}mm gusset ribs",
        "heavy duty L-bracket with bolt collars and pivot pin",
        "силовая опора ЧПУ деталь с фасками {chamfer}",
    ],
    "flanged_valve": [
        "фланцевый клапан отвод 90 градусов {holes} болтов",
        "промышленный трубопроводный вентиль с маховиком",
        "industrial flanged elbow valve {holes} bolts pipe bend",
        "bolted flange 90 deg manifold with handwheel",
        "задвижка трубная фланцевая стальная {holes} отверстий",
    ],
    "robotic_actuator": [
        "роботизированный манипулятор сустав привод 6-DOF",
        "гармонический привод рука робота с фланцем",
        "robotic actuator arm harmonic drive joint {size}mm",
        "6-DOF articulated robot arm link with ISO flange",
        "рука промышленного робота сервопривод шарнир",
    ],
    "heatsink_enclosure": [
        "корпус радиатор ЧПУ {fins} ребер охлаждения {size}мм",
        "алюминиевый корпус электроники с ребрами радиатора",
        "CNC finned heatsink enclosure {fins} cooling fins",
        "machined electronics housing with anodized faceplate",
        "радиатор охлаждения фрезерованный {fins} ребер",
    ],
    "geodesic_pavilion": [
        "геодезический купол павильон {fins} ребер стеклянный",
        "архитектурный купол параметрическая ферма подиум",
        "geodesic diagrid dome pavilion {fins} structural ribs",
        "modern architectural glass dome truss structure",
        "параметрический павильон купол с кольцами",
    ],
    "aerospace_fuselage": [
        "аэрокосмический фюзеляж крыло и реактивное сопло {size}мм",
        "ракета планер со стреловидным крылом и стабилизатором",
        "aerospace swept-wing fuselage with bell thruster nozzle",
        "supersonic drone airframe lofted wings and tail fin",
        "космический аппарат корпус крылья сопло",
    ],
    "precision_fastener_vessel": [
        "резьбовой болт с шестигранной головкой и гайкой {size}мм",
        "витая архитектурная ваза колонна с ребрами {fins} спиралей",
        "precision hex bolt washer and locking nut thread",
        "parametric fluted architectural vessel {fins} helical ribs",
        "винт М12 с шайбой и гайкой или витая ваза",
    ],
}

MATERIAL_HINTS = {
    "сталь": 0, "steel": 0,
    "титан": 1, "titanium": 1,
    "син": 2, "blue": 2,
    "золот": 3, "gold": 3,
    "мед": 4, "copper": 4,
    "карбон": 5, "carbon": 5,
    "керам": 6, "бел": 6, "ceramic": 6, "white": 6,
    "стекл": 7, "glass": 7,
    "оранж": 8, "orange": 8,
}


def generate_cad_dataset(n_samples: int = 1200, seed: int = 42) -> Dict[str, Any]:
    rng = np.random.default_rng(seed)
    prompts: List[str] = []
    arch_y = np.zeros((n_samples,), dtype=np.int64)
    param_y = np.zeros((n_samples, 6), dtype=np.float32)
    mat_y = np.zeros((n_samples,), dtype=np.int64)
    op_y = np.zeros((n_samples, 7), dtype=np.int64)

    for i in range(n_samples):
        a_idx = i % len(ARCHETYPES)
        arch = ARCHETYPES[a_idx]
        tmpl = rng.choice(CAD_TEMPLATES[arch])
        teeth = int(rng.integers(10, 48))
        blades = int(rng.integers(6, 20))
        holes = int(rng.integers(4, 10))
        fins = int(rng.integers(6, 18))
        size_mm = float(rng.uniform(45.0, 140.0))
        chamfer = float(rng.uniform(0.4, 2.4))

        prompt = tmpl.format(teeth=teeth, blades=blades, holes=holes, fins=fins, size=int(size_mm), chamfer=round(chamfer, 1))
        # Optionally append material word
        if rng.random() < 0.45:
            m_word, m_id = rng.choice(list(MATERIAL_HINTS.items()))
            m_id = int(m_id)
            prompt = f"{prompt} {m_word}"
        else:
            m_id = a_idx % len(CAD_MATERIAL_NAMES)

        prompts.append(prompt)
        arch_y[i] = a_idx
        param_y[i] = encode_cad_params(
            {"teeth": teeth, "blades": blades, "holes": holes, "fins": fins, "size_mm": size_mm, "chamfer": chamfer}
        )
        mat_y[i] = m_id
        toks = ARCHETYPE_PROGRAM_TOKENS[arch]
        seq = [OP2ID.get(t, 0) for t in toks[:7]]
        while len(seq) < 7:
            seq.append(OP2ID["<PART_END>"])
        op_y[i] = seq

    return {"prompts": prompts, "arch_y": arch_y, "param_y": param_y, "mat_y": mat_y, "op_y": op_y}


PHOTO_KEYWORDS: Dict[str, Tuple[List[str], List[str]]] = {
    "alpine_sunset": (
        ["горы", "закат", "рассвет", "альпы", "озеро", "снежные вершины", "солнце", "природа", "реалистичный пейзаж", "небо"],
        ["mountain", "sunset", "sunrise", "alpine", "lake", "snow peaks", "sun", "nature", "landscape", "clouds"],
    ),
    "cyberpunk_city": (
        ["город", "неон", "киберпанк", "ночью", "небоскребы", "дождь", "улица", "мегаполис", "огни", "отражения"],
        ["city", "neon", "cyberpunk", "night", "skyscrapers", "rain", "street", "metropolis", "glow", "reflections"],
    ),
    "studio_sportscar": (
        ["спорткар", "машина", "авто", "суперкар", "студийное фото", "хром", "блики", "темный пол", "автомобиль", "студия"],
        ["sportscar", "car", "supercar", "studio photo", "chrome", "rim light", "aerodynamic", "vehicle", "glossy", "dark floor"],
    ),
    "ocean_horizon": (
        ["океан", "море", "волны", "вода", "бирюзовая вода", "берег", "горизонт", "прибой", "солнце над морем", "пена"],
        ["ocean", "sea", "waves", "water", "turquoise", "coast", "horizon", "surf", "sunlight", "foam"],
    ),
    "forest_mist": (
        ["лес", "туман", "сосны", "хвойный лес", "утро", "лучи света", "деревья", "тайга", "рассвет", "дымка"],
        ["forest", "mist", "pine", "trees", "morning", "fog", "sunbeams", "woods", "nordic", "atmosphere"],
    ),
    "cosmic_nebula": (
        ["космос", "туманность", "планета", "звезды", "галактика", "кольцо планеты", "вселенная", "орбита", "сияние"],
        ["space", "nebula", "planet", "stars", "galaxy", "ringed planet", "cosmos", "deep space", "universe"],
    ),
    "modern_architecture": (
        ["архитектура", "стекло", "здание", "павильон", "небоскреб", "современный дом", "бетон", "фасад", "башня"],
        ["architecture", "glass", "building", "modern", "facade", "skyscraper", "tower", "concrete", "steel"],
    ),
    "macro_crystal_mech": (
        ["механизм", "шестерня", "часы", "макро", "металл", "сталь", "деталь", "кристалл", "крупный план", "блик"],
        ["mechanism", "gear", "watchwork", "macro", "metal", "steel", "precision", "crystal", "closeup", "bokeh"],
    ),
}

SCENE_PALETTES = {
    "alpine_sunset": [0.16, 0.24, 0.48, 0.96, 0.52, 0.24, 0.14, 0.17, 0.24],
    "cyberpunk_city": [0.06, 0.05, 0.18, 0.94, 0.18, 0.68, 0.05, 0.14, 0.26],
    "studio_sportscar": [0.07, 0.09, 0.14, 0.85, 0.34, 0.18, 0.08, 0.10, 0.13],
    "ocean_horizon": [0.22, 0.56, 0.88, 0.96, 0.82, 0.56, 0.06, 0.34, 0.48],
    "forest_mist": [0.44, 0.58, 0.62, 0.88, 0.82, 0.64, 0.12, 0.24, 0.16],
    "cosmic_nebula": [0.04, 0.03, 0.12, 0.72, 0.26, 0.92, 0.12, 0.42, 0.78],
    "modern_architecture": [0.18, 0.38, 0.68, 0.92, 0.64, 0.36, 0.18, 0.24, 0.32],
    "macro_crystal_mech": [0.10, 0.12, 0.16, 0.72, 0.78, 0.88, 0.16, 0.18, 0.22],
}


def _render_synthetic_parts_64(scene_idx: int, pal: np.ndarray, rng: np.random.Generator) -> Tuple[np.ndarray, np.ndarray]:
    """Render 4 part RGBA maps (4, 4, 64, 64) + composed RGB (3, 64, 64) for training PhotoPartNet."""
    h = w = 64
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) / float(h - 1)
    parts = np.zeros((4, 4, h, w), dtype=np.float32)
    c_sky, c_acc, c_gnd = pal[0:3], pal[3:6], pal[6:9]

    # Part 0: Sky + glowing sun/nebula
    sx = float(rng.uniform(0.25, 0.75))
    sy = float(rng.uniform(0.18, 0.40))
    grad = (1.0 - yy)[:, :, None] * c_sky + yy[:, :, None] * c_acc
    glow = np.exp(-np.hypot(xx - sx, yy - sy) * 5.0)[:, :, None]
    p0_rgb = np.clip(grad * 0.78 + c_acc[None, None, :] * glow * 0.65, 0.0, 1.0)
    parts[0, :3] = p0_rgb.transpose(2, 0, 1)
    parts[0, 3] = 1.0

    # Part 1: Far backdrop silhouette
    s_name = PHOTO_SCENES[scene_idx]
    if s_name in ("cyberpunk_city", "modern_architecture"):
        cols = rng.uniform(0.30, 0.60, size=16)
        ridge = cols[np.clip((xx * 16).astype(np.int32), 0, 15)]
        m1 = (yy > ridge).astype(np.float32)
    elif s_name == "cosmic_nebula":
        m1 = np.clip(1.0 - (np.hypot(xx - 0.55, yy - 0.44) - 0.22) * 24.0, 0.0, 1.0)
    else:
        phase = float(rng.uniform(0, 6.28))
        ridge = 0.46 + 0.11 * np.sin(xx * 6.0 + phase)
        m1 = np.clip((yy - ridge) * 20.0, 0.0, 1.0)
    parts[1, :3] = (c_gnd * 0.8)[None, None, :].transpose(2, 0, 1)
    parts[1, 3] = m1

    # Part 2: Midground hero object
    if s_name == "studio_sportscar":
        m2 = np.clip(1.0 - np.abs(xx - 0.5) / 0.34, 0.0, 1.0) * (yy > 0.48) * (yy < 0.72)
        c2 = c_acc
    elif s_name == "macro_crystal_mech":
        rad = np.hypot(xx - 0.5, yy - 0.5)
        m2 = ((rad < 0.26) & (rad > 0.08)).astype(np.float32)
        c2 = c_acc
    else:
        ridge2 = 0.58 + 0.08 * np.cos(xx * 8.0)
        m2 = np.clip((yy - ridge2) * 20.0, 0.0, 1.0) * (yy < 0.84)
        c2 = (c_gnd + c_acc * 0.25) * 0.7
    parts[2, :3] = np.broadcast_to(c2[:, None, None], (3, h, w))
    parts[2, 3] = m2

    # Part 3: Foreground ground / water reflections
    m3 = np.clip((yy - 0.70) * 18.0, 0.0, 1.0)
    glint = np.exp(-((xx - sx) ** 2) * 12.0) * m3
    p3_rgb = c_gnd[None, None, :] * 0.6 + c_acc[None, None, :] * glint[:, :, None] * 0.7
    parts[3, :3] = np.clip(p3_rgb, 0.0, 1.0).transpose(2, 0, 1)
    parts[3, 3] = m3

    # Compose final RGB
    comp = parts[0, :3].copy()
    for p in range(1, 4):
        a = parts[p, 3:4]
        comp = comp * (1.0 - a) + parts[p, :3] * a
    return parts, np.clip(comp, 0.0, 1.0)


def generate_photo_dataset(n_samples: int = 480, seed: int = 101) -> Dict[str, Any]:
    rng = np.random.default_rng(seed)
    prompts: List[str] = []
    scene_y = np.zeros((n_samples,), dtype=np.int64)
    pal_y = np.zeros((n_samples, 9), dtype=np.float32)
    parts_y = np.zeros((n_samples, 4, 4, 64, 64), dtype=np.float32)
    comp_y = np.zeros((n_samples, 3, 64, 64), dtype=np.float32)

    for i in range(n_samples):
        s_idx = i % len(PHOTO_SCENES)
        s_name = PHOTO_SCENES[s_idx]
        ru_kw, en_kw = PHOTO_KEYWORDS[s_name]
        pool = ru_kw if rng.random() < 0.55 else en_kw
        k = int(rng.integers(3, 6))
        chosen = rng.choice(pool, size=min(k, len(pool)), replace=False).tolist()
        if rng.random() < 0.3:
            chosen.append("реалистичное фото" if pool is ru_kw else "photorealistic")
        prompts.append(" ".join(chosen))
        base_pal = np.asarray(SCENE_PALETTES[s_name], dtype=np.float32)
        pal = np.clip(base_pal + rng.normal(0.0, 0.05, size=9).astype(np.float32), 0.02, 0.98)
        parts, comp = _render_synthetic_parts_64(s_idx, pal, rng)
        scene_y[i] = s_idx
        pal_y[i] = pal
        parts_y[i] = parts
        comp_y[i] = comp

    return {"prompts": prompts, "scene_y": scene_y, "pal_y": pal_y, "parts_y": parts_y, "comp_y": comp_y}


def generate_ocr_glyph_dataset(samples_per_class: int = 32, seed: int = 77) -> Tuple[np.ndarray, np.ndarray]:
    """Render real bilingual TrueType fonts (DejaVu family) into augmented 20x20 glyph crops."""
    rng = np.random.default_rng(seed)
    loaded_fonts = [ImageFont.truetype(fp, size=s) for fp in FONTS for s in (18, 22)]

    xs: List[np.ndarray] = []
    ys: List[int] = []
    for cls_idx, ch in enumerate(OCR_ALPHABET):
        for s_i in range(samples_per_class):
            font = loaded_fonts[s_i % len(loaded_fonts)]
            canvas = Image.new("L", (36, 36), 0)
            draw = ImageDraw.Draw(canvas)
            bbox = draw.textbbox((0, 0), ch, font=font)
            tw = max(bbox[2] - bbox[0], 1)
            th = max(bbox[3] - bbox[1], 1)
            ox = (36 - tw) // 2 - bbox[0]
            oy = (36 - th) // 2 - bbox[1]
            draw.text((ox, oy), ch, fill=255, font=font)

            if rng.random() < 0.65:
                ang = float(rng.uniform(-7.0, 7.0))
                canvas = canvas.rotate(ang, resample=Image.Resampling.BILINEAR)
            if rng.random() < 0.35:
                canvas = canvas.filter(ImageFilter.GaussianBlur(radius=float(rng.uniform(0.2, 0.65))))

            arr = np.asarray(canvas, dtype=np.float32) / 255.0
            # Tight crop around active ink pixels -> normalize to 20x20 just like runtime OCR!
            ys_nz, xs_nz = np.where(arr > 0.20)
            if len(ys_nz) > 0:
                y0, y1 = ys_nz.min(), ys_nz.max() + 1
                x0, x1 = xs_nz.min(), xs_nz.max() + 1
                crop = arr[y0:y1, x0:x1]
            else:
                crop = arr[8:28, 8:28]

            # Normalize into 20x20
            ph, pw = crop.shape
            scale = 16.0 / float(max(ph, pw, 1))
            nh = max(1, int(round(ph * scale)))
            nw = max(1, int(round(pw * scale)))
            pil_c = Image.fromarray((crop * 255).astype(np.uint8), mode="L").resize(
                (nw, nh), resample=Image.Resampling.BILINEAR
            )
            out = np.zeros((20, 20), dtype=np.float32)
            cy0 = (20 - nh) // 2 + int(rng.integers(-1, 2))
            cx0 = (20 - nw) // 2 + int(rng.integers(-1, 2))
            cy0 = max(0, min(20 - nh, cy0))
            cx0 = max(0, min(20 - nw, cx0))
            out[cy0 : cy0 + nh, cx0 : cx0 + nw] = np.asarray(pil_c, dtype=np.float32) / 255.0
            out = np.clip(out + rng.normal(0.0, 0.03, size=(20, 20)).astype(np.float32), 0.0, 1.0)
            xs.append(out[None, :, :])
            ys.append(cls_idx)

    X = np.stack(xs, axis=0)
    Y = np.asarray(ys, dtype=np.int64)
    perm = rng.permutation(len(Y))
    return X[perm], Y[perm]


# Mapping from 12 visual scene categories -> (suggested CAD archetype idx, [metallic, organic, arch, text_heavy])
SCENE_TO_CAD_AND_ATTR = {
    0: (0, [0.95, 0.05, 0.10, 0.05]),  # gear_mechanism -> involute_gear
    1: (2, [0.92, 0.10, 0.15, 0.05]),  # turbine_rotor -> turbine_impeller
    2: (3, [0.88, 0.05, 0.25, 0.05]),  # cnc_bracket_chassis -> cnc_bracket
    3: (4, [0.85, 0.05, 0.20, 0.05]),  # industrial_valve_pipe -> flanged_valve
    4: (5, [0.75, 0.05, 0.25, 0.10]),  # robotics_electronics -> robotic_actuator
    5: (7, [0.35, 0.10, 0.95, 0.05]),  # architecture_dome -> geodesic_pavilion
    6: (8, [0.80, 0.10, 0.40, 0.05]),  # aerospace_vehicle -> aerospace_fuselage
    7: (9, [0.05, 0.95, 0.10, 0.02]),  # landscape_nature -> vessel
    8: (7, [0.45, 0.10, 0.90, 0.10]),  # urban_cityscape -> pavilion
    9: (9, [0.10, 0.70, 0.20, 0.05]),  # cosmic_space -> vessel
    10: (3, [0.15, 0.05, 0.85, 0.65]), # technical_blueprint -> bracket/relief
    11: (6, [0.05, 0.05, 0.15, 0.98]), # text_document -> enclosure
}


def generate_vision_scene_dataset(n_samples: int = 720, seed: int = 88) -> Dict[str, Any]:
    """Generate synthetic 48x48 RGB images across all 12 visual categories for VisionSceneNet."""
    rng = np.random.default_rng(seed)
    X = np.zeros((n_samples, 3, 48, 48), dtype=np.float32)
    sc_y = np.zeros((n_samples,), dtype=np.int64)
    cad_y = np.zeros((n_samples,), dtype=np.int64)
    attr_y = np.zeros((n_samples, 4), dtype=np.float32)
    font = ImageFont.truetype(FONTS[1], 10)

    for i in range(n_samples):
        cat = i % len(SCENE_CATEGORIES)
        img = Image.new("RGB", (48, 48), (18, 22, 30))
        d = ImageDraw.Draw(img)

        if cat == 0:  # gear_mechanism
            cx, cy = 24 + int(rng.integers(-3, 4)), 24 + int(rng.integers(-3, 4))
            for k in range(12):
                a = 2 * math.pi * k / 12
                x1, y1 = cx + 17 * math.cos(a), cy + 17 * math.sin(a)
                d.line([(cx, cy), (x1, y1)], fill=(190, 200, 215), width=4)
            d.ellipse([cx - 13, cy - 13, cx + 13, cy + 13], fill=(160, 175, 195))
            d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=(22, 26, 34))
        elif cat == 1:  # turbine_rotor
            for k in range(9):
                a = 2 * math.pi * k / 9
                d.polygon([(24, 24), (24 + 19 * math.cos(a), 24 + 19 * math.sin(a)), (24 + 16 * math.cos(a + 0.35), 24 + 16 * math.sin(a + 0.35))], fill=(180, 195, 220))
            d.ellipse([18, 18, 30, 30], fill=(220, 180, 70))
        elif cat == 2:  # cnc_bracket
            d.rectangle([8, 30, 40, 40], fill=(175, 185, 200))
            d.rectangle([8, 10, 18, 34], fill=(175, 185, 200))
            d.polygon([(18, 16), (34, 30), (18, 30)], fill=(120, 145, 180))
        elif cat == 3:  # industrial_valve
            d.line([(12, 38), (12, 18), (36, 18)], fill=(130, 160, 205), width=9)
            d.ellipse([20, 4, 36, 16], outline=(235, 100, 40), width=3)
        elif cat == 4:  # robotics_electronics
            d.rectangle([6, 10, 42, 38], fill=(22, 82, 58))
            for k in range(4):
                d.rectangle([10 + k * 8, 16, 15 + k * 8, 32], fill=(40, 44, 52))
                d.line([(12 + k * 8, 10), (12 + k * 8, 38)], fill=(210, 175, 65), width=1)
        elif cat == 5:  # architecture_dome
            d.arc([6, 8, 42, 44], start=180, end=360, fill=(140, 205, 240), width=3)
            for k in range(5):
                d.line([(24, 9), (8 + k * 8, 34)], fill=(225, 230, 240), width=2)
            d.rectangle([6, 34, 42, 42], fill=(220, 224, 230))
        elif cat == 6:  # aerospace_vehicle
            d.polygon([(24, 5), (30, 36), (24, 42), (18, 36)], fill=(230, 235, 242))
            d.polygon([(20, 20), (6, 34), (20, 32)], fill=(140, 160, 190))
            d.polygon([(28, 20), (42, 34), (28, 32)], fill=(140, 160, 190))
        elif cat == 7:  # landscape_nature
            d.rectangle([0, 0, 48, 26], fill=(95, 165, 235))
            d.ellipse([30, 6, 40, 16], fill=(255, 210, 95))
            d.polygon([(0, 28), (15, 14), (28, 26), (40, 15), (48, 28), (48, 48), (0, 48)], fill=(38, 118, 62))
        elif cat == 8:  # urban_cityscape
            d.rectangle([0, 0, 48, 48], fill=(18, 16, 46))
            for bx in range(4, 44, 8):
                bh = int(rng.integers(14, 34))
                d.rectangle([bx, 48 - bh, bx + 6, 48], fill=(42, 52, 85))
                d.point((bx + 2, 50 - bh), fill=(240, 90, 210))
        elif cat == 9:  # cosmic_space
            d.rectangle([0, 0, 48, 48], fill=(8, 6, 22))
            d.ellipse([14, 14, 34, 34], fill=(145, 75, 220))
            d.arc([6, 20, 42, 29], start=0, end=360, fill=(245, 190, 120), width=2)
        elif cat == 10:  # technical_blueprint
            d.rectangle([0, 0, 48, 48], fill=(18, 66, 138))
            d.rectangle([6, 6, 42, 42], outline=(230, 242, 255), width=1)
            d.ellipse([14, 14, 34, 34], outline=(230, 242, 255), width=2)
            d.line([(8, 24), (40, 24)], fill=(180, 215, 255), width=1)
            d.line([(24, 8), (24, 40)], fill=(180, 215, 255), width=1)
        else:  # text_document
            d.rectangle([0, 0, 48, 48], fill=(242, 244, 246))
            d.text((5, 8), "CAD 3D", fill=(20, 24, 32), font=font)
            d.text((5, 22), "ТЕСТ", fill=(20, 24, 32), font=font)
            d.text((5, 34), "Ø24.5", fill=(20, 24, 32), font=font)

        arr = np.asarray(img, dtype=np.float32) / 255.0
        arr = np.clip(arr + rng.normal(0.0, 0.03, size=arr.shape).astype(np.float32), 0.0, 1.0)
        X[i] = arr.transpose(2, 0, 1)
        sc_y[i] = cat
        cad_idx, attrs = SCENE_TO_CAD_AND_ATTR[cat]
        cad_y[i] = cad_idx
        attr_y[i] = np.asarray(attrs, dtype=np.float32)

    perm = rng.permutation(n_samples)
    return {"X": X[perm], "sc_y": sc_y[perm], "cad_y": cad_y[perm], "attr_y": attr_y[perm]}

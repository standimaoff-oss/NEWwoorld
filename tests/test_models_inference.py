import base64
import io
from PIL import Image, ImageDraw, ImageFont

from newwoorld_ai.models import CadGPTModel, PhotoPartNetModel, VisionOCRSystem
from newwoorld_ai.scale_billion import (
    BILLION_SCALE_CONFIGS,
    compute_cad_transformer_params,
    compute_photopart_dit_params,
)
from newwoorld_ai.training.datasets import FONTS


def test_cadgpt_trained_bilingual_inference():
    cad = CadGPTModel.load_or_create()
    assert cad.trained_epochs >= 10
    cases = [
        ("шестерня эвольвентная 28 зубьев 6 отверстий титан", "involute_gear"),
        ("планетарный редуктор 16 зубьев 4 сателлита", "planetary_gearbox"),
        ("radial aerospace turbine impeller 11 blades", "turbine_impeller"),
        ("кронштейн фрезерованный силовой с ребрами жесткости", "cnc_bracket"),
        ("industrial flanged elbow valve 8 bolts", "flanged_valve"),
        ("геодезический купол павильон 12 ребер", "geodesic_pavilion"),
    ]
    for prompt, expected_arch in cases:
        asm, pred, audit = cad.generate_cad(prompt)
        assert pred["archetype"] == expected_arch, f"Expected {expected_arch}, got {pred}"
        assert audit["all_watertight"] is True
        assert audit["non_manifold_edges"] == 0
        assert audit["boundary_edges"] == 0


def test_photopart_trained_part_by_part_synthesis():
    photo = PhotoPartNetModel.load_or_create()
    assert photo.trained_epochs >= 8
    out = photo.generate_part_by_part("неон киберпанк город ночью дождь", size=256, seed=7)
    assert out["scene_archetype"] == "cyberpunk_city"
    assert len(out["parts"]) == 5
    for idx, part in enumerate(out["parts"], start=1):
        assert part["progress_pct"] == idx * 20
        img = Image.open(io.BytesIO(base64.b64decode(part["composite_png_b64"])))
        assert img.size == (256, 256)
    final_img = Image.open(io.BytesIO(base64.b64decode(out["final_png_b64"])))
    assert final_img.size == (256, 256)


def test_vision_ocr_bilingual_recognition_and_3d():
    vis = VisionOCRSystem.load_or_create()
    assert vis.trained_epochs >= 10

    img = Image.new("RGB", (440, 140), (245, 247, 250))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONTS[1], 28)
    d.text((20, 20), "CAD 3D MODEL", fill=(15, 20, 30), font=font)
    d.text((20, 75), "ШЕСТЕРНЯ 24", fill=(15, 20, 30), font=font)

    ocr = vis.detect_and_read_text(img)
    text_up = ocr["text"].upper()
    assert "CAD" in text_up and "MODEL" in text_up
    assert "ШЕСТЕРНЯ" in text_up and "24" in text_up

    scene = vis.analyze_scene(img)
    assert scene["scene_category"] in ("text_document", "technical_blueprint")

    asm, _, audit = vis.image_to_cad(img, mode="relief")
    assert audit["all_watertight"] is True
    assert audit["non_manifold_edges"] == 0


def test_billion_parameter_configs_exceed_1b():
    for k, cfg in BILLION_SCALE_CONFIGS.items():
        n = compute_cad_transformer_params(cfg) if k.startswith("cad") else compute_photopart_dit_params(cfg)
        assert n > 1_000_000_000

"""NEWwoorld-VisionOCR: Neural Image Understanding, Bilingual Glyph OCR & Blueprint-to-3D."""

from __future__ import annotations
import base64
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from ..config import VISION_OCR_CKPT, VISION_OCR_META
from ..geometry.cad_compiler import ARCHETYPES, compile_cad_program
from ..geometry.cad_primitives import build_blueprint_extrusion
from ..geometry.mesh_ops import CADAssembly, audit_assembly
from ..nn import (
    Conv2d,
    Linear,
    MaxPool2x,
    Module,
    RMSNorm,
    ResBlock2d,
    Tensor,
    TransformerBlock,
    count_parameters,
    load_model_safetensors,
    save_model_safetensors,
)

SCENE_CATEGORIES = [
    "gear_mechanism",
    "turbine_rotor",
    "cnc_bracket_chassis",
    "industrial_valve_pipe",
    "robotics_electronics",
    "architecture_dome",
    "aerospace_vehicle",
    "landscape_nature",
    "urban_cityscape",
    "cosmic_space",
    "technical_blueprint",
    "text_document",
]

# Homoglyph-unified visual alphabet so the CNN achieves high accuracy without Cyrillic/Latin twin ambiguity.
# Word-level script decoder maps shared glyphs cleanly to Cyrillic or Latin!
OCR_DIGITS = list("0123456789")
OCR_LATIN_UPPER = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
OCR_LATIN_LOWER = list("abcdefghijklmnopqrstuvwxyz")
OCR_CYR_UNIQUE_UPPER = list("БГДЁЖЗИЙЛПУФЦЧШЩЪЫЬЭЮЯ")
OCR_CYR_UNIQUE_LOWER = list("бвгдёжзийклмнптфцчшщъыьэюя")
OCR_SYMBOLS = list(".-+±×°Ø:/()%")

OCR_ALPHABET: List[str] = (
    OCR_DIGITS
    + OCR_LATIN_UPPER
    + OCR_LATIN_LOWER
    + OCR_CYR_UNIQUE_UPPER
    + OCR_CYR_UNIQUE_LOWER
    + OCR_SYMBOLS
)
CHAR2ID = {c: i for i, c in enumerate(OCR_ALPHABET)}

# Maps Latin visual homoglyph -> Cyrillic equivalent when word context is Cyrillic
LATIN_TO_CYR_HOMOGLYPH = {
    "A": "А", "B": "В", "E": "Е", "K": "К", "M": "М", "H": "Н",
    "O": "О", "P": "Р", "C": "С", "T": "Т", "X": "Х",
    "a": "а", "e": "е", "o": "о", "p": "р", "c": "с", "x": "х", "y": "у",
}
CYR_UNIQUE_SET = set(OCR_CYR_UNIQUE_UPPER + OCR_CYR_UNIQUE_LOWER)
LAT_UNIQUE_SET = set("DFGIJLNOQSUVWZdfghijlmnqrstuvwz") - set(LATIN_TO_CYR_HOMOGLYPH.keys())


def canonicalize_char_for_training(ch: str) -> Optional[str]:
    if ch in CHAR2ID:
        return ch
    rev = {v: k for k, v in LATIN_TO_CYR_HOMOGLYPH.items()}
    return rev.get(ch)


class VisionSceneNet(Module):
    """CNN + Attention encoder classifying scene categories, CAD archetypes, and surface attributes."""

    def __init__(self, seed: int = 700):
        super().__init__()
        self.c1 = Conv2d(3, 16, 3, 1, 1, seed=seed + 1)
        self.p1 = MaxPool2x()  # 48 -> 24
        self.r1 = ResBlock2d(16, seed=seed + 2)
        self.c2 = Conv2d(16, 32, 3, 1, 1, seed=seed + 3)
        self.p2 = MaxPool2x()  # 24 -> 12
        self.r2 = ResBlock2d(32, seed=seed + 4)
        self.c3 = Conv2d(32, 48, 3, 1, 1, seed=seed + 5)
        self.p3 = MaxPool2x()  # 12 -> 6
        self.pos_emb = Tensor(
            np.random.default_rng(seed + 6).normal(0.0, 0.02, size=(1, 36, 48)).astype(np.float32),
            requires_grad=True,
        )
        self.attn_blk = TransformerBlock(48, n_heads=4, ffn_mult=2.0, causal=False, seed=seed + 7)
        self.norm = RMSNorm(48)
        self.scene_head = Linear(48, len(SCENE_CATEGORIES), seed=seed + 10)
        self.cad_head = Linear(48, len(ARCHETYPES), seed=seed + 11)
        self.attr_head = Linear(48, 4, seed=seed + 12)  # [metallic, organic, architectural, text_heavy]

    def forward(self, img_nchw: Tensor) -> Tuple[Tensor, Tensor, Tensor]:
        b = img_nchw.shape[0]
        h = self.p1(self.c1(img_nchw).silu())
        h = self.r1(h)
        h = self.p2(self.c2(h).silu())
        h = self.r2(h)
        h = self.p3(self.c3(h).silu())  # (B, 48, 6, 6)
        tokens = h.reshape(b, 48, 36).transpose(0, 2, 1) + self.pos_emb
        tokens = self.norm(self.attn_blk(tokens))
        pooled = tokens.mean(axis=1)
        return self.scene_head(pooled), self.cad_head(pooled), self.attr_head(pooled).sigmoid()


class NeuralGlyphOCR(Module):
    """Lightweight Convolutional Neural Glyph Classifier over 20x20 normalized character patches."""

    def __init__(self, num_classes: int = len(OCR_ALPHABET), seed: int = 900):
        super().__init__()
        self.c1 = Conv2d(1, 16, 3, 1, 1, seed=seed + 1)
        self.p1 = MaxPool2x()  # 20 -> 10
        self.c2 = Conv2d(16, 32, 3, 1, 1, seed=seed + 2)
        self.p2 = MaxPool2x()  # 10 -> 5
        self.fc1 = Linear(32 * 5 * 5, 128, seed=seed + 3)
        self.fc2 = Linear(128, num_classes, seed=seed + 4)

    def forward(self, crops_n1hw: Tensor) -> Tensor:
        h = self.p1(self.c1(crops_n1hw).silu())
        h = self.p2(self.c2(h).silu())
        flat = h.reshape(crops_n1hw.shape[0], -1)
        return self.fc2(self.fc1(flat).silu())


def _otsu_threshold(gray: np.ndarray) -> float:
    hist, _ = np.histogram(gray.ravel(), bins=256, range=(0.0, 256.0))
    total = float(gray.size)
    sum_all = float(np.dot(np.arange(256), hist))
    sum_b = 0.0
    w_b = 0.0
    max_var = -1.0
    thresh = 127.0
    for i in range(256):
        w_b += hist[i]
        if w_b == 0:
            continue
        w_f = total - w_b
        if w_f == 0:
            break
        sum_b += float(i * hist[i])
        m_b = sum_b / w_b
        m_f = (sum_all - sum_b) / w_f
        var_between = w_b * w_f * ((m_b - m_f) ** 2)
        if var_between > max_var:
            max_var = var_between
            thresh = float(i)
    return thresh


def _normalize_glyph_crop(patch: np.ndarray, size: int = 20) -> np.ndarray:
    """Center binary/grayscale white-on-black character crop into a padded 20x20 square."""
    ph, pw = patch.shape
    target_inner = size - 4  # 2px margin on each side
    scale = target_inner / float(max(ph, pw, 1))
    nh = max(1, int(round(ph * scale)))
    nw = max(1, int(round(pw * scale)))
    pil = Image.fromarray((np.clip(patch, 0.0, 1.0) * 255.0).astype(np.uint8), mode="L").resize(
        (nw, nh), resample=Image.Resampling.BILINEAR
    )
    arr = np.asarray(pil, dtype=np.float32) / 255.0
    canvas = np.zeros((size, size), dtype=np.float32)
    y0 = (size - nh) // 2
    x0 = (size - nw) // 2
    canvas[y0 : y0 + nh, x0 : x0 + nw] = arr
    return canvas


def _resolve_word_script(chars: List[str]) -> str:
    """Resolve homoglyphs at word level using uniquely Cyrillic vs uniquely Latin clues."""
    n_cyr = sum(1 for c in chars if c in CYR_UNIQUE_SET)
    n_lat = sum(1 for c in chars if c in LAT_UNIQUE_SET)
    if n_cyr > n_lat:
        return "".join(LATIN_TO_CYR_HOMOGLYPH.get(c, c) for c in chars)
    return "".join(chars)


class VisionOCRSystem(Module):
    """Combined Multimodal Image Analyzer + Bilingual Neural OCR + Blueprint-to-3D System."""

    def __init__(self, seed: int = 700):
        super().__init__()
        self.scene_net = VisionSceneNet(seed=seed)
        self.ocr_net = NeuralGlyphOCR(num_classes=len(OCR_ALPHABET), seed=seed + 200)
        self.trained_epochs = 0
        self.ocr_accuracy = 0.0
        self.scene_accuracy = 0.0

    def analyze_scene(self, image: Image.Image) -> Dict[str, Any]:
        self.eval()
        rgb = image.convert("RGB").resize((48, 48), resample=Image.Resampling.BILINEAR)
        arr = (np.asarray(rgb, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None, ...]
        sc_logits, cad_logits, attrs = self.scene_net.forward(Tensor(arr))
        sc_probs = sc_logits.softmax(axis=-1).data[0]
        cad_probs = cad_logits.softmax(axis=-1).data[0]
        top_sc = int(np.argmax(sc_probs))
        top_cad = int(np.argmax(cad_probs))
        attr_vals = attrs.data[0]

        # Color & Edge statistics for detailed multimodal breakdown
        orig_arr = np.asarray(image.convert("RGB").resize((128, 128)), dtype=np.float32) / 255.0
        mean_rgb = (orig_arr.mean(axis=(0, 1)) * 255.0).astype(int).tolist()
        gray = 0.299 * orig_arr[:, :, 0] + 0.587 * orig_arr[:, :, 1] + 0.114 * orig_arr[:, :, 2]
        gx = np.abs(np.diff(gray, axis=1)).mean()
        gy = np.abs(np.diff(gray, axis=0)).mean()
        edge_density = float(np.clip((gx + gy) * 4.5, 0.0, 1.0))

        return {
            "scene_category": SCENE_CATEGORIES[top_sc],
            "scene_confidence": round(float(sc_probs[top_sc]), 4),
            "top_scenes": [
                {"category": SCENE_CATEGORIES[i], "prob": round(float(sc_probs[i]), 4)}
                for i in np.argsort(-sc_probs)[:3]
            ],
            "suggested_cad_archetype": ARCHETYPES[top_cad],
            "cad_confidence": round(float(cad_probs[top_cad]), 4),
            "attributes": {
                "metallic": round(float(attr_vals[0]), 3),
                "organic": round(float(attr_vals[1]), 3),
                "architectural": round(float(attr_vals[2]), 3),
                "text_density": round(float(attr_vals[3]), 3),
            },
            "visual_stats": {
                "size_px": list(image.size),
                "mean_rgb": mean_rgb,
                "edge_sharpness": round(edge_density, 3),
                "brightness": round(float(gray.mean()), 3),
            },
        }

    def detect_and_read_text(self, image: Image.Image) -> Dict[str, Any]:
        """Detect text boxes via connected components + classify each glyph via NeuralGlyphOCR."""
        self.eval()
        # Upscale small images gently for clean glyph segmentation
        w_orig, h_orig = image.size
        scale = 1.0
        if max(w_orig, h_orig) < 240:
            scale = 2.0
        elif max(w_orig, h_orig) > 1200:
            scale = 1200.0 / float(max(w_orig, h_orig))

        work_img = image.convert("L")
        if scale != 1.0:
            work_img = work_img.resize(
                (max(16, int(w_orig * scale)), max(16, int(h_orig * scale))),
                resample=Image.Resampling.BICUBIC,
            )

        gray = np.asarray(work_img, dtype=np.float32)
        h, w = gray.shape

        # Determine polarity from border pixels (dark background vs white paper)
        border = np.concatenate([gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]])
        dark_bg = float(np.median(border)) < 128.0
        thresh = _otsu_threshold(gray)
        fg = (gray > thresh) if dark_bg else (gray < thresh)
        fg_intensity = np.clip((gray - thresh) / max(255.0 - thresh, 1.0), 0.0, 1.0) if dark_bg else np.clip((thresh - gray) / max(thresh, 1.0), 0.0, 1.0)

        # Connected components (8-connected)
        struct = np.ones((3, 3), dtype=np.int32)
        labeled, num_feat = ndimage.label(fg, structure=struct)
        objs = ndimage.find_objects(labeled)

        raw_boxes: List[Dict[str, Any]] = []
        for idx, sl in enumerate(objs, start=1):
            if sl is None:
                continue
            y0, y1 = sl[0].start, sl[0].stop
            x0, x1 = sl[1].start, sl[1].stop
            bh, bw = y1 - y0, x1 - x0
            area = int(np.sum(labeled[sl] == idx))
            # Filter out tiny noise specks or giant image-wide frames
            if bh < 6 or bw < 2 or bh > h * 0.65 or bw > w * 0.85 or area < 9:
                continue
            if bw > bh * 6.5:  # likely horizontal separator line, not a single character
                continue
            raw_boxes.append({"y0": y0, "y1": y1, "x0": x0, "x1": x1, "bh": bh, "bw": bw, "ids": [idx]})

        if not raw_boxes:
            buf = io.BytesIO()
            image.convert("RGB").save(buf, format="PNG")
            return {
                "text": "",
                "lines": [],
                "char_count": 0,
                "mean_confidence": 0.0,
                "annotated_png_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
            }

        # Merge small dots/diacritics above characters (e.g. 'i', 'j', 'й', 'ё')
        raw_boxes.sort(key=lambda b: b["y1"], reverse=True)
        merged_boxes: List[Dict[str, Any]] = []
        used = [False] * len(raw_boxes)
        for i in range(len(raw_boxes)):
            if used[i]:
                continue
            base = dict(raw_boxes[i])
            used[i] = True
            for j in range(len(raw_boxes)):
                if used[j]:
                    continue
                cand = raw_boxes[j]
                # Cand sits right above base with overlapping X and small area
                x_ov = min(base["x1"], cand["x1"]) - max(base["x0"], cand["x0"])
                if (
                    x_ov >= -2
                    and cand["y1"] <= base["y0"] + 3
                    and (base["y0"] - cand["y1"]) < max(base["bh"] * 0.65, 6)
                    and cand["bh"] < base["bh"] * 0.6
                    and cand["bw"] <= base["bw"] * 1.4
                ):
                    base["y0"] = min(base["y0"], cand["y0"])
                    base["x0"] = min(base["x0"], cand["x0"])
                    base["x1"] = max(base["x1"], cand["x1"])
                    base["bh"] = base["y1"] - base["y0"]
                    base["bw"] = base["x1"] - base["x0"]
                    base["ids"].append(cand["ids"][0])
                    used[j] = True
            merged_boxes.append(base)

        # Extract normalized 20x20 crops for all valid character boxes
        crops = []
        for b in merged_boxes:
            sub_mask = np.isin(labeled[b["y0"] : b["y1"], b["x0"] : b["x1"]], b["ids"]).astype(np.float32)
            sub_val = fg_intensity[b["y0"] : b["y1"], b["x0"] : b["x1"]] * sub_mask
            crops.append(_normalize_glyph_crop(sub_val, size=20))

        batch = np.stack(crops, axis=0)[:, None, :, :]
        logits = self.ocr_net.forward(Tensor(batch))
        probs = logits.softmax(axis=-1).data
        pred_ids = np.argmax(probs, axis=-1)
        pred_confs = probs[np.arange(len(merged_boxes)), pred_ids]

        for b, pid, conf in zip(merged_boxes, pred_ids, pred_confs):
            b["char"] = OCR_ALPHABET[int(pid)]
            b["conf"] = float(conf)

        # Group boxes into horizontal lines
        merged_boxes.sort(key=lambda b: (b["y0"] + b["y1"]) * 0.5)
        lines_boxes: List[List[Dict[str, Any]]] = []
        for b in merged_boxes:
            cy = 0.5 * (b["y0"] + b["y1"])
            placed = False
            for ln in lines_boxes:
                ly = np.mean([0.5 * (x["y0"] + x["y1"]) for x in ln])
                lh = np.mean([x["bh"] for x in ln])
                if abs(cy - ly) <= max(lh * 0.65, 8.0):
                    ln.append(b)
                    placed = True
                    break
            if not placed:
                lines_boxes.append([b])

        lines_boxes.sort(key=lambda ln: min(x["y0"] for x in ln))

        # Reconstruct words & lines with homoglyph script resolution
        decoded_lines: List[Dict[str, Any]] = []
        vis_img = work_img.convert("RGB")
        draw = ImageDraw.Draw(vis_img)

        med_w = float(np.median([b["bw"] for b in merged_boxes])) if merged_boxes else 10.0
        space_thresh = max(med_w * 0.55, 4.0)

        for ln in lines_boxes:
            ln.sort(key=lambda b: b["x0"])
            max_bh = max(b["bh"] for b in ln) if ln else 10
            # Detect whether line has mixed heights (tall caps + shorter lowercase)
            min_bh = min(b["bh"] for b in ln) if ln else 10
            has_tall_and_short = max_bh > min_bh * 1.25

            words_chars: List[List[str]] = [[]]
            for i, b in enumerate(ln):
                if i > 0:
                    gap = b["x0"] - ln[i - 1]["x1"]
                    if gap > space_thresh:
                        words_chars.append([])
                ch = b["char"]
                # Refine bicameral case when glyph shape is identical (c/C, o/O, с/С, н/Н, т/Т, etc.)
                if ch.isalpha():
                    if has_tall_and_short:
                        if b["bh"] >= max_bh * 0.84:
                            ch = ch.upper()
                        elif b["bh"] <= max_bh * 0.78:
                            ch = ch.lower()
                    elif all(x["bh"] >= max_bh * 0.84 for x in ln) and any(x["char"].isupper() for x in ln):
                        ch = ch.upper()
                words_chars[-1].append(ch)
                draw.rectangle([b["x0"] - 1, b["y0"] - 1, b["x1"] + 1, b["y1"] + 1], outline=(0, 230, 140), width=1)

            resolved_words = [_resolve_word_script(w_chars) for w_chars in words_chars if w_chars]
            line_text = " ".join(resolved_words)
            lx0 = min(b["x0"] for b in ln)
            ly0 = min(b["y0"] for b in ln)
            lx1 = max(b["x1"] for b in ln)
            ly1 = max(b["y1"] for b in ln)
            draw.rectangle([lx0 - 3, ly0 - 3, lx1 + 3, ly1 + 3], outline=(56, 189, 248), width=2)
            decoded_lines.append(
                {
                    "text": line_text,
                    "bbox": [int(lx0 / scale), int(ly0 / scale), int(lx1 / scale), int(ly1 / scale)],
                    "confidence": round(float(np.mean([b["conf"] for b in ln])), 3),
                }
            )

        out_buf = io.BytesIO()
        vis_img.save(out_buf, format="PNG")
        full_text = "\n".join(l["text"] for l in decoded_lines)
        mean_conf = float(np.mean([b["conf"] for b in merged_boxes]))

        return {
            "text": full_text,
            "lines": decoded_lines,
            "char_count": len(merged_boxes),
            "mean_confidence": round(mean_conf, 3),
            "annotated_png_b64": base64.b64encode(out_buf.getvalue()).decode("ascii"),
        }

    def image_to_cad(self, image: Image.Image, mode: str = "auto") -> Tuple[CADAssembly, Dict[str, Any], Dict[str, Any]]:
        """
        Reconstruct a 3D CAD Assembly from an uploaded image:
        - If 'blueprint' / 'relief' or high blueprint score: extracts silhouette -> watertight CAD relief
        - Otherwise: maps neural vision prediction + attributes -> full parametric CAD assembly!
        """
        analysis = self.analyze_scene(image)
        use_relief = (mode == "relief") or (
            mode == "auto" and analysis["scene_category"] in ("technical_blueprint", "text_document")
        )
        if use_relief:
            gray = np.asarray(image.convert("L").resize((64, 64)), dtype=np.float32)
            border = np.concatenate([gray[0, :], gray[-1, :], gray[:, 0], gray[:, -1]])
            dark_bg = float(np.median(border)) < 128.0
            thresh = _otsu_threshold(gray)
            mask = (gray > thresh).astype(np.float32) if dark_bg else (gray < thresh).astype(np.float32)
            asm = build_blueprint_extrusion(mask, title="Vision-to-CAD Reconstructed Blueprint Relief")
        else:
            arch = analysis["suggested_cad_archetype"]
            asm = compile_cad_program(
                arch,
                {"size_mm": 80.0, "chamfer": 1.0, "holes": 6, "teeth": 20, "blades": 10},
                prompt=f"Image-to-3D ({analysis['scene_category']} -> {arch})",
            )
        audit = audit_assembly(asm)
        return asm, analysis, audit

    def save(self, ckpt_path: Path = VISION_OCR_CKPT, meta_path: Path = VISION_OCR_META) -> None:
        meta = {
            "model": "NEWwoorld-VisionOCR-Core",
            "params": count_parameters(self),
            "ocr_classes": len(OCR_ALPHABET),
            "scene_classes": len(SCENE_CATEGORIES),
            "trained_epochs": self.trained_epochs,
            "ocr_accuracy": self.ocr_accuracy,
            "scene_accuracy": self.scene_accuracy,
        }
        save_model_safetensors(self, ckpt_path, meta_path, meta)

    @classmethod
    def load_or_create(cls, ckpt_path: Path = VISION_OCR_CKPT, meta_path: Path = VISION_OCR_META) -> "VisionOCRSystem":
        model = cls()
        if ckpt_path.exists():
            load_model_safetensors(model, ckpt_path, strict=False)
            if meta_path.exists():
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                model.trained_epochs = int(m.get("trained_epochs", 0))
                model.ocr_accuracy = float(m.get("ocr_accuracy", 0.0))
                model.scene_accuracy = float(m.get("scene_accuracy", 0.0))
        return model

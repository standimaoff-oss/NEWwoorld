"""NEWwoorld-PhotoPartNet: Compositional Part-by-Part Neural Image Synthesis."""

from __future__ import annotations
import base64
import io
import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from PIL import Image, ImageFilter

from ..config import PHOTOPART_CKPT, PHOTOPART_META
from ..nn import (
    Conv2d,
    Embedding,
    Linear,
    Module,
    RMSNorm,
    ResBlock2d,
    SinusoidalTimeEmbedding,
    Tensor,
    Upsample2x,
    count_parameters,
    load_model_safetensors,
    save_model_safetensors,
)
from ..tokenizer import BilingualCADTokenizer


PHOTO_SCENES = [
    "alpine_sunset",
    "cyberpunk_city",
    "studio_sportscar",
    "ocean_horizon",
    "forest_mist",
    "cosmic_nebula",
    "modern_architecture",
    "macro_crystal_mech",
]

PART_NAMES = [
    ("sky_atmosphere", "Часть 1/5: Небо, атмосфера и источник света"),
    ("far_backdrop", "Часть 2/5: Дальний план и силуэт горизонта"),
    ("midground_subject", "Часть 3/5: Основной объект и структура"),
    ("foreground_details", "Часть 4/5: Передний план, детали и отражения"),
    ("lighting_refinement", "Часть 5/5: Финальный световой проход и ACES-тонирование"),
]


def _fbm_noise(h: int, w: int, seed: int, octaves: int = 4) -> np.ndarray:
    """Fast vectorized multi-octave value noise in [0, 1] for crisp high-res micro-detail."""
    rng = np.random.default_rng(seed)
    acc = np.zeros((h, w), dtype=np.float32)
    amp = 1.0
    norm = 0.0
    for oct_i in range(octaves):
        gh = max(4, min(h, 4 * (2 ** oct_i)))
        gw = max(4, min(w, 4 * (2 ** oct_i)))
        grid = rng.uniform(0.0, 1.0, size=(gh, gw)).astype(np.float32)
        pil_g = Image.fromarray((grid * 255.0).astype(np.uint8), mode="L").resize(
            (w, h), resample=Image.Resampling.BICUBIC
        )
        acc += (np.asarray(pil_g, dtype=np.float32) / 255.0) * amp
        norm += amp
        amp *= 0.5
    return np.clip(acc / max(norm, 1e-6), 0.0, 1.0)


def _aces_tonemap(rgb: np.ndarray) -> np.ndarray:
    """ACES Filmic tone mapping curve for photorealistic contrast and highlight rolloff."""
    x = np.clip(rgb, 0.0, 4.0)
    a, b, c, d, e = 2.51, 0.03, 2.43, 0.59, 0.14
    mapped = (x * (a * x + b)) / (x * (c * x + d) + e)
    return np.clip(mapped, 0.0, 1.0)


def _to_png_b64(arr_uint8: np.ndarray) -> str:
    img = Image.fromarray(arr_uint8)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


class PartPatchConvDecoder(Module):
    """
    Neural Conditional Spatial Decoder:
    Condition vector (128) + Part ID Embedding -> 4x4 -> 8x8 -> 16x16 -> 32x32 -> 64x64 RGBA layer.
    """

    def __init__(self, cond_dim: int = 96, seed: int = 200):
        super().__init__()
        self.part_emb = Embedding(5, cond_dim, seed=seed + 1)
        self.time_emb = SinusoidalTimeEmbedding(cond_dim)
        self.proj = Linear(cond_dim, 64 * 4 * 4, seed=seed + 2)
        self.up = Upsample2x()
        self.res1 = ResBlock2d(64, cond_dim=cond_dim, seed=seed + 10)
        self.conv_8_16 = Conv2d(64, 48, 3, 1, 1, seed=seed + 20)
        self.res2 = ResBlock2d(48, cond_dim=cond_dim, seed=seed + 30)
        self.conv_16_32 = Conv2d(48, 32, 3, 1, 1, seed=seed + 40)
        self.res3 = ResBlock2d(32, cond_dim=cond_dim, seed=seed + 50)
        self.conv_32_64 = Conv2d(32, 24, 3, 1, 1, seed=seed + 60)
        self.head_rgba = Conv2d(24, 4, 3, 1, 1, seed=seed + 70)

    def forward(self, text_cond: Tensor, part_ids: np.ndarray, t_vals: Optional[np.ndarray] = None) -> Tensor:
        b = text_cond.shape[0]
        if t_vals is None:
            t_vals = np.zeros((b,), dtype=np.float32)
        cond = text_cond + self.part_emb(part_ids) + self.time_emb(t_vals) * 0.25
        h = self.proj(cond).silu().reshape(b, 64, 4, 4)
        h = self.up(h)  # 8x8
        h = self.res1(h, cond)
        h = self.conv_8_16(self.up(h)).silu()  # 16x16
        h = self.res2(h, cond)
        h = self.conv_16_32(self.up(h)).silu()  # 32x32
        h = self.res3(h, cond)
        h = self.conv_32_64(self.up(h)).silu()  # 64x64
        rgba = self.head_rgba(h).sigmoid()
        return rgba


class PhotoPartNetModel(Module):
    """
    NEWwoorld-PhotoPartNet:
    1) Bilingual Prompt Encoder -> Scene Class + Palette + Latent Condition
    2) Conditional Neural Part-by-Part Conv Decoder -> 4 spatial RGBA parts (64x64)
    3) Multi-Scale Neural Refinement + Physical Lighting Upscaler -> crisp 512x512 output
       with full intermediate part-by-part visualization!
    """

    def __init__(self, max_len: int = 48, d_model: int = 96, seed: int = 123):
        super().__init__()
        self.tokenizer = BilingualCADTokenizer(max_len=max_len)
        self.d_model = d_model
        self.max_len = max_len

        self.tok_emb = Embedding(self.tokenizer.vocab_size, d_model, seed=seed)
        self.pos_emb = Tensor(
            np.random.default_rng(seed + 1).normal(0.0, 0.02, size=(1, max_len, d_model)).astype(np.float32),
            requires_grad=True,
        )
        self.enc_fc1 = Linear(d_model, d_model, seed=seed + 2)
        self.enc_norm = RMSNorm(d_model)
        self.pool_q = Linear(d_model, 1, bias=False, seed=seed + 3)

        self.scene_head = Linear(d_model, len(PHOTO_SCENES), seed=seed + 10)
        self.palette_head = Linear(d_model, 9, seed=seed + 11)  # 3 RGB colors (sky, accent, ground)
        self.part_decoder = PartPatchConvDecoder(cond_dim=d_model, seed=seed + 50)

        # Neural refinement UNet-like residual block at 64x64
        self.refine_in = Conv2d(3, 24, 3, 1, 1, seed=seed + 300)
        self.refine_res = ResBlock2d(24, cond_dim=d_model, seed=seed + 310)
        self.refine_out = Conv2d(24, 3, 3, 1, 1, seed=seed + 320)

        self.trained_epochs = 0
        self.last_loss = 0.0

    def encode_text(self, token_ids: np.ndarray) -> Tensor:
        b, t = token_ids.shape
        x = self.tok_emb(token_ids) + self.pos_emb[:, :t, :]
        h = self.enc_norm(x + self.enc_fc1(x).silu())
        attn_logits = self.pool_q(h).reshape(b, t)
        pad_mask = (token_ids == self.tokenizer.pad_id).astype(np.float32) * (-1e9)
        w = (attn_logits + pad_mask).softmax(axis=-1).reshape(b, t, 1)
        return (h * w).sum(axis=1)

    def forward_scene_and_parts(
        self, token_ids: np.ndarray, part_ids: np.ndarray
    ) -> Tuple[Tensor, Tensor, Tensor]:
        cond = self.encode_text(token_ids)
        scene_logits = self.scene_head(cond)
        palette = self.palette_head(cond).sigmoid()
        part_rgba = self.part_decoder.forward(cond, part_ids)
        return scene_logits, palette, part_rgba

    def refine_rgb(self, rgb_nchw: Tensor, cond: Tensor) -> Tensor:
        h = self.refine_in(rgb_nchw).silu()
        h = self.refine_res(h, cond)
        delta = self.refine_out(h).tanh() * 0.35
        return (rgb_nchw + delta).sigmoid() if False else Tensor(np.clip(rgb_nchw.data + delta.data, 0.0, 1.0))

    def refine_rgb_trainable(self, rgb_nchw: Tensor, cond: Tensor) -> Tensor:
        h = self.refine_in(rgb_nchw).silu()
        h = self.refine_res(h, cond)
        delta = self.refine_out(h).tanh() * 0.35
        return rgb_nchw + delta

    def _upscale_and_detail_layer(
        self,
        rgba_64: np.ndarray,
        part_idx: int,
        scene_name: str,
        palette: np.ndarray,
        out_size: int,
        seed: int,
    ) -> np.ndarray:
        """
        Lift neural 64x64 RGBA prediction cleanly to `out_size x out_size` RGBA,
        blending learned neural spatial structure with crisp high-resolution physical micro-detail.
        """
        h, w = out_size, out_size
        # Upsample neural RGBA smoothly
        pil_rgb = Image.fromarray((np.clip(rgba_64[:, :, :3], 0, 1) * 255).astype(np.uint8)).resize(
            (w, h), resample=Image.Resampling.BICUBIC
        )
        pil_a = Image.fromarray((np.clip(rgba_64[:, :, 3], 0, 1) * 255).astype(np.uint8)).resize(
            (w, h), resample=Image.Resampling.BICUBIC
        )
        n_rgb = np.asarray(pil_rgb, dtype=np.float32) / 255.0
        n_a = np.asarray(pil_a, dtype=np.float32) / 255.0

        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        yn = yy / float(h - 1)
        xn = xx / float(w - 1)
        fbm = _fbm_noise(h, w, seed=seed + part_idx * 97, octaves=5)
        fine = _fbm_noise(h, w, seed=seed + part_idx * 97 + 13, octaves=6)

        c_sky = palette[0:3]
        c_acc = palette[3:6]
        c_gnd = palette[6:9]

        rgb = n_rgb.copy()
        alpha = n_a.copy()

        # High-frequency physical detail injection per part so edges & textures stay crisp at 512px
        if part_idx == 0:
            # Part 1: Sky / Atmosphere / Sun or Nebula disc
            grad = (1.0 - yn)[:, :, None] * c_sky + yn[:, :, None] * c_acc
            sun_x = 0.28 + 0.44 * float((seed % 100) / 100.0)
            sun_y = 0.24 + 0.22 * float(((seed // 7) % 100) / 100.0)
            dist = np.hypot(xn - sun_x, yn - sun_y)
            glow = np.exp(-dist * 4.8)[:, :, None]
            disc = (1.0 / (1.0 + np.exp(np.clip((dist - 0.045) * 220.0, -40.0, 40.0))))[:, :, None]
            cloud = np.clip((fbm - 0.46) * 2.2, 0.0, 1.0)[:, :, None] * (1.0 - yn * 0.7)[:, :, None]
            if scene_name == "cosmic_nebula":
                stars = ((fine > 0.87) & (fbm > 0.35)).astype(np.float32)[:, :, None] * 1.4
                phys = grad * (0.55 + 0.7 * fbm[:, :, None]) + c_acc * glow * 1.2 + stars
            else:
                phys = grad * 0.75 + c_acc * glow * 0.85 + np.array([1.0, 0.96, 0.86]) * disc * 1.4 + cloud * 0.22
            rgb = np.clip(0.45 * n_rgb + 0.55 * phys, 0.0, 1.5)
            alpha = np.ones((h, w), dtype=np.float32)

        elif part_idx == 1:
            # Part 2: Far backdrop (mountains / city skyline / planetary horizon / forest ridge)
            if scene_name in ("cyberpunk_city", "modern_architecture"):
                # Stepped crisp skyscraper silhouette
                rng = np.random.default_rng(seed + 11)
                n_cols = 28
                col_idx = np.clip((xn * n_cols).astype(np.int32), 0, n_cols - 1)
                heights = rng.uniform(0.28, 0.62, size=n_cols)
                ridge = heights[col_idx]
                mask = (yn > ridge).astype(np.float32)
                win_grid = ((np.sin(xn * 220.0) > 0.35) & (np.sin(yn * 260.0) > 0.45) & (yn < 0.78)).astype(np.float32)
                phys = (c_gnd * 0.65)[None, None, :] + (c_acc * 0.95)[None, None, :] * win_grid[:, :, None] * 0.45
            elif scene_name == "cosmic_nebula":
                # Ringed gas giant planet backdrop
                px, py = 0.55, 0.44
                d_p = np.hypot(xn - px, yn - py)
                mask = np.clip(1.0 - (d_p - 0.22) * 80.0, 0.0, 1.0)
                band = 0.5 + 0.5 * np.sin((yn - py) * 45.0 + fbm * 3.0)
                shade = np.clip(1.0 - np.hypot(xn - (px - 0.08), yn - (py - 0.08)) * 2.2, 0.12, 1.2)
                phys = (c_acc * band[:, :, None] + c_sky * (1 - band[:, :, None])) * shade[:, :, None]
            else:
                # Layered alpine ridge silhouette
                ridge = 0.46 + 0.13 * np.sin(xn * 6.2 + seed * 0.3) + 0.08 * (fbm - 0.5) * 2.0
                mask = np.clip((yn - ridge) * 70.0, 0.0, 1.0)
                snow = np.clip((ridge + 0.09 - yn) * 18.0, 0.0, 1.0) * (fine > 0.38)
                phys = c_gnd[None, None, :] * (0.6 + 0.5 * fbm[:, :, None]) + np.array([0.92, 0.95, 1.0]) * snow[:, :, None] * 0.6
            rgb = np.clip(0.35 * n_rgb + 0.65 * phys, 0.0, 1.4)
            alpha = np.clip(0.30 * n_a + 0.70 * mask, 0.0, 1.0)

        elif part_idx == 2:
            # Part 3: Midground subject (hypercar / central tower / tree line / ocean wave / crystal mechanism)
            if scene_name == "studio_sportscar":
                # Sleek aerodynamic sportscar studio silhouette + specular studio softbox highlights
                cx, cy = 0.5, 0.62
                body_top = cy - 0.11 * np.exp(-((xn - 0.48) / 0.23) ** 2) - 0.05 * np.exp(-((xn - 0.32) / 0.14) ** 2)
                body_bot = cy + 0.09
                in_x = np.clip(1.0 - np.abs(xn - 0.5) / 0.37, 0.0, 1.0) * 18.0
                mask = np.clip((yn - body_top) * 90.0, 0.0, 1.0) * np.clip((body_bot - yn) * 90.0, 0.0, 1.0) * np.clip(in_x, 0.0, 1.0)
                # Wheels
                w1 = np.clip(1.0 - (np.hypot(xn - 0.30, yn - (body_bot - 0.01)) - 0.068) * 140.0, 0.0, 1.0)
                w2 = np.clip(1.0 - (np.hypot(xn - 0.70, yn - (body_bot - 0.01)) - 0.068) * 140.0, 0.0, 1.0)
                rim = np.exp(-np.abs(yn - body_top - 0.012) * 160.0)[:, :, None] * 1.35
                phys = c_acc[None, None, :] * (0.45 + 0.55 * (1.0 - yn[:, :, None])) + rim - 0.45 * (w1 + w2)[:, :, None]
                mask = np.clip(mask + w1 + w2, 0.0, 1.0)
            elif scene_name == "macro_crystal_mech":
                # Metallic gear / crystalline studio macro subject
                cx, cy = 0.5, 0.52
                ang = np.arctan2(yn - cy, xn - cx)
                rad = np.hypot(xn - cx, yn - cy)
                teeth_r = 0.24 + 0.032 * np.tanh(np.cos(ang * 14.0) * 8.0)
                mask = np.clip((teeth_r - rad) * 140.0, 0.0, 1.0) * np.clip((rad - 0.075) * 140.0, 0.0, 1.0)
                aniso = 0.5 + 0.5 * np.cos(ang * 2.0 + 0.7)
                phys = (c_acc * 0.7 + np.array([0.75, 0.80, 0.88]) * 0.5) * (0.4 + 0.85 * aniso[:, :, None])
            elif scene_name == "ocean_horizon":
                # Rolling cresting waves
                crest = 0.58 + 0.04 * np.sin(xn * 12.0 + fbm * 2.5)
                mask = np.clip((yn - crest) * 65.0, 0.0, 1.0)
                foam = np.exp(-np.abs(yn - crest) * 75.0)[:, :, None] * (fbm[:, :, None] > 0.35)
                phys = np.array([0.05, 0.36, 0.52]) * (0.6 + 0.5 * fbm[:, :, None]) + np.array([0.95, 0.98, 1.0]) * foam
            else:
                # Secondary ridge / architectural hero volume / forest trees
                ridge2 = 0.56 + 0.09 * np.cos(xn * 9.0 + seed) + 0.07 * (fbm - 0.5) * 2.0
                mask = np.clip((yn - ridge2) * 80.0, 0.0, 1.0) * np.clip((0.86 - yn) * 40.0, 0.0, 1.0)
                phys = (c_gnd * 0.8 + c_acc * 0.25)[None, None, :] * (0.5 + 0.65 * fine[:, :, None])
            rgb = np.clip(0.30 * n_rgb + 0.70 * phys, 0.0, 1.4)
            alpha = np.clip(0.25 * n_a + 0.75 * mask, 0.0, 1.0)

        else:
            # Part 4: Foreground ground / water reflections / neon puddles / bokeh glints
            fg_top = 0.70 + 0.03 * np.sin(xn * 14.0)
            mask = np.clip((yn - fg_top) * 55.0, 0.0, 1.0)
            ripple = np.sin(yn * 180.0 + fbm * 8.0) * 0.5 + 0.5
            glint = np.exp(-((xn - 0.5) ** 2) * 18.0) * ripple * np.clip((yn - fg_top) * 8.0, 0.0, 1.0)
            phys = (c_gnd * 0.55)[None, None, :] * (0.7 + 0.3 * fbm[:, :, None]) + c_acc[None, None, :] * glint[:, :, None] * 0.95
            rgb = np.clip(0.28 * n_rgb + 0.72 * phys, 0.0, 1.4)
            alpha = np.clip(0.25 * n_a + 0.75 * mask, 0.0, 1.0)

        out = np.concatenate([rgb, alpha[:, :, None]], axis=-1)
        return out

    def generate_part_by_part(
        self,
        prompt: str,
        size: int = 512,
        seed: int = 42,
    ) -> Dict[str, Any]:
        """
        Synthesize an image explicitly PART BY PART (5 layers + progressive composites).
        Returns scene prediction, individual part layers (PNG base64), and final 512x512 render.
        """
        self.eval()
        ids = self.tokenizer.encode_batch([prompt])
        cond = self.encode_text(ids)
        scene_logits = self.scene_head(cond)
        scene_probs = scene_logits.softmax(axis=-1).data[0]
        scene_idx = int(np.argmax(scene_probs))
        scene_name = PHOTO_SCENES[scene_idx]
        palette = self.palette_head(cond).sigmoid().data[0]  # (9,)

        # Derive stable prompt-dependent variation seed
        prompt_hash = sum((i + 1) * ord(ch) for i, ch in enumerate(prompt)) + seed * 31

        parts_output: List[Dict[str, Any]] = []
        canvas = np.zeros((size, size, 3), dtype=np.float32)

        # Parts 1..4 synthesized individually via Neural Part Decoder + High-Res Physical Detail
        for p_idx in range(4):
            p_arr = np.array([p_idx], dtype=np.int64)
            t_arr = np.array([float(p_idx) / 4.0], dtype=np.float32)
            rgba_64 = self.part_decoder.forward(cond, p_arr, t_arr).data[0].transpose(1, 2, 0)  # (64,64,4)
            rgba_hi = self._upscale_and_detail_layer(rgba_64, p_idx, scene_name, palette, size, prompt_hash)
            layer_rgb = rgba_hi[:, :, :3]
            layer_a = rgba_hi[:, :, 3:4]

            if p_idx == 0:
                canvas = layer_rgb.copy()
            else:
                canvas = canvas * (1.0 - layer_a) + layer_rgb * layer_a

            part_key, part_label = PART_NAMES[p_idx]
            # Render checkerboard-tinted standalone preview of this part + progressive composite
            part_vis = np.clip(layer_rgb * layer_a + 0.12 * (1.0 - layer_a), 0.0, 1.0)
            comp_vis = _aces_tonemap(canvas)
            parts_output.append(
                {
                    "index": p_idx + 1,
                    "name": part_key,
                    "label": part_label,
                    "progress_pct": (p_idx + 1) * 20,
                    "layer_png_b64": _to_png_b64((part_vis * 255).astype(np.uint8)),
                    "composite_png_b64": _to_png_b64((comp_vis * 255).astype(np.uint8)),
                }
            )

        # Part 5: Neural Refinement ConvNet Pass + Volumetric Specular Bloom + ACES Filmic Grading
        canvas_64 = np.asarray(
            Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8)).resize(
                (64, 64), resample=Image.Resampling.BILINEAR
            ),
            dtype=np.float32,
        ) / 255.0
        t_in = Tensor(canvas_64.transpose(2, 0, 1)[None, ...])
        refined_64 = self.refine_rgb_trainable(t_in, cond).data[0].transpose(1, 2, 0)
        delta_64 = refined_64 - canvas_64
        delta_hi = (
            np.asarray(
                Image.fromarray((np.clip(delta_64 * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)).resize(
                    (size, size), resample=Image.Resampling.BICUBIC
                ),
                dtype=np.float32,
            )
            / 255.0
            - 0.5
        ) * 2.0

        final_hdr = np.clip(canvas + delta_hi * 0.35, 0.0, 2.0)

        # Subtle soft optical bloom on bright highlights + vignette
        bright = np.clip(final_hdr - 0.72, 0.0, 1.5)
        bloom_img = Image.fromarray((np.clip(bright, 0, 1) * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(radius=max(size // 42, 4))
        )
        bloom = np.asarray(bloom_img, dtype=np.float32) / 255.0
        final_hdr = final_hdr + bloom * 0.42

        yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / float(size - 1)
        vig = 1.0 - 0.26 * ((xx - 0.5) ** 2 + (yy - 0.5) ** 2) * 2.0
        final_ldr = _aces_tonemap(final_hdr * vig[:, :, None])
        final_u8 = (final_ldr * 255.0).astype(np.uint8)

        part_key, part_label = PART_NAMES[4]
        final_b64 = _to_png_b64(final_u8)
        parts_output.append(
            {
                "index": 5,
                "name": part_key,
                "label": part_label,
                "progress_pct": 100,
                "layer_png_b64": _to_png_b64((np.clip(bloom * 1.8 + 0.06, 0, 1) * 255).astype(np.uint8)),
                "composite_png_b64": final_b64,
            }
        )

        return {
            "prompt": prompt,
            "scene_archetype": scene_name,
            "confidence": round(float(scene_probs[scene_idx]), 4),
            "resolution": [size, size],
            "palette_rgb": [[int(c * 255) for c in palette[k * 3 : (k + 1) * 3]] for k in range(3)],
            "final_png_b64": final_b64,
            "parts": parts_output,
        }

    def save(self, ckpt_path: Path = PHOTOPART_CKPT, meta_path: Path = PHOTOPART_META) -> None:
        meta = {
            "model": "NEWwoorld-PhotoPartNet-Core",
            "params": count_parameters(self),
            "d_model": self.d_model,
            "trained_epochs": self.trained_epochs,
            "last_loss": self.last_loss,
            "scenes": PHOTO_SCENES,
        }
        save_model_safetensors(self, ckpt_path, meta_path, meta)

    @classmethod
    def load_or_create(cls, ckpt_path: Path = PHOTOPART_CKPT, meta_path: Path = PHOTOPART_META) -> "PhotoPartNetModel":
        model = cls()
        if ckpt_path.exists():
            load_model_safetensors(model, ckpt_path, strict=False)
            if meta_path.exists():
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                model.trained_epochs = int(m.get("trained_epochs", 0))
                model.last_loss = float(m.get("last_loss", 0.0))
        return model

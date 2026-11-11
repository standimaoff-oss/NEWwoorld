"""Exact Billion-Parameter Model Configurations & Analytical Parameter Counters."""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict


@dataclass(frozen=True)
class CadBillionConfig:
    name: str
    vocab_size: int
    d_model: int
    n_layers: int
    n_heads: int
    n_kv_heads: int
    ffn_hidden: int
    max_seq_len: int = 2048
    num_experts: int = 1
    top_k: int = 1
    continuous_dim: int = 16


@dataclass(frozen=True)
class PhotoPartDiTConfig:
    name: str
    d_model: int
    n_layers: int
    n_heads: int
    latent_channels: int = 16
    patch_size: int = 2
    text_dim: int = 1024
    num_parts: int = 8


def compute_cad_transformer_params(cfg: CadBillionConfig) -> int:
    """Exact analytical parameter count for the PyTorch CAD Transformer (+ optional MoE)."""
    d = cfg.d_model
    kv_dim = (d // cfg.n_heads) * cfg.n_kv_heads
    # Token embedding + LM head (untied)
    embed = cfg.vocab_size * d
    lm_head = d * cfg.vocab_size
    # Attention per layer: Q, K, V, O + 2 RMSNorms
    attn_per_layer = (d * d) + 2 * (d * kv_dim) + (d * d) + 2 * d
    # SwiGLU FFN per expert: w_gate, w_up, w_down
    ffn_expert = 3 * (d * cfg.ffn_hidden)
    if cfg.num_experts > 1:
        router = d * cfg.num_experts
        ffn_per_layer = cfg.num_experts * ffn_expert + router
    else:
        ffn_per_layer = ffn_expert
    final_norm_and_cont_head = d + (d * d // 2) + (d // 2 * cfg.continuous_dim)
    return embed + lm_head + cfg.n_layers * (attn_per_layer + ffn_per_layer) + final_norm_and_cont_head


def compute_photopart_dit_params(cfg: PhotoPartDiTConfig) -> int:
    """Exact analytical parameter count for Regional Part-Cross-Attention MMDiT."""
    d = cfg.d_model
    # Patchify + unpatchify + timestep + part embedding + text proj
    in_out = 2 * (cfg.latent_channels * cfg.patch_size * cfg.patch_size * d)
    cond = (cfg.text_dim * d) + (cfg.num_parts * d) + (3 * d * d)
    # Per MMDiT block: self-attn (4*d^2) + cross-attn (4*d^2) + SwiGLU (~3*d*4d) + AdaLN-Zero (6*d^2)
    per_block = 4 * d * d + 4 * d * d + 3 * d * int(d * 3.5) + 6 * d * d
    return in_out + cond + cfg.n_layers * per_block


BILLION_SCALE_CONFIGS: Dict[str, Any] = {
    "cad_1.2b": CadBillionConfig(
        name="NEWwoorld-CadGPT-1.2B",
        vocab_size=32768,
        d_model=2048,
        n_layers=24,
        n_heads=16,
        n_kv_heads=4,
        ffn_hidden=5632,
        max_seq_len=2048,
    ),
    "cad_3.0b": CadBillionConfig(
        name="NEWwoorld-CadGPT-3.0B",
        vocab_size=32768,
        d_model=3072,
        n_layers=28,
        n_heads=24,
        n_kv_heads=8,
        ffn_hidden=8192,
        max_seq_len=4096,
    ),
    "cad_6.8b_moe": CadBillionConfig(
        name="NEWwoorld-CadGPT-6.8B-MoE",
        vocab_size=32768,
        d_model=2560,
        n_layers=30,
        n_heads=20,
        n_kv_heads=4,
        ffn_hidden=6656,
        max_seq_len=4096,
        num_experts=4,
        top_k=2,
    ),
    "photopart_3.1b": PhotoPartDiTConfig(
        name="NEWwoorld-PhotoPart-MMDiT-3.1B",
        d_model=2304,
        n_layers=24,
        n_heads=24,
    ),
}

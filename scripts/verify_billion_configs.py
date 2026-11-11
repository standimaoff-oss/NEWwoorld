"""Verify exact parameter counts across all billion-scale presets."""

from newwoorld_ai.scale_billion import (
    BILLION_SCALE_CONFIGS,
    compute_cad_transformer_params,
    compute_photopart_dit_params,
)

for key, cfg in BILLION_SCALE_CONFIGS.items():
    n = compute_cad_transformer_params(cfg) if key.startswith("cad") else compute_photopart_dit_params(cfg)
    print(f"{key:15s} | {cfg.name:30s} | {n:>14,d} params ({n/1e9:.3f}B)")

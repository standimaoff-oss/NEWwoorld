"""Billion-Parameter PyTorch Scaling Blueprints (1.4B / 3.2B / 7.1B CAD & 2.5B PhotoPart)."""

from .configs import BILLION_SCALE_CONFIGS, compute_cad_transformer_params, compute_photopart_dit_params

__all__ = [
    "BILLION_SCALE_CONFIGS",
    "compute_cad_transformer_params",
    "compute_photopart_dit_params",
]

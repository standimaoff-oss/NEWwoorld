"""
PyTorch 2.5B Regional Part-Cross-Attention Multi-Modal Diffusion Transformer (MMDiT)
for Part-by-Part Photorealistic Image Synthesis on Multi-GPU Clusters.
"""

from __future__ import annotations
try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "PyTorch is required for billion-parameter GPU scaling. Install requirements-scale-gpu.txt."
    ) from exc

from .configs import PhotoPartDiTConfig


class MMDiTPartBlock(nn.Module):
    def __init__(self, d_model: int, n_heads: int):
        super().__init__()
        self.norm1 = nn.LayerNorm(d_model, elementwise_affine=False)
        self.self_attn = nn.MultiheadAttention(d_model, n_heads, batch_first=True)
        self.norm2 = nn.LayerNorm(d_model, elementwise_affine=False)
        self.cross_attn = nn.MultiheadAttention(d_model, n_heads, batch_first=True)
        self.norm3 = nn.LayerNorm(d_model, elementwise_affine=False)
        hidden = int(d_model * 3.5)
        self.w_gate = nn.Linear(d_model, hidden, bias=False)
        self.w_up = nn.Linear(d_model, hidden, bias=False)
        self.w_down = nn.Linear(hidden, d_model, bias=False)
        self.ada_ln = nn.Linear(d_model, 6 * d_model)

    def forward(
        self,
        x: torch.Tensor,
        cond_seq: torch.Tensor,
        t_emb: torch.Tensor,
        region_mask: torch.Tensor | None = None,
    ) -> torch.Tensor:
        s1, sc1, g1, s2, sc2, g2 = self.ada_ln(F.silu(t_emb)).unsqueeze(1).chunk(6, dim=-1)
        h = self.norm1(x) * (1 + sc1) + s1
        sa, _ = self.self_attn(h, h, h, need_weights=False)
        x = x + g1 * sa

        ca_in = self.norm2(x)
        ca, _ = self.cross_attn(ca_in, cond_seq, cond_seq, attn_mask=region_mask, need_weights=False)
        x = x + ca

        h2 = self.norm3(x) * (1 + sc2) + s2
        ff = self.w_down(F.silu(self.w_gate(h2)) * self.w_up(h2))
        return x + g2 * ff


class PhotoPartMMDiT(nn.Module):
    """2.5B-Parameter Regional Flow-Matching Diffusion Transformer."""

    def __init__(self, cfg: PhotoPartDiTConfig):
        super().__init__()
        self.cfg = cfg
        p = cfg.patch_size
        patch_dim = cfg.latent_channels * p * p
        self.patch_in = nn.Linear(patch_dim, cfg.d_model)
        self.text_proj = nn.Linear(cfg.text_dim, cfg.d_model)
        self.part_emb = nn.Embedding(cfg.num_parts, cfg.d_model)
        self.time_mlp = nn.Sequential(
            nn.Linear(cfg.d_model, cfg.d_model),
            nn.SiLU(),
            nn.Linear(cfg.d_model, cfg.d_model),
        )
        self.blocks = nn.ModuleList([MMDiTPartBlock(cfg.d_model, cfg.n_heads) for _ in range(cfg.n_layers)])
        self.patch_out = nn.Linear(cfg.d_model, patch_dim)

    def forward(
        self,
        latent_patches: torch.Tensor,
        text_tokens: torch.Tensor,
        part_ids: torch.Tensor,
        t_vec: torch.Tensor,
    ) -> torch.Tensor:
        x = self.patch_in(latent_patches)
        cond = self.text_proj(text_tokens) + self.part_emb(part_ids)
        t_emb = self.time_mlp(t_vec)
        for blk in self.blocks:
            x = blk(x, cond, t_emb)
        return self.patch_out(x)

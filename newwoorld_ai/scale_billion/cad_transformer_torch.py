"""
PyTorch Billion-Parameter CAD B-Rep & Parametric Sequence Transformer (1.4B / 3.2B / 7.1B-MoE).
Features: Rotary Position Embeddings (RoPE), Grouped-Query Attention (GQA) with SDPA/FlashAttention,
SwiGLU / Top-K Mixture-of-Experts, and Flow-Matching Continuous Geometry Head.
"""

from __future__ import annotations
import math
from typing import Optional, Tuple

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "PyTorch is required for billion-parameter GPU scaling. Install requirements-scale-gpu.txt."
    ) from exc

from .configs import CadBillionConfig


class RMSNormTorch(nn.Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        rms = torch.rsqrt(x.pow(2).mean(dim=-1, keepdim=True) + self.eps)
        return (x * rms) * self.weight


def apply_rope(q: torch.Tensor, k: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
    def rotate_half(x: torch.Tensor) -> torch.Tensor:
        x1, x2 = x[..., : x.shape[-1] // 2], x[..., x.shape[-1] // 2 :]
        return torch.cat((-x2, x1), dim=-1)

    return (q * cos) + (rotate_half(q) * sin), (k * cos) + (rotate_half(k) * sin)


class GQAAttention(nn.Module):
    def __init__(self, cfg: CadBillionConfig):
        super().__init__()
        self.n_heads = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim = cfg.d_model // cfg.n_heads
        self.n_rep = cfg.n_heads // cfg.n_kv_heads

        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * self.head_dim, bias=False)
        self.o_proj = nn.Linear(cfg.n_heads * self.head_dim, cfg.d_model, bias=False)

    def forward(self, x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
        b, t, _ = x.shape
        q = self.q_proj(x).view(b, t, self.n_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(b, t, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(b, t, self.n_kv_heads, self.head_dim).transpose(1, 2)

        q, k = apply_rope(q, k, cos, sin)
        if self.n_rep > 1:
            k = k.repeat_interleave(self.n_rep, dim=1)
            v = v.repeat_interleave(self.n_rep, dim=1)

        out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.o_proj(out.transpose(1, 2).contiguous().view(b, t, -1))


class SwiGLUExpert(nn.Module):
    def __init__(self, d_model: int, hidden: int):
        super().__init__()
        self.w_gate = nn.Linear(d_model, hidden, bias=False)
        self.w_up = nn.Linear(d_model, hidden, bias=False)
        self.w_down = nn.Linear(hidden, d_model, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.w_down(F.silu(self.w_gate(x)) * self.w_up(x))


class SparseMoELayer(nn.Module):
    def __init__(self, d_model: int, hidden: int, num_experts: int, top_k: int):
        super().__init__()
        self.num_experts = num_experts
        self.top_k = top_k
        self.router = nn.Linear(d_model, num_experts, bias=False)
        self.experts = nn.ModuleList([SwiGLUExpert(d_model, hidden) for _ in range(num_experts)])

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, t, d = x.shape
        flat = x.view(-1, d)
        logits = self.router(flat)
        probs = F.softmax(logits, dim=-1)
        top_w, top_idx = torch.topk(probs, self.top_k, dim=-1)
        top_w = top_w / top_w.sum(dim=-1, keepdim=True)

        out = torch.zeros_like(flat)
        for e_id, expert in enumerate(self.experts):
            mask = top_idx == e_id
            if mask.any():
                token_mask = mask.any(dim=-1)
                weights = (top_w * mask.float()).sum(dim=-1)[token_mask].unsqueeze(-1)
                out[token_mask] += expert(flat[token_mask]) * weights
        return out.view(b, t, d)


class CadBillionBlock(nn.Module):
    def __init__(self, cfg: CadBillionConfig):
        super().__init__()
        self.norm1 = RMSNormTorch(cfg.d_model)
        self.attn = GQAAttention(cfg)
        self.norm2 = RMSNormTorch(cfg.d_model)
        if cfg.num_experts > 1:
            self.ffn = SparseMoELayer(cfg.d_model, cfg.ffn_hidden, cfg.num_experts, cfg.top_k)
        else:
            self.ffn = SwiGLUExpert(cfg.d_model, cfg.ffn_hidden)

    def forward(self, x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x), cos, sin)
        x = x + self.ffn(self.norm2(x))
        return x


class CadGPTBillionModel(nn.Module):
    """Scalable 1.4B / 3.2B / 7.1B-MoE Autoregressive CAD Sequence & Geometry Model."""

    def __init__(self, cfg: CadBillionConfig):
        super().__init__()
        self.cfg = cfg
        self.tok_emb = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.layers = nn.ModuleList([CadBillionBlock(cfg) for _ in range(cfg.n_layers)])
        self.norm = RMSNormTorch(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.cont_head = nn.Sequential(
            nn.Linear(cfg.d_model, cfg.d_model // 2, bias=False),
            nn.SiLU(),
            nn.Linear(cfg.d_model // 2, cfg.continuous_dim, bias=False),
        )

    def _rope_cache(self, seq_len: int, device: torch.device, dtype: torch.dtype) -> Tuple[torch.Tensor, torch.Tensor]:
        hd = self.cfg.d_model // self.cfg.n_heads
        inv_freq = 1.0 / (10000.0 ** (torch.arange(0, hd, 2, device=device, dtype=torch.float32) / hd))
        pos = torch.arange(seq_len, device=device, dtype=torch.float32)
        freqs = torch.einsum("i,j->ij", pos, inv_freq)
        emb = torch.cat((freqs, freqs), dim=-1)[None, None, :, :]
        return emb.cos().to(dtype), emb.sin().to(dtype)

    def forward(
        self, input_ids: torch.Tensor, targets: Optional[torch.Tensor] = None
    ) -> Tuple[torch.Tensor, torch.Tensor, Optional[torch.Tensor]]:
        x = self.tok_emb(input_ids)
        cos, sin = self._rope_cache(input_ids.shape[1], x.device, x.dtype)
        for layer in self.layers:
            x = layer(x, cos, sin)
        h = self.norm(x)
        logits = self.lm_head(h)
        cont = self.cont_head(h)
        loss = None
        if targets is not None:
            loss = F.cross_entropy(logits.view(-1, self.cfg.vocab_size), targets.view(-1))
        return logits, cont, loss

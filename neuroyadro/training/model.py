"""Small LLaMA-compatible decoder-only transformer implemented in PyTorch."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from .config import ModelConfig


class RMSNorm(nn.Module):
    def __init__(self, width: int, eps: float) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(width))
        self.eps = eps

    def forward(self, x: Tensor) -> Tensor:
        variance = x.float().pow(2).mean(dim=-1, keepdim=True)
        normalized = x * torch.rsqrt(variance + self.eps).to(dtype=x.dtype)
        return normalized * self.weight


class RotaryEmbedding(nn.Module):
    def __init__(self, head_dim: int, theta: float) -> None:
        super().__init__()
        inv_freq = 1.0 / (theta ** (torch.arange(0, head_dim, 2).float() / head_dim))
        self.register_buffer("inv_freq", inv_freq, persistent=False)

    @staticmethod
    def _rotate_half(x: Tensor) -> Tensor:
        # LLaMA pairs the first and second half of every head (not adjacent values).
        left, right = x.chunk(2, dim=-1)
        return torch.cat((-right, left), dim=-1)

    def forward(self, q: Tensor, k: Tensor, positions: Tensor) -> tuple[Tensor, Tensor]:
        # q/k: batch, heads, tokens, head_dim; positions: tokens
        phase = torch.outer(positions.to(self.inv_freq.dtype), self.inv_freq)
        phase = torch.cat((phase, phase), dim=-1).to(device=q.device, dtype=q.dtype)
        cos = phase.cos()[None, None, :, :]
        sin = phase.sin()[None, None, :, :]
        return q * cos + self._rotate_half(q) * sin, k * cos + self._rotate_half(k) * sin


class CausalSelfAttention(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.heads = config.num_attention_heads
        self.head_dim = config.head_dim
        self.q_proj = nn.Linear(config.hidden_size, config.hidden_size, bias=False)
        self.k_proj = nn.Linear(config.hidden_size, config.hidden_size, bias=False)
        self.v_proj = nn.Linear(config.hidden_size, config.hidden_size, bias=False)
        self.o_proj = nn.Linear(config.hidden_size, config.hidden_size, bias=False)
        self.rotary = RotaryEmbedding(config.head_dim, config.rope_theta)
        self.dropout = config.attention_dropout

    def forward(self, x: Tensor) -> Tensor:
        batch, tokens, width = x.shape
        def reshape(projection: Tensor) -> Tensor:
            return projection.view(batch, tokens, self.heads, self.head_dim).transpose(1, 2)

        q, k, v = reshape(self.q_proj(x)), reshape(self.k_proj(x)), reshape(self.v_proj(x))
        positions = torch.arange(tokens, device=x.device)
        q, k = self.rotary(q, k, positions)
        attended = F.scaled_dot_product_attention(
            q, k, v,
            attn_mask=None,
            dropout_p=self.dropout if self.training else 0.0,
            is_causal=True,
        )
        attended = attended.transpose(1, 2).contiguous().view(batch, tokens, width)
        return self.o_proj(attended)


class SwiGLUMLP(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=False)
        self.up_proj = nn.Linear(config.hidden_size, config.intermediate_size, bias=False)
        self.down_proj = nn.Linear(config.intermediate_size, config.hidden_size, bias=False)

    def forward(self, x: Tensor) -> Tensor:
        return self.down_proj(F.silu(self.gate_proj(x)) * self.up_proj(x))


class DecoderLayer(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.input_layernorm = RMSNorm(config.hidden_size, config.rms_norm_eps)
        self.self_attn = CausalSelfAttention(config)
        self.post_attention_layernorm = RMSNorm(config.hidden_size, config.rms_norm_eps)
        self.mlp = SwiGLUMLP(config)

    def forward(self, x: Tensor) -> Tensor:
        x = x + self.self_attn(self.input_layernorm(x))
        return x + self.mlp(self.post_attention_layernorm(x))


@dataclass
class CausalLMOutput:
    logits: Tensor
    loss: Optional[Tensor]


class NeuroYadroForCausalLM(nn.Module):
    """A deliberately LLaMA-shaped model so export does not require lossy conversion."""

    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.config = config
        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size)
        self.layers = nn.ModuleList(DecoderLayer(config) for _ in range(config.num_hidden_layers))
        self.norm = RMSNorm(config.hidden_size, config.rms_norm_eps)
        self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)
        self.lm_head.weight = self.embed_tokens.weight
        self.apply(self._init_weights)

    def _init_weights(self, module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=self.config.initializer_range)

    def forward(self, input_ids: Tensor, labels: Optional[Tensor] = None) -> CausalLMOutput:
        if input_ids.ndim != 2:
            raise ValueError("input_ids must have shape [batch, tokens]")
        if input_ids.size(1) > self.config.max_position_embeddings:
            raise ValueError("input sequence exceeds configured context window")
        hidden = self.embed_tokens(input_ids)
        for layer in self.layers:
            hidden = layer(hidden)
        logits = self.lm_head(self.norm(hidden))
        loss = None
        if labels is not None:
            if labels.shape != input_ids.shape:
                raise ValueError("labels must have the same shape as input_ids")
            loss = F.cross_entropy(logits.flatten(0, 1), labels.flatten(), ignore_index=-100)
        return CausalLMOutput(logits=logits, loss=loss)

    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())

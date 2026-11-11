"""Neural network layers built on the NEWwoorld Tensor Autograd engine."""

from __future__ import annotations
import math
import numpy as np
from typing import Dict, Iterator, List, Optional, Tuple
from .tensor import Tensor, cat


class Module:
    """Base class for all NEWwoorld neural network modules."""

    def __init__(self) -> None:
        self.training: bool = True

    def train(self, mode: bool = True) -> "Module":
        self.training = mode
        for m in self.modules():
            m.training = mode
        return self

    def eval(self) -> "Module":
        return self.train(False)

    def parameters(self) -> List[Tensor]:
        params: List[Tensor] = []
        seen = set()
        for _, p in self.named_parameters():
            if id(p) not in seen:
                seen.add(id(p))
                params.append(p)
        return params

    def named_parameters(self, prefix: str = "") -> Iterator[Tuple[str, Tensor]]:
        for name, val in self.__dict__.items():
            full = f"{prefix}.{name}" if prefix else name
            if isinstance(val, Tensor) and val.requires_grad:
                yield full, val
            elif isinstance(val, Module):
                yield from val.named_parameters(full)
            elif isinstance(val, (list, tuple)):
                for i, item in enumerate(val):
                    if isinstance(item, Module):
                        yield from item.named_parameters(f"{full}.{i}")
                    elif isinstance(item, Tensor) and item.requires_grad:
                        yield f"{full}.{i}", item
            elif isinstance(val, dict):
                for k, item in val.items():
                    if isinstance(item, Module):
                        yield from item.named_parameters(f"{full}.{k}")
                    elif isinstance(item, Tensor) and item.requires_grad:
                        yield f"{full}.{k}", item

    def modules(self) -> Iterator["Module"]:
        for val in self.__dict__.values():
            if isinstance(val, Module):
                yield val
                yield from val.modules()
            elif isinstance(val, (list, tuple)):
                for item in val:
                    if isinstance(item, Module):
                        yield item
                        yield from item.modules()
            elif isinstance(val, dict):
                for item in val.values():
                    if isinstance(item, Module):
                        yield item
                        yield from item.modules()

    def zero_grad(self) -> None:
        for p in self.parameters():
            p.zero_grad()

    def state_dict(self) -> Dict[str, np.ndarray]:
        return {name: p.data.copy() for name, p in self.named_parameters()}

    def load_state_dict(self, state: Dict[str, np.ndarray], strict: bool = True) -> None:
        own = dict(self.named_parameters())
        for name, p in own.items():
            if name in state:
                arr = np.asarray(state[name], dtype=np.float32)
                if arr.shape != p.shape:
                    raise ValueError(f"Shape mismatch for {name}: expected {p.shape}, got {arr.shape}")
                p.data[...] = arr
            elif strict:
                raise KeyError(f"Missing parameter in state_dict: {name}")


class Linear(Module):
    def __init__(self, in_features: int, out_features: int, bias: bool = True, seed: Optional[int] = None):
        super().__init__()
        rng = np.random.default_rng(seed)
        bound = math.sqrt(2.0 / float(in_features + out_features))
        self.weight = Tensor(
            rng.normal(0.0, bound, size=(in_features, out_features)).astype(np.float32),
            requires_grad=True,
        )
        self.bias = Tensor(np.zeros((out_features,), dtype=np.float32), requires_grad=True) if bias else None

    def __call__(self, x: Tensor) -> Tensor:
        y = x @ self.weight
        if self.bias is not None:
            y = y + self.bias
        return y


class Embedding(Module):
    def __init__(self, num_embeddings: int, embedding_dim: int, seed: Optional[int] = None):
        super().__init__()
        rng = np.random.default_rng(seed)
        self.weight = Tensor(
            rng.normal(0.0, 0.02, size=(num_embeddings, embedding_dim)).astype(np.float32),
            requires_grad=True,
        )

    def __call__(self, indices: np.ndarray) -> Tensor:
        idx = np.asarray(indices, dtype=np.int64)
        out = Tensor(
            self.weight.data[idx],
            requires_grad=self.weight.requires_grad,
            _children=(self.weight,),
            _op="embedding",
        )

        def _backward():
            if out.grad is not None and self.weight.requires_grad:
                g = np.zeros_like(self.weight.data, dtype=np.float32)
                np.add.at(g, idx, out.grad)
                self.weight.accumulate_grad(g)

        out._backward = _backward
        return out


class LayerNorm(Module):
    def __init__(self, normalized_shape: int, eps: float = 1e-5):
        super().__init__()
        self.eps = eps
        self.weight = Tensor(np.ones((normalized_shape,), dtype=np.float32), requires_grad=True)
        self.bias = Tensor(np.zeros((normalized_shape,), dtype=np.float32), requires_grad=True)

    def __call__(self, x: Tensor) -> Tensor:
        mean = x.data.mean(axis=-1, keepdims=True)
        var = x.data.var(axis=-1, keepdims=True)
        inv_std = 1.0 / np.sqrt(var + self.eps)
        norm = (x.data - mean) * inv_std
        out_data = norm * self.weight.data + self.bias.data
        req = x.requires_grad or self.weight.requires_grad or self.bias.requires_grad
        out = Tensor(
            out_data,
            requires_grad=req,
            _children=(x, self.weight, self.bias),
            _op="layernorm",
        )
        d = float(x.shape[-1])

        def _backward():
            if out.grad is None:
                return
            g = out.grad
            if self.weight.requires_grad:
                self.weight.accumulate_grad(np.sum(g * norm, axis=tuple(range(g.ndim - 1))))
            if self.bias.requires_grad:
                self.bias.accumulate_grad(np.sum(g, axis=tuple(range(g.ndim - 1))))
            if x.requires_grad:
                gn = g * self.weight.data
                sum_gn = np.sum(gn, axis=-1, keepdims=True)
                sum_gn_norm = np.sum(gn * norm, axis=-1, keepdims=True)
                gx = (inv_std / d) * (d * gn - sum_gn - norm * sum_gn_norm)
                x.accumulate_grad(gx)

        out._backward = _backward
        return out


class RMSNorm(Module):
    def __init__(self, dim: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        self.weight = Tensor(np.ones((dim,), dtype=np.float32), requires_grad=True)

    def __call__(self, x: Tensor) -> Tensor:
        sq_mean = np.mean(x.data * x.data, axis=-1, keepdims=True)
        inv_rms = 1.0 / np.sqrt(sq_mean + self.eps)
        norm = x.data * inv_rms
        out_data = norm * self.weight.data
        out = Tensor(
            out_data,
            requires_grad=x.requires_grad or self.weight.requires_grad,
            _children=(x, self.weight),
            _op="rmsnorm",
        )
        d = float(x.shape[-1])

        def _backward():
            if out.grad is None:
                return
            g = out.grad
            if self.weight.requires_grad:
                self.weight.accumulate_grad(np.sum(g * norm, axis=tuple(range(g.ndim - 1))))
            if x.requires_grad:
                gn = g * self.weight.data
                dot = np.mean(gn * norm, axis=-1, keepdims=True)
                gx = inv_rms * (gn - norm * dot)
                x.accumulate_grad(gx)

        out._backward = _backward
        return out


def _im2col(x: np.ndarray, kh: int, kw: int, stride: int, pad: int) -> Tuple[np.ndarray, int, int]:
    n, c, h, w = x.shape
    if pad > 0:
        xp = np.pad(x, ((0, 0), (0, 0), (pad, pad), (pad, pad)), mode="constant")
    else:
        xp = x
    hp, wp = xp.shape[2], xp.shape[3]
    oh = (hp - kh) // stride + 1
    ow = (wp - kw) // stride + 1
    s0, s1, s2, s3 = xp.strides
    cols = np.lib.stride_tricks.as_strided(
        xp,
        shape=(n, oh, ow, c, kh, kw),
        strides=(s0, s2 * stride, s3 * stride, s1, s2, s3),
    )
    return cols.reshape(n * oh * ow, c * kh * kw).copy(), oh, ow


def _col2im(cols: np.ndarray, x_shape: Tuple[int, int, int, int], kh: int, kw: int, stride: int, pad: int, oh: int, ow: int) -> np.ndarray:
    n, c, h, w = x_shape
    hp = h + 2 * pad
    wp = w + 2 * pad
    dxp = np.zeros((n, c, hp, wp), dtype=np.float32)
    cols_6d = cols.reshape(n, oh, ow, c, kh, kw)
    for i in range(kh):
        i_max = i + stride * oh
        for j in range(kw):
            j_max = j + stride * ow
            dxp[:, :, i:i_max:stride, j:j_max:stride] += cols_6d[:, :, :, :, i, j].transpose(0, 3, 1, 2)
    if pad > 0:
        return dxp[:, :, pad:-pad, pad:-pad]
    return dxp


class Conv2d(Module):
    """Fast im2col-based 2D convolution (NCHW)."""

    def __init__(
        self,
        in_channels: int,
        out_channels: int,
        kernel_size: int = 3,
        stride: int = 1,
        padding: int = 1,
        bias: bool = True,
        seed: Optional[int] = None,
    ):
        super().__init__()
        self.in_channels = in_channels
        self.out_channels = out_channels
        self.kh = kernel_size
        self.kw = kernel_size
        self.stride = stride
        self.padding = padding
        rng = np.random.default_rng(seed)
        fan_in = in_channels * self.kh * self.kw
        std = math.sqrt(2.0 / float(fan_in))
        self.weight = Tensor(
            rng.normal(0.0, std, size=(out_channels, in_channels, self.kh, self.kw)).astype(np.float32),
            requires_grad=True,
        )
        self.bias = Tensor(np.zeros((out_channels,), dtype=np.float32), requires_grad=True) if bias else None

    def __call__(self, x: Tensor) -> Tensor:
        n, _, h, w = x.shape
        cols, oh, ow = _im2col(x.data, self.kh, self.kw, self.stride, self.padding)
        w_mat = self.weight.data.reshape(self.out_channels, -1)  # (C_out, C_in*kh*kw)
        out_2d = cols @ w_mat.T  # (N*oh*ow, C_out)
        if self.bias is not None:
            out_2d += self.bias.data
        out_4d = out_2d.reshape(n, oh, ow, self.out_channels).transpose(0, 3, 1, 2)
        children = (x, self.weight, self.bias) if self.bias is not None else (x, self.weight)
        req = any(c.requires_grad for c in children)
        out = Tensor(out_4d, requires_grad=req, _children=children, _op="conv2d")

        def _backward():
            if out.grad is None:
                return
            g_2d = out.grad.transpose(0, 2, 3, 1).reshape(-1, self.out_channels)
            if self.bias is not None and self.bias.requires_grad:
                self.bias.accumulate_grad(g_2d.sum(axis=0))
            if self.weight.requires_grad:
                gw = (g_2d.T @ cols).reshape(self.weight.shape)
                self.weight.accumulate_grad(gw)
            if x.requires_grad:
                dcols = g_2d @ w_mat
                dx = _col2im(dcols, x.shape, self.kh, self.kw, self.stride, self.padding, oh, ow)
                x.accumulate_grad(dx)

        out._backward = _backward
        return out


class Upsample2x(Module):
    """Nearest-neighbor 2x spatial upsampling (NCHW)."""

    def __call__(self, x: Tensor) -> Tensor:
        y = np.repeat(np.repeat(x.data, 2, axis=2), 2, axis=3)
        out = Tensor(y, requires_grad=x.requires_grad, _children=(x,), _op="upsample2x")

        def _backward():
            if out.grad is not None and x.requires_grad:
                n, c, h, w = x.shape
                g = out.grad.reshape(n, c, h, 2, w, 2).sum(axis=(3, 5))
                x.accumulate_grad(g)

        out._backward = _backward
        return out


class MaxPool2x(Module):
    """2x2 stride-2 max pooling (NCHW)."""

    def __call__(self, x: Tensor) -> Tensor:
        n, c, h, w = x.shape
        oh, ow = h // 2, w // 2
        xr = x.data[:, :, : oh * 2, : ow * 2].reshape(n, c, oh, 2, ow, 2)
        y = xr.max(axis=(3, 5))
        out = Tensor(y, requires_grad=x.requires_grad, _children=(x,), _op="maxpool2x")

        def _backward():
            if out.grad is not None and x.requires_grad:
                mask = xr == y[:, :, :, None, :, None]
                # Divide ties equally
                norm = np.maximum(mask.sum(axis=(3, 5), keepdims=True), 1.0)
                gx = np.zeros_like(x.data, dtype=np.float32)
                gx[:, :, : oh * 2, : ow * 2] = (
                    (mask / norm) * out.grad[:, :, :, None, :, None]
                ).reshape(n, c, oh * 2, ow * 2)
                x.accumulate_grad(gx)

        out._backward = _backward
        return out


class MultiHeadAttention(Module):
    def __init__(self, d_model: int, n_heads: int, causal: bool = False, seed: Optional[int] = None):
        super().__init__()
        assert d_model % n_heads == 0
        self.d_model = d_model
        self.n_heads = n_heads
        self.head_dim = d_model // n_heads
        self.causal = causal
        s = seed or 0
        self.q_proj = Linear(d_model, d_model, bias=False, seed=s + 1)
        self.k_proj = Linear(d_model, d_model, bias=False, seed=s + 2)
        self.v_proj = Linear(d_model, d_model, bias=False, seed=s + 3)
        self.o_proj = Linear(d_model, d_model, bias=False, seed=s + 4)

    def __call__(self, x: Tensor, kv: Optional[Tensor] = None) -> Tensor:
        b, t, d = x.shape
        kv_in = x if kv is None else kv
        tk = kv_in.shape[1]

        q = self.q_proj(x).reshape(b, t, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        k = self.k_proj(kv_in).reshape(b, tk, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)
        v = self.v_proj(kv_in).reshape(b, tk, self.n_heads, self.head_dim).transpose(0, 2, 1, 3)

        scale = 1.0 / math.sqrt(float(self.head_dim))
        scores = (q @ k.swapaxes(-1, -2)) * scale
        if self.causal and kv is None:
            mask = np.triu(np.full((t, tk), -1e9, dtype=np.float32), k=1)
            scores = scores + mask
        attn = scores.softmax(axis=-1)
        out = (attn @ v).transpose(0, 2, 1, 3).reshape(b, t, d)
        return self.o_proj(out)


class SwiGLU(Module):
    def __init__(self, d_model: int, hidden_dim: int, seed: Optional[int] = None):
        super().__init__()
        s = seed or 0
        self.w_gate = Linear(d_model, hidden_dim, bias=False, seed=s + 1)
        self.w_up = Linear(d_model, hidden_dim, bias=False, seed=s + 2)
        self.w_down = Linear(hidden_dim, d_model, bias=False, seed=s + 3)

    def __call__(self, x: Tensor) -> Tensor:
        return self.w_down(self.w_gate(x).silu() * self.w_up(x))


class TransformerBlock(Module):
    def __init__(
        self,
        d_model: int,
        n_heads: int,
        ffn_mult: float = 2.5,
        causal: bool = False,
        seed: Optional[int] = None,
    ):
        super().__init__()
        s = seed or 0
        self.norm1 = RMSNorm(d_model)
        self.attn = MultiHeadAttention(d_model, n_heads, causal=causal, seed=s + 10)
        self.norm2 = RMSNorm(d_model)
        self.ffn = SwiGLU(d_model, int(d_model * ffn_mult), seed=s + 20)

    def __call__(self, x: Tensor, context: Optional[Tensor] = None) -> Tensor:
        h = x + self.attn(self.norm1(x), kv=context)
        return h + self.ffn(self.norm2(h))


class ResBlock2d(Module):
    def __init__(self, channels: int, cond_dim: Optional[int] = None, seed: Optional[int] = None):
        super().__init__()
        s = seed or 0
        self.conv1 = Conv2d(channels, channels, 3, 1, 1, seed=s + 1)
        self.conv2 = Conv2d(channels, channels, 3, 1, 1, seed=s + 2)
        self.cond_proj = Linear(cond_dim, channels, seed=s + 3) if cond_dim else None

    def __call__(self, x: Tensor, cond: Optional[Tensor] = None) -> Tensor:
        h = self.conv1(x).silu()
        if self.cond_proj is not None and cond is not None:
            c = self.cond_proj(cond).reshape(cond.shape[0], -1, 1, 1)
            h = h + c
        h = self.conv2(h)
        return (x + h).silu()


class SinusoidalTimeEmbedding(Module):
    def __init__(self, dim: int):
        super().__init__()
        self.dim = dim

    def __call__(self, t: np.ndarray) -> Tensor:
        half = self.dim // 2
        freqs = np.exp(
            -math.log(10000.0) * np.arange(half, dtype=np.float32) / max(half - 1, 1)
        )
        args = t[:, None].astype(np.float32) * freqs[None, :]
        emb = np.concatenate([np.sin(args), np.cos(args)], axis=-1)
        if emb.shape[1] < self.dim:
            emb = np.pad(emb, ((0, 0), (0, self.dim - emb.shape[1])))
        return Tensor(emb, requires_grad=False)

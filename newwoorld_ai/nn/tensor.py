"""Vectorized Tensor and reverse-mode Autograd engine (float32)."""

from __future__ import annotations
import numpy as np
from typing import Callable, Iterable, Optional, Sequence, Tuple, Union


def _unbroadcast(grad: np.ndarray, target_shape: Tuple[int, ...]) -> np.ndarray:
    """Sum gradient along broadcasted axes to match target_shape."""
    if grad.shape == target_shape:
        return grad
    if target_shape == ():
        return np.array(grad.sum(), dtype=np.float32)
    while grad.ndim > len(target_shape):
        grad = grad.sum(axis=0)
    for axis, (g_dim, t_dim) in enumerate(zip(grad.shape, target_shape)):
        if t_dim == 1 and g_dim != 1:
            grad = grad.sum(axis=axis, keepdims=True)
    return grad.astype(np.float32, copy=False)


_NOOP = lambda: None


class Tensor:
    """N-dimensional float32 tensor with reverse-mode automatic differentiation."""

    def __init__(
        self,
        data: Union[np.ndarray, float, int, Sequence],
        requires_grad: bool = False,
        _children: Tuple["Tensor", ...] = (),
        _op: str = "",
    ):
        if isinstance(data, np.ndarray):
            arr = data.astype(np.float32, copy=False)
        else:
            arr = np.asarray(data, dtype=np.float32)
        self.data: np.ndarray = arr
        self.requires_grad: bool = bool(requires_grad)
        self.grad: Optional[np.ndarray] = None
        self._backward: Callable[[], None] = _NOOP
        self._prev: Tuple["Tensor", ...] = _children
        self._op: str = _op

    @property
    def shape(self) -> Tuple[int, ...]:
        return self.data.shape

    @property
    def ndim(self) -> int:
        return self.data.ndim

    @property
    def size(self) -> int:
        return self.data.size

    def zero_grad(self) -> None:
        self.grad = None

    def accumulate_grad(self, g: np.ndarray) -> None:
        if not self.requires_grad:
            return
        g32 = g.astype(np.float32, copy=False)
        if self.grad is None:
            self.grad = g32.copy()
        else:
            self.grad += g32

    def numpy(self) -> np.ndarray:
        return self.data

    def item(self) -> float:
        return float(self.data.item())

    def detach(self) -> "Tensor":
        return Tensor(self.data.copy(), requires_grad=False)

    def __repr__(self) -> str:
        return f"Tensor(shape={self.shape}, requires_grad={self.requires_grad}, op={self._op!r})"

    @staticmethod
    def _ensure(other: Union["Tensor", float, int, np.ndarray]) -> "Tensor":
        return other if isinstance(other, Tensor) else Tensor(other, requires_grad=False)

    def __add__(self, other: Union["Tensor", float, int, np.ndarray]) -> "Tensor":
        other = self._ensure(other)
        req = self.requires_grad or other.requires_grad
        out = Tensor(self.data + other.data, requires_grad=req, _children=(self, other), _op="add")

        def _backward():
            if out.grad is None:
                return
            if self.requires_grad:
                self.accumulate_grad(_unbroadcast(out.grad, self.shape))
            if other.requires_grad:
                other.accumulate_grad(_unbroadcast(out.grad, other.shape))

        out._backward = _backward
        return out

    def __radd__(self, other) -> "Tensor":
        return self.__add__(other)

    def __neg__(self) -> "Tensor":
        out = Tensor(-self.data, requires_grad=self.requires_grad, _children=(self,), _op="neg")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(-out.grad)

        out._backward = _backward
        return out

    def __sub__(self, other: Union["Tensor", float, int, np.ndarray]) -> "Tensor":
        return self + (-self._ensure(other))

    def __rsub__(self, other) -> "Tensor":
        return self._ensure(other) + (-self)

    def __mul__(self, other: Union["Tensor", float, int, np.ndarray]) -> "Tensor":
        other = self._ensure(other)
        req = self.requires_grad or other.requires_grad
        out = Tensor(self.data * other.data, requires_grad=req, _children=(self, other), _op="mul")

        def _backward():
            if out.grad is None:
                return
            if self.requires_grad:
                self.accumulate_grad(_unbroadcast(out.grad * other.data, self.shape))
            if other.requires_grad:
                other.accumulate_grad(_unbroadcast(out.grad * self.data, other.shape))

        out._backward = _backward
        return out

    def __rmul__(self, other) -> "Tensor":
        return self.__mul__(other)

    def __truediv__(self, other: Union["Tensor", float, int, np.ndarray]) -> "Tensor":
        other = self._ensure(other)
        req = self.requires_grad or other.requires_grad
        out = Tensor(self.data / other.data, requires_grad=req, _children=(self, other), _op="div")

        def _backward():
            if out.grad is None:
                return
            if self.requires_grad:
                self.accumulate_grad(_unbroadcast(out.grad / other.data, self.shape))
            if other.requires_grad:
                other.accumulate_grad(
                    _unbroadcast(-out.grad * self.data / (other.data * other.data), other.shape)
                )

        out._backward = _backward
        return out

    def __pow__(self, power: float) -> "Tensor":
        out = Tensor(self.data ** power, requires_grad=self.requires_grad, _children=(self,), _op="pow")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(out.grad * power * (self.data ** (power - 1.0)))

        out._backward = _backward
        return out

    def __matmul__(self, other: "Tensor") -> "Tensor":
        other = self._ensure(other)
        req = self.requires_grad or other.requires_grad
        out_data = np.matmul(self.data, other.data)
        out = Tensor(out_data, requires_grad=req, _children=(self, other), _op="matmul")

        def _backward():
            if out.grad is None:
                return
            g = out.grad
            a = self.data
            b = other.data
            if a.ndim == 2 and b.ndim == 2:
                if self.requires_grad:
                    self.accumulate_grad(g @ b.T)
                if other.requires_grad:
                    other.accumulate_grad(a.T @ g)
            else:
                if self.requires_grad:
                    ga = np.matmul(g, np.swapaxes(b, -1, -2))
                    self.accumulate_grad(_unbroadcast(ga, a.shape))
                if other.requires_grad:
                    gb = np.matmul(np.swapaxes(a, -1, -2), g)
                    other.accumulate_grad(_unbroadcast(gb, b.shape))

        out._backward = _backward
        return out

    def reshape(self, *shape: int) -> "Tensor":
        if len(shape) == 1 and isinstance(shape[0], (tuple, list)):
            shape = tuple(shape[0])
        orig_shape = self.shape
        out = Tensor(self.data.reshape(shape), requires_grad=self.requires_grad, _children=(self,), _op="reshape")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(out.grad.reshape(orig_shape))

        out._backward = _backward
        return out

    def transpose(self, *axes: int) -> "Tensor":
        if len(axes) == 1 and isinstance(axes[0], (tuple, list)):
            axes = tuple(axes[0])
        inv_axes = tuple(np.argsort(axes))
        out = Tensor(
            np.transpose(self.data, axes),
            requires_grad=self.requires_grad,
            _children=(self,),
            _op="transpose",
        )

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(np.transpose(out.grad, inv_axes))

        out._backward = _backward
        return out

    def swapaxes(self, ax1: int, ax2: int) -> "Tensor":
        out = Tensor(
            np.swapaxes(self.data, ax1, ax2),
            requires_grad=self.requires_grad,
            _children=(self,),
            _op="swapaxes",
        )

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(np.swapaxes(out.grad, ax1, ax2))

        out._backward = _backward
        return out

    def __getitem__(self, idx) -> "Tensor":
        out = Tensor(self.data[idx], requires_grad=self.requires_grad, _children=(self,), _op="slice")

        def _backward():
            if out.grad is not None and self.requires_grad:
                g = np.zeros_like(self.data, dtype=np.float32)
                np.add.at(g, idx, out.grad)
                self.accumulate_grad(g)

        out._backward = _backward
        return out

    def sum(self, axis: Optional[Union[int, Tuple[int, ...]]] = None, keepdims: bool = False) -> "Tensor":
        out = Tensor(
            self.data.sum(axis=axis, keepdims=keepdims),
            requires_grad=self.requires_grad,
            _children=(self,),
            _op="sum",
        )

        def _backward():
            if out.grad is None or not self.requires_grad:
                return
            g = out.grad
            if not keepdims and axis is not None:
                axes = (axis,) if isinstance(axis, int) else tuple(axis)
                axes = tuple(ax if ax >= 0 else self.ndim + ax for ax in axes)
                for ax in sorted(axes):
                    g = np.expand_dims(g, axis=ax)
            self.accumulate_grad(np.broadcast_to(g, self.shape).astype(np.float32))

        out._backward = _backward
        return out

    def mean(self, axis: Optional[Union[int, Tuple[int, ...]]] = None, keepdims: bool = False) -> "Tensor":
        if axis is None:
            denom = float(self.size)
        elif isinstance(axis, int):
            denom = float(self.shape[axis])
        else:
            denom = float(np.prod([self.shape[a] for a in axis]))
        return self.sum(axis=axis, keepdims=keepdims) * (1.0 / denom)

    def exp(self) -> "Tensor":
        ex = np.exp(np.clip(self.data, -40.0, 40.0))
        out = Tensor(ex, requires_grad=self.requires_grad, _children=(self,), _op="exp")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(out.grad * ex)

        out._backward = _backward
        return out

    def relu(self) -> "Tensor":
        mask = self.data > 0.0
        out = Tensor(np.where(mask, self.data, 0.0), requires_grad=self.requires_grad, _children=(self,), _op="relu")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(np.where(mask, out.grad, 0.0))

        out._backward = _backward
        return out

    def silu(self) -> "Tensor":
        x = np.clip(self.data, -40.0, 40.0)
        sig = 1.0 / (1.0 + np.exp(-x))
        y = self.data * sig
        out = Tensor(y, requires_grad=self.requires_grad, _children=(self,), _op="silu")

        def _backward():
            if out.grad is not None and self.requires_grad:
                ds = sig * (1.0 + self.data * (1.0 - sig))
                self.accumulate_grad(out.grad * ds)

        out._backward = _backward
        return out

    def gelu(self) -> "Tensor":
        # Tanh approximation of GELU
        x = self.data
        c = np.sqrt(2.0 / np.pi, dtype=np.float32)
        u = c * (x + 0.044715 * (x ** 3))
        th = np.tanh(u)
        y = 0.5 * x * (1.0 + th)
        out = Tensor(y, requires_grad=self.requires_grad, _children=(self,), _op="gelu")

        def _backward():
            if out.grad is not None and self.requires_grad:
                du = c * (1.0 + 3.0 * 0.044715 * (x ** 2))
                dth = (1.0 - th * th) * du
                dy = 0.5 * (1.0 + th) + 0.5 * x * dth
                self.accumulate_grad(out.grad * dy)

        out._backward = _backward
        return out

    def tanh(self) -> "Tensor":
        th = np.tanh(self.data)
        out = Tensor(th, requires_grad=self.requires_grad, _children=(self,), _op="tanh")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(out.grad * (1.0 - th * th))

        out._backward = _backward
        return out

    def sigmoid(self) -> "Tensor":
        x = np.clip(self.data, -40.0, 40.0)
        sig = 1.0 / (1.0 + np.exp(-x))
        out = Tensor(sig, requires_grad=self.requires_grad, _children=(self,), _op="sigmoid")

        def _backward():
            if out.grad is not None and self.requires_grad:
                self.accumulate_grad(out.grad * sig * (1.0 - sig))

        out._backward = _backward
        return out

    def softmax(self, axis: int = -1) -> "Tensor":
        x_max = np.max(self.data, axis=axis, keepdims=True)
        ex = np.exp(self.data - x_max)
        s = ex / np.sum(ex, axis=axis, keepdims=True)
        out = Tensor(s, requires_grad=self.requires_grad, _children=(self,), _op="softmax")

        def _backward():
            if out.grad is not None and self.requires_grad:
                dot = np.sum(out.grad * s, axis=axis, keepdims=True)
                self.accumulate_grad(s * (out.grad - dot))

        out._backward = _backward
        return out

    def backward(self, grad: Optional[np.ndarray] = None) -> None:
        topo = []
        visited = set()

        def build(v: Tensor) -> None:
            vid = id(v)
            if vid not in visited:
                visited.add(vid)
                for child in v._prev:
                    build(child)
                topo.append(v)

        build(self)
        if grad is None:
            self.grad = np.ones_like(self.data, dtype=np.float32)
        else:
            self.grad = grad.astype(np.float32, copy=False)

        for v in reversed(topo):
            v._backward()
            has_children = bool(v._prev)
            v._backward = _NOOP
            v._prev = ()
            if has_children:
                v.grad = None


def cat(tensors: Sequence[Tensor], axis: int = 0) -> Tensor:
    req = any(t.requires_grad for t in tensors)
    data = np.concatenate([t.data for t in tensors], axis=axis)
    out = Tensor(data, requires_grad=req, _children=tuple(tensors), _op="cat")
    sizes = [t.shape[axis] for t in tensors]
    splits = np.cumsum(sizes[:-1]).tolist()

    def _backward():
        if out.grad is None:
            return
        grads = np.split(out.grad, splits, axis=axis)
        for t, g in zip(tensors, grads):
            if t.requires_grad:
                t.accumulate_grad(g)

    out._backward = _backward
    return out


def stack(tensors: Sequence[Tensor], axis: int = 0) -> Tensor:
    req = any(t.requires_grad for t in tensors)
    data = np.stack([t.data for t in tensors], axis=axis)
    out = Tensor(data, requires_grad=req, _children=tuple(tensors), _op="stack")

    def _backward():
        if out.grad is None:
            return
        for i, t in enumerate(tensors):
            if t.requires_grad:
                t.accumulate_grad(np.take(out.grad, i, axis=axis))

    out._backward = _backward
    return out


def cross_entropy_loss(
    logits: Tensor, targets: np.ndarray, ignore_index: int = -100, label_smoothing: float = 0.0
) -> Tensor:
    """Stable cross-entropy over the last axis of logits (..., C) with integer targets (...)."""
    orig_shape = logits.shape
    c = orig_shape[-1]
    flat_logits = logits.data.reshape(-1, c)
    flat_targets = np.asarray(targets, dtype=np.int64).reshape(-1)
    valid = flat_targets != ignore_index
    n_valid = int(np.sum(valid))
    if n_valid == 0:
        return Tensor(0.0, requires_grad=logits.requires_grad, _children=(logits,), _op="ce_empty")

    vl = flat_logits[valid]
    vt = flat_targets[valid]
    m = np.max(vl, axis=-1, keepdims=True)
    shifted = vl - m
    log_sum_exp = np.log(np.sum(np.exp(shifted), axis=-1, keepdims=True))
    log_probs = shifted - log_sum_exp
    probs = np.exp(log_probs)

    if label_smoothing > 0.0:
        nll = -log_probs[np.arange(n_valid), vt]
        smooth = -np.mean(log_probs, axis=-1)
        loss_val = float(np.mean((1.0 - label_smoothing) * nll + label_smoothing * smooth))
    else:
        loss_val = float(-np.mean(log_probs[np.arange(n_valid), vt]))

    out = Tensor(loss_val, requires_grad=logits.requires_grad, _children=(logits,), _op="cross_entropy")

    def _backward():
        if out.grad is None or not logits.requires_grad:
            return
        g_flat = np.zeros_like(flat_logits, dtype=np.float32)
        g_valid = probs.copy()
        if label_smoothing > 0.0:
            g_valid -= label_smoothing / float(c)
            g_valid[np.arange(n_valid), vt] -= (1.0 - label_smoothing)
        else:
            g_valid[np.arange(n_valid), vt] -= 1.0
        g_valid *= float(out.grad) / float(n_valid)
        g_flat[valid] = g_valid
        logits.accumulate_grad(g_flat.reshape(orig_shape))

    out._backward = _backward
    return out


def mse_loss(pred: Tensor, target: Union[Tensor, np.ndarray]) -> Tensor:
    t = target if isinstance(target, Tensor) else Tensor(target, requires_grad=False)
    diff = pred - t
    return (diff * diff).mean()


def huber_loss(pred: Tensor, target: Union[Tensor, np.ndarray], delta: float = 1.0) -> Tensor:
    t = target if isinstance(target, Tensor) else Tensor(target, requires_grad=False)
    diff = pred.data - t.data
    abs_d = np.abs(diff)
    quad = abs_d <= delta
    loss_arr = np.where(quad, 0.5 * diff * diff, delta * (abs_d - 0.5 * delta))
    out = Tensor(float(np.mean(loss_arr)), requires_grad=pred.requires_grad, _children=(pred,), _op="huber")

    def _backward():
        if out.grad is not None and pred.requires_grad:
            g = np.where(quad, diff, delta * np.sign(diff)) * (float(out.grad) / float(pred.size))
            pred.accumulate_grad(g)

    out._backward = _backward
    return out

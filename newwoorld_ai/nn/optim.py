"""Optimizers, LR Schedulers, and Gradient Clipping."""

from __future__ import annotations
import math
import numpy as np
from typing import Iterable, List
from .tensor import Tensor


def clip_grad_norm_(parameters: Iterable[Tensor], max_norm: float) -> float:
    params = [p for p in parameters if p.grad is not None]
    if not params:
        return 0.0
    total_sq = sum(float(np.sum(p.grad * p.grad)) for p in params)
    total_norm = math.sqrt(total_sq)
    if total_norm > max_norm and total_norm > 0.0:
        scale = float(max_norm / (total_norm + 1e-8))
        for p in params:
            p.grad *= scale
    return total_norm


class AdamW:
    def __init__(
        self,
        parameters: Iterable[Tensor],
        lr: float = 1e-3,
        betas: tuple[float, float] = (0.9, 0.999),
        eps: float = 1e-8,
        weight_decay: float = 1e-2,
    ):
        self.params: List[Tensor] = list(parameters)
        self.lr = lr
        self.beta1, self.beta2 = betas
        self.eps = eps
        self.weight_decay = weight_decay
        self.t = 0
        self.m = [np.zeros_like(p.data, dtype=np.float32) for p in self.params]
        self.v = [np.zeros_like(p.data, dtype=np.float32) for p in self.params]

    def zero_grad(self) -> None:
        for p in self.params:
            p.zero_grad()

    def step(self) -> None:
        self.t += 1
        bc1 = 1.0 - (self.beta1 ** self.t)
        bc2 = 1.0 - (self.beta2 ** self.t)
        for i, p in enumerate(self.params):
            if p.grad is None:
                continue
            g = p.grad
            if self.weight_decay != 0.0 and p.ndim >= 2:
                p.data *= 1.0 - self.lr * self.weight_decay
            self.m[i] = self.beta1 * self.m[i] + (1.0 - self.beta1) * g
            self.v[i] = self.beta2 * self.v[i] + (1.0 - self.beta2) * (g * g)
            m_hat = self.m[i] / bc1
            v_hat = self.v[i] / bc2
            p.data -= self.lr * m_hat / (np.sqrt(v_hat) + self.eps)


class CosineAnnealingLR:
    def __init__(self, optimizer: AdamW, total_steps: int, min_lr: float = 1e-5):
        self.optimizer = optimizer
        self.base_lr = optimizer.lr
        self.total_steps = max(total_steps, 1)
        self.min_lr = min_lr
        self.step_idx = 0

    def step(self) -> float:
        self.step_idx += 1
        progress = min(self.step_idx / self.total_steps, 1.0)
        lr = self.min_lr + 0.5 * (self.base_lr - self.min_lr) * (1.0 + math.cos(math.pi * progress))
        self.optimizer.lr = lr
        return lr

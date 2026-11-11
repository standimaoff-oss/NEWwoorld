import numpy as np
import pytest
from newwoorld_ai.nn import (
    Tensor,
    Linear,
    Conv2d,
    LayerNorm,
    RMSNorm,
    MultiHeadAttention,
    SwiGLU,
    Upsample2x,
    MaxPool2x,
    AdamW,
    cross_entropy_loss,
    mse_loss,
)


def numerical_grad(fn, arr: np.ndarray, eps: float = 1e-3) -> np.ndarray:
    grad = np.zeros_like(arr, dtype=np.float32)
    it = np.nditer(arr, flags=["multi_index"], op_flags=["readwrite"])
    while not it.finished:
        idx = it.multi_index
        orig = float(arr[idx])
        arr[idx] = orig + eps
        p = fn()
        arr[idx] = orig - eps
        m = fn()
        arr[idx] = orig
        grad[idx] = (p - m) / (2.0 * eps)
        it.iternext()
    return grad


def test_linear_and_activations_grad():
    rng = np.random.default_rng(42)
    x_data = rng.normal(size=(3, 5)).astype(np.float32)
    layer = Linear(5, 4, seed=7)

    def eval_fn():
        x = Tensor(x_data, requires_grad=True)
        y = layer(x).gelu()
        return float((y * y).sum().item())

    x = Tensor(x_data, requires_grad=True)
    loss = (layer(x).gelu() ** 2).sum()
    loss.backward()
    num_gx = numerical_grad(eval_fn, x_data)
    np.testing.assert_allclose(x.grad, num_gx, rtol=2e-2, atol=2e-2)


def test_layernorm_and_rmsnorm_grad():
    rng = np.random.default_rng(11)
    x_data = rng.normal(size=(2, 6)).astype(np.float32)
    ln = LayerNorm(6)
    rms = RMSNorm(6)

    for norm in (ln, rms):
        x = Tensor(x_data, requires_grad=True)
        w = Tensor(rng.normal(size=(2, 6)).astype(np.float32), requires_grad=False)
        loss = (norm(x) * w).sum()
        loss.backward()
        num_gx = numerical_grad(lambda: float((norm(Tensor(x_data)) * w).sum().item()), x_data)
        np.testing.assert_allclose(x.grad, num_gx, rtol=2e-2, atol=2e-2)


def test_conv2d_upsample_maxpool_grad():
    rng = np.random.default_rng(3)
    x_data = rng.normal(size=(2, 2, 4, 4)).astype(np.float32)
    conv = Conv2d(2, 3, kernel_size=3, stride=1, padding=1, seed=5)
    pool = MaxPool2x()
    up = Upsample2x()

    x = Tensor(x_data, requires_grad=True)
    y = up(pool(conv(x).silu()))
    loss = (y * y).mean()
    loss.backward()

    num_gx = numerical_grad(
        lambda: float((up(pool(conv(Tensor(x_data)).silu())) ** 2).mean().item()),
        x_data,
        eps=2e-3,
    )
    np.testing.assert_allclose(x.grad, num_gx, rtol=3e-2, atol=2e-2)


def test_attention_and_swiglu_grad():
    rng = np.random.default_rng(19)
    x_data = rng.normal(size=(2, 4, 8)).astype(np.float32)
    attn = MultiHeadAttention(8, 2, causal=True, seed=9)
    ffn = SwiGLU(8, 16, seed=10)

    x = Tensor(x_data, requires_grad=True)
    y = ffn(attn(x))
    loss = (y * y).mean()
    loss.backward()

    num_gx = numerical_grad(
        lambda: float((ffn(attn(Tensor(x_data))) ** 2).mean().item()),
        x_data,
        eps=2e-3,
    )
    np.testing.assert_allclose(x.grad, num_gx, rtol=3e-2, atol=2e-2)


def test_cross_entropy_and_adamw_convergence():
    rng = np.random.default_rng(100)
    X = rng.normal(size=(32, 6)).astype(np.float32)
    y = (X[:, 0] + 0.5 * X[:, 1] > 0).astype(np.int64)
    model = Linear(6, 2, seed=1)
    opt = AdamW(model.parameters(), lr=0.05)

    initial_loss = None
    for step in range(40):
        opt.zero_grad()
        logits = model(Tensor(X))
        loss = cross_entropy_loss(logits, y)
        if initial_loss is None:
            initial_loss = loss.item()
        loss.backward()
        opt.step()

    final_loss = cross_entropy_loss(model(Tensor(X)), y).item()
    assert final_loss < initial_loss * 0.4

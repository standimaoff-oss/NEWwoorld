"""Custom Vectorized Autograd & Neural Network Library for NEWwoorld AI."""

from .tensor import Tensor, cross_entropy_loss, mse_loss, huber_loss, cat, stack
from .layers import (
    Module,
    Linear,
    Embedding,
    LayerNorm,
    RMSNorm,
    Conv2d,
    Upsample2x,
    MaxPool2x,
    MultiHeadAttention,
    SwiGLU,
    TransformerBlock,
    ResBlock2d,
    SinusoidalTimeEmbedding,
)
from .optim import AdamW, CosineAnnealingLR, clip_grad_norm_
from .io import save_model_safetensors, load_model_safetensors, count_parameters

__all__ = [
    "Tensor",
    "cross_entropy_loss",
    "mse_loss",
    "huber_loss",
    "cat",
    "stack",
    "Module",
    "Linear",
    "Embedding",
    "LayerNorm",
    "RMSNorm",
    "Conv2d",
    "Upsample2x",
    "MaxPool2x",
    "MultiHeadAttention",
    "SwiGLU",
    "TransformerBlock",
    "ResBlock2d",
    "SinusoidalTimeEmbedding",
    "AdamW",
    "CosineAnnealingLR",
    "clip_grad_norm_",
    "save_model_safetensors",
    "load_model_safetensors",
    "count_parameters",
]

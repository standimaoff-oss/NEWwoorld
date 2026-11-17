"""Token storage validation and deterministic random context sampling."""
from __future__ import annotations

from pathlib import Path

import torch
from torch import Tensor


class TokenStream:
    def __init__(self, path: str | Path, context_length: int) -> None:
        self.path = Path(path)
        # tokenized.pt is produced locally by prepare_data.py, never accepted from an untrusted remote party.
        payload = torch.load(self.path, map_location="cpu", weights_only=False)
        if not isinstance(payload, dict) or payload.get("format") != 1 or "input_ids" not in payload:
            raise ValueError(f"{self.path} is not a NeuroYadro tokenized dataset (format 1)")
        ids = payload["input_ids"]
        if not isinstance(ids, Tensor) or ids.ndim != 1:
            raise ValueError("dataset input_ids must be a rank-1 tensor")
        if ids.numel() <= context_length:
            raise ValueError("dataset does not contain a full input/target context")
        self.ids = ids.to(dtype=torch.long).contiguous()
        self.context_length = context_length
        self.samples = self.ids.numel() - context_length

    def batch_for_step(self, *, batch_size: int, seed: int, step: int) -> Tensor:
        """Return the same contexts for a given (seed, step), including after resume."""
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        generator = torch.Generator(device="cpu")
        generator.manual_seed(seed + step * 1_000_003)
        starts = torch.randint(0, self.samples, (batch_size,), generator=generator)
        return torch.stack([self.ids[start : start + self.context_length + 1] for start in starts.tolist()])

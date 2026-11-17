"""Token storage validation and deterministic random context sampling.

Small proof-of-concept runs use one torch tensor.  Production runs use uint16 little-endian
shards that are memory-mapped on demand, so a multi-gigabyte corpus never becomes one Python
list or one RAM allocation.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import torch
from torch import Tensor


@dataclass(frozen=True)
class TokenShard:
    path: Path
    tokens: int
    sha256: str
    min_id: int
    max_id: int


class TokenStream:
    """A deterministic sampler for format-1 tensors and format-2 uint16 shard manifests."""

    def __init__(self, path: str | Path, context_length: int, *, verify_shards: bool = False) -> None:
        self.path = Path(path)
        self.context_length = context_length
        self.ids: Tensor | None = None
        self._shards: list[TokenShard] = []
        self._mapped: dict[Path, Tensor] = {}
        self._token_min = 0
        self._token_max = -1

        if self.path.suffix.lower() == ".json":
            self._load_shard_manifest(verify_shards)
        else:
            self._load_torch_tensor()
        if self.samples <= 0:
            raise ValueError("dataset does not contain a full input/target context")

    @property
    def samples(self) -> int:
        if self.ids is not None:
            return int(self.ids.numel()) - self.context_length
        return sum(max(0, shard.tokens - self.context_length) for shard in self._shards)

    @property
    def token_range(self) -> tuple[int, int]:
        return self._token_min, self._token_max

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def _load_torch_tensor(self) -> None:
        # tokenized.pt is produced locally by prepare_data.py, never accepted from an untrusted remote party.
        payload = torch.load(self.path, map_location="cpu", weights_only=False)
        if not isinstance(payload, dict) or payload.get("format") != 1 or "input_ids" not in payload:
            raise ValueError(f"{self.path} is not a NeuroYadro format-1 token tensor")
        ids = payload["input_ids"]
        if not isinstance(ids, Tensor) or ids.ndim != 1:
            raise ValueError("dataset input_ids must be a rank-1 tensor")
        self.ids = ids.to(dtype=torch.long).contiguous()
        self._token_min = int(self.ids.min())
        self._token_max = int(self.ids.max())

    def _load_shard_manifest(self, verify_shards: bool) -> None:
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if payload.get("format") != 2 or payload.get("storage") != "uint16le-shards":
            raise ValueError(f"{self.path} is not a NeuroYadro format-2 shard manifest")
        if int(payload.get("context_window", -1)) != self.context_length:
            raise ValueError("shard context window does not match the requested model configuration")
        token_min = int(payload.get("min_token_id", -1))
        token_max = int(payload.get("max_token_id", -1))
        raw_shards = payload.get("shards")
        if not isinstance(raw_shards, list) or not raw_shards:
            raise ValueError("shard manifest contains no shards")
        for entry in raw_shards:
            if not isinstance(entry, dict):
                raise ValueError("invalid shard entry")
            relative = entry.get("file")
            tokens = int(entry.get("tokens", 0))
            digest = entry.get("sha256")
            if not isinstance(relative, str) or tokens < 1 or not isinstance(digest, str):
                raise ValueError("invalid shard metadata")
            source = (self.path.parent / relative).resolve()
            if not source.is_file() or source.stat().st_size != tokens * 2:
                raise ValueError(f"shard size mismatch: {source}")
            if verify_shards and self._sha256(source) != digest:
                raise ValueError(f"shard checksum mismatch: {source}")
            self._shards.append(TokenShard(source, tokens, digest, token_min, token_max))
        self._token_min = token_min
        self._token_max = token_max

    def _mapped_shard(self, shard: TokenShard) -> Tensor:
        mapped = self._mapped.get(shard.path)
        if mapped is None:
            mapped = torch.from_file(str(shard.path), shared=False, size=shard.tokens, dtype=torch.uint16)
            self._mapped[shard.path] = mapped
        return mapped

    def batch_for_step(self, *, batch_size: int, seed: int, step: int) -> Tensor:
        """Return the same contexts for a given (seed, step), including after resume."""
        if batch_size < 1:
            raise ValueError("batch_size must be positive")
        generator = torch.Generator(device="cpu")
        generator.manual_seed(seed + step * 1_000_003)
        if self.ids is not None:
            starts = torch.randint(0, self.samples, (batch_size,), generator=generator)
            return torch.stack([self.ids[start : start + self.context_length + 1] for start in starts.tolist()])

        usable = [shard for shard in self._shards if shard.tokens > self.context_length]
        rows: list[Tensor] = []
        for _ in range(batch_size):
            shard = usable[int(torch.randint(0, len(usable), (1,), generator=generator).item())]
            start = int(torch.randint(0, shard.tokens - self.context_length, (1,), generator=generator).item())
            ids = self._mapped_shard(shard)[start : start + self.context_length + 1]
            rows.append(ids.to(dtype=torch.long))
        return torch.stack(rows)

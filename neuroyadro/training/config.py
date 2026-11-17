"""Architecture configuration validation shared by training and exporters."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ModelConfig:
    model_type: str
    model_name: str
    vocab_size: int
    hidden_size: int
    intermediate_size: int
    num_hidden_layers: int
    num_attention_heads: int
    num_key_value_heads: int
    max_position_embeddings: int
    rope_theta: float
    rms_norm_eps: float
    attention_dropout: float
    tie_word_embeddings: bool
    bos_token_id: int
    eos_token_id: int
    pad_token_id: int
    initializer_range: float

    @property
    def head_dim(self) -> int:
        return self.hidden_size // self.num_attention_heads

    def validate(self) -> None:
        if self.model_type != "llama":
            raise ValueError("GGUF export currently supports only the LLaMA-compatible architecture")
        if self.hidden_size % self.num_attention_heads:
            raise ValueError("hidden_size must be divisible by num_attention_heads")
        if self.num_key_value_heads != self.num_attention_heads:
            raise ValueError("only full multi-head attention is supported in the Stage 0 exporter")
        if self.head_dim % 2:
            raise ValueError("RoPE requires an even attention head dimension")
        if self.vocab_size < 512:
            raise ValueError("vocab_size is implausibly small")
        if self.max_position_embeddings < 64:
            raise ValueError("context must be at least 64 tokens")
        if min(self.bos_token_id, self.eos_token_id, self.pad_token_id) < 0:
            raise ValueError("special-token ids cannot be negative")
        if max(self.bos_token_id, self.eos_token_id, self.pad_token_id) >= self.vocab_size:
            raise ValueError("special-token ids must fit the vocabulary")

    def fingerprint(self) -> str:
        canonical = json.dumps(asdict(self), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def load_config(path: str | Path) -> ModelConfig:
    source = Path(path)
    raw: dict[str, Any] = json.loads(source.read_text(encoding="utf-8"))
    try:
        config = ModelConfig(**raw)
    except TypeError as error:
        raise ValueError(f"invalid model configuration in {source}: {error}") from error
    config.validate()
    return config

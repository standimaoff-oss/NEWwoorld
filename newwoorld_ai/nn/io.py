"""Model serialization using SafeTensors + JSON metadata."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, Optional
from safetensors.numpy import load_file, save_file
from .layers import Module


def count_parameters(model: Module) -> int:
    return sum(p.size for p in model.parameters())


def save_model_safetensors(
    model: Module,
    ckpt_path: Path,
    meta_path: Optional[Path] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    ckpt_path.parent.mkdir(parents=True, exist_ok=True)
    state = model.state_dict()
    str_meta = {"framework": "NEWwoorld-NN-v1", "params": str(count_parameters(model))}
    save_file(state, str(ckpt_path), metadata=str_meta)
    if meta_path is not None and metadata is not None:
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")


def load_model_safetensors(model: Module, ckpt_path: Path, strict: bool = True) -> None:
    state = load_file(str(ckpt_path))
    model.load_state_dict(state, strict=strict)

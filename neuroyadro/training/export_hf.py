"""Convert a verified NeuroYadro checkpoint into a Hugging Face Llama folder.

The output is intentionally an intermediate artefact. llama.cpp's own converter is used for
GGUF so tokenizer metadata is written by the runtime that will consume it.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from transformers import GenerationConfig, LlamaConfig, LlamaForCausalLM, LlamaTokenizer

from .config import load_config
from .model import NeuroYadroForCausalLM


def load_checkpoint(path: Path, config_path: Path) -> tuple[dict, NeuroYadroForCausalLM]:
    config = load_config(config_path)
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    if checkpoint.get("format") != 1:
        raise ValueError("not a NeuroYadro format-1 checkpoint")
    if checkpoint.get("config_fingerprint") != config.fingerprint():
        raise ValueError("checkpoint architecture does not match --config")
    custom_model = NeuroYadroForCausalLM(config)
    custom_model.load_state_dict(checkpoint["model"], strict=True)
    custom_model.eval()
    return checkpoint, custom_model


def hf_state_dict(source: dict[str, torch.Tensor], layers: int) -> dict[str, torch.Tensor]:
    mapped: dict[str, torch.Tensor] = {
        "model.embed_tokens.weight": source["embed_tokens.weight"],
        "model.norm.weight": source["norm.weight"],
        "lm_head.weight": source["lm_head.weight"],
    }
    for index in range(layers):
        source_prefix = f"layers.{index}."
        target_prefix = f"model.layers.{index}."
        mapped[target_prefix + "input_layernorm.weight"] = source[source_prefix + "input_layernorm.weight"]
        mapped[target_prefix + "post_attention_layernorm.weight"] = source[source_prefix + "post_attention_layernorm.weight"]
        for name in ("q_proj", "k_proj", "v_proj", "o_proj"):
            mapped[target_prefix + f"self_attn.{name}.weight"] = source[source_prefix + f"self_attn.{name}.weight"]
        for name in ("gate_proj", "up_proj", "down_proj"):
            mapped[target_prefix + f"mlp.{name}.weight"] = source[source_prefix + f"mlp.{name}.weight"]
    return mapped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True, help="tokenizer.model from prepare_data.py")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("configs/neuroyadro_25m.json"))
    args = parser.parse_args()

    if not args.tokenizer.is_file():
        raise FileNotFoundError(f"tokenizer not found: {args.tokenizer}")
    checkpoint, custom_model = load_checkpoint(args.checkpoint, args.config)
    config = custom_model.config
    tokenizer = LlamaTokenizer(
        vocab_file=str(args.tokenizer),
        unk_token="<unk>", bos_token="<s>", eos_token="</s>", pad_token="<pad>", legacy=False,
    )
    if tokenizer.vocab_size != config.vocab_size:
        raise ValueError(f"tokenizer has {tokenizer.vocab_size} tokens; model expects {config.vocab_size}")
    if (tokenizer.pad_token_id, tokenizer.bos_token_id, tokenizer.eos_token_id) != (
        config.pad_token_id, config.bos_token_id, config.eos_token_id,
    ):
        raise ValueError("tokenizer special tokens do not match the model architecture")

    hf_config = LlamaConfig(
        vocab_size=config.vocab_size,
        hidden_size=config.hidden_size,
        intermediate_size=config.intermediate_size,
        num_hidden_layers=config.num_hidden_layers,
        num_attention_heads=config.num_attention_heads,
        num_key_value_heads=config.num_key_value_heads,
        max_position_embeddings=config.max_position_embeddings,
        rms_norm_eps=config.rms_norm_eps,
        rope_theta=config.rope_theta,
        attention_dropout=config.attention_dropout,
        attention_bias=False,
        mlp_bias=False,
        tie_word_embeddings=config.tie_word_embeddings,
        bos_token_id=config.bos_token_id,
        eos_token_id=config.eos_token_id,
        pad_token_id=config.pad_token_id,
        initializer_range=config.initializer_range,
    )
    target = LlamaForCausalLM(hf_config)
    incompatible = target.load_state_dict(hf_state_dict(custom_model.state_dict(), config.num_hidden_layers), strict=True)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(f"state conversion incomplete: {incompatible}")

    output: Path = args.output
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"refusing to overwrite nonempty export directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    target.save_pretrained(output, safe_serialization=True, max_shard_size="2GB")
    tokenizer.save_pretrained(output)
    GenerationConfig(
        bos_token_id=config.bos_token_id,
        eos_token_id=config.eos_token_id,
        pad_token_id=config.pad_token_id,
        do_sample=True,
        temperature=0.7,
        top_p=0.9,
        repetition_penalty=1.12,
    ).save_pretrained(output)
    provenance = {
        "source_checkpoint": str(args.checkpoint.resolve()),
        "checkpoint_step": checkpoint["step"],
        "model_config_fingerprint": config.fingerprint(),
        "tokenizer_source": str(args.tokenizer.resolve()),
        "format": "huggingface-llama-compatible-v1",
    }
    (output / "neuroyadro_provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"output": str(output), "checkpoint_step": checkpoint["step"], "parameters": custom_model.parameter_count()}))


if __name__ == "__main__":
    main()

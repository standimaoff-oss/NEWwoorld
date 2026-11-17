"""Create a SentencePiece tokenizer and a token tensor from local text files.

The script deliberately accepts only local files. Dataset acquisition and licence review are
separate, explicit steps rather than a hidden downloader.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Iterable

import sentencepiece as spm
import torch

from .config import load_config


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_files(input_dir: Path) -> list[Path]:
    files = sorted(path for path in input_dir.rglob("*.txt") if path.is_file())
    if not files:
        raise FileNotFoundError(f"no .txt files found below {input_dir}")
    return files


def normalized_documents(files: Iterable[Path]) -> Iterable[str]:
    for source in files:
        text = source.read_text(encoding="utf-8", errors="strict").replace("\r\n", "\n")
        for line in text.splitlines():
            line = " ".join(line.split())
            if line:
                yield line


def build_tokenizer(corpus: Path, model_prefix: Path, vocab_size: int) -> Path:
    # The reserved ids agree with the GGUF/HF export configuration.
    spm.SentencePieceTrainer.train(
        input=str(corpus),
        model_prefix=str(model_prefix),
        model_type="bpe",
        vocab_size=vocab_size,
        character_coverage=0.9995,
        normalization_rule_name="nmt_nfkc_cf",
        split_digits=True,
        byte_fallback=True,
        shuffle_input_sentence=True,
        input_sentence_size=2_000_000,
        bos_id=2,
        eos_id=3,
        pad_id=0,
        unk_id=1,
        hard_vocab_limit=False,
    )
    return model_prefix.with_suffix(".model")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path, help="directory containing UTF-8 .txt files")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=Path("configs/neuroyadro_25m.json"))
    parser.add_argument("--min-characters", type=int, default=1, help="ignore shorter nonempty lines")
    args = parser.parse_args()

    config = load_config(args.config)
    files = text_files(args.input_dir)
    output: Path = args.output
    output.mkdir(parents=True, exist_ok=True)
    corpus_path = output / "corpus.normalized.txt"

    document_count = 0
    characters = 0
    with corpus_path.open("w", encoding="utf-8", newline="\n") as target:
        for line in normalized_documents(files):
            if len(line) < args.min_characters:
                continue
            target.write(line + "\n")
            document_count += 1
            characters += len(line)
    if document_count == 0:
        raise ValueError("the input contains no usable text after normalization")

    tokenizer_path = build_tokenizer(corpus_path, output / "tokenizer", config.vocab_size)
    tokenizer = spm.SentencePieceProcessor(model_file=str(tokenizer_path))
    if tokenizer.vocab_size() != config.vocab_size:
        raise RuntimeError(
            f"tokenizer has {tokenizer.vocab_size()} entries; expected exactly {config.vocab_size}. "
            "Increase corpus diversity or adjust the architecture config deliberately."
        )
    if (tokenizer.pad_id(), tokenizer.bos_id(), tokenizer.eos_id(), tokenizer.unk_id()) != (0, 2, 3, 1):
        raise RuntimeError("tokenizer special-token ids do not match the model configuration")

    all_ids: list[int] = []
    for line in normalized_documents(files):
        if len(line) >= args.min_characters:
            all_ids.extend(tokenizer.encode(line, out_type=int, add_bos=True, add_eos=True))
    tokens = torch.tensor(all_ids, dtype=torch.int32)
    if tokens.numel() <= config.max_position_embeddings:
        raise ValueError("the corpus is too small to form even one context window")
    dataset_path = output / "tokenized.pt"
    torch.save({"input_ids": tokens, "format": 1}, dataset_path)

    tokenizer_vocab = output / "tokenizer.vocab"
    manifest = {
        "format": 1,
        "model_config_fingerprint": config.fingerprint(),
        "model_name": config.model_name,
        "input_files": [{"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size} for path in files],
        "documents": document_count,
        "characters": characters,
        "tokens": int(tokens.numel()),
        "context_window": config.max_position_embeddings,
        "tokenizer": {"file": tokenizer_path.name, "sha256": sha256(tokenizer_path), "vocab_size": tokenizer.vocab_size()},
        "dataset": {"file": dataset_path.name, "sha256": sha256(dataset_path)},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Keep only the model and vocabulary as direct training inputs; corpus is reproducible but can be large.
    print(json.dumps({"output": str(output), "documents": document_count, "tokens": int(tokens.numel()), "vocab": tokenizer.vocab_size()}, ensure_ascii=False))


if __name__ == "__main__":
    main()

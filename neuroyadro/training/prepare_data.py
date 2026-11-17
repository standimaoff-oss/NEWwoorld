"""Create a SentencePiece tokenizer and an in-memory or sharded token dataset.

The script deliberately accepts only local files. Dataset acquisition and licence review are
separate, explicit steps rather than a hidden downloader.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from array import array
from pathlib import Path
from typing import Iterable, Iterator

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


def normalized_documents(files: Iterable[Path]) -> Iterator[str]:
    """Stream normalized lines; never read a complete production corpus into memory."""
    for source in files:
        with source.open("r", encoding="utf-8", errors="strict", newline=None) as handle:
            for raw_line in handle:
                line = " ".join(raw_line.split())
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
        max_sentence_length=20_000,
        bos_id=2,
        eos_id=3,
        pad_id=0,
        unk_id=1,
        hard_vocab_limit=False,
    )
    return model_prefix.with_suffix(".model")


class UInt16ShardWriter:
    def __init__(self, directory: Path, max_tokens: int) -> None:
        if max_tokens < 1024:
            raise ValueError("--shard-tokens must be at least 1024")
        self.directory = directory
        self.max_tokens = max_tokens
        self.buffer = array("H")
        self.shards: list[dict[str, int | str]] = []
        self.total_tokens = 0
        self.min_token_id = 65535
        self.max_token_id = 0
        directory.mkdir(parents=True, exist_ok=True)

    def append(self, ids: list[int]) -> None:
        if any(token < 0 or token > 65535 for token in ids):
            raise ValueError("uint16 sharded storage supports token IDs from 0 to 65535")
        self.buffer.extend(ids)
        self.total_tokens += len(ids)
        if ids:
            self.min_token_id = min(self.min_token_id, min(ids))
            self.max_token_id = max(self.max_token_id, max(ids))
        while len(self.buffer) >= self.max_tokens:
            self._flush(self.max_tokens)

    def _flush(self, count: int) -> None:
        index = len(self.shards)
        part = array("H", self.buffer[:count])
        del self.buffer[:count]
        if sys.byteorder != "little":
            part.byteswap()
        target = self.directory / f"tokens-{index:05d}.u16"
        target.write_bytes(part.tobytes())
        self.shards.append({"file": str(target.relative_to(self.directory.parent)), "tokens": count, "sha256": sha256(target)})

    def close(self) -> None:
        if self.buffer:
            self._flush(len(self.buffer))
        if not self.shards:
            raise ValueError("token writer received no tokens")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path, help="directory containing UTF-8 .txt files")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=Path("configs/neuroyadro_25m.json"))
    parser.add_argument("--min-characters", type=int, default=1, help="ignore shorter nonempty lines")
    parser.add_argument("--storage", choices=("pt", "shards"), default="pt",
                        help="pt is convenient for small smoke tests; shards memory-map production corpora")
    parser.add_argument("--shard-tokens", type=int, default=10_000_000)
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

    dataset: dict[str, object]
    token_count = 0
    if args.storage == "pt":
        all_ids: list[int] = []
        for line in normalized_documents(files):
            if len(line) >= args.min_characters:
                all_ids.extend(tokenizer.encode(line, out_type=int, add_bos=True, add_eos=True))
        tokens = torch.tensor(all_ids, dtype=torch.int32)
        token_count = int(tokens.numel())
        if token_count <= config.max_position_embeddings:
            raise ValueError("the corpus is too small to form even one context window")
        dataset_path = output / "tokenized.pt"
        torch.save({"input_ids": tokens, "format": 1}, dataset_path)
        dataset = {"format": "torch-pt", "file": dataset_path.name, "sha256": sha256(dataset_path),
                   "min_token_id": int(tokens.min()), "max_token_id": int(tokens.max())}
    else:
        writer = UInt16ShardWriter(output / "tokens", args.shard_tokens)
        for line in normalized_documents(files):
            if len(line) >= args.min_characters:
                writer.append(tokenizer.encode(line, out_type=int, add_bos=True, add_eos=True))
        writer.close()
        token_count = writer.total_tokens
        if token_count <= config.max_position_embeddings:
            raise ValueError("the corpus is too small to form even one context window")
        dataset_path = output / "tokenized.json"
        dataset = {"format": "uint16le-shards", "file": dataset_path.name, "shards": writer.shards,
                   "min_token_id": writer.min_token_id, "max_token_id": writer.max_token_id}
        dataset_path.write_text(json.dumps({
            "format": 2, "storage": "uint16le-shards", "context_window": config.max_position_embeddings,
            "model_config_fingerprint": config.fingerprint(), "tokens": token_count,
            "min_token_id": writer.min_token_id, "max_token_id": writer.max_token_id, "shards": writer.shards,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        dataset["sha256"] = sha256(dataset_path)

    manifest = {
        "format": 2,
        "model_config_fingerprint": config.fingerprint(),
        "model_name": config.model_name,
        "input_files": [{"path": str(path), "sha256": sha256(path), "bytes": path.stat().st_size} for path in files],
        "documents": document_count,
        "characters": characters,
        "tokens": token_count,
        "context_window": config.max_position_embeddings,
        "tokenizer": {"file": tokenizer_path.name, "sha256": sha256(tokenizer_path), "vocab_size": tokenizer.vocab_size()},
        "dataset": dataset,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "storage": args.storage, "documents": document_count,
                      "tokens": token_count, "vocab": tokenizer.vocab_size()}, ensure_ascii=False))


if __name__ == "__main__":
    main()

"""Resumable next-token training for NeuroYadro.

No background service is needed: the process writes self-contained atomic checkpoints so a
short Arena/desktop session can continue with --resume auto.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import time
from pathlib import Path
from typing import Any

import torch

from .config import load_config
from .dataset import TokenStream
from .model import NeuroYadroForCausalLM


def choose_device(requested: str) -> torch.device:
    if requested != "auto":
        device = torch.device(requested)
        if device.type == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested but is not available")
        return device
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def set_seed(seed: int) -> None:
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_torch_save(payload: dict[str, Any], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    torch.save(payload, temporary)
    os.replace(temporary, target)


def find_resume_checkpoint(output: Path, choice: str) -> Path | None:
    if choice == "none":
        return None
    if choice != "auto":
        path = Path(choice)
        if not path.is_file():
            raise FileNotFoundError(f"checkpoint does not exist: {path}")
        return path
    latest = output / "checkpoints" / "latest.pt"
    return latest if latest.is_file() else None


def learning_rate(base: float, step: int, total_steps: int, warmup_steps: int) -> float:
    if warmup_steps and step < warmup_steps:
        return base * (step + 1) / warmup_steps
    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
    return base * 0.1 + base * 0.9 * 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))


def checkpoint_payload(
    *, model: NeuroYadroForCausalLM, optimizer: torch.optim.Optimizer, step: int,
    config_fingerprint: str, dataset_path: Path, dataset_sha256: str, seed: int, args: argparse.Namespace,
) -> dict[str, Any]:
    return {
        "format": 1,
        "step": step,
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "config_fingerprint": config_fingerprint,
        "dataset_path": str(dataset_path.resolve()),
        "dataset_sha256": dataset_sha256,
        "seed": seed,
        "training_args": vars(args),
        "torch_rng_state": torch.get_rng_state(),
        "python_rng_state": random.getstate(),
        "cuda_rng_states": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--steps", type=int, required=True, help="target global step, not additional steps")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--warmup-steps", type=int, default=100)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--checkpoint-every", type=int, default=100)
    parser.add_argument("--log-every", type=int, default=10)
    parser.add_argument("--resume", default="auto", help="auto, none, or a checkpoint path")
    parser.add_argument("--device", default="auto", help="auto, cpu, cuda, cuda:0, mps")
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--clip-grad-norm", type=float, default=1.0)
    args = parser.parse_args()

    if min(args.steps, args.batch_size, args.grad_accum, args.checkpoint_every, args.log_every) < 1:
        raise ValueError("steps, batch size, gradient accumulation and intervals must be positive")
    if args.lr <= 0 or args.weight_decay < 0:
        raise ValueError("learning rate must be positive and weight decay non-negative")

    config = load_config(args.config)
    device = choose_device(args.device)
    set_seed(args.seed)
    stream = TokenStream(args.dataset, config.max_position_embeddings)
    dataset_sha256 = file_sha256(args.dataset)
    if int(stream.ids.max()) >= config.vocab_size or int(stream.ids.min()) < 0:
        raise ValueError("dataset token ids do not fit this model vocabulary")

    model = NeuroYadroForCausalLM(config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=args.weight_decay)
    args.output.mkdir(parents=True, exist_ok=True)
    checkpoints = args.output / "checkpoints"
    checkpoint = find_resume_checkpoint(args.output, args.resume)
    start_step = 0
    if checkpoint:
        saved: dict[str, Any] = torch.load(checkpoint, map_location="cpu", weights_only=False)
        if saved.get("format") != 1:
            raise ValueError(f"unsupported checkpoint format: {checkpoint}")
        if saved.get("config_fingerprint") != config.fingerprint():
            raise ValueError("checkpoint architecture does not match --config")
        if saved.get("seed") != args.seed:
            raise ValueError("--seed must match the checkpoint to retain deterministic batches")
        if saved.get("dataset_sha256") != dataset_sha256:
            raise ValueError("the tokenized dataset changed since this checkpoint")
        model.load_state_dict(saved["model"], strict=True)
        optimizer.load_state_dict(saved["optimizer"])
        for state in optimizer.state.values():
            for name, value in state.items():
                if isinstance(value, torch.Tensor):
                    state[name] = value.to(device)
        if "torch_rng_state" in saved:
            torch.set_rng_state(saved["torch_rng_state"])
        if "python_rng_state" in saved:
            random.setstate(saved["python_rng_state"])
        if device.type == "cuda" and saved.get("cuda_rng_states") is not None:
            torch.cuda.set_rng_state_all(saved["cuda_rng_states"])
        start_step = int(saved["step"])
        if start_step > args.steps:
            raise ValueError(f"checkpoint is at step {start_step}, above requested target {args.steps}")
        print(f"resuming {checkpoint} from step {start_step}")

    run_metadata = {
        "format": 1,
        "config": config.__dict__,
        "config_fingerprint": config.fingerprint(),
        "dataset": str(args.dataset.resolve()),
        "dataset_sha256": dataset_sha256,
        "device": str(device),
        "parameter_count": model.parameter_count(),
        "args": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
        "started_unix": time.time(),
    }
    (args.output / "run.json").write_text(json.dumps(run_metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    metrics_path = args.output / "metrics.jsonl"

    model.train()
    completed_step = start_step
    try:
        for step in range(start_step, args.steps):
            optimizer.zero_grad(set_to_none=True)
            accumulated_loss = 0.0
            started = time.perf_counter()
            for micro_step in range(args.grad_accum):
                batch = stream.batch_for_step(
                    batch_size=args.batch_size,
                    seed=args.seed,
                    step=step * args.grad_accum + micro_step,
                ).to(device, non_blocking=True)
                output = model(batch[:, :-1], labels=batch[:, 1:])
                assert output.loss is not None
                if not torch.isfinite(output.loss):
                    raise FloatingPointError(f"non-finite loss at step {step + 1}: {output.loss.item()}")
                (output.loss / args.grad_accum).backward()
                accumulated_loss += output.loss.detach().item()
            grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip_grad_norm).item())
            current_lr = learning_rate(args.lr, step, args.steps, args.warmup_steps)
            for group in optimizer.param_groups:
                group["lr"] = current_lr
            optimizer.step()
            completed = step + 1
            completed_step = completed
            elapsed = time.perf_counter() - started
            record = {
                "step": completed,
                "loss": accumulated_loss / args.grad_accum,
                "learning_rate": current_lr,
                "gradient_norm": grad_norm,
                "tokens_per_second": (args.batch_size * args.grad_accum * config.max_position_embeddings) / max(elapsed, 1e-9),
                "elapsed_seconds": elapsed,
            }
            if completed % args.log_every == 0 or completed == 1 or completed == args.steps:
                with metrics_path.open("a", encoding="utf-8") as log:
                    log.write(json.dumps(record, ensure_ascii=False) + "\n")
                print(json.dumps(record, ensure_ascii=False))
            if completed % args.checkpoint_every == 0 or completed == args.steps:
                payload = checkpoint_payload(
                    model=model, optimizer=optimizer, step=completed,
                    config_fingerprint=config.fingerprint(), dataset_path=args.dataset,
                    dataset_sha256=dataset_sha256, seed=args.seed, args=args,
                )
                numbered = checkpoints / f"step-{completed:08d}.pt"
                atomic_torch_save(payload, numbered)
                shutil.copy2(numbered, checkpoints / "latest.pt")
    except KeyboardInterrupt:
        print("interrupted; saving a resumable checkpoint")
        payload = checkpoint_payload(
            model=model, optimizer=optimizer, step=completed_step,
            config_fingerprint=config.fingerprint(), dataset_path=args.dataset,
            dataset_sha256=dataset_sha256, seed=args.seed, args=args,
        )
        atomic_torch_save(payload, checkpoints / "latest.pt")
        raise


if __name__ == "__main__":
    main()

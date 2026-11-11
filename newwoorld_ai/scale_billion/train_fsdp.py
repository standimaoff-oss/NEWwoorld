"""
Distributed FSDP / bf16 Multi-GPU Training Script for Billion-Parameter NEWwoorld Models.
Usage on GPU cluster:
  torchrun --nproc_per_node=8 -m newwoorld_ai.scale_billion.train_fsdp --preset cad_3.2b
"""

from __future__ import annotations
import argparse
import os
from .configs import BILLION_SCALE_CONFIGS, compute_cad_transformer_params, compute_photopart_dit_params


def main() -> None:
    parser = argparse.ArgumentParser(description="NEWwoorld Billion-Parameter FSDP Trainer")
    parser.add_argument("--preset", default="cad_1.2b", choices=list(BILLION_SCALE_CONFIGS.keys()))
    parser.add_argument("--steps", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--verify-only", action="store_true", help="Print parameter counts & memory footprint without GPU")
    args = parser.parse_args()

    cfg = BILLION_SCALE_CONFIGS[args.preset]
    if args.preset.startswith("cad"):
        n_params = compute_cad_transformer_params(cfg)
    else:
        n_params = compute_photopart_dit_params(cfg)

    print(f"Preset: {cfg.name}")
    print(f"Exact Parameters: {n_params:,} ({n_params / 1e9:.3f}B)")
    print(f"Estimated bf16 weights VRAM: {n_params * 2 / 1e9:.2f} GB")
    print(f"Estimated AdamW+Grads FSDP footprint: {n_params * 16 / 1e9:.2f} GB total across cluster")

    if args.verify_only:
        return

    import torch
    import torch.distributed as dist
    from torch.distributed.fsdp import FullyShardedDataParallel as FSDP
    from .cad_transformer_torch import CadGPTBillionModel

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA GPU cluster required for billion-parameter training. Use --verify-only on CPU.")

    dist.init_process_group(backend="nccl")
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    torch.cuda.set_device(local_rank)

    if args.preset.startswith("cad"):
        with torch.device("meta"):
            model = CadGPTBillionModel(cfg)
        model = FSDP(model.to_empty(device=torch.cuda.current_device()), use_orig_params=True)
        opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.1, betas=(0.9, 0.95))

        for step in range(1, args.steps + 1):
            x = torch.randint(0, cfg.vocab_size, (args.batch_size, 512), device=local_rank)
            y = torch.randint(0, cfg.vocab_size, (args.batch_size, 512), device=local_rank)
            opt.zero_grad()
            with torch.amp.autocast("cuda", dtype=torch.bfloat16):
                _, _, loss = model(x, y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            if local_rank == 0 and step % 50 == 0:
                print(f"[FSDP Step {step}/{args.steps}] loss={loss.item():.4f}")

    dist.destroy_process_group()


if __name__ == "__main__":
    main()

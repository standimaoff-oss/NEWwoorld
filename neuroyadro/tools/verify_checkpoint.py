"""Offline integrity report for a local NeuroYadro checkpoint."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Keep direct `python tools/verify_checkpoint.py` invocation usable.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

import torch

from training.config import load_config
from training.model import NeuroYadroForCausalLM


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path("configs/neuroyadro_25m.json"))
    args = parser.parse_args()
    config = load_config(args.config)
    saved = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    if saved.get("format") != 1 or saved.get("config_fingerprint") != config.fingerprint():
        raise SystemExit("checkpoint format or architecture fingerprint is invalid")
    model = NeuroYadroForCausalLM(config)
    model.load_state_dict(saved["model"], strict=True)
    print(json.dumps({"ok": True, "step": saved["step"], "parameters": model.parameter_count(), "config": config.model_name}))


if __name__ == "__main__":
    main()

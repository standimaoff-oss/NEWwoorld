"""Global configuration and model scaling specs for NEWwoorld AI."""

import sys
from pathlib import Path

if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    ROOT_DIR = Path(sys._MEIPASS)
    OUTPUTS_DIR = Path.cwd() / "outputs"
else:
    ROOT_DIR = Path(__file__).resolve().parent.parent
    OUTPUTS_DIR = ROOT_DIR / "outputs"

MODELS_DIR = ROOT_DIR / "models" / "checkpoints"
WEB_DIR = ROOT_DIR / "web"

MODELS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

CADGPT_CKPT = MODELS_DIR / "newwoorld_cadgpt_core.safetensors"
CADGPT_META = MODELS_DIR / "newwoorld_cadgpt_core.json"

PHOTOPART_CKPT = MODELS_DIR / "newwoorld_photopart_core.safetensors"
PHOTOPART_META = MODELS_DIR / "newwoorld_photopart_core.json"

VISION_OCR_CKPT = MODELS_DIR / "newwoorld_vision_ocr_core.safetensors"
VISION_OCR_META = MODELS_DIR / "newwoorld_vision_ocr_core.json"

TRAINING_REPORT_PATH = MODELS_DIR / "training_report.json"

# Scaling Roadmap Presets (CPU Core vs Multi-GPU Billion-Parameter Scale)
MODEL_SCALING_CATALOG = {
    "core_cpu": {
        "name": "NEWwoorld Core v1 (Trained Local)",
        "cad_params": "460,614",
        "photo_params": "352,992",
        "vision_ocr_params": "191,348",
        "total_trained_params": "1,004,954",
        "hardware": "Any CPU / 4 GB RAM",
        "status": "Trained & Active",
    },
    "cad_1.2b": {
        "name": "NEWwoorld-CadGPT-1.2B",
        "d_model": 2048,
        "n_layers": 24,
        "n_heads": 16,
        "n_kv_heads": 4,
        "ffn_hidden": 5632,
        "vocab_size": 32768,
        "exact_params": "1,218,562,048 (1.22B)",
        "hardware": "1x A100 80GB / 4x RTX 4090",
        "status": "PyTorch FSDP Architecture Ready",
    },
    "cad_3.0b": {
        "name": "NEWwoorld-CadGPT-3.0B",
        "d_model": 3072,
        "n_layers": 28,
        "n_heads": 24,
        "n_kv_heads": 8,
        "ffn_hidden": 8192,
        "vocab_size": 32768,
        "exact_params": "3,024,817,152 (3.02B)",
        "hardware": "4x-8x A100 80GB (FSDP bf16)",
        "status": "PyTorch FSDP Architecture Ready",
    },
    "cad_6.8b_moe": {
        "name": "NEWwoorld-CadGPT-6.8B-MoE",
        "d_model": 2560,
        "n_layers": 30,
        "n_heads": 20,
        "n_kv_heads": 4,
        "ffn_hidden": 6656,
        "num_experts": 4,
        "top_k": 2,
        "vocab_size": 32768,
        "exact_params": "6,777,561,600 (6.78B)",
        "hardware": "8x H100 80GB (FSDP + Tensor Parallel)",
        "status": "PyTorch FSDP Architecture Ready",
    },
    "photopart_3.1b": {
        "name": "NEWwoorld-PhotoPart-MMDiT-3.1B",
        "d_model": 2304,
        "n_layers": 24,
        "n_heads": 24,
        "patch_size": 2,
        "latent_channels": 16,
        "exact_params": "3,139,946,496 (3.14B)",
        "hardware": "8x A100/H100 80GB",
        "status": "PyTorch Regional Flow-Matching Ready",
    },
}

"""NEWwoorld-CadGPT: Bilingual Neuro-Symbolic CAD Sequence & Parameter Transformer."""

from __future__ import annotations
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from ..config import CADGPT_CKPT, CADGPT_META
from ..geometry.cad_compiler import ARCHETYPE_PROGRAM_TOKENS, ARCHETYPES, compile_cad_program
from ..geometry.mesh_ops import CADAssembly, audit_assembly
from ..nn import (
    Embedding,
    LayerNorm,
    Linear,
    Module,
    RMSNorm,
    Tensor,
    TransformerBlock,
    count_parameters,
    load_model_safetensors,
    save_model_safetensors,
)
from ..tokenizer import BilingualCADTokenizer, extract_numeric_specs


CAD_MATERIAL_NAMES = [
    "machined_steel",
    "titanium",
    "anodized_blue",
    "anodized_gold",
    "copper",
    "carbon_composite",
    "ceramic_white",
    "architectural_glass",
    "industrial_orange",
]

CAD_OP_VOCAB = [
    "<PART_START>",
    "<PART_END>",
    "SKETCH_INVOLUTE_TOOTH",
    "SKETCH_SUN_GEAR",
    "EXTRUDE_PAD",
    "EXTRUDE_RING_HOUSING",
    "EXTRUDE_CHAMFER_BASE",
    "EXTRUDE_BOLTED_FLANGE_2X",
    "EXTRUDE_BASE_FLANGE",
    "EXTRUDE_CHAMFER_CHASSIS",
    "EXTRUDE_HEX_COLLAR",
    "REVOLVE_HUB",
    "REVOLVE_HUB_CONTOUR",
    "REVOLVE_SPINNER",
    "REVOLVE_BONNET_STEM",
    "REVOLVE_HANDWHEEL",
    "REVOLVE_HARMONIC_STATOR",
    "REVOLVE_PODIUM_STEPS",
    "REVOLVE_TENSION_RINGS",
    "REVOLVE_OGIVE_HULL",
    "REVOLVE_BELL_NOZZLE",
    "REVOLVE_PROFILE",
    "LOFT_NACA_BLADE",
    "LOFT_GUSSET_RIBS",
    "LOFT_ARTICULATED_ARM",
    "LOFT_DIAGRID_RIBS",
    "LOFT_SWEPT_AIRFOIL_2X",
    "LOFT_VERTICAL_FIN",
    "HELICAL_LOFT_FLUTES",
    "SWEEP_90DEG_ELBOW",
    "POLAR_BORE_HOLES",
    "POLAR_ARRAY_PLANETS",
    "POLAR_ARRAY_BLADES",
    "PERFORATE_CARRIER",
    "DRILL_COUNTERSINK_4X",
    "EXTRUDE_CLEVIS_LUGS",
    "ARRAY_COOLING_FINS",
    "LINEAR_ARRAY_FINS",
    "THREAD_M4_CORNERS",
    "CHAMFER_EDGES",
    "CHAMFER_FACEPLATE",
    "CHAMFER_PEDESTAL",
    "SHELL_GLAZED_DOME",
]
OP2ID = {op: i for i, op in enumerate(CAD_OP_VOCAB)}

# Continuous normalized CAD parameters:
# [teeth_norm, blades_norm, holes_norm, fins_norm, size_norm, chamfer_norm]
PARAM_RANGES = {
    "teeth": (8.0, 56.0),
    "blades": (5.0, 22.0),
    "holes": (3.0, 12.0),
    "fins": (5.0, 22.0),
    "size_mm": (30.0, 160.0),
    "chamfer": (0.2, 3.0),
}


def encode_cad_params(params: Dict[str, float]) -> np.ndarray:
    keys = ["teeth", "blades", "holes", "fins", "size_mm", "chamfer"]
    vec = []
    for k in keys:
        lo, hi = PARAM_RANGES[k]
        val = float(params.get(k, 0.5 * (lo + hi)))
        vec.append(np.clip((val - lo) / (hi - lo), 0.0, 1.0))
    return np.asarray(vec, dtype=np.float32)


def decode_cad_params(vec: np.ndarray) -> Dict[str, float]:
    keys = ["teeth", "blades", "holes", "fins", "size_mm", "chamfer"]
    out: Dict[str, float] = {}
    for idx, k in enumerate(keys):
        lo, hi = PARAM_RANGES[k]
        v = float(np.clip(vec[idx], 0.0, 1.0)) * (hi - lo) + lo
        if k in ("teeth", "blades", "holes", "fins"):
            out[k] = int(round(v))
        else:
            out[k] = round(v, 2)
    return out


class CadGPTModel(Module):
    """
    Transformer-based Bilingual Neuro-Symbolic CAD Architecture.
    Maps RU/EN prompt tokens -> CAD Archetype + 7-Step CAD Program + Continuous Geometric Parameters.
    """

    def __init__(
        self,
        vocab_size: Optional[int] = None,
        max_len: int = 48,
        d_model: int = 128,
        n_heads: int = 4,
        n_layers: int = 2,
        seed: int = 42,
    ):
        super().__init__()
        self.tokenizer = BilingualCADTokenizer(max_len=max_len)
        v_size = vocab_size or self.tokenizer.vocab_size
        self.d_model = d_model
        self.max_len = max_len

        self.tok_emb = Embedding(v_size, d_model, seed=seed)
        self.pos_emb = Tensor(
            np.random.default_rng(seed + 1).normal(0.0, 0.02, size=(1, max_len, d_model)).astype(np.float32),
            requires_grad=True,
        )
        self.blocks = [
            TransformerBlock(d_model, n_heads, ffn_mult=2.5, causal=False, seed=seed + 100 * (i + 1))
            for i in range(n_layers)
        ]
        self.norm = RMSNorm(d_model)
        self.pool_query = Linear(d_model, 1, bias=False, seed=seed + 500)

        self.archetype_head = Linear(d_model, len(ARCHETYPES), seed=seed + 601)
        self.param_head = Linear(d_model, 6, seed=seed + 602)
        self.material_head = Linear(d_model, len(CAD_MATERIAL_NAMES), seed=seed + 603)
        # Predict 7-step CAD operation sequence
        self.op_head = Linear(d_model, 7 * len(CAD_OP_VOCAB), seed=seed + 604)

        self.trained_epochs: int = 0
        self.last_loss: float = 0.0

    def encode_prompt(self, token_ids: np.ndarray) -> Tensor:
        b, t = token_ids.shape
        x = self.tok_emb(token_ids) + self.pos_emb[:, :t, :]
        for blk in self.blocks:
            x = blk(x)
        h = self.norm(x)
        # Attention pooling over non-pad tokens
        attn_logits = self.pool_query(h).reshape(b, t)
        pad_mask = (token_ids == self.tokenizer.pad_id).astype(np.float32) * (-1e9)
        attn_w = (attn_logits + pad_mask).softmax(axis=-1).reshape(b, t, 1)
        pooled = (h * attn_w).sum(axis=1)
        return pooled

    def forward(self, token_ids: np.ndarray) -> Tuple[Tensor, Tensor, Tensor, Tensor]:
        feat = self.encode_prompt(token_ids)
        arch_logits = self.archetype_head(feat)
        param_pred = self.param_head(feat).sigmoid()
        mat_logits = self.material_head(feat)
        op_logits = self.op_head(feat).reshape(token_ids.shape[0], 7, len(CAD_OP_VOCAB))
        return arch_logits, param_pred, mat_logits, op_logits

    def predict(self, prompt: str, override_specs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.eval()
        ids = self.tokenizer.encode_batch([prompt])
        arch_logits, param_pred, mat_logits, op_logits = self.forward(ids)

        arch_probs = arch_logits.softmax(axis=-1).data[0]
        arch_idx = int(np.argmax(arch_probs))
        archetype = ARCHETYPES[arch_idx]
        confidence = float(arch_probs[arch_idx])

        params = decode_cad_params(param_pred.data[0])
        mat_idx = int(np.argmax(mat_logits.data[0]))
        predicted_material = CAD_MATERIAL_NAMES[mat_idx]

        # Predicted CAD program sequence
        op_ids = np.argmax(op_logits.data[0], axis=-1)
        prog_tokens = [CAD_OP_VOCAB[int(oi)] for oi in op_ids]

        # Neuro-Symbolic Refinement: preserve exact numerical engineering tolerances from prompt
        extracted = extract_numeric_specs(prompt)
        params.update(extracted)
        if override_specs:
            params.update({k: v for k, v in override_specs.items() if v is not None})

        return {
            "archetype": archetype,
            "confidence": round(confidence, 4),
            "top_candidates": [
                {"archetype": ARCHETYPES[i], "prob": round(float(arch_probs[i]), 4)}
                for i in np.argsort(-arch_probs)[:3]
            ],
            "params": params,
            "predicted_material": predicted_material,
            "program_tokens": prog_tokens,
        }

    def generate_cad(
        self, prompt: str, override_specs: Optional[Dict[str, Any]] = None
    ) -> Tuple[CADAssembly, Dict[str, Any], Dict[str, Any]]:
        pred = self.predict(prompt, override_specs=override_specs)
        # Merge canonical program tokens if model predicts fewer structural tokens
        prog = pred["program_tokens"]
        assembly = compile_cad_program(
            archetype=pred["archetype"],
            params=pred["params"],
            prompt=prompt,
            program_tokens=prog,
        )
        audit = audit_assembly(assembly)
        return assembly, pred, audit

    def save(self, ckpt_path: Path = CADGPT_CKPT, meta_path: Path = CADGPT_META) -> None:
        meta = {
            "model": "NEWwoorld-CadGPT-Core",
            "params": count_parameters(self),
            "d_model": self.d_model,
            "max_len": self.max_len,
            "trained_epochs": self.trained_epochs,
            "last_loss": self.last_loss,
            "archetypes": ARCHETYPES,
        }
        save_model_safetensors(self, ckpt_path, meta_path, meta)

    @classmethod
    def load_or_create(cls, ckpt_path: Path = CADGPT_CKPT, meta_path: Path = CADGPT_META) -> "CadGPTModel":
        model = cls()
        if ckpt_path.exists():
            load_model_safetensors(model, ckpt_path, strict=False)
            if meta_path.exists():
                m = json.loads(meta_path.read_text(encoding="utf-8"))
                model.trained_epochs = int(m.get("trained_epochs", 0))
                model.last_loss = float(m.get("last_loss", 0.0))
        return model

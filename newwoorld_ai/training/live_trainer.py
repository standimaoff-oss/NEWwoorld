"""Live incremental fine-tuning callable from the Studio UI."""

from __future__ import annotations
from typing import Any, Dict, List
import numpy as np

from ..geometry.cad_compiler import ARCHETYPE_PROGRAM_TOKENS, ARCHETYPES
from ..models.cad_gpt import CAD_MATERIAL_NAMES, CadGPTModel, OP2ID, encode_cad_params
from ..nn import AdamW, Tensor, clip_grad_norm_, cross_entropy_loss, huber_loss


def fine_tune_step(
    model: CadGPTModel,
    samples: List[Dict[str, Any]],
    steps: int = 8,
    lr: float = 1.5e-3,
) -> Dict[str, Any]:
    """Run live incremental backpropagation steps on custom user CAD prompts & save checkpoint."""
    if not samples:
        raise ValueError("At least one training sample is required")

    prompts = [str(s["prompt"]) for s in samples]
    toks = model.tokenizer.encode_batch(prompts)
    arch_y = np.array([ARCHETYPES.index(s["archetype"]) for s in samples], dtype=np.int64)
    param_y = np.stack([encode_cad_params(s.get("params", {})) for s in samples], axis=0)
    mat_y = np.array([CAD_MATERIAL_NAMES.index(s.get("material", "machined_steel")) for s in samples], dtype=np.int64)
    op_rows = []
    for s in samples:
        seq = [OP2ID.get(t, 0) for t in ARCHETYPE_PROGRAM_TOKENS[s["archetype"]][:7]]
        while len(seq) < 7:
            seq.append(OP2ID["<PART_END>"])
        op_rows.append(seq)
    op_y = np.array(op_rows, dtype=np.int64)

    opt = AdamW(model.parameters(), lr=lr, weight_decay=1e-3)
    losses: List[float] = []
    model.train()
    for _ in range(steps):
        opt.zero_grad()
        a_log, p_pred, m_log, o_log = model.forward(toks)
        loss = (
            cross_entropy_loss(a_log, arch_y)
            + 1.5 * huber_loss(p_pred, param_y, delta=0.2)
            + 0.3 * cross_entropy_loss(m_log, mat_y)
            + 0.4 * cross_entropy_loss(o_log, op_y)
        )
        loss.backward()
        clip_grad_norm_(model.parameters(), 1.5)
        opt.step()
        losses.append(round(loss.item(), 4))

    model.eval()
    model.trained_epochs += steps
    model.last_loss = losses[-1]
    model.save()
    return {
        "steps": steps,
        "initial_loss": losses[0],
        "final_loss": losses[-1],
        "loss_curve": losses,
        "total_epochs": model.trained_epochs,
    }

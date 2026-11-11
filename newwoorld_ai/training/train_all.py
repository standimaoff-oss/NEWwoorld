"""End-to-End Training Runner for CadGPT, PhotoPartNet, and VisionOCR."""

from __future__ import annotations
import json
import time
from typing import Any, Dict, List
import numpy as np

from ..config import TRAINING_REPORT_PATH
from ..models.cad_gpt import CadGPTModel
from ..models.photo_part_net import PhotoPartNetModel
from ..models.vision_ocr import VisionOCRSystem
from ..nn import (
    AdamW,
    CosineAnnealingLR,
    Tensor,
    clip_grad_norm_,
    count_parameters,
    cross_entropy_loss,
    huber_loss,
    mse_loss,
)
from .datasets import (
    generate_cad_dataset,
    generate_ocr_glyph_dataset,
    generate_photo_dataset,
    generate_vision_scene_dataset,
)


def train_cadgpt(epochs: int = 18, batch_size: int = 48) -> Dict[str, Any]:
    t0 = time.time()
    ds = generate_cad_dataset(n_samples=1000, seed=42)
    model = CadGPTModel()
    toks = model.tokenizer.encode_batch(ds["prompts"])

    n_val = 150
    X_tr, X_val = toks[:-n_val], toks[-n_val:]
    ay_tr, ay_val = ds["arch_y"][:-n_val], ds["arch_y"][-n_val:]
    py_tr, py_val = ds["param_y"][:-n_val], ds["param_y"][-n_val:]
    my_tr, my_val = ds["mat_y"][:-n_val], ds["mat_y"][-n_val:]
    oy_tr, oy_val = ds["op_y"][:-n_val], ds["op_y"][-n_val:]

    steps_per_epoch = max(len(X_tr) // batch_size, 1)
    opt = AdamW(model.parameters(), lr=3.5e-3, weight_decay=1e-2)
    sched = CosineAnnealingLR(opt, total_steps=epochs * steps_per_epoch, min_lr=1e-4)

    history: List[Dict[str, float]] = []
    rng = np.random.default_rng(7)

    for ep in range(1, epochs + 1):
        model.train()
        perm = rng.permutation(len(X_tr))
        ep_loss = 0.0
        n_b = 0
        for s in range(0, len(X_tr), batch_size):
            idx = perm[s : s + batch_size]
            opt.zero_grad()
            a_log, p_pred, m_log, o_log = model.forward(X_tr[idx])
            loss = (
                cross_entropy_loss(a_log, ay_tr[idx], label_smoothing=0.05)
                + 1.5 * huber_loss(p_pred, py_tr[idx], delta=0.2)
                + 0.4 * cross_entropy_loss(m_log, my_tr[idx])
                + 0.5 * cross_entropy_loss(o_log, oy_tr[idx])
            )
            loss.backward()
            clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            sched.step()
            ep_loss += loss.item()
            n_b += 1

        model.eval()
        va_log, vp_pred, _, _ = model.forward(X_val)
        val_acc = float(np.mean(np.argmax(va_log.data, axis=-1) == ay_val))
        val_param_mae = float(np.mean(np.abs(vp_pred.data - py_val)))
        avg_loss = ep_loss / max(n_b, 1)
        history.append({"epoch": ep, "loss": round(avg_loss, 4), "val_acc": round(val_acc, 4), "val_param_mae": round(val_param_mae, 4)})
        print(f"[CadGPT] Epoch {ep:02d}/{epochs} | loss={avg_loss:.4f} | val_arch_acc={val_acc:.3f} | param_mae={val_param_mae:.4f}")

    model.trained_epochs = epochs
    model.last_loss = history[-1]["loss"]
    model.save()
    return {
        "model": "NEWwoorld-CadGPT-Core",
        "params": count_parameters(model),
        "epochs": epochs,
        "duration_sec": round(time.time() - t0, 2),
        "final_loss": history[-1]["loss"],
        "val_accuracy": history[-1]["val_acc"],
        "history": history,
    }


def train_photopart(epochs: int = 12, batch_size: int = 12) -> Dict[str, Any]:
    t0 = time.time()
    ds = generate_photo_dataset(n_samples=480, seed=101)
    model = PhotoPartNetModel()
    toks = model.tokenizer.encode_batch(ds["prompts"])

    n_val = 64
    X_tr, X_val = toks[:-n_val], toks[-n_val:]
    sy_tr, sy_val = ds["scene_y"][:-n_val], ds["scene_y"][-n_val:]
    py_tr, py_val = ds["pal_y"][:-n_val], ds["pal_y"][-n_val:]
    parts_tr = ds["parts_y"][:-n_val]
    comp_tr = ds["comp_y"][:-n_val]

    steps_per_ep = max(len(X_tr) // batch_size, 1)
    opt = AdamW(model.parameters(), lr=3e-3, weight_decay=1e-2)
    sched = CosineAnnealingLR(opt, total_steps=epochs * steps_per_ep, min_lr=1e-4)
    history: List[Dict[str, float]] = []
    rng = np.random.default_rng(13)

    for ep in range(1, epochs + 1):
        model.train()
        perm = rng.permutation(len(X_tr))
        ep_loss = 0.0
        n_b = 0
        for s in range(0, len(X_tr), batch_size):
            idx = perm[s : s + batch_size]
            b = len(idx)
            opt.zero_grad()
            # Sample a random part index per batch sample so all 4 layers train cleanly
            p_ids = rng.integers(0, 4, size=(b,), dtype=np.int64)
            target_part = parts_tr[idx, p_ids]  # (B, 4, 64, 64)

            cond = model.encode_text(X_tr[idx])
            sc_log = model.scene_head(cond)
            pal_pred = model.palette_head(cond).sigmoid()
            part_pred = model.part_decoder.forward(cond, p_ids)

            # Also train refiner residual block on 64x64 composed image
            noisy = np.clip(comp_tr[idx] + rng.normal(0.0, 0.04, size=comp_tr[idx].shape).astype(np.float32), 0.0, 1.0)
            ref_pred = model.refine_rgb_trainable(Tensor(noisy), cond)

            loss = (
                cross_entropy_loss(sc_log, sy_tr[idx], label_smoothing=0.05)
                + 2.0 * mse_loss(pal_pred, py_tr[idx])
                + 2.5 * mse_loss(part_pred, target_part)
                + 1.5 * mse_loss(ref_pred, comp_tr[idx])
            )
            loss.backward()
            clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            sched.step()
            ep_loss += loss.item()
            n_b += 1

        model.eval()
        cond_v = model.encode_text(X_val)
        val_acc = float(np.mean(np.argmax(model.scene_head(cond_v).data, axis=-1) == sy_val))
        avg_loss = ep_loss / max(n_b, 1)
        history.append({"epoch": ep, "loss": round(avg_loss, 4), "val_scene_acc": round(val_acc, 4)})
        print(f"[PhotoPartNet] Epoch {ep:02d}/{epochs} | loss={avg_loss:.4f} | val_scene_acc={val_acc:.3f}")

    model.trained_epochs = epochs
    model.last_loss = history[-1]["loss"]
    model.save()
    return {
        "model": "NEWwoorld-PhotoPartNet-Core",
        "params": count_parameters(model),
        "epochs": epochs,
        "duration_sec": round(time.time() - t0, 2),
        "final_loss": history[-1]["loss"],
        "val_accuracy": history[-1]["val_scene_acc"],
        "history": history,
    }


def train_vision_ocr(ocr_epochs: int = 16, scene_epochs: int = 14) -> Dict[str, Any]:
    t0 = time.time()
    system = VisionOCRSystem()

    # 1) Train NeuralGlyphOCR on rendered bilingual glyphs
    X_ocr, y_ocr = generate_ocr_glyph_dataset(samples_per_class=26, seed=77)
    n_val_o = min(400, len(X_ocr) // 6)
    Xo_tr, Xo_val = X_ocr[:-n_val_o], X_ocr[-n_val_o:]
    yo_tr, yo_val = y_ocr[:-n_val_o], y_ocr[-n_val_o:]

    bs_o = 64
    opt_o = AdamW(system.ocr_net.parameters(), lr=3.5e-3, weight_decay=1e-3)
    sched_o = CosineAnnealingLR(opt_o, total_steps=ocr_epochs * max(len(Xo_tr) // bs_o, 1), min_lr=1e-4)
    ocr_hist: List[Dict[str, float]] = []
    rng = np.random.default_rng(77)

    for ep in range(1, ocr_epochs + 1):
        system.ocr_net.train()
        perm = rng.permutation(len(Xo_tr))
        ep_loss = 0.0
        n_b = 0
        for s in range(0, len(Xo_tr), bs_o):
            idx = perm[s : s + bs_o]
            opt_o.zero_grad()
            logits = system.ocr_net.forward(Tensor(Xo_tr[idx]))
            loss = cross_entropy_loss(logits, yo_tr[idx], label_smoothing=0.03)
            loss.backward()
            clip_grad_norm_(system.ocr_net.parameters(), 2.0)
            opt_o.step()
            sched_o.step()
            ep_loss += loss.item()
            n_b += 1

        system.ocr_net.eval()
        val_logits = system.ocr_net.forward(Tensor(Xo_val))
        val_acc = float(np.mean(np.argmax(val_logits.data, axis=-1) == yo_val))
        ocr_hist.append({"epoch": ep, "loss": round(ep_loss / max(n_b, 1), 4), "val_ocr_acc": round(val_acc, 4)})
        print(f"[VisionOCR-Glyph] Epoch {ep:02d}/{ocr_epochs} | loss={ocr_hist[-1]['loss']:.4f} | val_ocr_acc={val_acc:.3f}")

    # 2) Train VisionSceneNet on 12-category visual scenes
    ds_sc = generate_vision_scene_dataset(n_samples=600, seed=88)
    n_val_s = 96
    Xs_tr, Xs_val = ds_sc["X"][:-n_val_s], ds_sc["X"][-n_val_s:]
    sy_tr, sy_val = ds_sc["sc_y"][:-n_val_s], ds_sc["sc_y"][-n_val_s:]
    cy_tr, cy_val = ds_sc["cad_y"][:-n_val_s], ds_sc["cad_y"][-n_val_s:]
    ay_tr, ay_val = ds_sc["attr_y"][:-n_val_s], ds_sc["attr_y"][-n_val_s:]

    bs_s = 32
    opt_s = AdamW(system.scene_net.parameters(), lr=3e-3, weight_decay=1e-2)
    sched_s = CosineAnnealingLR(opt_s, total_steps=scene_epochs * max(len(Xs_tr) // bs_s, 1), min_lr=1e-4)
    sc_hist: List[Dict[str, float]] = []

    for ep in range(1, scene_epochs + 1):
        system.scene_net.train()
        perm = rng.permutation(len(Xs_tr))
        ep_loss = 0.0
        n_b = 0
        for s in range(0, len(Xs_tr), bs_s):
            idx = perm[s : s + bs_s]
            opt_s.zero_grad()
            sl, cl, at = system.scene_net.forward(Tensor(Xs_tr[idx]))
            loss = (
                cross_entropy_loss(sl, sy_tr[idx])
                + 0.7 * cross_entropy_loss(cl, cy_tr[idx])
                + 1.0 * mse_loss(at, ay_tr[idx])
            )
            loss.backward()
            clip_grad_norm_(system.scene_net.parameters(), 2.0)
            opt_s.step()
            sched_s.step()
            ep_loss += loss.item()
            n_b += 1

        system.scene_net.eval()
        vsl, vcl, _ = system.scene_net.forward(Tensor(Xs_val))
        sc_acc = float(np.mean(np.argmax(vsl.data, axis=-1) == sy_val))
        sc_hist.append({"epoch": ep, "loss": round(ep_loss / max(n_b, 1), 4), "val_scene_acc": round(sc_acc, 4)})
        print(f"[VisionOCR-Scene] Epoch {ep:02d}/{scene_epochs} | loss={sc_hist[-1]['loss']:.4f} | val_scene_acc={sc_acc:.3f}")

    system.trained_epochs = ocr_epochs
    system.ocr_accuracy = ocr_hist[-1]["val_ocr_acc"]
    system.scene_accuracy = sc_hist[-1]["val_scene_acc"]
    system.save()

    return {
        "model": "NEWwoorld-VisionOCR-Core",
        "params": count_parameters(system),
        "epochs": ocr_epochs,
        "duration_sec": round(time.time() - t0, 2),
        "ocr_val_accuracy": system.ocr_accuracy,
        "scene_val_accuracy": system.scene_accuracy,
        "ocr_history": ocr_hist,
        "scene_history": sc_hist,
    }


def train_all_models() -> Dict[str, Any]:
    import gc
    cad_res = train_cadgpt(epochs=16, batch_size=32)
    gc.collect()
    photo_res = train_photopart(epochs=12, batch_size=12)
    gc.collect()
    vis_res = train_vision_ocr(ocr_epochs=16, scene_epochs=12)
    gc.collect()
    report = {
        "cadgpt": cad_res,
        "photopart": photo_res,
        "vision_ocr": vis_res,
    }
    TRAINING_REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved training report -> {TRAINING_REPORT_PATH}")
    return report


if __name__ == "__main__":
    train_all_models()

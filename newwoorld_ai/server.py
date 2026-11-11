"""FastAPI Studio Server for NEWwoorld AI (3D CAD + Part-by-Part Photo + Vision/OCR + Training Lab)."""

from __future__ import annotations
import base64
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

from .config import MODEL_SCALING_CATALOG, TRAINING_REPORT_PATH, WEB_DIR
from .geometry import (
    ARCHETYPES,
    assembly_to_viewer_payload,
    compile_cad_program,
    export_glb_bytes,
    export_obj_with_quads,
    export_scad,
    export_stl_binary,
)
from .models import CadGPTModel, PhotoPartNetModel, VisionOCRSystem
from .nn import count_parameters
from .training.datasets import FONTS
from .training.live_trainer import fine_tune_step

app = FastAPI(title="NEWwoorld AI Studio", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load trained neural models once on startup
_cad_model: Optional[CadGPTModel] = None
_photo_model: Optional[PhotoPartNetModel] = None
_vision_model: Optional[VisionOCRSystem] = None
_last_assembly = None


def get_cad_model() -> CadGPTModel:
    global _cad_model
    if _cad_model is None:
        _cad_model = CadGPTModel.load_or_create()
    return _cad_model


def get_photo_model() -> PhotoPartNetModel:
    global _photo_model
    if _photo_model is None:
        _photo_model = PhotoPartNetModel.load_or_create()
    return _photo_model


def get_vision_model() -> VisionOCRSystem:
    global _vision_model
    if _vision_model is None:
        _vision_model = VisionOCRSystem.load_or_create()
    return _vision_model


def _ensure_last_assembly():
    global _last_assembly
    if _last_assembly is None:
        asm, _, _ = get_cad_model().generate_cad("шестерня эвольвентная 24 зуба 6 отверстий титан")
        _last_assembly = asm
    return _last_assembly


class CadGenRequest(BaseModel):
    prompt: str
    archetype_override: Optional[str] = None
    teeth: Optional[int] = None
    blades: Optional[int] = None
    holes: Optional[int] = None
    fins: Optional[int] = None
    size_mm: Optional[float] = None
    chamfer: Optional[float] = None


class PhotoGenRequest(BaseModel):
    prompt: str
    size: int = 512
    seed: int = 42


class FineTuneSample(BaseModel):
    prompt: str
    archetype: str
    material: str = "machined_steel"


class FineTuneRequest(BaseModel):
    samples: List[FineTuneSample]
    steps: int = 8
    lr: float = 0.0015


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    idx_file = WEB_DIR / "index.html"
    if not idx_file.exists():
        raise HTTPException(status_code=404, detail="Studio UI not found")
    return HTMLResponse(idx_file.read_text(encoding="utf-8"))


@app.get("/api/health")
def health() -> Dict[str, Any]:
    cad = get_cad_model()
    photo = get_photo_model()
    vis = get_vision_model()
    report = {}
    if TRAINING_REPORT_PATH.exists():
        report = json.loads(TRAINING_REPORT_PATH.read_text(encoding="utf-8"))
    return {
        "status": "ok",
        "backend": "python_neural_core",
        "models": {
            "cadgpt": {
                "params": count_parameters(cad),
                "trained_epochs": cad.trained_epochs,
                "last_loss": cad.last_loss,
            },
            "photopart": {
                "params": count_parameters(photo),
                "trained_epochs": photo.trained_epochs,
                "last_loss": photo.last_loss,
            },
            "vision_ocr": {
                "params": count_parameters(vis),
                "trained_epochs": vis.trained_epochs,
                "ocr_accuracy": vis.ocr_accuracy,
                "scene_accuracy": vis.scene_accuracy,
            },
        },
        "archetypes": ARCHETYPES,
        "scaling_catalog": MODEL_SCALING_CATALOG,
        "training_report": report,
    }


@app.post("/api/cad/generate")
def generate_cad(req: CadGenRequest) -> Dict[str, Any]:
    global _last_assembly
    overrides = {
        "teeth": req.teeth,
        "blades": req.blades,
        "holes": req.holes,
        "fins": req.fins,
        "size_mm": req.size_mm,
        "chamfer": req.chamfer,
    }
    cad = get_cad_model()
    if req.archetype_override and req.archetype_override in ARCHETYPES:
        pred = cad.predict(req.prompt, override_specs=overrides)
        pred["archetype"] = req.archetype_override
        asm = compile_cad_program(req.archetype_override, pred["params"], req.prompt, pred["program_tokens"])
    else:
        asm, pred, _ = cad.generate_cad(req.prompt, override_specs=overrides)

    _last_assembly = asm
    payload = assembly_to_viewer_payload(asm)
    payload["prediction"] = pred
    return payload


@app.get("/api/cad/export/{fmt}")
def export_cad(fmt: str) -> Response:
    asm = _ensure_last_assembly()
    fmt_l = fmt.lower()
    if fmt_l == "obj":
        data = export_obj_with_quads(asm).encode("utf-8")
        return Response(
            content=data,
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{asm.archetype}.obj"'},
        )
    if fmt_l == "stl":
        data = export_stl_binary(asm)
        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{asm.archetype}.stl"'},
        )
    if fmt_l == "glb":
        data = export_glb_bytes(asm)
        return Response(
            content=data,
            media_type="model/gltf-binary",
            headers={"Content-Disposition": f'attachment; filename="{asm.archetype}.glb"'},
        )
    if fmt_l == "scad":
        data = export_scad(asm).encode("utf-8")
        return Response(
            content=data,
            media_type="text/plain",
            headers={"Content-Disposition": f'attachment; filename="{asm.archetype}.scad"'},
        )
    if fmt_l == "json":
        payload = assembly_to_viewer_payload(asm)
        return JSONResponse(content=payload)
    raise HTTPException(status_code=400, detail=f"Unsupported export format: {fmt}")


@app.post("/api/photo/generate")
def generate_photo(req: PhotoGenRequest) -> Dict[str, Any]:
    size = int(max(128, min(req.size, 768)))
    photo = get_photo_model()
    return photo.generate_part_by_part(req.prompt, size=size, seed=req.seed)


@app.post("/api/vision/analyze")
async def vision_analyze(file: UploadFile = File(...)) -> Dict[str, Any]:
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image file: {exc}") from exc
    vis = get_vision_model()
    scene = vis.analyze_scene(img)
    ocr = vis.detect_and_read_text(img)
    return {"scene": scene, "ocr": ocr}


@app.post("/api/vision/to-cad")
async def vision_to_cad(file: UploadFile = File(...), mode: str = Form("auto")) -> Dict[str, Any]:
    global _last_assembly
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image file: {exc}") from exc
    vis = get_vision_model()
    asm, analysis, _ = vis.image_to_cad(img, mode=mode)
    _last_assembly = asm
    payload = assembly_to_viewer_payload(asm)
    payload["vision_analysis"] = analysis
    return payload


@app.get("/api/vision/sample/{kind}")
def vision_sample(kind: str) -> Response:
    """Generate clean test images (blueprint, russian+english OCR spec sheet, mechanical diagram)."""
    img = Image.new("RGB", (480, 260), (242, 245, 248))
    d = ImageDraw.Draw(img)
    f_lg = ImageFont.truetype(FONTS[1], 28)
    f_md = ImageFont.truetype(FONTS[0], 22)

    if kind == "blueprint":
        img = Image.new("RGB", (480, 260), (16, 62, 134))
        d = ImageDraw.Draw(img)
        d.rectangle([16, 16, 464, 244], outline=(210, 232, 255), width=2)
        d.ellipse([60, 50, 220, 210], outline=(235, 246, 255), width=4)
        d.ellipse([110, 100, 170, 160], outline=(235, 246, 255), width=3)
        d.text((250, 58), "GEAR Z24", fill=(235, 246, 255), font=f_lg)
        d.text((250, 108), "Ø84.0 MM", fill=(235, 246, 255), font=f_md)
        d.text((250, 152), "ТИТАН VT6", fill=(235, 246, 255), font=f_md)
    elif kind == "cyrillic_doc":
        d.rectangle([14, 14, 466, 246], outline=(40, 50, 68), width=2)
        d.text((34, 34), "ЧЕРТЕЖ ДЕТАЛИ 3D", fill=(18, 22, 30), font=f_lg)
        d.text((34, 92), "ТУРБИНА 12 ЛОПАТОК", fill=(18, 22, 30), font=f_md)
        d.text((34, 142), "NEWWOORLD CAD 2026", fill=(18, 22, 30), font=f_md)
        d.text((34, 190), "ДОПУСК ±0.05 ММ", fill=(18, 22, 30), font=f_md)
    else:
        img = Image.new("RGB", (480, 260), (20, 24, 32))
        d = ImageDraw.Draw(img)
        d.ellipse([45, 40, 225, 220], fill=(165, 180, 198), outline=(230, 236, 244), width=3)
        d.ellipse([105, 100, 165, 160], fill=(20, 24, 32), outline=(230, 236, 244), width=2)
        d.text((255, 65), "TURBINE", fill=(235, 240, 248), font=f_lg)
        d.text((255, 115), "РОТОР 11", fill=(235, 240, 248), font=f_md)
        d.text((255, 165), "120 MM", fill=(235, 240, 248), font=f_md)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@app.post("/api/train/fine-tune")
def api_fine_tune(req: FineTuneRequest) -> Dict[str, Any]:
    cad = get_cad_model()
    samples = [s.model_dump() for s in req.samples]
    return fine_tune_step(cad, samples, steps=max(1, min(req.steps, 30)), lr=req.lr)


if (WEB_DIR / "css").exists():
    app.mount("/css", StaticFiles(directory=str(WEB_DIR / "css")), name="css")
if (WEB_DIR / "js").exists():
    app.mount("/js", StaticFiles(directory=str(WEB_DIR / "js")), name="js")
if (WEB_DIR / "vendor").exists():
    app.mount("/vendor", StaticFiles(directory=str(WEB_DIR / "vendor")), name="vendor")

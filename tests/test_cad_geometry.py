import numpy as np
import pytest
from newwoorld_ai.geometry import (
    ARCHETYPES,
    compile_cad_program,
    audit_assembly,
    export_obj_with_quads,
    export_stl_binary,
    export_glb_bytes,
)
from newwoorld_ai.geometry.cad_primitives import build_blueprint_extrusion


@pytest.mark.parametrize("archetype", ARCHETYPES)
def test_cad_archetype_watertight_and_manifold(archetype):
    asm = compile_cad_program(
        archetype,
        {"teeth": 20, "blades": 9, "holes": 6, "fins": 10, "size_mm": 80.0, "chamfer": 1.0},
        prompt=f"test {archetype}",
    )
    rep = audit_assembly(asm)
    assert rep["part_count"] >= 1
    assert rep["total_vertices"] > 20
    assert rep["total_triangles"] > 20
    assert rep["non_manifold_edges"] == 0, f"{archetype} has non-manifold edges: {rep}"
    assert rep["boundary_edges"] == 0, f"{archetype} has boundary edges: {rep}"
    assert rep["all_watertight"] is True, f"{archetype} is not watertight: {rep}"
    assert rep["total_volume_mm3"] > 0.0

    # Verify exports succeed cleanly
    obj_txt = export_obj_with_quads(asm)
    assert "\nv " in obj_txt and "\nf " in obj_txt
    stl_bytes = export_stl_binary(asm)
    assert len(stl_bytes) > 84
    glb_bytes = export_glb_bytes(asm)
    assert glb_bytes[:4] == b"glTF"


def test_fastener_submode_watertight():
    asm = compile_cad_program("precision_fastener_vessel", {"size_mm": 40.0}, prompt="резьбовой болт с гайкой")
    rep = audit_assembly(asm)
    assert rep["all_watertight"] is True
    assert rep["non_manifold_edges"] == 0
    assert rep["boundary_edges"] == 0


def test_blueprint_extrusion_watertight():
    mask = np.zeros((40, 40), dtype=np.float32)
    mask[10:30, 10:30] = 1.0
    asm = build_blueprint_extrusion(mask)
    rep = audit_assembly(asm)
    assert rep["all_watertight"] is True
    assert rep["non_manifold_edges"] == 0
    assert rep["boundary_edges"] == 0

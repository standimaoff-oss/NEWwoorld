"""Compiles CadGPT predicted archetype + CAD program tokens + continuous specs into CADAssembly."""

from __future__ import annotations
from typing import Any, Dict, List
from .mesh_ops import CADAssembly
from .cad_primitives import (
    build_aerospace_fuselage,
    build_cnc_bracket,
    build_flanged_valve,
    build_geodesic_pavilion,
    build_heatsink_enclosure,
    build_involute_gear,
    build_planetary_gearbox,
    build_precision_fastener_vessel,
    build_robotic_actuator,
    build_turbine_impeller,
)

ARCHETYPES: List[str] = [
    "involute_gear",
    "planetary_gearbox",
    "turbine_impeller",
    "cnc_bracket",
    "flanged_valve",
    "robotic_actuator",
    "heatsink_enclosure",
    "geodesic_pavilion",
    "aerospace_fuselage",
    "precision_fastener_vessel",
]

_BUILDERS = {
    "involute_gear": build_involute_gear,
    "planetary_gearbox": build_planetary_gearbox,
    "turbine_impeller": build_turbine_impeller,
    "cnc_bracket": build_cnc_bracket,
    "flanged_valve": build_flanged_valve,
    "robotic_actuator": build_robotic_actuator,
    "heatsink_enclosure": build_heatsink_enclosure,
    "geodesic_pavilion": build_geodesic_pavilion,
    "aerospace_fuselage": build_aerospace_fuselage,
    "precision_fastener_vessel": build_precision_fastener_vessel,
}

ARCHETYPE_PROGRAM_TOKENS: Dict[str, List[str]] = {
    "involute_gear": ["<PART_START>", "SKETCH_INVOLUTE_TOOTH", "EXTRUDE_PAD", "CHAMFER_EDGES", "POLAR_BORE_HOLES", "REVOLVE_HUB", "<PART_END>"],
    "planetary_gearbox": ["<PART_START>", "SKETCH_SUN_GEAR", "POLAR_ARRAY_PLANETS", "EXTRUDE_RING_HOUSING", "PERFORATE_CARRIER", "<PART_END>"],
    "turbine_impeller": ["<PART_START>", "REVOLVE_HUB_CONTOUR", "LOFT_NACA_BLADE", "POLAR_ARRAY_BLADES", "REVOLVE_SPINNER", "<PART_END>"],
    "cnc_bracket": ["<PART_START>", "EXTRUDE_CHAMFER_BASE", "DRILL_COUNTERSINK_4X", "EXTRUDE_CLEVIS_LUGS", "LOFT_GUSSET_RIBS", "<PART_END>"],
    "flanged_valve": ["<PART_START>", "SWEEP_90DEG_ELBOW", "EXTRUDE_BOLTED_FLANGE_2X", "REVOLVE_BONNET_STEM", "REVOLVE_HANDWHEEL", "<PART_END>"],
    "robotic_actuator": ["<PART_START>", "EXTRUDE_BASE_FLANGE", "REVOLVE_HARMONIC_STATOR", "ARRAY_COOLING_FINS", "LOFT_ARTICULATED_ARM", "<PART_END>"],
    "heatsink_enclosure": ["<PART_START>", "EXTRUDE_CHAMFER_CHASSIS", "LINEAR_ARRAY_FINS", "THREAD_M4_CORNERS", "CHAMFER_FACEPLATE", "<PART_END>"],
    "geodesic_pavilion": ["<PART_START>", "REVOLVE_PODIUM_STEPS", "LOFT_DIAGRID_RIBS", "REVOLVE_TENSION_RINGS", "SHELL_GLAZED_DOME", "<PART_END>"],
    "aerospace_fuselage": ["<PART_START>", "REVOLVE_OGIVE_HULL", "LOFT_SWEPT_AIRFOIL_2X", "LOFT_VERTICAL_FIN", "REVOLVE_BELL_NOZZLE", "<PART_END>"],
    "precision_fastener_vessel": ["<PART_START>", "REVOLVE_PROFILE", "HELICAL_LOFT_FLUTES", "EXTRUDE_HEX_COLLAR", "CHAMFER_PEDESTAL", "<PART_END>"],
}


def compile_cad_program(
    archetype: str,
    params: Dict[str, Any],
    prompt: str,
    program_tokens: List[str] | None = None,
) -> CADAssembly:
    if archetype not in _BUILDERS:
        archetype = "involute_gear"
    asm = _BUILDERS[archetype](params, prompt)
    asm.program_tokens = program_tokens or ARCHETYPE_PROGRAM_TOKENS[archetype]
    return asm

"""Analytical & Parametric CAD Assembly Builders (10 Professional Archetypes + Image-to-CAD)."""

from __future__ import annotations
import math
from typing import Any, Dict, List, Tuple
import numpy as np
from .mesh_ops import (
    CADAssembly,
    CADMaterial,
    CADPart,
    MATERIALS,
    loft_sections,
    make_annular_extrusion,
    make_chamfered_box,
    make_perforated_flange,
    make_revolved_solid,
    quads_to_tris,
    transform_verts,
    _fix_winding_and_merge,
)


def _cylinder(r: float, h: float, segs: int = 36, z0: float = 0.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    return make_revolved_solid([(0.0, z0), (r, z0), (r, z0 + h), (0.0, z0 + h)], segments=segs)


def _tube(r_in: float, r_out: float, h: float, segs: int = 40, z0: float = 0.0, chamfer: float = 0.4) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    ch = min(chamfer, 0.25 * (r_out - r_in), 0.2 * h)
    prof = [
        (r_in + ch, z0),
        (r_out - ch, z0),
        (r_out, z0 + ch),
        (r_out, z0 + h - ch),
        (r_out - ch, z0 + h),
        (r_in + ch, z0 + h),
        (r_in, z0 + h - ch),
        (r_in, z0 + ch),
    ]
    return make_revolved_solid(prof, segments=segs)


def _hex_head(flat_width: float, h: float, z0: float = 0.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    r = flat_width / math.sqrt(3.0)
    return make_revolved_solid([(0.0, z0), (r, z0), (r * 0.96, z0 + h * 0.85), (r * 0.78, z0 + h), (0.0, z0 + h)], segments=6)


def _involute_gear_xy(teeth: int, module_mm: float, pressure_deg: float = 20.0, pts_per_tooth: int = 10) -> Tuple[np.ndarray, float, float]:
    """Generate exact 2D involute spur gear profile points (K, 2)."""
    z = max(int(teeth), 6)
    m = max(float(module_mm), 0.5)
    alpha = math.radians(pressure_deg)
    rp = 0.5 * m * z
    rb = rp * math.cos(alpha)
    ra = rp + m
    rf = max(rp - 1.25 * m, 2.0)

    # Half tooth angular thickness at pitch circle
    theta_p = math.pi / (2.0 * z)
    inv_alpha = math.tan(alpha) - alpha
    theta_b = theta_p + inv_alpha

    pts: List[Tuple[float, float]] = []
    pitch_step = 2.0 * math.pi / z
    # Build involute flank table from rb to ra
    t_max = math.sqrt(max((ra / rb) ** 2 - 1.0, 0.01))
    n_flank = max(pts_per_tooth // 2, 4)

    for i in range(z):
        center_ang = i * pitch_step
        # Root arc start
        ang_root_l = center_ang - pitch_step * 0.34
        pts.append((rf * math.cos(ang_root_l), rf * math.sin(ang_root_l)))

        # Rising involute flank (bottom -> tip)
        for k in range(n_flank):
            u = k / float(max(n_flank - 1, 1))
            r_cur = max(rb, rf) + u * (ra - max(rb, rf))
            t = math.sqrt(max((r_cur / rb) ** 2 - 1.0, 0.0))
            inv_t = t - math.atan(t)
            ang = center_ang - (theta_b - inv_t)
            pts.append((r_cur * math.cos(ang), r_cur * math.sin(ang)))

        # Tip land
        t_tip = t_max
        inv_tip = t_tip - math.atan(t_tip)
        tip_half = max(theta_b - inv_tip, 0.01)
        pts.append((ra * math.cos(center_ang - tip_half * 0.5), ra * math.sin(center_ang - tip_half * 0.5)))
        pts.append((ra * math.cos(center_ang + tip_half * 0.5), ra * math.sin(center_ang + tip_half * 0.5)))

        # Falling involute flank (tip -> bottom)
        for k in range(n_flank - 1, -1, -1):
            u = k / float(max(n_flank - 1, 1))
            r_cur = max(rb, rf) + u * (ra - max(rb, rf))
            t = math.sqrt(max((r_cur / rb) ** 2 - 1.0, 0.0))
            inv_t = t - math.atan(t)
            ang = center_ang + (theta_b - inv_t)
            pts.append((r_cur * math.cos(ang), r_cur * math.sin(ang)))

        ang_root_r = center_ang + pitch_step * 0.34
        pts.append((rf * math.cos(ang_root_r), rf * math.sin(ang_root_r)))

    return np.asarray(pts, dtype=np.float64), rp, rf


def _gear_part(
    name: str,
    teeth: int,
    module_mm: float,
    thickness: float,
    bore_r: float,
    chamfer: float,
    mat: CADMaterial,
    z0: float = 0.0,
    center_xy: Tuple[float, float] = (0.0, 0.0),
    rot_z_deg: float = 0.0,
    helical_twist_deg: float = 0.0,
) -> Tuple[CADPart, float, float]:
    outer_xy, rp, rf = _involute_gear_xy(teeth, module_mm)
    k = len(outer_xy)
    thetas = np.arctan2(outer_xy[:, 1], outer_xy[:, 0])
    inner_xy = np.column_stack([bore_r * np.cos(thetas), bore_r * np.sin(thetas)])

    if abs(helical_twist_deg) > 1.0:
        # Helical gear: loft 6 twisted annular slices -> wait, annular extrusion with twist!
        # Twist outer_xy cleanly around Z while keeping inner bore cylindrical
        n_layers = 6
        z_vals = np.linspace(z0, z0 + thickness, n_layers)
        ang_vals = np.radians(np.linspace(0.0, helical_twist_deg, n_layers))
        # Build closed loop (outer bottom->top, inner top->bottom) using ring loft
        # Simplest guaranteed-watertight helical extrusion: use annular_extrusion + twist Z-proportional angle on outer vertices!
        v, f, q = make_annular_extrusion(outer_xy, inner_xy, z0, z0 + thickness, chamfer=chamfer)
        # Apply smooth helical shear only on vertices beyond bore_r * 1.15
        r_v = np.hypot(v[:, 0], v[:, 1])
        frac_z = np.clip((v[:, 2] - z0) / max(thickness, 1e-6), 0.0, 1.0)
        twist = np.radians(helical_twist_deg) * frac_z * np.clip((r_v - bore_r * 1.1) / max(rf - bore_r, 1.0), 0.0, 1.0)
        ct, st = np.cos(twist), np.sin(twist)
        nx = v[:, 0] * ct - v[:, 1] * st
        ny = v[:, 0] * st + v[:, 1] * ct
        v[:, 0], v[:, 1] = nx, ny
    else:
        v, f, q = make_annular_extrusion(outer_xy, inner_xy, z0, z0 + thickness, chamfer=chamfer)

    v = transform_verts(v, translate=(center_xy[0], center_xy[1], 0.0), rotate_xyz_deg=(0.0, 0.0, rot_z_deg))
    return CADPart(name=name, vertices=v, faces=f, quads=q, material=mat, crease_angle_deg=32.0), rp, rf


def build_involute_gear(params: Dict[str, Any], prompt: str) -> CADAssembly:
    teeth = int(np.clip(params.get("teeth", 24), 8, 60))
    mod = float(np.clip(params.get("module_mm", 2.8), 1.4, 6.0))
    thick = float(np.clip(params.get("thickness", 16.0), 6.0, 45.0))
    holes = int(np.clip(params.get("holes", 6), 3, 12))
    chamfer = float(np.clip(params.get("chamfer", 0.9), 0.2, 3.0))
    helical = float(params.get("helical_deg", 12.0 if ("helical" in prompt.lower() or "косозуб" in prompt.lower()) else 0.0))

    rp = 0.5 * mod * teeth
    rf = max(rp - 1.25 * mod, 6.0)
    web_r = rf * 0.84
    hub_r = max(rf * 0.34, 8.0)
    bore_r = max(hub_r * 0.52, 4.5)

    parts: List[CADPart] = []
    gear_ring, _, _ = _gear_part(
        "involute_gear_rim", teeth, mod, thick, web_r * 0.92, chamfer, MATERIALS["machined_steel"], helical_twist_deg=helical
    )
    parts.append(gear_ring)

    # Perforated bolted web flange inside the rim
    wv, wf, wq = make_perforated_flange(
        r_inner=hub_r * 0.98,
        r_outer=web_r * 0.94,
        thickness=thick * 0.58,
        num_holes=holes,
        hole_radius=max((web_r - hub_r) * 0.19, 2.2),
        z_offset=thick * 0.21,
        chamfer=chamfer * 0.5,
    )
    parts.append(CADPart("lightened_bolted_web", wv, wf, wq, MATERIALS["anodized_blue"], 30.0))

    # Central stepped hub collar
    hv, hf, hq = _tube(bore_r, hub_r, thick * 1.35, segs=40, z0=-thick * 0.175, chamfer=chamfer * 0.7)
    parts.append(CADPart("central_hub_collar", hv, hf, hq, MATERIALS["titanium"], 30.0))

    scad = f"""// Precision Involute Gear Assembly
teeth = {teeth}; module_mm = {mod:.2f}; pitch_radius = {rp:.2f};
thickness = {thick:.2f}; bore_radius = {bore_r:.2f}; bolts = {holes};
module involute_gear() {{
  difference() {{
    cylinder(r={rp + mod:.2f}, h=thickness, $fn=teeth*4);
    translate([0,0,-1]) cylinder(r=bore_radius, h=thickness+2, $fn=48);
  }}
}}
involute_gear();
"""
    return CADAssembly(
        title=f"Precision Involute Gear (Z={teeth}, m={mod:.1f}mm)",
        archetype="involute_gear",
        prompt=prompt,
        parts=parts,
        params={"teeth": teeth, "module_mm": mod, "thickness": thick, "holes": holes, "chamfer": chamfer, "helical_deg": helical},
        scad_code=scad,
    )


def build_planetary_gearbox(params: Dict[str, Any], prompt: str) -> CADAssembly:
    sun_z = int(np.clip(params.get("teeth", 16), 10, 28))
    planet_z = max(8, (sun_z // 2) + 2)
    # Exact planetary condition: ring_z = sun_z + 2 * planet_z
    ring_z = sun_z + 2 * planet_z
    mod = float(np.clip(params.get("module_mm", 2.2), 1.4, 4.0))
    thick = float(np.clip(params.get("thickness", 14.0), 8.0, 32.0))
    n_planets = int(np.clip(params.get("holes", 4), 3, 6))
    # Enforce divisibility or approximate exact mesh phase
    chamfer = float(np.clip(params.get("chamfer", 0.7), 0.2, 2.0))

    r_sun = 0.5 * mod * sun_z
    r_planet = 0.5 * mod * planet_z
    r_ring = 0.5 * mod * ring_z
    orbit_r = r_sun + r_planet

    parts: List[CADPart] = []
    sun_part, _, _ = _gear_part("sun_gear", sun_z, mod, thick * 1.15, max(r_sun * 0.38, 4.0), chamfer, MATERIALS["anodized_gold"], z0=-thick * 0.075)
    parts.append(sun_part)

    for i in range(n_planets):
        ang = 2.0 * math.pi * i / n_planets
        px = orbit_r * math.cos(ang)
        py = orbit_r * math.sin(ang)
        # Phase alignment so teeth visually mesh cleanly with sun gear
        phase_deg = math.degrees(ang) + (180.0 / planet_z)
        p_part, _, _ = _gear_part(
            f"planet_gear_{i+1}", planet_z, mod, thick, max(r_planet * 0.35, 3.0), chamfer, MATERIALS["machined_steel"], center_xy=(px, py), rot_z_deg=phase_deg
        )
        parts.append(p_part)
        pv, pf, pq = _cylinder(max(r_planet * 0.32, 2.8), thick * 1.4, segs=24, z0=-thick * 0.2)
        pv = transform_verts(pv, translate=(px, py, 0.0))
        parts.append(CADPart(f"planet_pin_{i+1}", pv, pf, pq, MATERIALS["titanium"], 35.0))

    # Outer precision flanged housing ring
    hv, hf, hq = make_perforated_flange(
        r_inner=r_ring + mod * 1.2,
        r_outer=r_ring + mod * 5.8,
        thickness=thick * 1.25,
        num_holes=max(n_planets * 2, 6),
        hole_radius=mod * 1.4,
        z_offset=-thick * 0.125,
        chamfer=chamfer,
    )
    parts.append(CADPart("outer_housing_flange", hv, hf, hq, MATERIALS["anodized_blue"], 32.0))

    # Carrier ring plate below gears
    cv, cf, cq = make_perforated_flange(
        r_inner=max(r_sun * 0.42, 4.5),
        r_outer=orbit_r + r_planet * 0.55,
        thickness=thick * 0.32,
        num_holes=n_planets,
        hole_radius=max(r_planet * 0.32, 2.8),
        hole_pcd_radius=orbit_r,
        z_offset=-thick * 0.52,
        chamfer=chamfer * 0.5,
    )
    parts.append(CADPart("planet_carrier_plate", cv, cf, cq, MATERIALS["carbon_composite"], 32.0))

    scad = f"""// Planetary Gearbox Assembly
sun_z = {sun_z}; planet_z = {planet_z}; ring_z = {ring_z}; module_mm = {mod:.2f};
orbit_r = {orbit_r:.2f}; n_planets = {n_planets};
"""
    return CADAssembly(
        title=f"Planetary Gearbox (Sun={sun_z}, Planet={planet_z}x{n_planets}, Ring={ring_z})",
        archetype="planetary_gearbox",
        prompt=prompt,
        parts=parts,
        params={"sun_teeth": sun_z, "planet_teeth": planet_z, "ring_teeth": ring_z, "n_planets": n_planets, "module_mm": mod},
        scad_code=scad,
    )


def build_turbine_impeller(params: Dict[str, Any], prompt: str) -> CADAssembly:
    blades = int(np.clip(params.get("blades", 11), 5, 24))
    radius = float(np.clip(params.get("size_mm", 55.0), 28.0, 120.0))
    height = radius * 0.62
    hub_r = radius * 0.28
    bore_r = hub_r * 0.44

    parts: List[CADPart] = []

    # Aerodynamic contoured hub + spinner nose cone (revolved solid)
    profile = [
        (bore_r, 0.0),
        (radius * 0.98, 0.0),
        (radius * 0.98, height * 0.14),
        (radius * 0.65, height * 0.24),
        (hub_r * 1.18, height * 0.52),
        (hub_r * 0.92, height * 0.85),
        (hub_r * 0.50, height * 1.12),
        (bore_r, height * 1.12),
    ]
    hv, hf, hq = make_revolved_solid(profile, segments=max(blades * 4, 48))
    parts.append(CADPart("impeller_hub_disc", hv, hf, hq, MATERIALS["titanium"], 28.0))

    # Nose spinner cone
    nv, nf, nq = make_revolved_solid(
        [(0.0, height * 1.10), (hub_r * 0.52, height * 1.10), (hub_r * 0.32, height * 1.38), (0.0, height * 1.56)],
        segments=36,
    )
    parts.append(CADPart("aerodynamic_spinner_cone", nv, nf, nq, MATERIALS["anodized_gold"], 25.0))

    # Lofted twisted NACA-style 3D blades
    n_span = 8
    n_chord = 16  # closed airfoil loop points
    for b in range(blades):
        base_theta = 2.0 * math.pi * b / blades
        sections: List[np.ndarray] = []
        for si in range(n_span):
            u = si / float(n_span - 1)  # 0 at hub, 1 at outer tip
            r_span = hub_r * 0.85 + u * (radius * 0.96 - hub_r * 0.85)
            chord = height * (0.68 - 0.18 * u)
            thick_ratio = 0.16 * (1.0 - 0.55 * u)
            sweep_ang = base_theta + 0.58 * (u ** 1.35)
            twist_ang = math.radians(26.0 + 34.0 * u)
            z_center = height * (0.48 - 0.14 * u)

            ring_pts: List[List[float]] = []
            for ci in range(n_chord):
                phi = 2.0 * math.pi * ci / n_chord
                # Parametric cambered airfoil cross-section in local (chord, thickness) coordinates
                xc = 0.5 * math.cos(phi)  # -0.5 to 0.5
                camber = 0.08 * (1.0 - 4.0 * xc * xc)
                yt = thick_ratio * math.sin(phi) * (0.65 - 0.35 * xc) + camber
                # Rotate by blade pitch twist around radial axis
                local_t = xc * chord * math.cos(twist_ang) - yt * chord * math.sin(twist_ang)
                local_z = xc * chord * math.sin(twist_ang) + yt * chord * math.cos(twist_ang)
                # Map onto cylindrical-radial blade surface
                ang = sweep_ang + local_t / max(r_span, 1.0)
                ring_pts.append([r_span * math.cos(ang), r_span * math.sin(ang), z_center + local_z])
            sections.append(np.asarray(ring_pts, dtype=np.float64))

        bv, bf, bq = loft_sections(sections, closed_caps=True)
        parts.append(CADPart(f"turbine_blade_{b+1}", bv, bf, bq, MATERIALS["machined_steel"], 30.0))

    # Rear balancing flange ring
    fv, ff, fq = make_perforated_flange(bore_r, hub_r * 1.15, height * 0.12, num_holes=6, hole_radius=2.0, z_offset=-height * 0.12, chamfer=0.4)
    parts.append(CADPart("rear_mounting_flange", fv, ff, fq, MATERIALS["anodized_blue"], 30.0))

    return CADAssembly(
        title=f"Radial Aerospace Turbine Impeller ({blades} NACA Blades)",
        archetype="turbine_impeller",
        prompt=prompt,
        parts=parts,
        params={"blades": blades, "radius_mm": radius, "height_mm": round(height, 2)},
        scad_code=f"// Radial Turbine Impeller\nblades = {blades}; radius = {radius:.2f};\n",
    )


def build_cnc_bracket(params: Dict[str, Any], prompt: str) -> CADAssembly:
    w = float(np.clip(params.get("size_mm", 84.0), 40.0, 180.0))
    d = w * 0.72
    h = w * 0.78
    thick = max(w * 0.11, 6.0)
    chamfer = float(np.clip(params.get("chamfer", 1.2), 0.4, 3.0))

    parts: List[CADPart] = []

    # Base plate (chamfered) + 4 precision bushing rings/holes
    bv, bf, bq = make_chamfered_box(w, d, thick, chamfer=chamfer, center=(0.0, 0.0, thick * 0.5))
    parts.append(CADPart("cnc_base_plate", bv, bf, bq, MATERIALS["machined_steel"], 30.0))

    # 4 corner flanged mounting collars + hex socket cap screws
    ox, oy = w * 0.34, d * 0.30
    for idx, (sx, sy) in enumerate([(-ox, -oy), (ox, -oy), (ox, oy), (-ox, oy)]):
        cv, cf, cq = _tube(3.2, 6.8, 3.5, segs=24, z0=thick, chamfer=0.6)
        cv = transform_verts(cv, translate=(sx, sy, 0.0))
        parts.append(CADPart(f"mount_collar_{idx+1}", cv, cf, cq, MATERIALS["anodized_blue"], 30.0))
        hv, hf, hq = _hex_head(8.5, 4.2, z0=thick + 3.5)
        hv = transform_verts(hv, translate=(sx, sy, 0.0))
        parts.append(CADPart(f"m6_bolt_{idx+1}", hv, hf, hq, MATERIALS["titanium"], 35.0))

    # Vertical upright back wall
    uv, uf, uq = make_chamfered_box(w * 0.86, thick, h, chamfer=chamfer, center=(0.0, -d * 0.38, thick + h * 0.5 - 1.0))
    parts.append(CADPart("vertical_upright_wall", uv, uf, uq, MATERIALS["machined_steel"], 30.0))

    # Dual clevis bearing lugs projecting forward along +Y
    lug_sep = w * 0.34
    lug_y = -d * 0.08
    lug_z = thick + h * 0.68
    for idx, lx in enumerate((-lug_sep, lug_sep)):
        lv, lf, lq = _tube(9.0, 20.0, thick * 1.1, segs=36, z0=-thick * 0.55, chamfer=chamfer * 0.7)
        lv = transform_verts(lv, rotate_xyz_deg=(0.0, 90.0, 0.0), translate=(lx, lug_y, lug_z))
        parts.append(CADPart(f"clevis_bearing_eye_{idx+1}", lv, lf, lq, MATERIALS["anodized_gold"], 30.0))

        # Clevis arm connecting back wall to eye
        arm_len = abs(lug_y - (-d * 0.38)) + 8.0
        av, af, aq = make_chamfered_box(thick * 1.1, arm_len, 32.0, chamfer=chamfer * 0.6, center=(lx, 0.5 * (lug_y - d * 0.38), lug_z))
        parts.append(CADPart(f"clevis_arm_{idx+1}", av, af, aq, MATERIALS["machined_steel"], 30.0))

    # Cross precision pivot pin
    pv, pf, pq = _cylinder(8.6, lug_sep * 2.5, segs=32, z0=-lug_sep * 1.25)
    pv = transform_verts(pv, rotate_xyz_deg=(0.0, 90.0, 0.0), translate=(0.0, lug_y, lug_z))
    parts.append(CADPart("precision_pivot_pin", pv, pf, pq, MATERIALS["titanium"], 32.0))

    # Twin triangular structural gusset ribs (lofted tapered ribs)
    for idx, gx in enumerate((-w * 0.22, w * 0.22)):
        rib_len = d * 0.52
        rib_h = h * 0.64
        sec0 = np.array([[-thick * 0.38, -d * 0.34, thick], [thick * 0.38, -d * 0.34, thick], [thick * 0.38, -d * 0.34 + rib_len, thick], [-thick * 0.38, -d * 0.34 + rib_len, thick]])
        sec1 = np.array([[-thick * 0.32, -d * 0.34, thick + rib_h], [thick * 0.32, -d * 0.34, thick + rib_h], [thick * 0.32, -d * 0.34 + thick * 1.1, thick + rib_h], [-thick * 0.32, -d * 0.34 + thick * 1.1, thick + rib_h]])
        rv, rf, rq = loft_sections([sec0, sec1], closed_caps=True)
        rv = transform_verts(rv, translate=(gx, 0.0, 0.0))
        parts.append(CADPart(f"structural_gusset_rib_{idx+1}", rv, rf, rq, MATERIALS["titanium"], 32.0))

    return CADAssembly(
        title=f"CNC Aerospace Clevis Mounting Bracket ({w:.0f}mm)",
        archetype="cnc_bracket",
        prompt=prompt,
        parts=parts,
        params={"width_mm": w, "depth_mm": round(d, 1), "height_mm": round(h, 1), "chamfer": chamfer},
        scad_code=f"// Aerospace CNC Bracket\nw={w:.1f}; d={d:.1f}; h={h:.1f}; thick={thick:.1f};\n",
    )


def build_flanged_valve(params: Dict[str, Any], prompt: str) -> CADAssembly:
    pipe_r = float(np.clip(params.get("size_mm", 44.0) * 0.45, 14.0, 42.0))
    wall = max(pipe_r * 0.24, 4.0)
    r_outer = pipe_r + wall
    flange_r = r_outer * 1.68
    holes = int(np.clip(params.get("holes", 8), 4, 12))
    bend_r = r_outer * 2.2

    parts: List[CADPart] = []

    # 90-degree swept hollow pipe elbow using lofted circular rings (outer & inner or thick manifold rings)
    # Build watertight thick-walled elbow by sweeping rectangular-annulus cross section or solid body + end flanges
    # Better: build outer + inner coaxial 90-deg torus sector capped cleanly with the perforated flanges!
    # Wait: to guarantee EACH CADPart is independently 100% watertight, let's build the elbow pipe wall as a closed revolved profile over 90 deg, OR closed lofted thick-walled ring? A closed 90-deg pipe has 2 open circular ends unless capped, so let's cap each end with a recessed bore plug OR build 24 segments around the cross-section? Wait: an elbow with a through-bore is genus 1 — we can sweep the 2-ring cross-section or build solid outer bend + recessed flange bores! Even better: sweep an annular ring? Wait: `loft_sections` with `closed_caps=False` would leave ends open unless we connect outer->inner!
    # Let's build a 100% watertight 90-deg hollow pipe bend directly!
    n_arc = 20
    n_circ = 32
    thetas = np.linspace(0.0, 2.0 * math.pi, n_circ, endpoint=False)
    phis = np.linspace(0.0, math.pi * 0.5, n_arc)

    verts_list: List[List[float]] = []
    # Outer surface rings: indices 0..n_arc-1
    for phi in phis:
        cx, cz = bend_r * math.cos(phi), bend_r * math.sin(phi)
        nx, nz = math.cos(phi), math.sin(phi)
        for th in thetas:
            r_off = r_outer * math.cos(th)
            y_off = r_outer * math.sin(th)
            verts_list.append([cx + r_off * nx, y_off, cz + r_off * nz])
    # Inner bore surface rings: indices n_arc..2*n_arc-1
    for phi in phis:
        cx, cz = bend_r * math.cos(phi), bend_r * math.sin(phi)
        nx, nz = math.cos(phi), math.sin(phi)
        for th in thetas:
            r_off = pipe_r * math.cos(th)
            y_off = pipe_r * math.sin(th)
            verts_list.append([cx + r_off * nx, y_off, cz + r_off * nz])

    quads: List[List[int]] = []
    # Outer wall
    for ai in range(n_arc - 1):
        b0, b1 = ai * n_circ, (ai + 1) * n_circ
        for ci in range(n_circ):
            nci = (ci + 1) % n_circ
            quads.append([b0 + ci, b0 + nci, b1 + nci, b1 + ci])
    # Inner bore wall (reversed winding)
    in_off = n_arc * n_circ
    for ai in range(n_arc - 1):
        b0, b1 = in_off + ai * n_circ, in_off + (ai + 1) * n_circ
        for ci in range(n_circ):
            nci = (ci + 1) % n_circ
            quads.append([b0 + nci, b0 + ci, b1 + ci, b1 + nci])
    # Start annular end cap (phi=0)
    for ci in range(n_circ):
        nci = (ci + 1) % n_circ
        quads.append([ci, in_off + ci, in_off + nci, nci])
    # End annular end cap (phi=pi/2)
    eo = (n_arc - 1) * n_circ
    ei = in_off + eo
    for ci in range(n_circ):
        nci = (ci + 1) % n_circ
        quads.append([eo + nci, ei + nci, ei + ci, eo + ci])

    ev, ef, eq = _fix_winding_and_merge(np.asarray(verts_list, dtype=np.float64), quads_to_tris(np.asarray(quads, dtype=np.int32)), np.asarray(quads, dtype=np.int32))
    # Shift so bend center aligns nicely near origin
    ev = transform_verts(ev, translate=(-bend_r * 0.45, 0.0, -bend_r * 0.25))
    parts.append(CADPart("swept_90deg_elbow_body", ev, ef, eq, MATERIALS["titanium"], 28.0))

    # Bottom inlet bolted flange (at phi=0: center at (bend_r, 0, 0) pointing -Z)
    f1v, f1f, f1q = make_perforated_flange(pipe_r, flange_r, wall * 2.2, num_holes=holes, hole_radius=wall * 0.72, chamfer=0.7)
    f1v = transform_verts(f1v, translate=(bend_r - bend_r * 0.45, 0.0, -bend_r * 0.25 - wall * 2.15))
    parts.append(CADPart("inlet_bolted_flange", f1v, f1f, f1q, MATERIALS["anodized_blue"], 30.0))

    # Top/side outlet bolted flange (at phi=pi/2: center at (0, 0, bend_r) pointing -X)
    f2v, f2f, f2q = make_perforated_flange(pipe_r, flange_r, wall * 2.2, num_holes=holes, hole_radius=wall * 0.72, chamfer=0.7)
    f2v = transform_verts(f2v, rotate_xyz_deg=(0.0, -90.0, 0.0), translate=(-bend_r * 0.45, 0.0, bend_r - bend_r * 0.25))
    parts.append(CADPart("outlet_bolted_flange", f2v, f2f, f2q, MATERIALS["anodized_blue"], 30.0))

    # Valve bonnet & handwheel assembly mounted on elbow crown
    crown_x = bend_r * math.cos(math.pi * 0.25) - bend_r * 0.45
    crown_z = bend_r * math.sin(math.pi * 0.25) - bend_r * 0.25
    sv, sf, sq = _tube(r_outer * 0.22, r_outer * 0.42, r_outer * 1.1, segs=24, z0=0.0, chamfer=0.6)
    sv = transform_verts(sv, rotate_xyz_deg=(0.0, 45.0, 0.0), translate=(crown_x, 0.0, crown_z))
    parts.append(CADPart("valve_bonnet_stem", sv, sf, sq, MATERIALS["anodized_gold"], 30.0))

    # Handwheel rim
    hw_r = flange_r * 0.65
    rim_prof = [
        (hw_r - 3.0, -3.0),
        (hw_r + 3.0, -3.0),
        (hw_r + 3.0, 3.0),
        (hw_r - 3.0, 3.0),
    ]
    wv, wf, wq = make_revolved_solid(rim_prof, segments=36)
    wv = transform_verts(wv, translate=(0.0, 0.0, r_outer * 1.15))
    wv = transform_verts(wv, rotate_xyz_deg=(0.0, 45.0, 0.0), translate=(crown_x, 0.0, crown_z))
    parts.append(CADPart("valve_handwheel", wv, wf, wq, MATERIALS["industrial_orange"], 25.0))

    return CADAssembly(
        title=f"Industrial Bolted Valve & 90° Flange Elbow ({holes}-Bolt PCD)",
        archetype="flanged_valve",
        prompt=prompt,
        parts=parts,
        params={"pipe_radius_mm": round(pipe_r, 1), "flange_holes": holes, "bend_radius_mm": round(bend_r, 1)},
        scad_code=f"// Industrial Flanged Valve Assembly\npipe_r={pipe_r:.1f}; holes={holes}; bend_r={bend_r:.1f};\n",
    )


def build_robotic_actuator(params: Dict[str, Any], prompt: str) -> CADAssembly:
    scale = float(np.clip(params.get("size_mm", 65.0) / 65.0, 0.6, 2.0))
    parts: List[CADPart] = []

    # Harmonic drive base pedestal with 6 mounting holes
    bv, bf, bq = make_perforated_flange(14.0 * scale, 36.0 * scale, 10.0 * scale, num_holes=6, hole_radius=3.2 * scale, chamfer=0.8)
    parts.append(CADPart("base_mounting_flange", bv, bf, bq, MATERIALS["carbon_composite"], 30.0))

    # Ribbed stator housing cylinder
    hv, hf, hq = _tube(15.0 * scale, 28.0 * scale, 26.0 * scale, segs=40, z0=10.0 * scale, chamfer=1.0)
    parts.append(CADPart("harmonic_stator_housing", hv, hf, hq, MATERIALS["anodized_blue"], 28.0))

    # Cooling rings around stator
    for ri in range(3):
        rv, rf, rq = _tube(27.5 * scale, 31.0 * scale, 2.4 * scale, segs=40, z0=(14.0 + ri * 6.5) * scale, chamfer=0.4)
        parts.append(CADPart(f"cooling_fin_ring_{ri+1}", rv, rf, rq, MATERIALS["titanium"], 32.0))

    # Rotary joint turret + twin clevis arms
    tv, tf, tq = make_chamfered_box(38.0 * scale, 36.0 * scale, 16.0 * scale, chamfer=1.8 * scale, center=(0.0, 0.0, 44.0 * scale))
    parts.append(CADPart("shoulder_turret", tv, tf, tq, MATERIALS["machined_steel"], 30.0))

    # Articulated arm link (angled 32 degrees)
    av, af, aq = make_chamfered_box(16.0 * scale, 18.0 * scale, 64.0 * scale, chamfer=1.6 * scale, center=(0.0, 0.0, 32.0 * scale))
    av = transform_verts(av, rotate_xyz_deg=(32.0, 0.0, 0.0), translate=(0.0, 0.0, 46.0 * scale))
    parts.append(CADPart("articulated_arm_link", av, af, aq, MATERIALS["ceramic_white"], 30.0))

    # Elbow harmonic joint drum at end of arm link
    ey = -64.0 * scale * math.sin(math.radians(32.0))
    ez = 46.0 * scale + 64.0 * scale * math.cos(math.radians(32.0))
    ev, ef, eq = _tube(7.0 * scale, 16.0 * scale, 26.0 * scale, segs=36, z0=-13.0 * scale, chamfer=0.9)
    ev = transform_verts(ev, rotate_xyz_deg=(0.0, 90.0, 0.0), translate=(0.0, ey, ez))
    parts.append(CADPart("elbow_harmonic_joint", ev, ef, eq, MATERIALS["anodized_gold"], 30.0))

    # Forearm boom & end-effector ISO flange
    fv, ff, fq = make_chamfered_box(13.0 * scale, 13.0 * scale, 48.0 * scale, chamfer=1.2 * scale, center=(0.0, 0.0, 24.0 * scale))
    fv = transform_verts(fv, rotate_xyz_deg=(-48.0, 0.0, 0.0), translate=(0.0, ey, ez))
    parts.append(CADPart("forearm_boom", fv, ff, fq, MATERIALS["carbon_composite"], 30.0))

    tip_y = ey - 48.0 * scale * math.sin(math.radians(-48.0))
    tip_z = ez + 48.0 * scale * math.cos(math.radians(-48.0))
    efv, eff, efq = make_perforated_flange(5.0 * scale, 18.0 * scale, 6.0 * scale, num_holes=6, hole_radius=1.6 * scale, chamfer=0.5)
    efv = transform_verts(efv, rotate_xyz_deg=(-48.0, 0.0, 0.0), translate=(0.0, tip_y, tip_z))
    parts.append(CADPart("iso_end_effector_flange", efv, eff, efq, MATERIALS["industrial_orange"], 30.0))

    return CADAssembly(
        title="6-DOF Harmonic Drive Robotic Actuator Arm",
        archetype="robotic_actuator",
        prompt=prompt,
        parts=parts,
        params={"scale": round(scale, 2), "dof_joints": 3},
        scad_code=f"// 6-DOF Robotic Actuator Assembly\nscale = {scale:.2f};\n",
    )


def build_heatsink_enclosure(params: Dict[str, Any], prompt: str) -> CADAssembly:
    w = float(np.clip(params.get("size_mm", 92.0), 50.0, 180.0))
    d = w * 0.78
    h = w * 0.34
    fins = int(np.clip(params.get("fins", 11), 5, 22))
    chamfer = float(np.clip(params.get("chamfer", 1.5), 0.4, 3.0))

    parts: List[CADPart] = []

    # Main CNC chassis housing
    cv, cf, cq = make_chamfered_box(w, d, h, chamfer=chamfer, center=(0.0, 0.0, h * 0.5))
    parts.append(CADPart("cnc_chassis_body", cv, cf, cq, MATERIALS["carbon_composite"], 30.0))

    # Top anodized cooling fin array
    usable_w = w * 0.84
    pitch = usable_w / max(fins, 1)
    fin_t = pitch * 0.42
    fin_h = h * 0.48
    for i in range(fins):
        fx = -usable_w * 0.5 + (i + 0.5) * pitch
        fv, ff, fq = make_chamfered_box(fin_t, d * 0.86, fin_h, chamfer=min(fin_t * 0.2, 0.4), center=(fx, 0.0, h + fin_h * 0.5 - 0.5))
        parts.append(CADPart(f"cooling_fin_{i+1}", fv, ff, fq, MATERIALS["machined_steel"], 35.0))

    # Corner M4 socket fasteners & standoff flanges
    ox, oy = w * 0.43, d * 0.40
    for idx, (sx, sy) in enumerate([(-ox, -oy), (ox, -oy), (ox, oy), (-ox, oy)]):
        bv, bf, bq = _hex_head(5.8, 3.5, z0=h)
        bv = transform_verts(bv, translate=(sx, sy, 0.0))
        parts.append(CADPart(f"corner_bolt_{idx+1}", bv, bf, bq, MATERIALS["anodized_gold"], 35.0))

    # Front brushed aluminum I/O faceplate
    pv, pf, pq = make_chamfered_box(w * 0.92, 4.0, h * 0.68, chamfer=0.8, center=(0.0, -d * 0.5 - 1.5, h * 0.5))
    parts.append(CADPart("front_io_faceplate", pv, pf, pq, MATERIALS["anodized_blue"], 30.0))

    return CADAssembly(
        title=f"CNC Finned Heatsink Enclosure ({fins} Fins)",
        archetype="heatsink_enclosure",
        prompt=prompt,
        parts=parts,
        params={"width_mm": w, "depth_mm": round(d, 1), "fins": fins},
        scad_code=f"// CNC Heatsink Enclosure\nw={w:.1f}; d={d:.1f}; fins={fins};\n",
    )


def build_geodesic_pavilion(params: Dict[str, Any], prompt: str) -> CADAssembly:
    radius = float(np.clip(params.get("size_mm", 76.0), 40.0, 160.0))
    n_ribs = int(np.clip(params.get("fins", 12), 6, 20))
    n_rings = 4
    parts: List[CADPart] = []

    # Stepped circular architectural podium base
    pv, pf, pq = make_revolved_solid(
        [(0.0, 0.0), (radius * 1.12, 0.0), (radius * 1.12, 4.0), (radius * 1.04, 4.0), (radius * 1.04, 8.0), (0.0, 8.0)],
        segments=max(n_ribs * 3, 48),
    )
    parts.append(CADPart("architectural_podium_base", pv, pf, pq, MATERIALS["ceramic_white"], 30.0))

    # Curved meridional structural diagrid ribs lofted cleanly
    for r_idx in range(n_ribs):
        theta = 2.0 * math.pi * r_idx / n_ribs
        sections: List[np.ndarray] = []
        for s in range(9):
            phi = (s / 8.0) * (math.pi * 0.46)
            rc = radius * math.cos(phi)
            zc = 8.0 + radius * 0.85 * math.sin(phi)
            # Rectangular rib cross-section oriented radially
            rw, rh = 2.2, 3.6
            ct, st = math.cos(theta), math.sin(theta)
            tx, ty = -st, ct
            nx, ny = ct * math.cos(phi), st * math.cos(phi)
            nz = math.sin(phi)
            # Tangent along meridian
            mx, my, mz = -ct * math.sin(phi), -st * math.sin(phi), math.cos(phi)
            # Normal outward (nx, ny, nz) and side (tx, ty, 0)
            p_c = np.array([rc * ct, rc * st, zc])
            side = np.array([tx, ty, 0.0]) * (rw * 0.5)
            outv = np.array([nx, ny, nz]) * (rh * 0.5)
            sec = np.array([p_c - side - outv, p_c + side - outv, p_c + side + outv, p_c - side + outv])
            sections.append(sec)
        rv, rf, rq = loft_sections(sections, closed_caps=True)
        parts.append(CADPart(f"meridional_rib_{r_idx+1}", rv, rf, rq, MATERIALS["titanium"], 35.0))

    # Horizontal structural compression rings
    for ri in range(1, n_rings + 1):
        phi = (ri / float(n_rings + 0.3)) * (math.pi * 0.46)
        rc = radius * math.cos(phi)
        zc = 8.0 + radius * 0.85 * math.sin(phi)
        tv, tf, tq = make_revolved_solid(
            [(rc - 1.6, zc - 1.6), (rc + 1.6, zc - 1.6), (rc + 1.6, zc + 1.6), (rc - 1.6, zc + 1.6)],
            segments=max(n_ribs * 3, 48),
        )
        parts.append(CADPart(f"compression_ring_{ri}", tv, tf, tq, MATERIALS["anodized_gold"], 30.0))

    # Glazed faceted dome shell (thick watertight shell slightly inset)
    shell_prof = []
    for s in range(9):
        phi = (s / 8.0) * (math.pi * 0.44)
        shell_prof.append((max(radius * 0.96 * math.cos(phi), 0.0), 8.0 + radius * 0.82 * math.sin(phi)))
    shell_prof[0] = (radius * 0.96, 8.0)
    shell_prof.append((0.0, 8.0 + radius * 0.82 * math.sin(math.pi * 0.44)))
    for s in range(8, -1, -1):
        phi = (s / 8.0) * (math.pi * 0.44)
        r_in = max(radius * 0.93 * math.cos(phi), 0.0)
        z_in = 8.0 + radius * 0.79 * math.sin(phi)
        if s == 8:
            shell_prof.append((0.0, z_in))
        else:
            shell_prof.append((r_in, z_in))
    gv, gf, gq = make_revolved_solid(shell_prof, segments=n_ribs * 2)
    parts.append(CADPart("glazed_dome_envelope", gv, gf, gq, MATERIALS["architectural_glass"], 20.0))

    return CADAssembly(
        title=f"Parametric Geodesic Diagrid Pavilion ({n_ribs} Ribs)",
        archetype="geodesic_pavilion",
        prompt=prompt,
        parts=parts,
        params={"radius_mm": radius, "ribs": n_ribs, "rings": n_rings},
        scad_code=f"// Parametric Geodesic Pavilion\nradius={radius:.1f}; ribs={n_ribs};\n",
    )


def build_aerospace_fuselage(params: Dict[str, Any], prompt: str) -> CADAssembly:
    length = float(np.clip(params.get("size_mm", 120.0), 60.0, 240.0))
    r_max = length * 0.13
    parts: List[CADPart] = []

    # Ogive-to-boat-tail fuselage + rocket/jet body via revolved profile
    prof = [
        (0.0, length * 0.52),
        (r_max * 0.36, length * 0.42),
        (r_max * 0.80, length * 0.26),
        (r_max, length * 0.05),
        (r_max * 0.96, -length * 0.25),
        (r_max * 0.78, -length * 0.42),
        (r_max * 0.56, -length * 0.46),
        (0.0, -length * 0.46),
    ]
    fv, ff, fq = make_revolved_solid(list(reversed(prof)), segments=40)
    fv = transform_verts(fv, rotate_xyz_deg=(-90.0, 0.0, 0.0))  # Nose along +Y
    parts.append(CADPart("aerospace_fuselage_hull", fv, ff, fq, MATERIALS["ceramic_white"], 25.0))

    # Swept airfoil wings (left & right lofted NACA-like sections)
    span = length * 0.46
    for side_name, sgn in (("port_wing", -1.0), ("starboard_wing", 1.0)):
        secs: List[np.ndarray] = []
        for wi in range(6):
            u = wi / 5.0
            x_pos = sgn * (r_max * 0.75 + u * span)
            chord = length * (0.28 - 0.17 * u)
            y_le = length * 0.06 - u * length * 0.22
            thick = chord * (0.11 - 0.04 * u)
            ring = []
            for ci in range(14):
                phi = 2.0 * math.pi * ci / 14
                xc = 0.5 - 0.5 * math.cos(phi)  # 0 at LE -> 1 at TE
                yt = thick * math.sin(phi) * (0.85 - 0.5 * xc)
                ring.append([x_pos, y_le - xc * chord, yt])
            secs.append(np.asarray(ring, dtype=np.float64))
        wv, wf, wq = loft_sections(secs, closed_caps=True)
        parts.append(CADPart(side_name, wv, wf, wq, MATERIALS["titanium"], 28.0))

    # Vertical tail stabilizer fin
    v_secs = []
    for vi in range(5):
        u = vi / 4.0
        z_pos = r_max * 0.65 + u * length * 0.24
        chord = length * (0.22 - 0.12 * u)
        y_le = -length * 0.20 - u * length * 0.16
        thick = chord * 0.10
        ring = []
        for ci in range(12):
            phi = 2.0 * math.pi * ci / 12
            xc = 0.5 - 0.5 * math.cos(phi)
            xt = thick * math.sin(phi) * (0.85 - 0.5 * xc)
            ring.append([xt, y_le - xc * chord, z_pos])
        v_secs.append(np.asarray(ring, dtype=np.float64))
    sv, sf, sq = loft_sections(v_secs, closed_caps=True)
    parts.append(CADPart("vertical_stabilizer_fin", sv, sf, sq, MATERIALS["anodized_blue"], 28.0))

    # Converging-diverging thruster exhaust bell nozzle
    noz_prof = [
        (0.0, -length * 0.45),
        (r_max * 0.58, -length * 0.45),
        (r_max * 0.42, -length * 0.50),
        (r_max * 0.72, -length * 0.60),
        (r_max * 0.56, -length * 0.60),
        (r_max * 0.34, -length * 0.50),
        (0.0, -length * 0.50),
    ]
    nv, nf, nq = make_revolved_solid(list(reversed(noz_prof)), segments=36)
    nv = transform_verts(nv, rotate_xyz_deg=(-90.0, 0.0, 0.0))
    parts.append(CADPart("exhaust_bell_nozzle", nv, nf, nq, MATERIALS["copper"], 25.0))

    return CADAssembly(
        title=f"Aerospace Swept-Wing Airframe & Nozzle ({length:.0f}mm)",
        archetype="aerospace_fuselage",
        prompt=prompt,
        parts=parts,
        params={"length_mm": length, "wingspan_mm": round(span * 2.0, 1)},
        scad_code=f"// Aerospace Swept-Wing Vehicle\nlength={length:.1f}; wingspan={span*2:.1f};\n",
    )


def build_precision_fastener_vessel(params: Dict[str, Any], prompt: str) -> CADAssembly:
    """Fluted Architectural Column / Precision Lathe Vessel with helical ribs or hex fastener."""
    p = prompt.lower()
    is_fastener = any(k in p for k in ("болт", "гайк", "резьб", "bolt", "nut", "screw", "fastener", "thread"))
    parts: List[CADPart] = []

    if is_fastener:
        r_shaft = float(np.clip(params.get("size_mm", 40.0) * 0.25, 6.0, 18.0))
        # Precision Hex Bolt with helical thread ridges (closed revolved profile)
        prof: List[Tuple[float, float]] = [(0.0, 0.0), (r_shaft * 0.85, 0.0), (r_shaft, 1.5)]
        pitch = 3.0
        n_threads = 10
        z_cur = 4.0
        prof.append((r_shaft, z_cur))
        for _ in range(n_threads):
            prof.append((r_shaft * 1.12, z_cur + pitch * 0.45))
            prof.append((r_shaft * 0.92, z_cur + pitch * 0.95))
            z_cur += pitch
        prof.append((r_shaft, z_cur + 6.0))
        prof.append((0.0, z_cur + 6.0))
        sv, sf, sq = make_revolved_solid(prof, segments=36)
        parts.append(CADPart("threaded_bolt_shank", sv, sf, sq, MATERIALS["machined_steel"], 25.0))

        hv, hf, hq = _hex_head(r_shaft * 3.1, r_shaft * 1.25, z0=z_cur + 6.0)
        parts.append(CADPart("hex_bolt_head", hv, hf, hq, MATERIALS["anodized_gold"], 35.0))

        # Matching washer + nut collar positioned partway along thread
        wv, wf, wq = _tube(r_shaft * 1.15, r_shaft * 2.2, 3.0, segs=36, z0=z_cur - 2.0, chamfer=0.5)
        parts.append(CADPart("precision_washer", wv, wf, wq, MATERIALS["titanium"], 30.0))

        nv, nf, nq = make_annular_extrusion(
            np.column_stack([r_shaft * 1.9 * np.cos(np.linspace(0, 2 * math.pi, 6, endpoint=False)), r_shaft * 1.9 * np.sin(np.linspace(0, 2 * math.pi, 6, endpoint=False))]),
            np.column_stack([r_shaft * 1.14 * np.cos(np.linspace(0, 2 * math.pi, 6, endpoint=False)), r_shaft * 1.14 * np.sin(np.linspace(0, 2 * math.pi, 6, endpoint=False))]),
            z0=10.0,
            z1=10.0 + r_shaft * 1.1,
            chamfer=0.8,
        )
        parts.append(CADPart("hex_locking_nut", nv, nf, nq, MATERIALS["anodized_blue"], 35.0))
        title = "Precision Threaded Bolt, Washer & Hex Nut Assembly"
    else:
        h = float(np.clip(params.get("size_mm", 88.0), 45.0, 180.0))
        r_base = h * 0.34
        # Architectural pedestal + fluted twisted lathe vessel
        pv, pf, pq = make_chamfered_box(r_base * 2.2, r_base * 2.2, h * 0.11, chamfer=1.6, center=(0.0, 0.0, h * 0.055))
        parts.append(CADPart("chamfered_pedestal", pv, pf, pq, MATERIALS["carbon_composite"], 35.0))

        # Smooth revolved sculptural core
        prof = [
            (0.0, h * 0.11),
            (r_base * 0.78, h * 0.11),
            (r_base * 0.56, h * 0.24),
            (r_base * 0.94, h * 0.54),
            (r_base * 0.72, h * 0.80),
            (r_base * 0.48, h * 0.94),
            (r_base * 0.58, h * 1.00),
            (0.0, h * 1.00),
        ]
        vv, vf, vq = make_revolved_solid(prof, segments=48)
        parts.append(CADPart("lathe_core_vessel", vv, vf, vq, MATERIALS["ceramic_white"], 24.0))

        # Fluted helical architectural ribs around vessel
        n_ribs = int(np.clip(params.get("fins", 10), 6, 18))
        for ri in range(n_ribs):
            theta0 = 2.0 * math.pi * ri / n_ribs
            secs = []
            for s in range(9):
                u = s / 8.0
                z = h * (0.14 + 0.82 * u)
                r = r_base * (0.58 + 0.38 * math.sin(u * math.pi * 0.85))
                th = theta0 + 0.45 * u
                w_rib = 2.2
                c, sn = math.cos(th), math.sin(th)
                tx, ty = -sn, c
                center = np.array([r * c, r * sn, z])
                n_out = np.array([c, sn, 0.0]) * 2.5
                t_dir = np.array([tx, ty, 0.0]) * w_rib
                secs.append(np.array([center - t_dir, center + t_dir, center + t_dir + n_out, center - t_dir + n_out]))
            rv, rf, rq = loft_sections(secs, closed_caps=True)
            parts.append(CADPart(f"helical_flute_rib_{ri+1}", rv, rf, rq, MATERIALS["anodized_gold"], 32.0))
        title = f"Parametric Fluted Architectural Vessel ({n_ribs} Helical Ribs)"

    return CADAssembly(
        title=title,
        archetype="precision_fastener_vessel",
        prompt=prompt,
        parts=parts,
        params=params,
        scad_code=f"// {title}\n",
    )


def build_blueprint_extrusion(silhouette_mask: np.ndarray, title: str = "Vision-to-CAD Reconstructed Relief", thickness: float = 14.0) -> CADAssembly:
    """
    Convert a detected 2D binary/depth silhouette from Vision+OCR into a clean watertight
    stepped multi-layer CAD relief + chamfered mounting plate.
    """
    h, w = silhouette_mask.shape
    # Downsample to clean 24x24 CAD voxel heightfield column grid merged smoothly or stepped architectural plate
    gh, gw = 20, 20
    small = np.zeros((gh, gw), dtype=np.float32)
    bh, bw = max(h // gh, 1), max(w // gw, 1)
    for r in range(gh):
        for c in range(gw):
            patch = silhouette_mask[r * bh : (r + 1) * bh, c * bw : (c + 1) * bw]
            small[r, c] = float(np.mean(patch)) if patch.size else 0.0

    parts: List[CADPart] = []
    # Base chamfered CAD plate
    pv, pf, pq = make_chamfered_box(84.0, 84.0, 6.0, chamfer=1.2, center=(0.0, 0.0, 3.0))
    parts.append(CADPart("cad_base_plate", pv, pf, pq, MATERIALS["carbon_composite"], 30.0))

    cell_w = 72.0 / gw
    cell_h = 72.0 / gh
    for r in range(gh):
        for c in range(gw):
            val = small[r, c]
            if val > 0.25:
                cz_h = 3.0 + val * thickness
                cx = (c - gw * 0.5 + 0.5) * cell_w
                cy = -(r - gh * 0.5 + 0.5) * cell_h
                bv, bf, bq = make_chamfered_box(cell_w * 0.92, cell_h * 0.92, cz_h, chamfer=0.35, center=(cx, cy, 6.0 + cz_h * 0.5))
                parts.append(CADPart(f"extruded_feature_{r}_{c}", bv, bf, bq, MATERIALS["anodized_blue"], 30.0))

    return CADAssembly(
        title=title,
        archetype="vision_blueprint_extrusion",
        prompt="Image-to-CAD Reconstruction",
        parts=parts,
        params={"grid": [gh, gw], "thickness_mm": thickness},
        scad_code="// Reconstructed from uploaded image blueprint\n",
    )

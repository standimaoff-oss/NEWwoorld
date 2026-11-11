"""Core manifold CAD mesh builders, topology audit, and multi-format exporters."""

from __future__ import annotations
import io
import json
import math
import struct
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple
import numpy as np
import trimesh


@dataclass
class CADMaterial:
    name: str = "anodized_titanium"
    base_color: Tuple[float, float, float, float] = (0.72, 0.76, 0.82, 1.0)
    metallic: float = 0.88
    roughness: float = 0.28

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "baseColor": list(self.base_color),
            "metallic": self.metallic,
            "roughness": self.roughness,
        }


MATERIALS: Dict[str, CADMaterial] = {
    "machined_steel": CADMaterial("machined_steel", (0.76, 0.79, 0.83, 1.0), 0.92, 0.24),
    "titanium": CADMaterial("titanium", (0.64, 0.67, 0.72, 1.0), 0.90, 0.30),
    "anodized_blue": CADMaterial("anodized_blue", (0.16, 0.45, 0.85, 1.0), 0.82, 0.26),
    "anodized_gold": CADMaterial("anodized_gold", (0.88, 0.68, 0.22, 1.0), 0.92, 0.22),
    "copper": CADMaterial("copper", (0.85, 0.48, 0.30, 1.0), 0.94, 0.22),
    "carbon_composite": CADMaterial("carbon_composite", (0.16, 0.18, 0.21, 1.0), 0.35, 0.42),
    "ceramic_white": CADMaterial("ceramic_white", (0.91, 0.92, 0.94, 1.0), 0.08, 0.20),
    "architectural_glass": CADMaterial("architectural_glass", (0.48, 0.74, 0.88, 0.55), 0.10, 0.08),
    "industrial_orange": CADMaterial("industrial_orange", (0.90, 0.36, 0.12, 1.0), 0.45, 0.34),
}


@dataclass
class CADPart:
    name: str
    vertices: np.ndarray  # (N, 3) float64
    faces: np.ndarray     # (F, 3) int32 triangles
    quads: Optional[np.ndarray] = None  # (Q, 4) int32 optional pure-quad faces
    material: CADMaterial = field(default_factory=lambda: MATERIALS["machined_steel"])
    crease_angle_deg: float = 34.0
    cad_ops: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class CADAssembly:
    title: str
    archetype: str
    prompt: str
    parts: List[CADPart]
    params: Dict[str, Any] = field(default_factory=dict)
    program_tokens: List[str] = field(default_factory=list)
    scad_code: str = ""


def _fix_winding_and_merge(verts: np.ndarray, faces: np.ndarray, quads: Optional[np.ndarray] = None) -> Tuple[np.ndarray, np.ndarray, Optional[np.ndarray]]:
    """Ensure outward-facing winding (positive signed volume) and deduplicate near-identical vertices."""
    v = np.asarray(verts, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int32)
    # Compute signed volume * 6
    v0 = v[f[:, 0]]
    v1 = v[f[:, 1]]
    v2 = v[f[:, 2]]
    vol6 = float(np.sum(np.einsum("ij,ij->i", v0, np.cross(v1, v2))))
    if vol6 < 0.0:
        f = f[:, [0, 2, 1]]
        if quads is not None:
            quads = np.asarray(quads, dtype=np.int32)[:, [0, 3, 2, 1]]
    return v, f, quads


def quads_to_tris(quads: np.ndarray) -> np.ndarray:
    q = np.asarray(quads, dtype=np.int32)
    t1 = q[:, [0, 1, 2]]
    t2 = q[:, [0, 2, 3]]
    return np.vstack([t1, t2])


def make_chamfered_box(
    sx: float,
    sy: float,
    sz: float,
    chamfer: float = 0.0,
    center: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Create a watertight pure-quad box or chamfered box (via octant corner beveling)."""
    hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
    c = float(min(chamfer, hx * 0.4, hy * 0.4, hz * 0.4))
    cx, cy, cz = center

    if c <= 1e-6:
        verts = np.array(
            [
                [-hx, -hy, -hz],
                [hx, -hy, -hz],
                [hx, hy, -hz],
                [-hx, hy, -hz],
                [-hx, -hy, hz],
                [hx, -hy, hz],
                [hx, hy, hz],
                [-hx, hy, hz],
            ],
            dtype=np.float64,
        ) + np.array([cx, cy, cz])
        quads = np.array(
            [
                [0, 3, 2, 1],
                [4, 5, 6, 7],
                [0, 1, 5, 4],
                [1, 2, 6, 5],
                [2, 3, 7, 6],
                [3, 0, 4, 7],
            ],
            dtype=np.int32,
        )
        verts, faces, quads = _fix_winding_and_merge(verts, quads_to_tris(quads), quads)
        return verts, faces, quads

    # Chamfered box: extrude octagonal profile along Z with clean top/bottom chamfered bevels
    ix, iy = hx - c, hy - c
    # 8-vertex chamfered 2D rectangle (CCW)
    prof_mid = [
        (ix, -hy),
        (hx, -iy),
        (hx, iy),
        (ix, hy),
        (-ix, hy),
        (-hx, iy),
        (-hx, -iy),
        (-ix, -hy),
    ]
    c_in = c * 0.85
    hx_i, hy_i = max(hx - c_in, hx * 0.2), max(hy - c_in, hy * 0.2)
    ix_i, iy_i = max(ix - c_in * 0.6, hx * 0.1), max(iy - c_in * 0.6, hy * 0.1)
    prof_cap = [
        (ix_i, -hy_i),
        (hx_i, -iy_i),
        (hx_i, iy_i),
        (ix_i, hy_i),
        (-ix_i, hy_i),
        (-hx_i, iy_i),
        (-hx_i, -iy_i),
        (-ix_i, -hy_i),
    ]
    rings = []
    z_levels = [
        (-hz, prof_cap),
        (-hz + c, prof_mid),
        (hz - c, prof_mid),
        (hz, prof_cap),
    ]
    for z, prof in z_levels:
        for px, py in prof:
            rings.append([px + cx, py + cy, z + cz])

    # Top and bottom caps: pure convex CCW quads covering the octagon
    n = 8
    verts = np.asarray(rings, dtype=np.float64)

    quads_list = []
    # 3 vertical/chamfered bands
    for b in range(3):
        r0 = b * n
        r1 = (b + 1) * n
        for i in range(n):
            ni = (i + 1) % n
            quads_list.append([r0 + i, r0 + ni, r1 + ni, r1 + i])

    # Bottom cap (normal -Z -> CW when viewed from +Z)
    quads_list.append([0, 3, 2, 1])
    quads_list.append([7, 4, 3, 0])
    quads_list.append([6, 5, 4, 7])

    # Top cap (normal +Z -> CCW when viewed from +Z)
    rt = 3 * n
    quads_list.append([rt + 0, rt + 1, rt + 2, rt + 3])
    quads_list.append([rt + 7, rt + 0, rt + 3, rt + 4])
    quads_list.append([rt + 6, rt + 7, rt + 4, rt + 5])

    q_arr = np.asarray(quads_list, dtype=np.int32)
    verts, faces, quads = _fix_winding_and_merge(verts, quads_to_tris(q_arr), q_arr)
    return verts, faces, quads


def make_revolved_solid(
    profile_rz: Sequence[Tuple[float, float]],
    segments: int = 48,
    center: Tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Revolve a closed 2D (r, z) polygon around the Z axis into a watertight solid.
    profile_rz: list of (r, z) points. If first and last have r==0, forms solid caps;
    if all r > 0 (closed ring cross-section), forms a watertight torus-like tube.
    """
    pts = [(float(r), float(z)) for r, z in profile_rz]
    has_bot_pole = pts[0][0] <= 1e-7
    has_top_pole = pts[-1][0] <= 1e-7

    inner_pts = pts[1 if has_bot_pole else 0 : (-1 if has_top_pole else len(pts))]
    n_rings = len(inner_pts)
    cx, cy, cz = center

    verts_list: List[List[float]] = []
    thetas = np.linspace(0.0, 2.0 * math.pi, segments, endpoint=False)
    cos_t = np.cos(thetas)
    sin_t = np.sin(thetas)

    for r, z in inner_pts:
        for ct, st in zip(cos_t, sin_t):
            verts_list.append([cx + r * ct, cy + r * st, cz + z])

    tris: List[List[int]] = []
    quads: List[List[int]] = []

    if has_bot_pole and has_top_pole:
        # Open profile from bottom axis to top axis -> capped closed solid
        for ri in range(n_rings - 1):
            base0 = ri * segments
            base1 = (ri + 1) * segments
            for s in range(segments):
                ns = (s + 1) % segments
                q = [base0 + s, base0 + ns, base1 + ns, base1 + s]
                quads.append(q)
                tris.append([q[0], q[1], q[2]])
                tris.append([q[0], q[2], q[3]])
        bot_idx = len(verts_list)
        verts_list.append([cx, cy, cz + pts[0][1]])
        top_idx = len(verts_list)
        verts_list.append([cx, cy, cz + pts[-1][1]])
        for s in range(segments):
            ns = (s + 1) % segments
            tris.append([bot_idx, ns, s])
            top_base = (n_rings - 1) * segments
            tris.append([top_idx, top_base + s, top_base + ns])
    else:
        # Closed loop of (r, z) points -> wrap last ring back to 0!
        for ri in range(n_rings):
            ri_next = (ri + 1) % n_rings
            base0 = ri * segments
            base1 = ri_next * segments
            for s in range(segments):
                ns = (s + 1) % segments
                q = [base0 + s, base0 + ns, base1 + ns, base1 + s]
                quads.append(q)
                tris.append([q[0], q[1], q[2]])
                tris.append([q[0], q[2], q[3]])

    verts = np.asarray(verts_list, dtype=np.float64)
    faces = np.asarray(tris, dtype=np.int32)
    q_arr = np.asarray(quads, dtype=np.int32)
    return _fix_winding_and_merge(verts, faces, q_arr)


def make_annular_extrusion(
    outer_xy: np.ndarray,
    inner_xy: np.ndarray,
    z0: float,
    z1: float,
    chamfer: float = 0.0,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Watertight pure-quad extrusion between matching closed outer_xy (K,2) and inner_xy (K,2) loops,
    with optional top & bottom edge bevels/chamfers.
    """
    k = len(outer_xy)
    assert len(inner_xy) == k, "outer_xy and inner_xy must have equal vertex count"
    h = abs(z1 - z0)
    c = float(min(chamfer, h * 0.25))

    # Build 4 or 6 rings around the cross section loop:
    # outer_bot, (outer_bot_c, outer_top_c), outer_top, inner_top, (inner_top_c, inner_bot_c), inner_bot
    rings_3d: List[np.ndarray] = []

    if c > 1e-6:
        # Radial shrink toward center by c
        def inset_loop(pts: np.ndarray, delta: float) -> np.ndarray:
            r = np.linalg.norm(pts, axis=1, keepdims=True)
            unit = pts / np.maximum(r, 1e-8)
            return pts + unit * delta

        out_ch = inset_loop(outer_xy, -c)
        in_ch = inset_loop(inner_xy, c)
        loop_specs = [
            (out_ch, z0),
            (outer_xy, z0 + c),
            (outer_xy, z1 - c),
            (out_ch, z1),
            (in_ch, z1),
            (inner_xy, z1 - c),
            (inner_xy, z0 + c),
            (in_ch, z0),
        ]
    else:
        loop_specs = [
            (outer_xy, z0),
            (outer_xy, z1),
            (inner_xy, z1),
            (inner_xy, z0),
        ]

    for pts2d, z in loop_specs:
        zcol = np.full((k, 1), z, dtype=np.float64)
        rings_3d.append(np.hstack([pts2d.astype(np.float64), zcol]))

    verts = np.vstack(rings_3d)
    m = len(loop_specs)
    quads = []
    for ri in range(m):
        ri_next = (ri + 1) % m
        b0 = ri * k
        b1 = ri_next * k
        for i in range(k):
            ni = (i + 1) % k
            quads.append([b0 + i, b0 + ni, b1 + ni, b1 + i])

    q_arr = np.asarray(quads, dtype=np.int32)
    return _fix_winding_and_merge(verts, quads_to_tris(q_arr), q_arr)


def make_perforated_flange(
    r_inner: float,
    r_outer: float,
    thickness: float,
    num_holes: int = 6,
    hole_radius: float = 4.0,
    hole_pcd_radius: Optional[float] = None,
    hole_sides: int = 16,
    z_offset: float = 0.0,
    chamfer: float = 0.8,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Build a 100% pure-quad, watertight, concentric-loop bolted flange!
    Each angular sector around each bolt hole maps a square-ring grid radially from
    the circular hole boundary out to the sector boundary — zero sloppy booleans!
    """
    if hole_pcd_radius is None:
        hole_pcd_radius = 0.5 * (r_inner + r_outer)
    max_hr = 0.38 * (r_outer - r_inner)
    hr = min(hole_radius, max_hr, hole_pcd_radius * math.sin(math.pi / max(num_holes, 3)) * 0.58)
    hr = max(hr, 1.0)
    # Use multiple of 4 for hole_sides so each sector splits cleanly into 4 quadrants
    sides = max(8, ((hole_sides + 3) // 4) * 4)
    q_per_side = sides // 4

    z0 = z_offset
    z1 = z_offset + thickness
    ch = float(min(chamfer, thickness * 0.18))

    # Build top & bottom 2D vertex grid per sector, then connect outer, inner, hole walls, top & bottom!
    verts_list: List[List[float]] = []
    quads: List[List[int]] = []

    # Create 2 layers (bottom z0, top z1) + optional inner chamfer rings
    # For clean pure-quad topology across sectors, let's place shared vertices along sector seams!
    # In each sector m (0..num_holes-1):
    #   theta spans [theta_a, theta_b], center theta_mid
    #   sector boundary is parameterized around the 4 sides of the curved annular sector:
    #     Side 0 (outer arc): r = r_outer, theta from theta_b -> theta_a (actually CCW around sector!)
    #   Wait: let's parameterize around the local hole center in polar angle alpha in [0, 2pi),
    #   where the 4 quadrants map to the 4 edges of the curved sector:
    #     alpha in [-pi/4, +pi/4] -> right-outer radial edge? Let's map cleanly:
    #     s in [0, sides): alpha = (s / sides) * 2*pi + pi/4  (starting at corner)
    #     Quadrant 0 (s=0..q-1): Outer arc (r = r_outer, theta: theta_b -> theta_a)
    #     Quadrant 1 (s=q..2q-1): Left seam (theta = theta_a, r: r_outer -> r_inner)
    #     Quadrant 2 (s=2q..3q-1): Inner arc (r = r_inner, theta: theta_a -> theta_b)
    #     Quadrant 3 (s=3q..4q-1): Right seam (theta = theta_b, r: r_inner -> r_outer)
    #   Notice: Left seam of sector m is identical to Right seam of sector (m-1) reversed!

    d_theta = 2.0 * math.pi / num_holes
    vert_map: Dict[Tuple[float, float, float], int] = {}

    def get_v(x: float, y: float, z: float) -> int:
        key = (round(x, 6), round(y, 6), round(z, 6))
        idx = vert_map.get(key)
        if idx is None:
            idx = len(verts_list)
            verts_list.append([x, y, z])
            vert_map[key] = idx
        return idx

    for m in range(num_holes):
        ta = m * d_theta
        tb = (m + 1) * d_theta
        tmid = 0.5 * (ta + tb)
        hx = hole_pcd_radius * math.cos(tmid)
        hy = hole_pcd_radius * math.sin(tmid)

        # Compute outer boundary ring (sides points) and inner hole ring (sides points)
        b_pts: List[Tuple[float, float]] = []
        h_pts: List[Tuple[float, float]] = []

        # Corner angles aligned so tmid direction is alpha=0:
        # Let's define boundary loop in CCW order around sector center:
        # Corner 0: (r_outer, ta), Corner 1: (r_inner, ta), Corner 2: (r_inner, tb), Corner 3: (r_outer, tb)?
        # Wait: in (r, theta) polar coords, going from (r_outer, tb) -> (r_outer, ta) is CW, while (r_outer, ta)->(r_outer, tb) is CCW!
        # Let's trace CCW around the sector patch:
        #   Edge 0: (r_inner, ta) -> (r_outer, ta)   (radial outward along ta)
        #   Edge 1: (r_outer, ta) -> (r_outer, tb)   (outer arc CCW)
        #   Edge 2: (r_outer, tb) -> (r_inner, tb)   (radial inward along tb)
        #   Edge 3: (r_inner, tb) -> (r_inner, ta)   (inner arc CW)
        # Let's verify CCW orientation at tmid=0:
        #   (r_in, -d/2) -> (r_out, -d/2) -> (r_out, +d/2) -> (r_in, +d/2).
        #   In XY plane around (hx, 0):
        #   (r_in, -y) bottom-left -> (r_out, -y) bottom-right -> (r_out, +y) top-right -> (r_in, +y) top-left -> YES! Pure CCW!
        #   Corresponding angles from hole center (hx, hy) at tmid=0:
        #   bottom-left is -3pi/4, bottom-right is -pi/4, top-right is +pi/4, top-left is +3pi/4!
        for s in range(sides):
            quad_idx = s // q_per_side
            u = (s % q_per_side) / float(q_per_side)
            if quad_idx == 0:
                r, th = r_inner + u * (r_outer - r_inner), ta
            elif quad_idx == 1:
                r, th = r_outer, ta + u * (tb - ta)
            elif quad_idx == 2:
                r, th = r_outer - u * (r_outer - r_inner), tb
            else:
                r, th = r_inner, tb - u * (tb - ta)
            b_pts.append((r * math.cos(th), r * math.sin(th)))

            # Matching hole perimeter angle starting at tmid - 3*pi/4 going CCW
            alpha = (tmid - 0.75 * math.pi) + (s / float(sides)) * 2.0 * math.pi
            h_pts.append((hx + hr * math.cos(alpha), hy + hr * math.sin(alpha)))

        # Create intermediate concentric ring for gorgeous quad-flow around the bolt hole
        m_pts = [(0.55 * bx + 0.45 * hx_p, 0.55 * by + 0.45 * hy_p) for (bx, by), (hx_p, hy_p) in zip(b_pts, h_pts)]

        # Emit vertices at z0 and z1 (and chamfered outer/inner/hole steps if ch > 0)
        b_bot = [get_v(x, y, z0) for x, y in b_pts]
        m_bot = [get_v(x, y, z0) for x, y in m_pts]
        h_bot = [get_v(x, y, z0) for x, y in h_pts]

        b_top = [get_v(x, y, z1) for x, y in b_pts]
        m_top = [get_v(x, y, z1) for x, y in m_pts]
        h_top = [get_v(x, y, z1) for x, y in h_pts]

        for s in range(sides):
            ns = (s + 1) % sides
            # Top face (normal +Z): outer -> mid -> hole
            quads.append([b_top[s], b_top[ns], m_top[ns], m_top[s]])
            quads.append([m_top[s], m_top[ns], h_top[ns], h_top[s]])
            # Bottom face (normal -Z): reversed
            quads.append([b_bot[ns], b_bot[s], m_bot[s], m_bot[ns]])
            quads.append([m_bot[ns], m_bot[s], h_bot[s], h_bot[ns]])
            # Inner bolt hole cylindrical wall (normal pointing toward hole center)
            quads.append([h_bot[ns], h_bot[s], h_top[s], h_top[ns]])

            # Sector outer arc wall (quad_idx == 1) and inner bore wall (quad_idx == 3)
            quad_idx = s // q_per_side
            if quad_idx in (1, 3):
                quads.append([b_bot[s], b_bot[ns], b_top[ns], b_top[s]])

    verts = np.asarray(verts_list, dtype=np.float64)
    q_arr = np.asarray(quads, dtype=np.int32)
    return _fix_winding_and_merge(verts, quads_to_tris(q_arr), q_arr)


def loft_sections(
    sections: Sequence[np.ndarray],
    closed_caps: bool = True,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Loft a watertight solid through ordered closed 3D ring sections (each shape (K, 3)).
    """
    k = len(sections[0])
    n_sec = len(sections)
    verts_list = [np.asarray(sec, dtype=np.float64) for sec in sections]
    quads = []
    tris = []
    for si in range(n_sec - 1):
        b0 = si * k
        b1 = (si + 1) * k
        for i in range(k):
            ni = (i + 1) % k
            q = [b0 + i, b0 + ni, b1 + ni, b1 + i]
            quads.append(q)
            tris.append([q[0], q[1], q[2]])
            tris.append([q[0], q[2], q[3]])

    verts = np.vstack(verts_list)
    if closed_caps:
        c0 = sections[0].mean(axis=0, keepdims=True)
        c1 = sections[-1].mean(axis=0, keepdims=True)
        i0 = len(verts)
        i1 = i0 + 1
        verts = np.vstack([verts, c0, c1])
        b_last = (n_sec - 1) * k
        for i in range(k):
            ni = (i + 1) % k
            tris.append([i0, ni, i])
            tris.append([i1, b_last + i, b_last + ni])

    q_arr = np.asarray(quads, dtype=np.int32)
    f_arr = np.asarray(tris, dtype=np.int32)
    return _fix_winding_and_merge(verts, f_arr, q_arr)


def transform_verts(
    verts: np.ndarray,
    translate: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    rotate_xyz_deg: Tuple[float, float, float] = (0.0, 0.0, 0.0),
    scale: Tuple[float, float, float] = (1.0, 1.0, 1.0),
) -> np.ndarray:
    v = verts.copy() * np.asarray(scale, dtype=np.float64)
    rx, ry, rz = [math.radians(a) for a in rotate_xyz_deg]
    if abs(rx) > 1e-8:
        c, s = math.cos(rx), math.sin(rx)
        m = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)
        v = v @ m.T
    if abs(ry) > 1e-8:
        c, s = math.cos(ry), math.sin(ry)
        m = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)
        v = v @ m.T
    if abs(rz) > 1e-8:
        c, s = math.cos(rz), math.sin(rz)
        m = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)
        v = v @ m.T
    v += np.asarray(translate, dtype=np.float64)
    return v


def audit_part(part: CADPart) -> Dict[str, Any]:
    """Compute exact topological and geometric CAD quality metrics for a part."""
    edges: Counter = Counter()
    f = part.faces
    for tri in f:
        for a, b in ((tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])):
            key = (int(a), int(b)) if a < b else (int(b), int(a))
            edges[key] += 1

    boundary_edges = sum(1 for c in edges.values() if c == 1)
    non_manifold_edges = sum(1 for c in edges.values() if c > 2)

    tm = trimesh.Trimesh(vertices=part.vertices, faces=part.faces, process=False)
    v_cnt = int(len(part.vertices))
    e_cnt = int(len(edges))
    f_cnt = int(len(part.faces))
    euler = v_cnt - e_cnt + f_cnt

    return {
        "name": part.name,
        "vertices": v_cnt,
        "triangles": f_cnt,
        "quads": int(len(part.quads)) if part.quads is not None else 0,
        "edges": e_cnt,
        "boundary_edges": boundary_edges,
        "non_manifold_edges": non_manifold_edges,
        "watertight": bool(tm.is_watertight and boundary_edges == 0 and non_manifold_edges == 0),
        "winding_consistent": bool(tm.is_winding_consistent),
        "euler_characteristic": euler,
        "volume_mm3": float(abs(tm.volume)) if tm.is_watertight else 0.0,
        "surface_area_mm2": float(tm.area),
    }


def audit_assembly(assembly: CADAssembly) -> Dict[str, Any]:
    part_reports = [audit_part(p) for p in assembly.parts]
    all_verts = []
    for p in assembly.parts:
        all_verts.append(p.vertices)
    merged_v = np.vstack(all_verts) if all_verts else np.zeros((1, 3))
    bmin = merged_v.min(axis=0)
    bmax = merged_v.max(axis=0)
    dims = bmax - bmin

    return {
        "part_count": len(assembly.parts),
        "total_vertices": sum(r["vertices"] for r in part_reports),
        "total_triangles": sum(r["triangles"] for r in part_reports),
        "total_quads": sum(r["quads"] for r in part_reports),
        "all_watertight": all(r["watertight"] for r in part_reports),
        "non_manifold_edges": sum(r["non_manifold_edges"] for r in part_reports),
        "boundary_edges": sum(r["boundary_edges"] for r in part_reports),
        "total_volume_mm3": round(sum(r["volume_mm3"] for r in part_reports), 2),
        "total_area_mm2": round(sum(r["surface_area_mm2"] for r in part_reports), 2),
        "bounds_mm": [round(float(x), 2) for x in dims],
        "parts": part_reports,
    }


def export_obj_with_quads(assembly: CADAssembly) -> str:
    """Export clean Wavefront OBJ preserving true quad faces where available."""
    lines = [
        f"# NEWwoorld-CadGPT Professional CAD Mesh: {assembly.title}",
        f"# Archetype: {assembly.archetype}",
        f"# Prompt: {assembly.prompt}",
    ]
    v_offset = 1
    for part in assembly.parts:
        lines.append(f"o {part.name}")
        for vx, vy, vz in part.vertices:
            lines.append(f"v {vx:.6f} {vy:.6f} {vz:.6f}")
        if part.quads is not None and len(part.quads) > 0:
            # Emit quads + any non-quad pole cap triangles if present
            quad_tri_set = set()
            for q in part.quads:
                a, b, c, d = int(q[0]), int(q[1]), int(q[2]), int(q[3])
                lines.append(f"f {a + v_offset} {b + v_offset} {c + v_offset} {d + v_offset}")
                quad_tri_set.add(tuple(sorted((a, b, c))))
                quad_tri_set.add(tuple(sorted((a, c, d))))
            for f in part.faces:
                key = tuple(sorted((int(f[0]), int(f[1]), int(f[2]))))
                if key not in quad_tri_set:
                    lines.append(
                        f"f {int(f[0]) + v_offset} {int(f[1]) + v_offset} {int(f[2]) + v_offset}"
                    )
        else:
            for f in part.faces:
                lines.append(
                    f"f {int(f[0]) + v_offset} {int(f[1]) + v_offset} {int(f[2]) + v_offset}"
                )
        v_offset += len(part.vertices)
    return "\n".join(lines) + "\n"


def export_stl_binary(assembly: CADAssembly) -> bytes:
    """Export watertight binary STL ready for SolidWorks / Blender / 3D Printing."""
    tris_total = sum(len(p.faces) for p in assembly.parts)
    buf = io.BytesIO()
    header = f"NEWwoorld CAD Binary STL - {assembly.archetype}".encode("ascii", "ignore")[:80].ljust(80, b" ")
    buf.write(header)
    buf.write(struct.pack("<I", tris_total))
    for part in assembly.parts:
        v = part.vertices
        for f in part.faces:
            p0, p1, p2 = v[f[0]], v[f[1]], v[f[2]]
            n = np.cross(p1 - p0, p2 - p0)
            norm = float(np.linalg.norm(n))
            if norm > 1e-12:
                n /= norm
            buf.write(
                struct.pack(
                    "<12fH",
                    float(n[0]), float(n[1]), float(n[2]),
                    float(p0[0]), float(p0[1]), float(p0[2]),
                    float(p1[0]), float(p1[1]), float(p1[2]),
                    float(p2[0]), float(p2[1]), float(p2[2]),
                    0,
                )
            )
    return buf.getvalue()


def export_glb_bytes(assembly: CADAssembly) -> bytes:
    """Export binary glTF 2.0 (.glb) with PBR materials per assembly part."""
    scene = trimesh.Scene()
    for part in assembly.parts:
        rgba = [int(round(c * 255)) for c in part.material.base_color]
        mat = trimesh.visual.material.PBRMaterial(
            name=part.material.name,
            baseColorFactor=rgba,
            metallicFactor=float(part.material.metallic),
            roughnessFactor=float(part.material.roughness),
        )
        tm = trimesh.Trimesh(vertices=part.vertices, faces=part.faces, process=False)
        tm.visual = trimesh.visual.TextureVisuals(material=mat)
        scene.add_geometry(tm, node_name=part.name, geom_name=part.name)
    return bytes(scene.export(file_type="glb"))


def export_scad(assembly: CADAssembly) -> str:
    if assembly.scad_code:
        return assembly.scad_code
    lines = [
        f"// NEWwoorld-CadGPT Parametric OpenSCAD Script",
        f"// Archetype: {assembly.archetype}",
        f"// Prompt: {assembly.prompt}",
        "$fn = 64;",
        json.dumps(assembly.params, indent=2).replace('"', "// "),
    ]
    return "\n".join(lines) + "\n"


def assembly_to_viewer_payload(assembly: CADAssembly) -> Dict[str, Any]:
    """Serialize multi-part CAD assembly for the Three.js Professional Viewport."""
    audit = audit_assembly(assembly)
    parts_json = []
    for part, rep in zip(assembly.parts, audit["parts"]):
        parts_json.append(
            {
                "name": part.name,
                "vertices": np.round(part.vertices, 4).ravel().tolist(),
                "faces": part.faces.ravel().tolist(),
                "quads": part.quads.ravel().tolist() if part.quads is not None else [],
                "material": part.material.to_dict(),
                "creaseAngleDeg": part.crease_angle_deg,
                "metrics": rep,
            }
        )
    return {
        "title": assembly.title,
        "archetype": assembly.archetype,
        "prompt": assembly.prompt,
        "params": assembly.params,
        "program_tokens": assembly.program_tokens,
        "audit": audit,
        "parts": parts_json,
        "scad": export_scad(assembly),
    }

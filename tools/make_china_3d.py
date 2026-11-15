#!/usr/bin/env python3
"""Build a compact, traceable runtime extract for the standalone Beijing 3D scene.

Input:  docs/beijing-osm-3d/osm-map.json  (raw OSM API v0.6 map.json)
        docs/beijing-osm-3d/osm-source.json (provenance written by CI)
Output: docs/china-3d/beijing-3d.json

The raw OSM file stays in the repository. This script only projects WGS84
coordinates to local metres, clips polygons to the AOI, computes honest default
heights/widths, and produces search/sign/label indices. It does not invent
streets, buildings, fences or monuments.
"""
from __future__ import annotations

import collections
import json
import math
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "docs/beijing-osm-3d/osm-map.json"
SOURCE = ROOT / "docs/beijing-osm-3d/osm-source.json"
OUT = ROOT / "docs/china-3d/beijing-3d.json"

raw = json.loads(RAW.read_text(encoding="utf-8"))
src = json.loads(SOURCE.read_text(encoding="utf-8"))
elements = raw["elements"]
bbox = [float(x) for x in src["bboxWGS84"]]  # minlon, minlat, maxlon, maxlat
minlon, minlat, maxlon, maxlat = bbox
lon0, lat0 = (minlon + maxlon) / 2, (minlat + maxlat) / 2
m_per_lat = 110540.0
m_per_lon = 111320.0 * math.cos(math.radians(lat0))
xmin, xmax = (minlon - lon0) * m_per_lon, (maxlon - lon0) * m_per_lon
zmin, zmax = (minlat - lat0) * m_per_lat, (maxlat - lat0) * m_per_lat
# OSM map.json returns every node of a way that merely intersects the bbox, so
# some ways extend outside it. Keep a modest buffer for those exact geometries,
# but do not drag in kilometres of unrelated streets from long boundary ways.
CLIP_MARGIN = 160.0
CLIP = (xmin - CLIP_MARGIN, zmin - CLIP_MARGIN, xmax + CLIP_MARGIN, zmax + CLIP_MARGIN)
area_km2 = ((xmax - xmin) * (zmax - zmin)) / 1_000_000

# External documentary height only where OSM itself has no height tag.
BELL_TOWER_ID = 425993664
EXTERNAL_HEIGHTS = {
    BELL_TOWER_ID: (47.9, "Baidu Baike, «bell tower and drum tower»; Beijing Bell Tower total height 47.9 m"),
}
EXTERNAL_URL = "https://baike.baidu.com/en/item/bell%20tower%20and%20drum%20tower/1525576"

DEFAULT_HEIGHTS = {
    # Only 1 of 552 buildings has a surveyed height in this OSM extract. These
    # conservative low-rise hutong values make the footprint extrusion legible;
    # every use is marked defaultHeight=true and disclosed in meta.caveats.
    "bungalow": 4.2, "house": 4.8, "yes": 7.5, "residential": 14.0,
    "commercial": 11.0, "retail": 8.0, "school": 10.0, "temple": 9.0,
}
ROAD_WIDTHS = {
    "primary": 20.0, "secondary": 16.0, "secondary_link": 12.0,
    "tertiary": 12.0, "residential": 8.0, "unclassified": 7.0,
    "service": 5.0, "pedestrian": 6.0, "footway": 2.4,
    "cycleway": 2.6, "steps": 1.8,
}
BARRIER_HEIGHTS = {
    "wall": 2.3, "city_wall": 6.0, "retaining_wall": 1.4,
    "gate": 2.5, "entrance": 2.5, "fence": 1.7,
}
ALLEY_TYPES = {"service", "footway", "pedestrian", "residential", "unclassified", "tertiary", "cycleway", "steps"}
MONUMENT_TOURISM = {"attraction", "artwork", "viewpoint", "museum"}
GREEN_TAGS = {"grass", "forest", "wood", "park", "garden", "pitch", "tree", "tree_row"}
NAMED_RELATION_TAGS = {"name", "name:en", "name:ru", "name:zh"}

nodes = {}
ways = {}
relations = {}
for el in elements:
    if el["type"] == "node":
        x, z = (el["lon"] - lon0) * m_per_lon, (el["lat"] - lat0) * m_per_lat
        nodes[el["id"]] = [round(x, 2), round(z, 2)]
    elif el["type"] == "way":
        ways[el["id"]] = el
    elif el["type"] == "relation":
        relations[el["id"]] = el

node_tags = {el["id"]: el.get("tags", {}) for el in elements if el["type"] == "node" and el.get("tags")}


def r2(v):
    return round(float(v), 2)


def way_points(wid):
    out = []
    for nid in ways[wid]["nodes"]:
        if nid in nodes:
            out.append(nodes[nid])
    return out


def dedupe_open(points):
    out = []
    for p in points:
        if not out or abs(out[-1][0] - p[0]) > 1e-6 or abs(out[-1][1] - p[1]) > 1e-6:
            out.append([p[0], p[1]])
    if len(out) > 1 and abs(out[0][0] - out[-1][0]) < 1e-6 and abs(out[0][1] - out[-1][1]) < 1e-6:
        out.pop()
    return out


def clip_polygon(points):
    """Sutherland–Hodgman clip of a possibly concave ring to the convex AOI."""
    poly = dedupe_open(points)
    if len(poly) < 3:
        return []

    def intersect(a, b, axis, value):
        if abs(b[axis] - a[axis]) < 1e-9:
            return [b[0], b[1]]
        t = (value - a[axis]) / (b[axis] - a[axis])
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

    def edge(poly, axis, value, greater):
        out = []
        for i, b in enumerate(poly):
            a = poly[i - 1]
            ain = a[axis] >= value if greater else a[axis] <= value
            bin = b[axis] >= value if greater else b[axis] <= value
            if bin:
                if not ain:
                    out.append(intersect(a, b, axis, value))
                out.append(b)
            elif ain:
                out.append(intersect(a, b, axis, value))
        return out

    cxmin, czmin, cxmax, czmax = CLIP
    poly = edge(poly, 0, cxmin, True)
    poly = edge(poly, 0, cxmax, False)
    poly = edge(poly, 1, czmin, True)
    poly = edge(poly, 1, czmax, False)
    poly = dedupe_open(poly)
    if len(poly) < 3:
        return []
    area = 0.0
    for i, b in enumerate(poly):
        a = poly[i - 1]
        area += a[0] * b[1] - b[0] * a[1]
    if abs(area) * 0.5 < 0.5:
        return []
    return [[r2(p[0]), r2(p[1])] for p in poly]


def clip_segment(a, b):
    """Liang–Barsky segment clip to CLIP; returns an open [p0, p1] or None."""
    cxmin, czmin, cxmax, czmax = CLIP
    dx, dz = b[0] - a[0], b[1] - a[1]
    t0, t1 = 0.0, 1.0
    tests = [(-dx, a[0] - cxmin), (dx, cxmax - a[0]), (-dz, a[1] - czmin), (dz, czmax - a[1])]
    for p, q in tests:
        if abs(p) < 1e-9:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            if r > t1:
                return None
            if r > t0:
                t0 = r
        else:
            if r < t0:
                return None
            if r < t1:
                t1 = r
    return [
        [a[0] + dx * t0, a[1] + dz * t0],
        [a[0] + dx * t1, a[1] + dz * t1],
    ]


def clip_polyline(points, closed):
    """Clip each segment, merging contiguous survivors into separate pieces."""
    pts = dedupe_open(points)
    if len(pts) < 2:
        return []
    segs = list(zip(pts[:-1], pts[1:]))
    if closed and len(pts) > 2:
        segs.append((pts[-1], pts[0]))
    raw_pieces, cur = [], []
    for a, b in segs:
        c = clip_segment(a, b)
        if not c:
            if len(cur) > 1:
                raw_pieces.append(cur)
            cur = []
            continue
        if cur and abs(cur[-1][0] - c[0][0]) < 1e-5 and abs(cur[-1][1] - c[0][1]) < 1e-5:
            cur.append(c[1])
        else:
            if len(cur) > 1:
                raw_pieces.append(cur)
            cur = [c[0], c[1]]
    if len(cur) > 1:
        raw_pieces.append(cur)
    out = []
    for piece in raw_pieces:
        p = dedupe_open(piece)
        if len(p) < 2:
            continue
        is_closed = False
        if closed and len(raw_pieces) == 1 and len(p) > 2:
            is_closed = abs(p[0][0] - p[-1][0]) < .1 and abs(p[0][1] - p[-1][1]) < .1
        out.append({"points": [[r2(q[0]), r2(q[1])] for q in p], "closed": is_closed})
    return out


def polygon_area(points):
    if len(points) < 3:
        return 0.0
    a = 0.0
    for i, b in enumerate(points):
        p = points[i - 1]
        a += p[0] * b[1] - b[0] * p[1]
    return a * 0.5


def centroid(points):
    pts = dedupe_open(points)
    if not pts:
        return [0.0, 0.0]
    a = polygon_area(pts)
    if abs(a) > 1e-6:
        cx = cz = 0.0
        for i, b in enumerate(pts):
            p = pts[i - 1]
            cross = p[0] * b[1] - b[0] * p[1]
            cx += (p[0] + b[0]) * cross
            cz += (p[1] + b[1]) * cross
        return [r2(cx / (6 * a)), r2(cz / (6 * a))]
    return [r2(sum(p[0] for p in pts) / len(pts)), r2(sum(p[1] for p in pts) / len(pts))]


def point_in_poly(pt, poly):
    x, z = pt
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]
        xj, zj = poly[j]
        if ((zi > z) != (zj > z)) and x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-9) + xi:
            inside = not inside
        j = i
    return inside


def bbox_of(points):
    xs = [p[0] for p in points]
    zs = [p[1] for p in points]
    return [r2(min(xs)), r2(min(zs)), r2(max(xs)), r2(max(zs))]


def union_bbox(a, b):
    if not a:
        return b
    if not b:
        return a
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def parse_height(tags):
    if "height" in tags:
        m = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)", str(tags["height"]).replace(",", "."))
        if m:
            return float(m.group(1)), "OSM height tag"
    if "building:levels" in tags:
        try:
            return float(tags["building:levels"]) * 3.2, "OSM building:levels × 3.2 m"
        except ValueError:
            pass
    return None


def building_height(osm_id, osm_type, tags):
    h = parse_height(tags)
    if h:
        return r2(h[0]), h[1], False
    if osm_type == "way" and osm_id in EXTERNAL_HEIGHTS:
        return r2(EXTERNAL_HEIGHTS[osm_id][0]), EXTERNAL_HEIGHTS[osm_id][1], False
    kind = str(tags.get("building", "yes"))
    return r2(DEFAULT_HEIGHTS.get(kind, DEFAULT_HEIGHTS["yes"])), "inferred from OSM building type (not surveyed)", True


def is_monument(tags):
    return (
        "historic" in tags or "heritage" in tags or tags.get("man_made") == "tower"
        or tags.get("tourism") in MONUMENT_TOURISM or tags.get("amenity") == "place_of_worship"
        or ("wikidata" in tags and tags.get("tourism") in MONUMENT_TOURISM)
        or ("wikidata" in tags and tags.get("historic"))
    )


def is_green(tags):
    return (
        tags.get("landuse") in GREEN_TAGS or tags.get("leisure") in GREEN_TAGS
        or tags.get("natural") in GREEN_TAGS or tags.get("natural") == "wood"
        or tags.get("landuse") == "forest"
    )


def is_water(tags):
    return tags.get("natural") == "water" or tags.get("water") in ("lake", "river") or "waterway" in tags


def primary_kind(tags):
    if "building" in tags:
        return "building"
    if "highway" in tags:
        return "alley" if tags["highway"] in ALLEY_TYPES else "street"
    if "barrier" in tags:
        return "barrier"
    if is_water(tags):
        return "water"
    if is_monument(tags):
        return "monument"
    if is_green(tags):
        return "green"
    if "waterway" in tags:
        return "waterway"
    if "landuse" in tags:
        return "landuse"
    if "leisure" in tags:
        return "leisure"
    if "amenity" in tags:
        return "poi"
    if "shop" in tags:
        return "shop"
    if "tourism" in tags:
        return "tourism"
    if "railway" in tags:
        return "railway"
    if "place" in tags:
        return "place"
    if "entrance" in tags:
        return "entrance"
    if "man_made" in tags:
        return "man_made"
    return "other"


def layer_for(kind, tags):
    # `kind` is the geometry role assigned from OSM tags (possibly overridden for
    # a multipolygon relation). It is authoritative for the render layer; tags
    # are only a fallback for untyped landuse/leisure records.
    if kind == "building":
        return "buildings"
    if kind in ("alley", "street", "paving"):
        return "roads"
    if kind == "barrier":
        return "barriers"
    if kind in ("water", "waterway"):
        return "water"
    if kind in ("green", "pitch"):
        return "green"
    if kind in ("landuse", "leisure") and is_green(tags):
        return "green"
    if kind in ("monument", "historic"):
        return "monuments"
    if kind in ("pier", "tree_row"):
        return "other" if kind == "pier" else "green"
    if kind in ("poi", "shop", "tourism", "railway", "place", "entrance", "man_made"):
        return "pois"
    return "other"


def names(tags):
    return [str(v) for k, v in tags.items() if k == "name" or k.startswith("name:")]


def feature_name(tags):
    return tags.get("name") or tags.get("name:en") or tags.get("name:ru") or tags.get("name:zh") or ""


def search_text(tags, kind, osm_id):
    parts = names(tags) + [kind, "OSM", str(osm_id)]
    for key in ("amenity", "shop", "tourism", "historic", "highway", "barrier", "railway", "place", "wikidata"):
        if tags.get(key):
            parts.append(str(tags[key]))
    return " | ".join(dict.fromkeys(p.strip() for p in parts if p.strip()))


def osm_url(osm_type, osm_id):
    return f"https://www.openstreetmap.org/{osm_type}/{osm_id}"


def make_feature(osm_type, osm_id, tags, center, bb, kind=None, layer=None, height=None, height_source=None, default_height=None, rings=None):
    kind = kind or primary_kind(tags)
    layer = layer or layer_for(kind, tags)
    fid = f"{osm_type[0]}{osm_id}"
    return {
        "id": fid,
        "osmType": osm_type,
        "osmId": osm_id,
        "kind": kind,
        "layer": layer,
        "name": feature_name(tags),
        "nameEn": tags.get("name:en", ""),
        "nameRu": tags.get("name:ru", ""),
        "tags": tags,
        "center": [r2(center[0]), r2(center[1])],
        "bbox": [r2(v) for v in bb] if bb else None,
        "searchText": search_text(tags, kind, osm_id),
        "osmUrl": osm_url(osm_type, osm_id),
        "height": height,
        "heightSource": height_source,
        "defaultHeight": default_height,
        "hasGeometry": bool(rings or bb),
    }


features = {}
feature_order = []


def add_feature(f):
    if f["id"] not in features:
        features[f["id"]] = f
        feature_order.append(f["id"])


# -----------------------------------------------------------------------------
# Geometry containers
# -----------------------------------------------------------------------------
buildings = []
areas = []
lines = []
markers = []
trees = []

def inside_clip(x, z):
    cxmin, czmin, cxmax, czmax = CLIP
    return cxmin <= x <= cxmax and czmin <= z <= czmax


tagged_nodes_raw = len(node_tags)
tagged_nodes_rendered = 0
# OSM nodes with real tags become exact POI / marker geometry, but only inside
# the represented AOI. Long OSM ways can contribute nodes kilometres away.
for nid, tags in node_tags.items():
    if nid not in nodes:
        continue
    x, z = nodes[nid]
    if not inside_clip(x, z):
        add_feature(make_feature("node", nid, tags, [x, z], None))
        continue
    tagged_nodes_rendered += 1
    kind = primary_kind(tags)
    layer = layer_for(kind, tags)
    f = make_feature("node", nid, tags, [x, z], [x, z, x, z], kind=kind, layer=layer)
    add_feature(f)
    marker = {
        "featureId": f["id"], "x": r2(x), "z": r2(z), "kind": kind, "layer": layer,
        "name": f["name"], "tags": tags,
    }
    markers.append(marker)
    if tags.get("natural") == "tree":
        trees.append({"featureId": f["id"], "x": r2(x), "z": r2(z), "tags": tags})

# Classify ways. Building ways become extruded footprints; area-like ways become
# flat polygons; linear ways become ribbons or walls. Every way is first clipped
# to CLIP so long OSM boundary ways cannot drag kilometres of irrelevant
# geometry into the scene.
highway_way_count = 0
alley_way_count = 0
barrier_way_count = 0
landuse_way_count = 0
leisure_way_count = 0
natural_way_count = 0
waterway_way_count = 0
building_way_count = 0
building_ways_rendered = 0
closed_highway_areas = 0
for wid, w in ways.items():
    tags = w.get("tags", {})
    ids = w["nodes"]
    pts = way_points(wid)
    if len(pts) < 2:
        continue
    closed = len(ids) > 3 and ids[0] == ids[-1]
    kind = primary_kind(tags)
    layer = layer_for(kind, tags)
    bb = bbox_of(pts)
    c = centroid(pts) if closed else [r2(sum(p[0] for p in pts) / len(pts)), r2(sum(p[1] for p in pts) / len(pts))]
    f = make_feature("way", wid, tags, c, bb, kind=kind, layer=layer)
    add_feature(f)

    if "building" in tags:
        building_way_count += 1
        ring = clip_polygon(pts)
        if not ring:
            f["hasGeometry"] = False
            continue
        rbb, rc = bbox_of(ring), centroid(ring)
        f["bbox"], f["center"] = rbb, rc
        h, hs, dh = building_height(wid, "way", tags)
        buildings.append({
            "featureId": f["id"], "kind": "building", "layer": "buildings",
            "tags": tags, "rings": [{"outer": ring, "holes": []}],
            "height": h, "heightSource": hs, "defaultHeight": dh,
            "center": rc, "bbox": rbb,
            "roofShape": tags.get("roof:shape"), "monument": is_monument(tags),
            "name": f["name"],
        })
        building_ways_rendered += 1
        f["height"], f["heightSource"], f["defaultHeight"] = h, hs, dh
        continue

    # area-like polygons; barrier rings stay walls, never flat paving areas
    area_kind = None
    if "barrier" not in tags:
        if "highway" in tags and (tags.get("area") == "yes" or (closed and tags.get("highway") in ("pedestrian", "footway"))):
            area_kind, closed_highway_areas = "paving", closed_highway_areas + 1
        elif closed and tags.get("area") == "yes" and tags.get("man_made") == "pier":
            area_kind = "pier"
        elif closed and is_water(tags):
            area_kind = "water"
        elif closed and is_green(tags):
            area_kind = "green"
        elif closed and "historic" in tags:
            area_kind = "historic"
        elif closed and "amenity" in tags:
            area_kind = "paving"
        elif closed and "landuse" in tags:
            area_kind = "paving"
        elif closed and "leisure" in tags:
            area_kind = "pitch" if tags.get("leisure") == "pitch" else "green"
        elif closed and tags.get("tourism") == "attraction" and tags.get("leisure") == "park":
            area_kind = "green"
    if area_kind:
        if "highway" in tags:
            highway_way_count += 1
            if tags.get("highway") in ALLEY_TYPES:
                alley_way_count += 1
        if "landuse" in tags:
            landuse_way_count += 1
        if "leisure" in tags:
            leisure_way_count += 1
        if "natural" in tags:
            natural_way_count += 1
        if "waterway" in tags:
            waterway_way_count += 1
        ring = clip_polygon(pts)
        if not ring:
            f["hasGeometry"] = False
            continue
        rbb, rc = bbox_of(ring), centroid(ring)
        f["bbox"], f["center"] = rbb, rc
        areas.append({
            "featureId": f["id"], "kind": area_kind, "layer": layer_for(area_kind, tags),
            "tags": tags, "rings": [{"outer": ring, "holes": []}],
            "center": rc, "bbox": rbb, "name": f["name"],
        })
        continue

    # linear features: exact OSM polylines, clipped segment by segment
    base = None
    if "highway" in tags:
        highway_way_count += 1
        if tags.get("highway") in ALLEY_TYPES:
            alley_way_count += 1
        base = {
            "kind": "road", "layer": "roads",
            "width": ROAD_WIDTHS.get(tags.get("highway"), 5.0),
            "widthSource": "OSM width tag" if "width" in tags else "inferred from OSM highway class",
            "surface": tags.get("surface"),
        }
    elif "barrier" in tags:
        barrier_way_count += 1
        base = {
            "kind": "barrier", "layer": "barriers", "width": 0.35,
            "height": BARRIER_HEIGHTS.get(tags.get("barrier"), 2.0),
            "heightSource": "OSM height tag" if "height" in tags else "inferred from OSM barrier type",
        }
    elif "waterway" in tags:
        waterway_way_count += 1
        base = {
            "kind": "waterway", "layer": "water",
            "width": 3.0 if tags.get("waterway") == "river" else 2.0,
            "widthSource": "inferred from OSM waterway class",
        }
    elif tags.get("natural") == "tree_row":
        natural_way_count += 1
        base = {"kind": "tree_row", "layer": "green", "width": 2.0, "widthSource": "inferred from OSM tree_row"}
    elif tags.get("man_made") == "pier":
        base = {"kind": "pier", "layer": "other", "width": 2.5, "widthSource": "inferred pier width"}
    elif "historic" in tags or is_monument(tags) or "tourism" in tags:
        base = {"kind": "monument_line", "layer": "monuments", "width": 4.0, "widthSource": "inferred highlight width"}
    if not base:
        f["hasGeometry"] = False
        continue

    pieces = clip_polyline(pts, closed)
    if not pieces:
        f["hasGeometry"] = False
        continue
    all_clipped = [q for piece in pieces for q in piece["points"]]
    rbb = bbox_of(all_clipped)
    # Segment-wise clipped polylines are not polygons: use the rendered bbox
    # midpoint as a deterministic anchor that cannot drift kilometres away.
    rc = [r2((rbb[0] + rbb[2]) / 2), r2((rbb[1] + rbb[3]) / 2)]
    f["bbox"], f["center"] = rbb, rc
    for part_i, piece in enumerate(pieces):
        lines.append({
            "featureId": f["id"], "partIndex": part_i, **base,
            "tags": tags, "points": piece["points"], "closed": piece["closed"],
            "name": f["name"], "center": rc, "bbox": rbb,
        })

# Multipolygon relations: water lakes, grass clusters, temple/building shells.
relation_ids = [409777, 5451458, 11518929, 19136035, 21773024, 21434020]
building_relation_count = 0
water_relation_count = 0
for rid in relation_ids:
    r = relations.get(rid)
    if not r:
        continue
    tags = r.get("tags", {})
    members = [m for m in r.get("members", []) if m["type"] == "way" and m["ref"] in ways]
    if not members:
        continue
    outers, inners = [], []
    for m in members:
        pts = way_points(m["ref"])
        ring = clip_polygon(pts)
        if not ring:
            continue
        (inners if m["role"] == "inner" else outers).append(ring)
    if not outers:
        continue
    all_pts = [p for ring in outers for p in ring]
    bb = bbox_of(all_pts)
    c = centroid(outers[0])
    f = make_feature("relation", rid, tags, c, bb)
    add_feature(f)

    # Assign each clipped hole to the outer ring that contains its centroid.
    grouped = [{"outer": o, "holes": []} for o in outers]
    for h in inners:
        hc = centroid(h)
        for g in grouped:
            if point_in_poly(hc, g["outer"]):
                g["holes"].append(h)
                break

    if "building" in tags or rid in (19136035, 21773024):
        building_relation_count += 1
        h, hs, dh = building_height(rid, "relation", tags)
        b = {
            "featureId": f["id"], "kind": "building", "layer": "buildings",
            "tags": tags, "rings": grouped, "height": h, "heightSource": hs,
            "defaultHeight": dh, "center": [r2(c[0]), r2(c[1])], "bbox": bb,
            "roofShape": tags.get("roof:shape"), "monument": is_monument(tags) or rid == 21773024,
            "name": f["name"],
        }
        buildings.append(b)
        f["height"] = h
        f["heightSource"] = hs
        f["defaultHeight"] = dh
    else:
        if is_water(tags):
            area_kind, water_relation_count = "water", water_relation_count + 1
        elif is_green(tags):
            area_kind = "green"
        elif rid == 21434020:
            # area=yes + highway=pedestrian + type=multipolygon: six small
            # pedestrian plaza rings, not a park and not another highway way.
            area_kind = "paving"
        else:
            area_kind = "historic"
        areas.append({
            "featureId": f["id"], "kind": area_kind, "layer": layer_for(area_kind, tags),
            "tags": tags, "rings": grouped, "center": [r2(c[0]), r2(c[1])], "bbox": bb,
            "name": f["name"],
        })

# Named / tagged relations without area geometry: exact OSM records for search,
# selection and monument labels. Their coordinates come from available members.
for rid, r in relations.items():
    tags = r.get("tags", {})
    if not tags:
        continue
    if not any(k in tags for k in NAMED_RELATION_TAGS) and not is_monument(tags):
        continue
    member_pts = []
    for m in r.get("members", []):
        if m["type"] == "way" and m["ref"] in ways:
            member_pts.extend(way_points(m["ref"]))
        elif m["type"] == "node" and m["ref"] in nodes:
            member_pts.append(nodes[m["ref"]])
    if member_pts:
        bb = bbox_of(member_pts)
        c = centroid(member_pts)
    else:
        bb = [xmin, zmin, xmax, zmax]
        c = [0.0, 0.0]
    kind = "monument" if is_monument(tags) else primary_kind(tags)
    layer = layer_for(kind, tags)
    f = make_feature("relation", rid, tags, c, bb, kind=kind, layer=layer)
    add_feature(f)

# -----------------------------------------------------------------------------
# Signs and DOM labels: actual OSM names, never invented shop text.
# -----------------------------------------------------------------------------
def priority(f):
    t = f["tags"]
    s = 0
    if f["layer"] == "monuments" or is_monument(t):
        s += 120
    if t.get("historic") or t.get("heritage"):
        s += 40
    if t.get("tourism") in MONUMENT_TOURISM:
        s += 30
    if t.get("man_made") == "tower":
        s += 30
    if f["layer"] == "roads" and t.get("highway") in ALLEY_TYPES and f["name"]:
        s += 25
    if f["layer"] == "roads" and f["name"]:
        s += 15
    if t.get("amenity") or t.get("shop"):
        s += 10
    if f["name"]:
        s += 5
    return s


# Some long OSM ways and transport relations are split by the clip buffer into
# disjoint pieces. A polygon centroid over concatenated pieces can land outside
# the rendered bbox, so keep every label/sign/focus anchor inside its own bbox.
for f in features.values():
    bb = f.get("bbox")
    if not bb:
        continue
    c = f["center"]
    mx, mz = r2((bb[0] + bb[2]) / 2), r2((bb[1] + bb[3]) / 2)
    if not (bb[0] - 1 <= c[0] <= bb[2] + 1 and bb[1] - 1 <= c[1] <= bb[3] + 1):
        f["center"] = [mx, mz]

named = [f for f in features.values() if f["name"] and f["hasGeometry"]]
named.sort(key=lambda f: (-priority(f), f["id"]))

sign_palette = {
    "monuments": ("#713b30", "#ead6a8"),
    "roads": ("#3e6250", "#eee2bd"),
    "buildings": ("#5b493d", "#e9dbc0"),
    "water": ("#3d5366", "#e7e5d8"),
    "green": ("#3c5945", "#e6dfc1"),
    "pois": ("#315b51", "#eee4c9"),
    "barriers": ("#665341", "#e9ddc4"),
}
signs = []
for i, f in enumerate(named[:128]):
    bg, fg = sign_palette.get(f["layer"], ("#4d5145", "#e6d9bd"))
    signs.append({
        "featureId": f["id"], "index": i, "text": f["name"][:14],
        "sub": (f["nameEn"] or f["kind"])[:28], "bg": bg, "fg": fg,
        "layer": f["layer"], "center": f["center"], "priority": priority(f),
    })

labels = []
for f in named:
    h = f.get("height") or 0
    y = (h + 2.5) if f["layer"] == "buildings" else 5.0
    labels.append({
        "featureId": f["id"], "text": f["name"][:32],
        "sub": f["nameEn"][:40], "x": f["center"][0], "y": r2(y), "z": f["center"][1],
        "layer": f["layer"], "priority": priority(f),
    })

# -----------------------------------------------------------------------------
# Stats and honest caveats.
# -----------------------------------------------------------------------------
barrier_nodes_raw = sum(1 for t in node_tags.values() if "barrier" in t)
barrier_nodes_rendered = sum(1 for m in markers if m["kind"] == "barrier")
highway_nodes_raw = sum(1 for t in node_tags.values() if "highway" in t)
highway_nodes_rendered = sum(1 for m in markers if "highway" in m["tags"])
historic_tagged = sum(1 for el in elements if "historic" in el.get("tags", {}))
heritage_relations = sum(1 for r in relations.values() if "heritage" in r.get("tags", {}))
tourism_tagged = sum(1 for el in elements if "tourism" in el.get("tags", {}))
monument_features = sum(1 for f in features.values() if f["layer"] == "monuments" or is_monument(f["tags"]))
building_levels = sum(1 for el in elements if "building:levels" in el.get("tags", {}))
height_tags = sum(1 for el in elements if "height" in el.get("tags", {}))
surface_tags = sum(1 for el in elements if "surface" in el.get("tags", {}))
road_line_features = {l["featureId"] for l in lines if l["kind"] == "road"}
barrier_line_features = {l["featureId"] for l in lines if l["kind"] == "barrier"}
highway_area_features = {a["featureId"] for a in areas if "highway" in a["tags"] and a["featureId"].startswith("w")}
highway_ways_rendered = len((road_line_features | highway_area_features) & {i for i in features if i.startswith("w")})
barrier_ways_rendered = len(barrier_line_features)
alley_ways_rendered = sum(
    1 for f in features.values()
    if f["osmType"] == "way" and f["hasGeometry"] and f["tags"].get("highway") in ALLEY_TYPES
)
building_relations_rendered = sum(1 for b in buildings if b["featureId"].startswith("r"))
clip_area_km2 = ((CLIP[2] - CLIP[0]) * (CLIP[3] - CLIP[1])) / 1_000_000
nan_feature = features.get("w4922662")
nan_center = nan_feature["center"] if nan_feature else [0.0, 0.0]
buildings_near_nan_150 = sum(
    1 for b in buildings
    if math.hypot(b["center"][0] - nan_center[0], b["center"][1] - nan_center[1]) <= 150
)
buildings_near_nan_300 = sum(
    1 for b in buildings
    if math.hypot(b["center"][0] - nan_center[0], b["center"][1] - nan_center[1]) <= 300
)

stats = {
    "rawElements": len(elements),
    "nodes": len(nodes),
    "ways": len(ways),
    "relations": len(relations),
    "buildings": len(buildings),
    "buildingWaysRaw": building_way_count,
    "buildingWaysRendered": building_ways_rendered,
    "buildingWaysOutsideClip": building_way_count - building_ways_rendered,
    "buildingRelationsRaw": building_relation_count,
    "buildingRelationsRendered": building_relations_rendered,
    "highwayWaysRaw": highway_way_count,
    "highwayWaysRendered": highway_ways_rendered,
    "highwayNodesRaw": highway_nodes_raw,
    "highwayNodesRendered": highway_nodes_rendered,
    "alleyWaysRaw": alley_way_count,
    "alleyWaysRendered": alley_ways_rendered,
    "barrierWaysRaw": barrier_way_count,
    "barrierWaysRendered": barrier_ways_rendered,
    "barrierNodesRaw": barrier_nodes_raw,
    "barrierNodesRendered": barrier_nodes_rendered,
    "barriersTotalRaw": barrier_way_count + barrier_nodes_raw,
    "barriersRendered": barrier_ways_rendered + barrier_nodes_rendered,
    "monumentFeatures": monument_features,
    "historicTagged": historic_tagged,
    "heritageRelations": heritage_relations,
    "tourismTagged": tourism_tagged,
    "amenityNodes": sum(1 for t in node_tags.values() if "amenity" in t),
    "shopNodes": sum(1 for t in node_tags.values() if "shop" in t),
    "taggedNodesRaw": tagged_nodes_raw,
    "taggedNodesRendered": tagged_nodes_rendered,
    "taggedNodesOutsideClip": tagged_nodes_raw - tagged_nodes_rendered,
    "waterRelations": water_relation_count,
    "waterPolygons": sum(1 for a in areas if a["kind"] == "water"),
    "greenPolygons": sum(1 for a in areas if a["kind"] in ("green", "pitch")),
    "areas": len(areas),
    "lines": len(lines),
    "roadLines": sum(1 for l in lines if l["kind"] == "road"),
    "barrierLines": sum(1 for l in lines if l["kind"] == "barrier"),
    "markers": len(markers),
    "trees": len(trees),
    "namedFeatures": len(named),
    "signs": len(signs),
    "labels": len(labels),
    "features": len(features),
    "buildingHeightTags": height_tags,
    "buildingLevelsTags": building_levels,
    "surfaceTags": surface_tags,
    "areaKm2": r2(area_km2),
    "clipAreaKm2": r2(clip_area_km2),
    "buildingsNearNanluoguxiang150m": buildings_near_nan_150,
    "buildingsNearNanluoguxiang300m": buildings_near_nan_300,
}

caveats = [
    "OSM — краудсорсинговая база. Отсутствие в выгрузке забора, ворот или переулка не доказывает их отсутствия на местности; показаны только объекты, реально внесённые в OSM на дату выгрузки.",
    f"Покрытие building-контуров неравномерное: в радиусе 150 м от центра way 4922662 (Наньлогусян) в выгрузке всего {buildings_near_nan_150} building-контур, в радиусе 300 м — {buildings_near_nan_300}. Пустые дворовые пространства не заполнены выдуманными зданиями; более плотная застройка показана у Гулоу и башен.",
    f"В сырой выгрузке {barrier_way_count} barrier-way и {barrier_nodes_raw} barrier-node. Все {barrier_ways_rendered} barrier-way внутри буфера AOI отрисованы как стены/ворота; {barrier_nodes_rendered} из {barrier_nodes_raw} точек barrier попали в буфер, остальные {barrier_nodes_raw - barrier_nodes_rendered} находятся далеко за пределами выбранного квартала и в сцену не включены. Неотмеченные в OSM ограждения не могут быть воспроизведены.",
    f"Все {highway_way_count} highway-way из выгрузки обработаны; {highway_ways_rendered} имеют геометрию внутри буфера AOI и отрисованы как ленты/площади. {alley_way_count} из них — межквартальные хутуны service/footway/pedestrian/residential/unclassified/tertiary/cycleway/steps. Длинные транзитные way обрезаны по буферу, а не проведены на много километров за кадр.",
    "Ширина дорог в OSM не указана ни для одного way: использованы классозависимые значения из meta.roadWidths. Это визуальная интерпретация, не геодезический промер.",
    f"Только {height_tags} объект имеет height и {building_levels} имеют building:levels. Высота остальных зданий вычислена по типу building (meta.defaultHeights) и помечена defaultHeight=true — это не реальные замеры.",
    "Высота Колокольной башни 47.9 м взята из внешнего справочника [1], потому что в OSM-выгрузке у way 425993664 нет height; у Барабанной башни height=47 м взят напрямую из OSM.",
    f"Памятники, heritage-relation и tourism-объекты ({monument_features} записей) показаны как реальные OSM-контуры/точки с подписями и карточками. 3D-объёмы — экструзия контуров OSM, а не фотограмметрия и не импорт Sketchfab.",
    "Окна, фонари, вывески, карнизы и черепичные крыши — стилистические процедурные детали из China_Preview.html, а не отдельные объекты OSM; их можно отключить слоями.",
    "Водные поверхности — плоские полигоны OSM без батиметрии; подземные/туннельные waterway показаны тонкими линиями с пометкой в тегах.",
    f"AOI: {minlon}–{maxlon}°E, {minlat}–{maxlat}°N ({area_km2:.2f} км²). OSM map.json возвращает все узлы way, пересекающего bbox, поэтому сцена обрезана по буферу +{CLIP_MARGIN:.0f} м ({clip_area_km2:.2f} км²). {tagged_nodes_raw - tagged_nodes_rendered} тегированных узлов и {building_way_count - building_ways_rendered} контур здания целиком вне буфера сохранены в исходном экстракте, но не отрисованы.",
    "Проекция локальная равнопромежуточная: x — восток, z — север, метры; искажения на масштабе квартала пренебрежимо малы, но это не государственная геодезическая система.",
    "Данные получены через OpenStreetMap API v0.6 / map.json и распространяются по ODbL 1.0; атрибуция «© OpenStreetMap contributors» встроена в документ и должна сохраняться.",
]

meta = {
    "name": "Beijing · Gulou / Nanluoguxiang — exact OSM 3D extract",
    "title": "Пекин · Гулоу / Наньлогусян — 3D по данным OSM",
    "source": src["source"],
    "sourceUrl": "https://api.openstreetmap.org/api/0.6/map.json?bbox=" + ",".join(str(v) for v in bbox),
    "retrievedAt": src["retrievedAt"],
    "attribution": "© OpenStreetMap contributors",
    "license": "ODbL 1.0",
    "licenseUrl": "https://www.openstreetmap.org/copyright",
    "coordinateSystem": "local equirectangular metres; x east, z north",
    "origin": {"lon": r2(lon0), "lat": r2(lat0)},
    "metersPerLon": r2(m_per_lon),
    "metersPerLat": r2(m_per_lat),
    "bboxWGS84": bbox,
    "bboxMeters": [r2(xmin), r2(zmin), r2(xmax), r2(zmax)],
    "clipBBoxMeters": [r2(v) for v in CLIP],
    "clipMarginMeters": CLIP_MARGIN,
    "generator": raw.get("generator"),
    "rawBounds": raw.get("bounds"),
    "roadWidths": ROAD_WIDTHS,
    "defaultHeights": DEFAULT_HEIGHTS,
    "barrierHeights": BARRIER_HEIGHTS,
    "externalSources": [{"id": 1, "title": "Baidu Baike — bell tower and drum tower", "url": EXTERNAL_URL}],
    "externalHeightSources": [{"osmId": BELL_TOWER_ID, "height": 47.9, "source": EXTERNAL_HEIGHTS[BELL_TOWER_ID][1], "sourceId": 1}],
    "proceduralDetails": ["facade windows", "lanterns", "sign boards", "roof caps", "pagoda roofs", "tree crowns"],
    "stats": stats,
    "caveats": caveats,
}

data = {
    "meta": meta,
    "nodes": {str(k): v for k, v in nodes.items()},
    "ways": [{"id": w["id"], "tags": w.get("tags", {}), "nodes": w["nodes"]} for w in ways.values()],
    "relations": [{"id": r["id"], "tags": r.get("tags", {}), "members": r.get("members", [])} for r in relations.values()],
    "buildings": buildings,
    "areas": areas,
    "lines": lines,
    "markers": markers,
    "trees": trees,
    "features": [features[i] for i in feature_order],
    "signs": signs,
    "labels": labels,
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
print("wrote", OUT, OUT.stat().st_size, "bytes")
print("stats", json.dumps(stats, ensure_ascii=False, indent=2))

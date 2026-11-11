import io
from fastapi.testclient import TestClient
from PIL import Image

from newwoorld_ai.server import app


client = TestClient(app)


def test_health_and_ui_root():
    r_root = client.get("/")
    assert r_root.status_code == 200
    assert "NEWwoorld AI Studio" in r_root.text

    r_h = client.get("/api/health")
    assert r_h.status_code == 200
    data = r_h.json()
    assert data["status"] == "ok"
    assert data["models"]["cadgpt"]["params"] > 100_000
    assert len(data["archetypes"]) == 10


def test_cad_generate_and_all_exports():
    r = client.post("/api/cad/generate", json={"prompt": "турбина импеллер 11 лопаток", "size_mm": 75.0})
    assert r.status_code == 200
    payload = r.json()
    assert payload["archetype"] == "turbine_impeller"
    assert payload["audit"]["all_watertight"] is True
    assert payload["audit"]["non_manifold_edges"] == 0

    for fmt, check in [
        ("obj", lambda b: b"v " in b and b"f " in b),
        ("stl", lambda b: len(b) > 84),
        ("glb", lambda b: b[:4] == b"glTF"),
        ("scad", lambda b: len(b) > 10),
    ]:
        er = client.get(f"/api/cad/export/{fmt}")
        assert er.status_code == 200
        assert check(er.content)


def test_photo_part_by_part_endpoint():
    r = client.post("/api/photo/generate", json={"prompt": "закат в горах альпы озеро", "size": 256, "seed": 5})
    assert r.status_code == 200
    data = r.json()
    assert data["scene_archetype"] == "alpine_sunset"
    assert len(data["parts"]) == 5


def test_vision_sample_analyze_and_to_cad():
    sr = client.get("/api/vision/sample/cyrillic_doc")
    assert sr.status_code == 200
    assert sr.headers["content-type"] == "image/png"

    ar = client.post("/api/vision/analyze", files={"file": ("doc.png", sr.content, "image/png")})
    assert ar.status_code == 200
    adata = ar.json()
    assert len(adata["ocr"]["text"]) >= 5
    assert adata["ocr"]["char_count"] >= 5

    cr = client.post(
        "/api/vision/to-cad",
        files={"file": ("doc.png", sr.content, "image/png")},
        data={"mode": "relief"},
    )
    assert cr.status_code == 200
    cdata = cr.json()
    assert cdata["audit"]["all_watertight"] is True

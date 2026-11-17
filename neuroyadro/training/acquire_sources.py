"""Acquire a reviewed, commit-pinned GitHub corpus source into an ignored local directory.

This utility never downloads a source until its exact licence identifier is passed on the
command line. It deliberately does not support sources hosted outside GitHub in Arena.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def source_by_id(manifest: dict[str, Any], source_id: str) -> dict[str, Any]:
    for source in manifest.get("sources", []):
        if source.get("id") == source_id:
            return source
    available = ", ".join(str(source.get("id")) for source in manifest.get("sources", []))
    raise ValueError(f"unknown source {source_id!r}; available: {available}")


def run(command: list[str], *, cwd: Path | None = None) -> str:
    return subprocess.run(command, cwd=cwd, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("data/sources/open_sources.json"))
    parser.add_argument("--source", required=True, help="source id from the manifest")
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--accept-license", required=True, help="must exactly match the manifest licence")
    parser.add_argument("--allow-large-download", action="store_true", help="required acknowledgement for corpora above 100 MB")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    source = source_by_id(manifest, args.source)
    if source.get("kind") != "git":
        raise ValueError("this source requires manual acquisition; read its provenance entry instead of bypassing review")
    if args.accept_license != source.get("license"):
        raise ValueError("--accept-license must exactly match the licence recorded in the manifest")
    if not args.allow_large_download:
        raise ValueError("refusing a potentially large corpus download without --allow-large-download")
    destination: Path = args.destination
    if destination.exists():
        raise FileExistsError(f"destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)

    try:
        run(["git", "clone", "--depth", "1", source["repository"], str(destination)])
        actual = run(["git", "rev-parse", "HEAD"], cwd=destination).strip()
        expected = source["revision"]
        if actual != expected:
            raise RuntimeError(f"repository revision mismatch: got {actual}, expected {expected}")
        licence = destination / str(source["license_file"])
        if not licence.is_file():
            raise FileNotFoundError(f"declared licence file is absent: {licence}")
        provenance = {
            "format": 1,
            "source": source,
            "checked_out_revision": actual,
            "license_sha256": sha256(licence),
            "acquired_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        (destination / "NEUROYADRO_SOURCE_PROVENANCE.json").write_text(
            json.dumps(provenance, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise
    print(json.dumps({"source": source["id"], "destination": str(destination), "revision": actual,
                      "license": source["license"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

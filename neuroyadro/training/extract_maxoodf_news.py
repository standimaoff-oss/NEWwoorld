"""Extract the commit-pinned maxoodf Russian news corpus into UTF-8 documents.

The source archive is a single bzip2 stream split across files. This extractor streams it,
keeps no article collection in RAM, applies conservative quality filters, and records exactly
what was accepted. It does not alter or redistribute the source repository.
"""
from __future__ import annotations

import argparse
import bz2
import codecs
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator


CYRILLIC = re.compile(r"[А-Яа-яЁё]")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def decompressed_chunks(parts: list[Path], block_size: int = 1024 * 1024) -> Iterator[bytes]:
    """Decode the one bzip2 stream that is split across the source fragments."""
    decompressor = bz2.BZ2Decompressor()
    completed = False
    for part in parts:
        with part.open("rb") as source:
            while block := source.read(block_size):
                if completed:
                    raise ValueError("unexpected data after the final bzip2 stream")
                data = decompressor.decompress(block)
                if data:
                    yield data
                if decompressor.eof:
                    completed = True
                    if decompressor.unused_data:
                        raise ValueError("unexpected concatenated bzip2 stream")
    if not completed:
        raise ValueError("the joined bzip2 stream ended before its final block")


def source_lines(parts: list[Path]) -> Iterator[str]:
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    pending = ""
    for raw in decompressed_chunks(parts):
        pending += decoder.decode(raw)
        lines = pending.split("\n")
        pending = lines.pop()
        yield from lines
    pending += decoder.decode(b"", final=True)
    if pending:
        yield pending


def clean_document(line: str, minimum: int, maximum: int) -> str | None:
    # A bad byte is not silently converted into training text. The incremental decoder uses
    # replacement only so one corrupted article cannot abort a multi-gigabyte extraction.
    if "\ufffd" in line:
        return None
    text = " ".join(line.split())
    if len(text) < minimum or len(text) > maximum:
        return None
    letters = sum(character.isalpha() for character in text)
    if letters == 0:
        return None
    cyrillic = len(CYRILLIC.findall(text))
    if cyrillic / letters < 0.55:
        return None
    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True, help="checkout created by acquire_sources")
    parser.add_argument("--output", type=Path, required=True, help="ignored UTF-8 .txt target")
    parser.add_argument("--min-characters", type=int, default=80)
    parser.add_argument("--max-characters", type=int, default=8000)
    parser.add_argument("--limit-documents", type=int, default=0, help="0 means all documents")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()

    provenance_path = args.source_dir / "NEUROYADRO_SOURCE_PROVENANCE.json"
    if not provenance_path.is_file():
        raise FileNotFoundError("source provenance is missing; use training.acquire_sources first")
    provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
    if provenance.get("source", {}).get("id") != "maxoodf-russian-news-2017":
        raise ValueError("this extractor only accepts the pinned maxoodf source")
    parts = sorted(args.source_dir.glob("russian_news.txt.bz2_a*"))
    if not parts:
        raise FileNotFoundError("no russian_news.txt.bz2_a* fragments found")
    if args.output.exists() and not args.overwrite:
        raise FileExistsError(f"refusing to overwrite {args.output}")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    accepted = 0
    scanned = 0
    rejected_invalid_utf8 = 0
    characters = 0
    with args.output.open("w", encoding="utf-8", newline="\n") as target:
        for line in source_lines(parts):
            scanned += 1
            if "\ufffd" in line:
                rejected_invalid_utf8 += 1
            text = clean_document(line, args.min_characters, args.max_characters)
            if text is None:
                continue
            target.write(text + "\n")
            accepted += 1
            characters += len(text)
            if args.limit_documents and accepted >= args.limit_documents:
                break
            if accepted and accepted % 100_000 == 0:
                print(json.dumps({"accepted": accepted, "scanned": scanned}, ensure_ascii=False), flush=True)
    report = {
        "format": 1,
        "source_provenance": str(provenance_path.resolve()),
        "source_revision": provenance["checked_out_revision"],
        "output": str(args.output.resolve()),
        "output_sha256": sha256(args.output),
        "documents_scanned": scanned,
        "documents_accepted": accepted,
        "documents_rejected_invalid_utf8": rejected_invalid_utf8,
        "characters_accepted": characters,
        "min_characters": args.min_characters,
        "max_characters": args.max_characters,
        "limit_documents": args.limit_documents,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
    }
    report_path = args.output.with_suffix(args.output.suffix + ".provenance.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "accepted": accepted, "characters": characters,
                      "report": str(report_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

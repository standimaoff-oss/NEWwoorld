"""Cross-platform launcher for NEWwoorld AI Studio."""

from __future__ import annotations
import argparse
import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch NEWwoorld AI Studio")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("newwoorld_ai.server:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

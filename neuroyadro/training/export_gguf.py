"""Call a pinned local llama.cpp conversion flow and optionally quantize the GGUF file."""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def tool_path(root: Path, candidates: tuple[str, ...]) -> Path | None:
    for name in candidates:
        candidate = root / name
        if candidate.is_file() and candidate.exists():
            return candidate
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True, help="output of training.export_hf")
    parser.add_argument("--llama-cpp-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True, help="destination f16 GGUF")
    parser.add_argument("--quantize", default="", help="optional quantization type, e.g. Q8_0 or Q4_K_M")
    parser.add_argument("--quantized-output", type=Path, default=None)
    args = parser.parse_args()

    if not (args.model_dir / "config.json").is_file() or not (args.model_dir / "tokenizer.model").is_file():
        raise FileNotFoundError("--model-dir must be a completed export_hf directory")
    converter = args.llama_cpp_dir / "convert_hf_to_gguf.py"
    if not converter.is_file():
        raise FileNotFoundError(f"llama.cpp converter not found: {converter}")
    if args.output.suffix != ".gguf":
        raise ValueError("--output must end with .gguf")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise FileExistsError(f"refusing to overwrite {args.output}")

    subprocess.run(
        [sys.executable, str(converter), str(args.model_dir), "--outfile", str(args.output), "--outtype", "f16"],
        check=True,
    )
    if not args.output.is_file() or args.output.stat().st_size < 1024:
        raise RuntimeError("llama.cpp reported success but did not create a plausible GGUF file")

    if args.quantize:
        binary = tool_path(args.llama_cpp_dir, ("build/bin/llama-quantize", "build/bin/quantize", "llama-quantize", "quantize"))
        if binary is None:
            raise FileNotFoundError("GGUF was created but llama-quantize is not built in llama.cpp")
        quantized = args.quantized_output or args.output.with_name(args.output.stem + f"-{args.quantize.lower()}" + args.output.suffix)
        if quantized.exists():
            raise FileExistsError(f"refusing to overwrite {quantized}")
        subprocess.run([str(binary), str(args.output), str(quantized), args.quantize], check=True)
        if not quantized.is_file() or quantized.stat().st_size < 1024:
            raise RuntimeError("quantizer did not create a plausible GGUF file")
        print(quantized)
    else:
        print(args.output)


if __name__ == "__main__":
    main()

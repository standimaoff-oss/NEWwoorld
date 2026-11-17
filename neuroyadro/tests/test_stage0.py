from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

import torch
from transformers import LlamaConfig, LlamaForCausalLM

from training.config import load_config
from training.dataset import TokenStream
from training.model import NeuroYadroForCausalLM
from training.prepare_data import UInt16ShardWriter
from training.extract_maxoodf_news import clean_document, source_lines
from training.export_hf import hf_state_dict


ROOT = Path(__file__).resolve().parents[1]


def tiny_config():
    base = load_config(ROOT / "configs/neuroyadro_25m.json")
    return replace(
        base,
        vocab_size=128,
        hidden_size=32,
        intermediate_size=64,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=4,
        max_position_embeddings=16,
    )


class ArchitectureTests(unittest.TestCase):
    def test_base_architecture_is_near_25m(self) -> None:
        config = load_config(ROOT / "configs/neuroyadro_25m.json")
        # Tied output embeddings are deliberately counted only once.
        estimated = config.vocab_size * config.hidden_size
        estimated += config.num_hidden_layers * (
            4 * config.hidden_size * config.hidden_size
            + 3 * config.hidden_size * config.intermediate_size
            + 2 * config.hidden_size
        )
        estimated += config.hidden_size
        self.assertEqual(estimated, 24_635_936)
        self.assertEqual(config.head_dim, 52)

    def test_model_shapes_and_weight_tying(self) -> None:
        config = tiny_config()
        model = NeuroYadroForCausalLM(config)
        self.assertIs(model.embed_tokens.weight, model.lm_head.weight)
        tokens = torch.randint(0, config.vocab_size, (2, 7))
        result = model(tokens, labels=tokens)
        self.assertEqual(tuple(result.logits.shape), (2, 7, config.vocab_size))
        self.assertTrue(torch.isfinite(result.loss))

    def test_attention_is_causal(self) -> None:
        config = tiny_config()
        torch.manual_seed(42)
        model = NeuroYadroForCausalLM(config).eval()
        first = torch.tensor([[2, 11, 12, 13, 14]])
        second = torch.tensor([[2, 11, 12, 55, 56]])
        with torch.no_grad():
            first_logits = model(first).logits
            second_logits = model(second).logits
        torch.testing.assert_close(first_logits[:, :3], second_logits[:, :3], rtol=0.0, atol=1e-6)

    def test_huggingface_weight_mapping_preserves_logits(self) -> None:
        config = tiny_config()
        torch.manual_seed(11)
        source = NeuroYadroForCausalLM(config).eval()
        converted = LlamaForCausalLM(LlamaConfig(
            vocab_size=config.vocab_size, hidden_size=config.hidden_size,
            intermediate_size=config.intermediate_size, num_hidden_layers=config.num_hidden_layers,
            num_attention_heads=config.num_attention_heads, num_key_value_heads=config.num_key_value_heads,
            max_position_embeddings=config.max_position_embeddings, rms_norm_eps=config.rms_norm_eps,
            rope_theta=config.rope_theta, attention_bias=False, mlp_bias=False,
            tie_word_embeddings=True, bos_token_id=config.bos_token_id,
            eos_token_id=config.eos_token_id, pad_token_id=config.pad_token_id,
        )).eval()
        converted.load_state_dict(hf_state_dict(source.state_dict(), config.num_hidden_layers), strict=True)
        ids = torch.tensor([[2, 7, 9, 11, 3]])
        with torch.no_grad():
            expected = source(ids).logits
            actual = converted(ids).logits
        torch.testing.assert_close(expected, actual, rtol=2e-5, atol=2e-5)


class DatasetTests(unittest.TestCase):
    def test_step_seed_makes_resume_batch_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "tokens.pt"
            torch.save({"format": 1, "input_ids": torch.arange(64, dtype=torch.int32)}, path)
            stream = TokenStream(path, context_length=8)
            torch.testing.assert_close(
                stream.batch_for_step(batch_size=3, seed=17, step=9),
                stream.batch_for_step(batch_size=3, seed=17, step=9),
            )
            self.assertFalse(torch.equal(
                stream.batch_for_step(batch_size=3, seed=17, step=9),
                stream.batch_for_step(batch_size=3, seed=17, step=10),
            ))

    def test_uint16_shards_are_memory_mapped_and_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            writer = UInt16ShardWriter(root / "tokens", max_tokens=1024)
            writer.append(list(range(1300)))
            writer.close()
            manifest = {
                "format": 2, "storage": "uint16le-shards", "context_window": 8,
                "min_token_id": writer.min_token_id, "max_token_id": writer.max_token_id,
                "shards": writer.shards,
            }
            path = root / "tokenized.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            stream = TokenStream(path, context_length=8, verify_shards=True)
            self.assertEqual(stream.token_range, (0, 1299))
            first = stream.batch_for_step(batch_size=4, seed=123, step=3)
            second = stream.batch_for_step(batch_size=4, seed=123, step=3)
            self.assertEqual(tuple(first.shape), (4, 9))
            torch.testing.assert_close(first, second)

    def test_split_bzip_news_extractor_rejects_bad_utf8(self) -> None:
        import bz2
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payload = bz2.compress("Первая строка\nВторая строка\n".encode("utf-8"))
            first = root / "russian_news.txt.bz2_aa"
            second = root / "russian_news.txt.bz2_ab"
            first.write_bytes(payload[:7])
            second.write_bytes(payload[7:])
            self.assertEqual(list(source_lines([first, second])), ["Первая строка", "Вторая строка"])
        self.assertIsNone(clean_document("сломано \ufffd", 1, 100))


if __name__ == "__main__":
    unittest.main()

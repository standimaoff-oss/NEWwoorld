"""Bilingual Russian/English + CAD Technical Subword Tokenizer."""

from __future__ import annotations
import re
from typing import Dict, List, Tuple
import numpy as np


SPECIAL_TOKENS = ["<pad>", "<bos>", "<eos>", "<unk>", "<cad>", "<photo>", "<vision>"]

DOMAIN_SUBWORDS = [
    # CAD / 3D Russian roots
    "шестер", "зуб", "планетар", "вал", "турбин", "импеллер", "лопат", "кронштейн",
    "флан", "болт", "отверст", "фаск", "скругл", "купол", "геодез", "арк", "колонн",
    "башн", "робот", "манипул", "шарнир", "клапан", "корпус", "радиатор", "ребр",
    "фюзеляж", "крыл", "сопл", "бокал", "ваз", "шахмат", "гайк", "резьб", "муфт",
    "подшип", "диск", "ступиц", "мост", "ферм", "павильон", "корабл", "дрон", "сталь",
    "титан", "алюмин", "бронз", "медь", "стекл", "керам", "бетон", "карбон", "золот",
    # CAD / 3D English roots
    "gear", "spur", "helical", "planet", "shaft", "turbine", "impeller", "blade",
    "bracket", "gusset", "flange", "bolt", "hole", "chamfer", "fillet", "bevel", "dome",
    "geodesic", "arch", "column", "tower", "robot", "actuator", "arm", "joint", "valve",
    "enclosure", "heatsink", "fin", "fuselage", "wing", "nozzle", "vase", "vessel",
    "chess", "nut", "thread", "coupling", "bearing", "hub", "bridge", "truss", "pavilion",
    "drone", "steel", "titanium", "aluminum", "bronze", "copper", "glass", "carbon", "gold",
    # Photo / Scene Russian & English roots
    "небо", "закат", "рассвет", "ночь", "облак", "горы", "лес", "океан", "море", "вода",
    "город", "небоскреб", "улиц", "неон", "киберпанк", "космос", "планет", "звезд",
    "авто", "машин", "спорткар", "интерьер", "портрет", "архитектур", "природ",
    "солнц", "свет", "тен", "отражен", "реалист", "студи", "фото", "детал", "хром",
    "sky", "sunset", "sunrise", "night", "cloud", "mountain", "forest", "ocean", "sea",
    "water", "city", "skyscraper", "street", "neon", "cyberpunk", "space", "planet",
    "star", "car", "sportscar", "interior", "portrait", "architect", "nature", "sun",
    "light", "shadow", "reflect", "realistic", "studio", "photo", "detail", "chrome",
    "marble", "wood", "snow", "desert", "fire", "aurora",
]

CHARS = (
    list("abcdefghijklmnopqrstuvwxyz")
    + list("абвгдеёжзийклмнопрстуфхцчшщъыьэюя")
    + list("0123456789")
    + list(" .,:-_+*/()[]{}°±Ø×")
)


class BilingualCADTokenizer:
    """Deterministic subword + character tokenizer covering RU/EN and CAD terminology."""

    def __init__(self, max_len: int = 48):
        self.max_len = max_len
        self.vocab: List[str] = list(SPECIAL_TOKENS) + DOMAIN_SUBWORDS + CHARS
        self.tok2id: Dict[str, int] = {t: i for i, t in enumerate(self.vocab)}
        self.id2tok: Dict[int, str] = {i: t for i, t in enumerate(self.vocab)}
        self.pad_id = self.tok2id["<pad>"]
        self.bos_id = self.tok2id["<bos>"]
        self.eos_id = self.tok2id["<eos>"]
        self.unk_id = self.tok2id["<unk>"]
        # Sort domain subwords longest-first for greedy matching
        self._subwords_sorted = sorted(DOMAIN_SUBWORDS, key=len, reverse=True)

    @property
    def vocab_size(self) -> int:
        return len(self.vocab)

    def encode(self, text: str, max_len: int | None = None, add_special: bool = True) -> np.ndarray:
        limit = max_len or self.max_len
        s = text.lower().strip()
        ids: List[int] = [self.bos_id] if add_special else []

        i = 0
        n = len(s)
        while i < n and len(ids) < limit - (1 if add_special else 0):
            matched = False
            for sw in self._subwords_sorted:
                if s.startswith(sw, i):
                    ids.append(self.tok2id[sw])
                    i += len(sw)
                    matched = True
                    break
            if not matched:
                ch = s[i]
                ids.append(self.tok2id.get(ch, self.unk_id))
                i += 1

        if add_special:
            ids.append(self.eos_id)
        if len(ids) < limit:
            ids.extend([self.pad_id] * (limit - len(ids)))
        else:
            ids = ids[:limit]
        return np.asarray(ids, dtype=np.int64)

    def encode_batch(self, texts: List[str], max_len: int | None = None) -> np.ndarray:
        return np.stack([self.encode(t, max_len=max_len) for t in texts], axis=0)


def extract_numeric_specs(prompt: str) -> Dict[str, float]:
    """Extract explicit engineering dimensions/counts from RU/EN prompts."""
    p = prompt.lower()
    specs: Dict[str, float] = {}

    # Teeth / blades / fins / holes / sides / floors
    m = re.search(r"(\d+)\s*(?:зуб|teeth|tooth)", p)
    if m:
        specs["teeth"] = float(np.clip(int(m.group(1)), 6, 72))

    m = re.search(r"(\d+)\s*(?:лопат|лопаст|blade|vane)", p)
    if m:
        specs["blades"] = float(np.clip(int(m.group(1)), 3, 32))

    m = re.search(r"(\d+)\s*(?:отверст|болт|bolt|hole)", p)
    if m:
        specs["holes"] = float(np.clip(int(m.group(1)), 2, 24))

    m = re.search(r"(\d+)\s*(?:ребер|ребра|ребр|fin)", p)
    if m:
        specs["fins"] = float(np.clip(int(m.group(1)), 4, 40))

    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:мм|mm)\b", p)
    if m:
        specs["size_mm"] = float(np.clip(float(m.group(1)), 10.0, 500.0))

    m = re.search(r"(?:фаск|chamfer|bevel)\s*(\d+(?:\.\d+)?)", p)
    if m:
        specs["chamfer"] = float(np.clip(float(m.group(1)), 0.2, 10.0))

    return specs

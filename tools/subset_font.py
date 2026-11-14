#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_subset_font.py — подмножество CJK-шрифта для вывесок Пекина (шаг 5.33).

Зачем. Полный Noto Serif SC — 14 МБ и 40 000 глифов. В игру такой шрифт класть
нельзя: на Android apk растёт на десятки мегабайт, а FreeType тратит кэш на
поиск глифов, которых никто не рисует. Нужен ровно тот набор, что встречается
на вывесках, плюс уличная лексика, которую игрок может увидеть в новых вывесках
при расширении мода.

Что делает:
  1. собирает список иероглифов из SIGNS в tools/make_beijing_tex.py (чтобы
     генератор атласа и шрифт не разъезжались) + словарь уличных слов;
  2. инстанцирует вариативный шрифт до wght=400 (fontTools.varLib.instancer);
  3. вырезает подмножество pyftsubset-ом (fontTools.subset) — только нужные
     глифы, без хинтинга, с десубрутинызацией (быстрее растеризуется);
  4. проверяет, что каждый затребованный глиф действительно есть в cmap, и
     печатает покрытие; при пропуске — код возврата 1.

Запуск (нужен fontTools: pip install fonttools --break-system-packages):

    python3 tools/subset_font.py --src /tmp/NotoSerifSC-wght.ttf \\
        --out assets/fonts/NotoSerifSC-Regular.ttf

Скачать источник, если его нет (только github.com доступен из песочницы):

    git clone --filter=blob:none --sparse https://github.com/google/fonts /tmp/gf
    cd /tmp/gf && git sparse-checkout set ofl/notoserifsc
    # дальше --src /tmp/gf/ofl/notoserifsc/NotoSerifSC[wght].ttf
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Уличная лексика Пекина: то, что реально читается на фасадах. Собрано по
# реестру вывесок хутунов и рыночных улиц — 8 групп товаров + сервисы.
STREET_WORDS = """
烤鸭北京全聚德便宜坊炸酱面豆汁儿卤煮火锅烧烤串串麻辣烫小吃快餐早点包子饺子馄饨
面条米饭炒饭盖浇便当超市便利商店商场百货五金建材文具图书眼镜钟表修表配钥匙裁缝
洗衣理发美发美甲按摩足浴洗浴旅馆宾馆酒店客栈民宿诊所药房药店医院学校幼儿园托儿所
幼儿园咖啡茶饮奶茶甜品蛋糕面包烘焙花店宠物摄影婚纱广告印刷装饰装潢安装维修疏通
搬家快递物流仓储车库停车场收费站加油站汽车修理配件轮胎电瓶出租出售收购旧货废品
烟酒糖茶干果副食调味粮油生鲜蔬菜水果海鲜水产肉蛋奶熟食凉菜卤味盒饭食堂餐馆饭店酒楼
麻将棋牌台球健身游泳球馆影院剧院书场茶社酒馆酒吧KTV夜宵宵禁停车让行慢行注意危险
施工禁止吸烟灭火器材应急出口安全通道楼层电话报警求救门诊住院挂号收费取药抓药中药
"""

LATIN = "0123456789.&-+()/:%#,;!?·—«»\"'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийklmnoprstufxyz"


def signs_glyphs() -> str:
    """Иероглифы из SIGNS генератора атласа — общий источник истины."""
    src = open(os.path.join(HERE, "make_beijing_tex.py"), encoding="utf-8").read()
    m = re.search(r"^SIGNS\s*=\s*\[(.*?)^\]", src, re.S | re.M)
    if not m:
        return ""
    return "".join(re.findall(r"[一-鿿]", m.group(1)))


def wanted(extra: str = "") -> str:
    chars = set(signs_glyphs()) | set(STREET_WORDS) | set(extra)
    chars = {c for c in chars if ord(c) > 0x20}          # без управления и пробелов
    chars |= {c for c in LATIN if ord(c) > 0x20}
    return "".join(sorted(chars))


def instance_variable(src: str, dst: str, wght: int) -> None:
    from fontTools import varLib
    from fontTools.varLib import instancer
    from fontTools.ttLib import TTFont
    f = TTFont(src)
    if "fvar" not in f:
        import shutil
        shutil.copyfile(src, dst)
        return
    axes = {a.axisTag: wght for a in f["fvar"].axes if a.axisTag == "wght"}
    if not axes:
        import shutil
        shutil.copyfile(src, dst)
        return
    out = instancer.instantiateVariableFont(f, axes, updateFontNames=True)
    out.save(dst)
    print(f"  инстанс wght={wght}: {len(out.getGlyphOrder())} глифов-кандидатов")


def subset(src: str, dst: str, text: str) -> None:
    tmp = tempfile.mkdtemp(prefix="subset_")
    glyphs_path = os.path.join(tmp, "glyphs.txt")
    with open(glyphs_path, "w", encoding="utf-8") as f:
        f.write(text)
    cmd = [
        sys.executable, "-m", "fontTools.subset", src, f"--text-file={glyphs_path}",
        f"--output-file={dst}",
        # только базовые таблицы: движку нужны cmap + контуры + метрики
        "--layout-features=",
        "--drop-tables+=DSIG,BASE,GPOS,GSUB,GDEF,JSTF,MATH,CBDT,CBLC,CBSC,VORG",
        "--no-hinting", "--desubroutinize", "--name-IDs=1,2,3,4,6",
        "--notdef-outline", "--recalc-bounds",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit("pyftsubset не запустился:\n" + (r.stdout + r.stderr)[-2000:])
    if r.stderr.strip():
        print("  (pyftsubset):", r.stderr.strip()[:400])


def verify(path: str, text: str) -> int:
    from fontTools.ttLib import TTFont
    f = TTFont(path)
    cmap = f.getBestCmap()
    miss = [c for c in text if ord(c) not in cmap]
    total = len(f.getGlyphOrder())
    size = os.path.getsize(path) / 1024
    print(f"  готово: {os.path.relpath(path, ROOT)}  {size:.0f} КБ  глифов {total}")
    print(f"  покрытие запрошенного: {len(text) - len(miss)}/{len(text)}")
    if miss:
        print("  НЕТ ГЛИФОВ:", "".join(miss[:60]), ("…" if len(miss) > 60 else ""))
    return 1 if miss else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="/tmp/NotoSerifSC[wght].ttf",
                    help="исходный (можно вариативный) TTF/OTF")
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "fonts", "NotoSerifSC-Regular.ttf"))
    ap.add_argument("--wght", type=int, default=400)
    ap.add_argument("--extra", default="", help="дополнительные символы")
    ap.add_argument("--dry-list", action="store_true", help="только напечатать набор символов")
    a = ap.parse_args()

    text = wanted(a.extra)
    if a.dry_list:
        print(text)
        print(f"# {len(text)} символов")
        return 0
    if not os.path.exists(a.src):
        raise SystemExit(f"нет исходного шрифта {a.src}\n"
                         "  git clone --filter=blob:none --sparse https://github.com/google/fonts /tmp/gf && "
                         "cd /tmp/gf && git sparse-checkout set ofl/notoserifsc\n"
                         f"  затем: python3 tools/subset_font.py --src /tmp/gf/ofl/notoserifsc/NotoSerifSC[wght].ttf")
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    print(f"подмножество: {len(text)} символов из {os.path.basename(a.src)}")
    inst = a.out + ".instance.ttf"
    instance_variable(a.src, inst, a.wght)
    subset(inst, a.out, text)
    if os.path.exists(inst):
        os.remove(inst)
    return verify(a.out, text)


if __name__ == "__main__":
    sys.exit(main())

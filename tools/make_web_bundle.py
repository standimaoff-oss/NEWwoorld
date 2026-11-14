#!/usr/bin/env python3
"""Сборка автономного веб-бандла (то, что кладётся в релиз).

    python3 tools/make_web_bundle.py            # → dist/newwoorld-<версия>-web.zip

В бандл попадает ровно то, что читает браузер: `web/` (разметка, JS, PWA),
собранные под WebGL 2 шейдеры из `build/shaders/web`, атласы и шрифт из
`assets/`, и исходники `shaders/glsl` — чтобы бандл можно было сверить с
единым источником шейдеров. Каталог `build/` в git не входит, поэтому шейдеры
перед сборкой перегеняются здесь же (тот же `tools/shader_dialect.py`).

Почему это «and-версия», а не apk: сцена на WebGL 2 ставится на телефон как
PWA («Установить приложение» в Chrome), без сборки под NDK. Нативный apk — это
проект `android/` плюс `src/`, а их в этом дереве нет.
"""
import hashlib
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = "newwoorld-web"


def version():
    """Версия берётся из README, а не удваивается: заголовок раздела «Новое в
    шаге 5.33 (версия 0.5.32)» — единственный источник числа для бандла."""
    txt = open(os.path.join(ROOT, "README.md"), encoding="utf-8").read()
    m = re.search(r"Новое в шаге \d+\.\d+ \(версия (\d+\.\d+\.\d+)\)", txt)
    if m:
        return m.group(1)
    m = re.search(r"этап (\d+), шаг (\d+)", txt)         # запасной путь: 0.5.(шаг-1)
    return f"0.{m.group(1)}.{int(m.group(2)) - 1}" if m else "0.0.0"


def collect():
    """Список (путь_в_бандле, абсолютный_путь)."""
    out = []
    for top in ("web", "assets", "shaders"):
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, top)):
            dirnames[:] = [d for d in dirnames if d not in ("__pycache__", ".ipynb_checkpoints")]
            for f in filenames:
                if f.endswith((".pyc", ".xcf", ".psd")):
                    continue
                full = os.path.join(dirpath, f)
                out.append((os.path.relpath(full, ROOT).replace(os.sep, "/"), full))
    sh = os.path.join(ROOT, "build", "shaders", "web")
    for f in sorted(os.listdir(sh)):
        out.append((f"build/shaders/web/{f}", os.path.join(sh, f)))
    out.append(("build/shaders/manifest.json", os.path.join(ROOT, "build", "shaders", "manifest.json")))
    return [(a, b) for a, b in out if os.path.isfile(b)]


README = """# ShopSim {ver} — веб-сборка (Пекин: шейдеры, трава, вода, вывески)

Бандл автономен: шейдеры, атласы и шрифт уже внутри, интернет не нужен.

Запуск на компьютере:

    cd {dir}
    python3 -m http.server 8080
    # затем открыть  http://localhost:8080/web/?freeze=1&clean=1

`?freeze=1` — камера стоит (удобно сравнивать кадр с эталонным снимком из
README), `?clean=1` — без отладочных проходов. Управление: WASD, мышь — LMB,
`P` — панель, `H` — справка, `S` — снимок PNG.

## Телефон (Android, iOS) без сборки apk

1. отдать тот же каталог по сети: `python3 -m http.server 8080`, узнать IP машины
  (`ip a` / `ifconfig`) и открыть `http://IP:8080/web/` браузером телефона;
2. Chrome → меню → «Установить приложение…» (Safari → «На экран Домой»).
   Иконка, полноэкранный режим и офлайн-режим описаны в `web/manifest.webmanifest`
   и `web/sw.js`: политика кэша «сеть вперёд», поэтому правки файлов видны сразу.

Внимание: установка как приложения работает только по https или с localhost —
на голом http по IP браузер не отдаёт ни service worker, ни промпт установки.
Быстрый способ получить https в локальной сети: `mkcert`, `localhost`, любой
статический хостинг с https, либо туннель. Если возиться не хочется — сцена
отлично открывается и без установки, просто не офлайн.

## Если что-то пошло не так

* чёрный экран и `program.missing` в `#stats` — не совпали uniform'ы: соберите
  шейдеры заново, `python3 tools/shader_dialect.py --validate`, и сверьтесь с
  `build/shaders/manifest.json`;
* кэш мешает — открыть `http://…/web/?nosw=1`: это снимает регистрацию
  service worker, после перезагрузки всё отдаётся сервером как есть;
* проверка всех чисел и контрактов без браузера: `./tools/check.sh`.
"""


def main():
    ver = version()
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "shader_dialect.py")], check=True,
                   cwd=ROOT, stdout=subprocess.DEVNULL)
    files = collect()
    outdir = os.path.join(ROOT, "dist")
    os.makedirs(outdir, exist_ok=True)
    name = f"{NAME}-{ver}"
    path = os.path.join(outdir, f"{name}.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for arc, full in sorted(files):
            z.write(full, f"{name}/{arc}")
        z.writestr(f"{name}/README-WEB.md", README.format(ver=ver, dir=name))
    data = open(path, "rb").read()
    print(f"бандл: {os.path.relpath(path, ROOT)}  {len(data) / 1e6:.1f} МБ, файлов {len(files) + 1}")
    print(f"sha256: {hashlib.sha256(data).hexdigest()}")


if __name__ == "__main__":
    main()

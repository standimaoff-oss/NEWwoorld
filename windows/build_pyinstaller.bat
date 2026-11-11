@echo off
cd /d "%~dp0\.."
python -m pip install --upgrade pip pyinstaller pywebview -r requirements.txt
python -m pip install -e . --no-deps
pyinstaller --noconfirm --onefile --windowed ^
  --name NEWwoorldStudio-Full ^
  --add-data "web;web" ^
  --add-data "models/checkpoints;models/checkpoints" ^
  --hidden-import newwoorld_ai.server ^
  windows/pyinstaller_entry.py
echo Built standalone full EXE at dist\NEWwoorldStudio-Full.exe

@echo off
cd /d "%~dp0\.."
echo ============================================
echo   NEWwoorld AI Studio - Windows Setup & Run
echo ============================================
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating Python virtual environment...
    python -m venv .venv
)
echo [2/3] Checking core dependencies...
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
".venv\Scripts\python.exe" -m pip install -q -e . --no-deps
echo [3/3] Launching NEWwoorldStudio.exe (Full Neural Core)...
start "" "%~dp0\NEWwoorldStudio.exe"

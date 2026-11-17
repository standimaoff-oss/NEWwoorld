@echo off
chcp 65001 >nul
title ShopSim — запуск
setlocal

rem ============================================================
rem  ShopSim — запуск на Windows.
rem  Скрипт поднимает локальный веб-сервер (нужен для ES-модулей)
rem  и открывает игру в браузере. Ничего устанавливать не нужно,
rem  кроме одного из браузеров: Chrome / Edge / Firefox.
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"

set "PORT=8123"
set "URL=http://127.0.0.1:%PORT%/index.html"

rem --- ищем Python (встроенный сервер; обычно уже есть в Windows 10/11) ---
where py >nul 2>nul && (set "PY=py -3" & goto havepy)
where python >nul 2>nul && (set "PY=python" & goto havepy)
where python3 >nul 2>nul && (set "PY=python3" & goto havepy)

echo.
echo   Python не найден. Игра откроется напрямую из файла,
echo   но так браузер может не загрузить часть модулей.
echo   Рекомендуется установить Python с python.org (галочка "Add to PATH").
echo.
start "" "%HERE%index.html"
goto end

:havepy
echo.
echo   ShopSim — локальный сервер на порту %PORT%
echo   Адрес: %URL%
echo   Закрыть игру: закройте это окно.
echo.

rem --- открываем браузер, когда сервер поднимется ---
start "" /b cmd /c "timeout /t 2 >nul & start "" "%URL%""

%PY% -m http.server %PORT% --bind 127.0.0.1

:end
endlocal

@echo off
rem Silero-сервер в окне, для запуска вручную двойным щелчком. Остановка — закрыть окно или
rem Ctrl+C. Автозапуск без окна — другой путь: install-autostart.ps1 и silero-serve.cmd.
chcp 65001 >nul
title Silero TTS
rem Запуск из папки скрипта: пакет silero кладёт latest_silero_models.yml в рабочий каталог.
cd /d "%~dp0"
set PYTHONUTF8=1

if not exist ".venv\Scripts\python.exe" (
    echo Нет .venv — сначала установите сервер, см. README.md, раздел Windows.
    pause
    exit /b 1
)

rem Второй экземпляр ошибкой не упадёт: на Windows Flask садится на занятый порт, а запросы
rem уходят первому. Поэтому не запускаемся, если на порту уже кто-то отвечает.
curl.exe -sf -m 2 -o nul http://127.0.0.1:5011/health
if not errorlevel 1 (
    echo Silero уже запущена: http://127.0.0.1:5011 отвечает — другое окно, задача «Silero TTS» или WSL.
    pause
    exit /b 0
)

".venv\Scripts\python.exe" server.py
rem Сюда попадаем, только если сервер упал: окно не закроется, и ошибку будет видно.
pause

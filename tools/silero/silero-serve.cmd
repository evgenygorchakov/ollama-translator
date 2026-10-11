@echo off
rem Silero-сервер на Windows. Запуск из папки скрипта: пакет silero кладёт
rem latest_silero_models.yml в рабочий каталог. Вывод — в silero.log, заново при каждом старте.
rem Порт, голос и прочее — переменные SILERO_* (список в начале server.py).
cd /d "%~dp0"
set PYTHONUTF8=1
".venv\Scripts\python.exe" server.py > silero.log 2>&1

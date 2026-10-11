# Silero — синтез речи для озвучки видео

HTTP-сервер Silero `v5_5_ru` на `http://127.0.0.1:5011`: 5 русских голосов, ударения ставит сама
модель. Расширение озвучивает им переведённые субтитры YouTube. GPU не нужен: на процессоре
фраза синтезируется примерно за 0,1–0,2 с, а с Ollama за видеопамять сервер не спорит.

`server.py` и `requirements.txt` — копия `sup/optional/voice/silero`. Файлы держим одинаковыми:
правка в одном — переносим в другой.

| Запрос | Ответ |
|---|---|
| `POST /synthesize` `{"text", "voice"?, "rate"?}` | wav, 48 кГц, моно. 204 — в тексте нет слов. 404 — нет такого голоса или темпа |
| `GET /voices` | `{"voices", "default", "rates", "default_rate"}` |
| `GET /health` | `{"model", "voices", "device", …}` |

Темп `rate`: `x-slow` (×0,5), `slow` (×0,8), `medium` (×1), `fast` (×1,2), `x-fast` (×1,5).

## Linux

Сервер ставится как systemd user-сервис по инструкции в `sup/optional/voice/README.md`. Там
он слушает тот же порт 5011, поэтому расширению настраивать ничего не нужно.

## Установка на Windows

Нужен [uv](https://docs.astral.sh/uv/). Закачка около 280 МБ: torch ~120 МБ, модель ~139 МБ.
В PowerShell из этой папки:

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.venv\Scripts\python.exe server.py
```

torch ставится отдельной командой из CPU-индекса PyTorch: так он точно без CUDA и меньше.
Последняя команда — пробный запуск. Во время первого старта модель скачивается внутрь `.venv`
(`site-packages\silero\model\`), потом запуск занимает несколько секунд. Когда в консоли
появится `Running on http://127.0.0.1:5011`, сервер готов. Ctrl+C — остановить.

Автозапуск при входе в Windows, без окна:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

Скрипт создаёт задачу Планировщика «Silero TTS» и сразу запускает сервер. Задача запускает
`silero-serve.cmd` через `conhost --headless`: так окна нет совсем, а вывод попадает в лог.
`pythonw` для этого хуже: у него нет stdout, и вывод модели при первом старте пропадает.

## Управление

```powershell
curl.exe -s http://127.0.0.1:5011/health               # отвечает ли сервер
Get-Content .\silero.log -Wait                         # лог (пишется заново при каждом старте)
Start-ScheduledTask "Silero TTS"                       # запустить
Get-Process python | ? Path -like "$PWD\.venv\*" | Stop-Process   # остановить
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Remove   # убрать автозапуск
```

Голос по умолчанию, порт и прочее задают переменные `SILERO_*`: список с дефолтами есть в
начале `server.py`. Их можно задать в `silero-serve.cmd` строкой `set SILERO_VOICE=baya`.

Обновить пакеты: `uv pip install --python .venv\Scripts\python.exe -U -r requirements.txt`.
Удалить всё: убрать автозапуск, затем удалить папку `.venv`.

## Если рядом работает WSL

WSL пробрасывает порты из Linux на Windows. Если в WSL работает свой Silero на 5011
(systemd-сервис из `sup`), то на Windows порт 5011 займёт `wslrelay.exe`. Кто займёт порт,
зависит от того, что стартовало раньше, WSL или задача «Silero TTS».

- Сервер на Windows, запущенный вторым, ошибкой не падает: Flask на Windows садится на
  занятый порт. При этом запросы получает тот, кто был первым.
- Пока порт держит `wslrelay`, расширение говорит через Silero из WSL. Если там старая
  версия `server.py`, без темпов (в `/health` нет `default_rate`), темп речи не меняется.
  Лечится так: скопировать `server.py` из `sup/optional/voice/silero` в
  `~/.local/share/silero/` и выполнить `systemctl --user restart silero`.
- Проверить, кто держит порт: `Get-NetTCPConnection -LocalPort 5011 -State Listen` и имя
  процесса по `OwningProcess`.

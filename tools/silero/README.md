# Silero — speech synthesis for video dubbing

Silero `v5_5_ru` HTTP server on `http://127.0.0.1:5011`: 5 Russian voices, stress is placed by
the model itself. The extension uses it to voice translated YouTube captions. No GPU needed: on
CPU a phrase takes about 0.1–0.2 s, and the server doesn't compete with Ollama for VRAM.

`server.py` and `requirements.txt` are a copy of `sup/optional/voice/silero`. Keep them
identical: a change in one goes into the other.

| Request | Response |
|---|---|
| `POST /synthesize` `{"text", "voice"?, "rate"?}` | WAV, 48 kHz, mono. 204 — no words in the text. 404 — unknown voice or rate |
| `GET /voices` | `{"voices", "default", "rates", "default_rate"}` |
| `GET /health` | `{"model", "voices", "device", …}` |

`rate`: `x-slow` (×0.5), `slow` (×0.8), `medium` (×1), `fast` (×1.2), `x-fast` (×1.5).

## Linux

Installed as a systemd user service following `sup/optional/voice/README.md`. It listens on the
same port 5011, so the extension needs no configuration.

## Windows

Requires [uv](https://docs.astral.sh/uv/) (`winget install astral-sh.uv`). Downloads about
280 MB: torch ~120 MB, model ~139 MB. In PowerShell from this folder:

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
```

torch is installed from the PyTorch CPU index so it comes without CUDA and is smaller.

**Start:** double-click `start-silero.cmd`. The server runs in its own window; close the window
or press Ctrl+C to stop it. On first start the model is downloaded into `.venv`
(`site-packages\silero\model\`), later starts take a few seconds. The server is ready once the
window shows `Running on http://127.0.0.1:5011`. If something already answers on port 5011
(another window, the autostart task or WSL), the script says so and doesn't start a second server.

**Autostart (optional)** at Windows sign-in, without a window:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1
```

The script creates the "Silero TTS" Task Scheduler task and starts the server. The task runs
`silero-serve.cmd` via `conhost --headless`, so there is no window and output goes to the log.
`pythonw` is worse here: it has no stdout, and the model's first-start output is lost.

## Management

```powershell
curl.exe -s http://127.0.0.1:5011/health               # is the server up
```

With autostart (`start-silero.cmd` prints to its window instead of the log):

```powershell
Get-Content .\silero.log -Wait                         # log (rewritten on every start)
Start-ScheduledTask "Silero TTS"                       # start
Get-Process python | ? Path -like "$PWD\.venv\*" | Stop-Process   # stop
powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -Remove   # remove autostart
```

Default voice, port and the rest are set by `SILERO_*` variables, listed with defaults at the
top of `server.py`. Set them in `start-silero.cmd` and `silero-serve.cmd` with a line like
`set SILERO_VOICE=baya`. Port 5011 is also in the `start-silero.cmd` check and in the extension's
manifest permissions.

Update packages: `uv pip install --python .venv\Scripts\python.exe -U -r requirements.txt`.
Uninstall: remove autostart if it's set up, then delete `.venv`.

## When WSL is running

WSL forwards ports from Linux to Windows. If WSL runs its own Silero on 5011 (the systemd
service from `sup`), `wslrelay.exe` takes port 5011 on Windows. Which one gets the port depends
on what started first: WSL or the Windows server. `start-silero.cmd` checks the port and won't
start if WSL already answers on it; the "Silero TTS" task doesn't check.

- The Windows server started second doesn't fail: Flask on Windows binds to a busy port anyway,
  but requests go to whoever was first.
- While `wslrelay` holds the port, the extension talks to the Silero in WSL. If that one runs an
  old `server.py` without rates (no `default_rate` in `/health`), speech rate doesn't change.
  Fix: copy `server.py` from `sup/optional/voice/silero` to `~/.local/share/silero/` and run
  `systemctl --user restart silero`.
- To see who holds the port: `Get-NetTCPConnection -LocalPort 5011 -State Listen`, then look up
  the process by `OwningProcess`.

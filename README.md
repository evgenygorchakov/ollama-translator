# Ollama Translator

Chrome and Firefox extension that translates web pages and selected text from English through a
local [Ollama](https://ollama.com) and dubs YouTube videos in Russian through Silero.

## Setup

1. **Ollama.** Pull a model (e.g. `ollama pull gemma4`), allow extension origins and restart Ollama:
   - Windows: `setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"`, then quit Ollama
     from the tray and start it again;
   - Linux: `sudo systemctl edit ollama`, add
     `Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"` under `[Service]`,
     then `sudo systemctl restart ollama`.
2. **Extension.**
   - Chrome: `chrome://extensions` → Developer mode → Load unpacked → project folder;
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`
     (removed when the browser restarts).
3. **Model.** Pick one in the extension popup.
4. **Dubbing** (YouTube only). Silero on `http://127.0.0.1:5011`: on Windows see
   [`tools/silero/README.md`](tools/silero/README.md) (~280 MB), on Linux use the systemd
   service from `sup/optional/voice`.

Settings are stored in the browser and don't sync between machines.

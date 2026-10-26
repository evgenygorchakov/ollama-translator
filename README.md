# Ollama Translator

Chrome and Firefox extension that translates and summarizes web pages and selected text through a
local [Ollama](https://ollama.com) and dubs YouTube videos in Russian through Silero.

## Setup

1. Install [Ollama](https://ollama.com/download), pull a model (`ollama pull gemma4`), allow
   extension origins and restart Ollama:
   - Windows: `setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"`, quit Ollama from the
     tray and start it from the Start menu;
   - Linux (systemd service from the official install script):

     ```bash
     sudo mkdir -p /etc/systemd/system/ollama.service.d && printf '[Service]\nEnvironment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"\n' | sudo tee /etc/systemd/system/ollama.service.d/origins.conf && sudo systemctl daemon-reload && sudo systemctl restart ollama
     ```
2. Load the extension and pick the model in its popup:
   - Chrome: `chrome://extensions` → Developer mode → Load unpacked → project folder;
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json` (until
     restart).
3. For YouTube dubbing run Silero on port 5011: [`tools/silero`](tools/silero/README.md) on
   Windows, `sup/optional/voice` on Linux.

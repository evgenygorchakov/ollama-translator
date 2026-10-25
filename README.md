# Ollama Translator

Chrome and Firefox extension that translates web pages and selected text from English and
summarizes them through a local [Ollama](https://ollama.com), and dubs YouTube videos in Russian
through Silero.

## Setup

1. **Ollama.** Install it (Windows: `winget install Ollama.Ollama`), pull a model (e.g.
   `ollama pull gemma4`), allow extension origins and restart Ollama:
   - Windows: `setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"`, then quit Ollama
     from the tray and start it again from the Start menu (not from a terminal opened before
     `setx`: it still has the old environment);
   - Linux: `sudo systemctl edit ollama`, add
     `Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"` under `[Service]`,
     then `sudo systemctl restart ollama`.
2. **Extension.**
   - Chrome: `chrome://extensions` → Developer mode → Load unpacked → project folder;
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `manifest.json`
     (removed when the browser restarts).
3. **Model.** Pick one in the extension popup.
4. **Dubbing** (YouTube only). Silero on `http://127.0.0.1:5011`: on Windows install it per
   [`tools/silero/README.md`](tools/silero/README.md) (~280 MB) and start it with
   `tools\silero\start-silero.cmd` when needed; on Linux use the systemd service from
   `sup/optional/voice`.

Settings are stored in the browser and don't sync between machines.

## Summary

«Краткое содержание» in the popup or «Краткое содержание страницы» in the page context menu opens
a panel with a summary of the page's main text in the translation language; «Кратко о выделенном»
in the selection context menu does the same for the selected text. Switch between a short and a
detailed summary in the panel. A long page is read part by part, up to 150 000 characters, so it
takes several requests to the model.

Below the summary you can ask questions about the same text. The model answers only from the
text and sees the summary and earlier questions, so follow-ups like «а подробнее про второй
пункт?» work. On a long page each question is looked up part by part: one request per part plus
one for the answer.

«В чём суть» in the popup («В чём суть страницы» and «В чём суть выделенного» in the context
menus) opens the same panel in the «Суть» mode: not a retelling but the main point of the text and
a detailed explanation around it — what it rests on, what follows from it, the author's caveats.
A model with thinking (`capabilities` in `ollama show`) reasons before answering, the panel shows
for how long. All «Суть» requests, questions under it included, use `num_ctx` 32768 whatever the
settings say, so a text up to ~72 000 characters is read at once. With another `num_ctx` in the
settings Ollama reloads the model when switching between «Суть» and translation.

«Сбросить» in the panel forgets all answers, questions and the clickbait verdict; the mode you
pick next is asked again with the current settings. To compare models: press «Сбросить», change
the model in the popup, then pick the mode. A long text is read part by part again; the page text
and captions are not read again.

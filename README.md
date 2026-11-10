# Ollama Translator

Chrome and Firefox extension that translates and summarizes web pages and selected text through a
local [Ollama](https://ollama.com) and dubs YouTube videos in Russian through Silero.

The summary panel has two question fields: “Ask about the page…” answers only from the source
text; “Ask freely…” can also use the model’s own knowledge and reasoning. Each keeps its own
conversation history. Both use the selected Ollama model and response language.

For automatic web search in **Ask freely**, run [SearXNG](https://docs.searxng.org/), open the
extension's Settings, enable “Search the web automatically when needed”, enter the SearXNG base
address (default `http://127.0.0.1:8888`), and press Save. Allow access to that address when the
browser asks. The address must be reachable from the browser; for Docker, use the published
host port, not the container name. Press Check to run a sample search through its JSON API.
Select a model that supports tools and use a context (`num_ctx`) of at least 8192. The model
decides when to search, then answers with numbered references and links to the search results.
Each question allows up to 6 tool calls across 3 rounds; retrieved text is limited to fit the
context. A simple question can be answered without searching.

Enable JSON in SearXNG's `settings.yml`, then restart its container if the setting changed:

```yaml
search:
  formats:
    - html
    - json
```

Merge this into the existing `search` section. A 403 response can mean JSON output is disabled;
see the [SearXNG Search API](https://docs.searxng.org/dev/search_api.html). A 429 response means
requests are being rate limited. CAPTCHA or limits from individual search engines can reduce
the results even when the JSON API works.

No Ollama API key or Ollama cloud search service is used. Search queries go to your SearXNG
server and its configured search engines; your selected Ollama model generates the answer.
The model receives search excerpts, not full page downloads: SearXNG does not replace
`web_fetch`. With automatic search disabled, Ask freely uses the page and the model's own
knowledge. Questions in “Ask about the page…” always use only the source text.

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

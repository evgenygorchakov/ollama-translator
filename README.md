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
Select a model that supports tools and set a context of at least 8192 in Ollama. The model
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

## Context length and usage

Set context length in the **Ollama app**, or use `OLLAMA_CONTEXT_LENGTH` when running its server.
The extension does not send `num_ctx` overrides; old context settings saved in the extension are
ignored. After loading the model with Ollama's settings, it reads the actual window from
`/api/ps` and uses it to fit source text, conversation history and search results. The loaded
model's window may be smaller than the setting in Ollama.

Each question field has its own **Context: used / total tokens · percent** indicator and meter.
“Ask about the page” and “Ask freely” track their independent conversations; translations,
summaries, page-reading steps and intermediate web tool calls do not overwrite them. The popup
retains its separate counter for the last completed request across operations.

Exact usage is the final request's input tokens plus generated tokens, including thinking, as
reported by Ollama after generation finishes. History is already included in that input;
independent requests and intermediate steps are never added together. `—` means usage has not
been reported, and `unknown` means capacity is unavailable. Hover for the input/output breakdown.
A request can process more tokens than the window retains; the count and percentage show that
overflow, while the meter stops at 100%.

The conversation also shows an **estimated history budget** (3 characters per token). Page text,
prompts, response space and web search reduce the room available for history. For long pages,
the smallest history budget across page-search and final-answer steps is used. After a reply,
the estimate includes that reply for the next turn; the next question and the model's tokenizer
can change the actual fit. Warnings appear at 80% of either the context or history budget.

If request preparation omits old messages, shortens earlier answers or trims web tool text, a
visible warning remains even at low context usage, after retries and after stopping generation.
The existing **Reset** button clears both histories, both indicators and all these warnings.
During generation or after an interrupted attempt, usage stays unknown until a final response
completes. An error does not add partial answers to history.

Changing context length in Ollama takes effect on the next operation. Reopen the popup or press
⟳ to refresh its capacity. The extension still limits source text to 150,000 characters for
summaries and questions, and selection translation to 5,000 characters.

While loading a model or waiting for a chat response to begin, the extension checks Ollama
every 30 seconds and allows 10 seconds for each check. If Ollama stops responding, it cancels
the attempt; normal retries still apply. Slow loading can continue while Ollama responds.
Stop cancels the wait immediately.

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

# PageGloss

Translate web pages, summarize articles and ask questions about what you read without
leaving your browser. PageGloss is a Chrome and Firefox extension for working with web
content using models you run on your own computer. It currently connects through
[Ollama](https://ollama.com), so you can work with text locally and choose your model.

- **Translate in place.** Read pages in any of 14 target languages, hover to see the original,
  or translate just the text you select. Russian is the default.
- **Ask questions.** Get a page summary, ask about its contents, or open a conversation
  beside a selected passage with the experimental Text workspace.
- **Search when needed.** Connect SearXNG to let the model find current information and
  include source links in its answers.
- **Listen in Russian.** Dub YouTube videos from their captions with a local Silero speech
  server.
- **Load from source.** The extension needs no build step or npm dependencies.

For example, translating a selection into Russian looks like this. The wording depends on
your model:

```text
Selected text:  "The meeting starts at noon."
Action:         Right-click → Translate selection
Language:       Russian (default)
Example result: "Встреча начинается в полдень."
```

[Get started](#get-started) · [Everyday use](#everyday-use) ·
[Optional features](#optional-features) · [Troubleshooting](#troubleshooting) ·
[Detailed guide](docs/usage.md) · [Development](#development)

---

## Get started

You need **Chrome 127+ or Firefox 140+**, [Ollama](https://ollama.com/download), and a
downloaded model. The instructions below cover Windows and Linux.

### 1. Download the extension

With [Git](https://git-scm.com/downloads) installed, run:

```sh
git clone https://github.com/evgenygorchakov/pagegloss.git
cd pagegloss
```

Alternatively, choose **Code → Download ZIP** on the
[repository page](https://github.com/evgenygorchakov/pagegloss) and extract it.
Keep this folder: the browser loads the extension directly from it.

### 2. Prepare Ollama

Install and start [Ollama](https://ollama.com/download). Allow requests from browser
extensions using the instructions for your operating system below.

**Windows — PowerShell:**

```powershell
setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"
```

Quit Ollama from the system tray, then start it again from the Start menu.

**Linux — Ollama installed as a systemd service:**

```sh
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"\n' | sudo tee /etc/systemd/system/ollama.service.d/origins.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

If you run Ollama manually instead of as a service, start it in a separate terminal with:

```sh
OLLAMA_ORIGINS='chrome-extension://*,moz-extension://*' ollama serve
```

See [Ollama's server configuration guide](https://docs.ollama.com/faq#how-do-i-configure-ollama-server)
for other installation methods.

Download a model, for example [Gemma 4](https://ollama.com/library/gemma4), or use one you
already have. Run these commands in a terminal; model downloads can be several gigabytes:

```sh
ollama pull gemma4
ollama list
```

### 3. Load the extension and translate a page

| Browser | Installation |
| --- | --- |
| Chrome | Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the folder containing `manifest.json`. |
| Firefox | Open `about:debugging`, choose **This Firefox → Load Temporary Add-on**, and select `manifest.json`. Load it again after restarting Firefox. |

1. Open an ordinary web page, such as an article, and click the extension icon.
2. Wait for the Ollama status to show **OK**, then select your model. On first connection,
   the popup selects the first available model alphabetically; changing it saves immediately.
3. Open **Settings**. Choose your **Translation language** if you want something other than
   Russian, then press **Save**. Web search is off by default, so SearXNG is not needed
   for translation or conversations using the page text and the model's knowledge.
4. Return to the article, open the extension popup and click **Translate page**. Text is
   translated as you scroll. Click **Show original** to restore it.

The default Ollama address is `http://127.0.0.1:11434`. If your server is elsewhere, change
**Ollama address** in Settings, press **Check**, then **Save**, and grant access when asked.
The address must be reachable from the machine running the browser.

---

## Everyday use

| You want to… | Do this |
| --- | --- |
| Translate a page | Click **Translate page**, or press **Alt+Shift+T** to toggle translation. Hover over translated text to see the original. |
| Translate a passage | Select text, right-click and choose **Translate selection**. |
| Get the main points | Click **Summary** in the popup. |
| Ask about an article | Click **Ask**, then use **Ask about the page…**. This mode uses only the source text. |
| Ask a broader question | Use **Ask freely…**. It can use the model's knowledge and, when configured, web search. |
| Start fresh | Use **Reset** in a panel, or **Reset context** in the popup to clear conversations across open panels. |
| Stop model work | Click **Stop** in the popup or press **Alt+Shift+S** to cancel model requests and unload the model. |

The two question fields keep separate histories and use your selected model and response
language. See the [detailed guide](docs/usage.md) for conversation controls, limits and
context usage.

## Optional features

### Text workspace: work with a passage

Enable **Text workspace** in Settings and allow website access. Select text and hover over
**✦ Ask** to open a conversation beside it. Ask your own question, or click **Translate**,
**Explain** or **Summarize**. Answers stream into the panel; you can stop or copy them.

This experimental mode is off by default. Selecting text or hovering does not send a
request. Each selection has its own conversation, which is discarded when you close the
panel. [Controls, appearance and limits →](docs/usage.md#text-workspace)

### Web search: add current information

Connect a [SearXNG](https://docs.searxng.org/) server with its JSON API enabled, choose a
model with tool support, and set at least **8192 context tokens** in Ollama. In Settings,
enter the SearXNG address, enable automatic search, press **Save** and grant access.
The extension checks SearXNG before saving; if the check fails, the previous settings stay
in effect. **Check** lets you test the server without enabling search.

Search is off by default. Previously saved choices are preserved; turn it off in Settings
if you no longer run SearXNG.

Search is available in **Ask freely** and **Text workspace**. The model decides when to
search and includes numbered sources. Queries go to SearXNG and its search engines;
answers use your selected Ollama model. [SearXNG configuration →](docs/usage.md#web-search)

### YouTube dubbing: listen in Russian

Run a Silero server at `http://127.0.0.1:5011`; the
[Silero guide](tools/silero/README.md#windows) includes Windows installation and startup
commands. Open a YouTube video with captions and click **Translate** in the player.
Choose the voice in extension Settings; adjust original volume, speech speed-up and
Russian subtitles in the menu beside the player's Translate button.

**Dubbing is always in Russian**, regardless of your translation language.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Ollama is unavailable | Start Ollama, check its address in Settings, then press **⟳** in the popup. With WSL or Docker, use an address reachable from the browser. |
| Ollama rejects extension requests | Set `OLLAMA_ORIGINS` as shown above and fully restart Ollama. |
| No models, or the saved model is missing | Run `ollama list`, download a model if needed, then select an available model in the popup. A saved choice is not silently replaced. |
| Ask freely or Text workspace reports a search error | Disable automatic search if you do not use SearXNG; otherwise check its JSON API, browser permission, tool support and context size. |
| A passage does not fit, or an answer is cut off | Select less text, reset the conversation, or increase context length in Ollama. [Context and limits →](docs/usage.md#context-length-and-usage) |
| Nothing opens on a browser settings page or PDF | Browser internal pages, extension stores and the built-in PDF viewer do not allow the injected panels. Try an ordinary web page. |
| YouTube dubbing cannot start | Check that the video has captions and Silero is running. Use **Check** next to the Silero address in Settings. |

## Development

Edit the JavaScript, HTML or CSS directly, reload the extension on the browser's extensions
page, then reload the web pages you are testing. No package installation or build is needed.

- [src/page](src/page) and [src/selection](src/selection): page and selection translation.
- [src/summary](src/summary): summaries and page conversations.
- [src/text-workspace](src/text-workspace): conversations about selected text.
- [src/dub](src/dub): YouTube dubbing.
- [src/lib](src/lib) and [src/shared](src/shared): shared logic and interface components.
- [tools/silero](tools/silero): the speech server.

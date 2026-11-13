# Ollama Translator usage guide

[Back to the README](../README.md)

Use this guide to configure optional features and understand what each conversation keeps,
sends and clears.

[Settings](#settings) · [Page questions](#page-questions) ·
[Text workspace](#text-workspace) · [Web search](#web-search) ·
[Context and usage](#context-length-and-usage)

## Settings

The popup saves model changes immediately. Most Settings fields apply when you press
**Save**; Text workspace's enable switch, cursor and color controls apply immediately.

When no model is saved, a successful popup connection check selects and saves the first
available model alphabetically. An existing choice stays selected even if that model is
missing from the server: choose a replacement manually. A failed connection or an empty
model list does not change the saved choice.

**Translation language** controls translations and the response language for summaries and
questions. Russian is the default. Text workspace also uses this language for explanations
and rewrites, unless the question explicitly requests another language. YouTube dubbing
always uses Russian.

## Page questions

Open **Summary** for a summary and follow-up questions, or **Ask** to go directly to questions.
The panel has two independent conversations:

| Field | Sources available to the answer |
| --- | --- |
| **Ask about the page…** | The source text only. |
| **Ask freely…** | The source text, the model's knowledge and reasoning, plus search excerpts when web search is enabled and used. |

Each field uses the selected Ollama model and response language, and has its own history
and context indicator. Translation, summarization and intermediate page-reading requests
do not overwrite those indicators.

**Reset** in the Summary / Ask panel clears both histories, both indicators and their
warnings. To clear conversations in all open Summary / Ask and Text workspace panels,
use **Reset context** in the extension popup.

## Text workspace

Work with a selected passage without opening a separate page conversation. Enable
**Text workspace** in Settings and grant website access when the browser asks. The switch
applies immediately to open and future HTTP(S) pages; it is off by default.

### Open and use the panel

1. Select ordinary page text. **✦ Ask** appears beside the pointer where the selection ends,
   moves inward near window edges and follows the text when you scroll. Keyboard selections
   place it beside the selected text.
2. Hover over **✦ Ask** to reveal the panel. Click the button or press **Alt+Enter** while it
   is visible to focus the question field.
3. Ask a question, or click **Translate**, **Explain** or **Summarize** to send a request
   immediately. **Enter** sends; **Shift+Enter** inserts a line break.
4. Read the streaming answer. Use **Stop** to cancel, **Copy** to copy the answer and its
   source links, or **Reset** to clear the conversation while keeping the selection.

Selecting or hovering alone sends no request. Requests contain the selection and the
panel's completed questions and answers, along with search excerpts when web search is
used. Follow-up questions retain references from earlier answers.

### Conversation lifetime

Each selection starts an independent conversation. History stays in memory, never on disk,
and is not shared with translations or either page-question field. The panel uses the same
selected model and Ollama context setting as the rest of the extension.

**Closing the panel discards its conversation.** Escape, ×, a click outside, selecting
another passage or disabling the mode cancels the request and clears the history. Stop and
closing also cancel an in-progress search. Reset keeps the selection for a new conversation.

### Appearance and supported pages

**Main color** offers seven colors, with orange as the default. Changes save immediately
and apply across the popup, settings, translation, summary and dubbing panels, including
panels already open. Animations respect reduced-motion preferences.

The custom orange cursor can be disabled separately. While enabled, it also replaces link,
button and text-input cursors, including inside extension panels and settings.

The automatic button works on ordinary page text, not form fields or editable areas.
Browser internal pages, extension stores and the built-in PDF viewer do not allow this UI.

### Limits

| Item | Limit |
| --- | --- |
| Selected passage | 12,000 characters |
| Question | 2,000 characters |
| Retained history | Up to 24 complete exchanges and 64,000 characters, subject to the model's context budget |

An oversized selection is rejected rather than silently shortened. Even a selection below
the character limit may not fit the loaded model's context. Web search reserves room for
results, leaving less room for the passage and history.

The panel warns when older exchanges are omitted, search excerpts are shortened or an
answer reaches its generation limit. Estimates are approximate; Ollama's final token counts
appear after a completed answer.

## Web search

Give **Ask freely** and **Text workspace** access to current information through your own
SearXNG server. **Ask about the page…** always uses only the source text.

### Configure SearXNG

1. Run [SearXNG](https://docs.searxng.org/admin/installation.html) at an address reachable
   from the browser. The extension defaults to `http://127.0.0.1:8888`. With Docker, use the
   published host port, not the container name.
2. Enable JSON in SearXNG's `settings.yml`. Merge this into the existing `search` section,
   then restart SearXNG:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

3. Select an Ollama model that supports tools and set context length to at least **8192**
   in Ollama.
4. In extension Settings, enter the SearXNG base address and enable **Search the web
   automatically when needed**. Press **Save** and allow access when the browser asks.
5. Press **Check** beside the SearXNG address to run a sample search through its JSON API.

> Automatic search is enabled by default. If you do not run SearXNG, turn it off in Settings
> and press Save before using Ask freely or Text workspace.

### What search sends and returns

The model decides when to search. Translation, rewriting, explanations and simple questions
can be answered without a search. While searching, the panel displays the query; answers
include numbered references and clickable sources.

- Search queries go to your SearXNG server and its configured search engines. Your selected
  Ollama model generates the answer. No Ollama API key or Ollama cloud search service is used.
- The model receives search excerpts, not full page downloads. SearXNG does not provide
  `web_fetch` here.
- Each question permits up to 6 tool calls across 3 rounds. Retrieved text is limited to
  fit the available context.
- With search disabled, Ask freely and Text workspace use the provided text and the model's
  own knowledge.

### Search errors

| Error or symptom | Check |
| --- | --- |
| HTTP 403 | JSON output may be disabled. Check `search.formats` and the [SearXNG Search API](https://docs.searxng.org/dev/search_api.html). |
| HTTP 429 | Requests are being rate limited. |
| Few or no results | Individual engines may have CAPTCHA challenges or rate limits even when the JSON API works. |
| Permission error | Save the search settings again and grant access to the server address. |
| Tool or context error | Choose a model with tool support and at least 8192 context tokens, or disable automatic search. |

## Context length and usage

Increase context length when you need room for longer passages, conversation history or
search results. Set it in the **Ollama app**, or use `OLLAMA_CONTEXT_LENGTH` when running
the server. The extension does not send `num_ctx` overrides; old context settings saved in
the extension are ignored.

After loading the model, the extension reads its actual window from `/api/ps`. That window
may be smaller than the configured setting. Changing context length in Ollama takes effect
on the next operation; reopen the popup or press **⟳** to refresh its capacity.

### Read the indicators

**Context: used / total tokens · percent** shows the final request's input plus generated
tokens, including thinking, as reported by Ollama. History is already included in the input;
independent requests and intermediate web tool calls are not added together. Hover over the
indicator for the input/output breakdown.

- Each question field tracks its own conversation. The popup has a separate counter for
  the last completed request across operations.
- The block is hidden until both usage and capacity are available. During generation or
  after an interrupted attempt, it stays hidden until a final response completes. Errors
  do not add partial answers to history.
- A request can process more tokens than the window retains. The count and percentage show
  that overflow; the meter stops at 100%.

The **estimated history budget** describes room available for conversation history after
allowing for source text, prompts, an answer and search results. Page conversations estimate
3 characters per token; Text workspace uses a more conservative estimate for non-ASCII
text. For long pages, the smallest budget across page-reading and final-answer steps is
used. After a reply, the estimate includes that reply for the next turn.

Warnings appear at 80% of the context or history budget. If request preparation omits old
messages, shortens earlier answers or trims search text, its warning persists even at low
usage, after retries and after stopping. It is shown with the context block when usage is
available. The next question and the model's tokenizer can change the actual fit.

### Reset without losing the source

**Reset context** in the popup clears conversations, usage counters, warnings and cached
summary notes across open Summary / Ask and Text workspace panels. It cancels pending
answers and keeps the source text, selected passage and loaded model available.

Page translation and dubbing continue. Their next completed request can update the popup
counter again. To cancel model work and unload the model, use the popup's **Stop** button
or **Alt+Shift+S** instead.

### Source limits and slow requests

| Operation | Limit |
| --- | --- |
| Selection translation | 5,000 characters |
| Source text for summaries and page questions | 150,000 characters |
| Summaries, page questions and Text workspace | At least 2048 context tokens |
| Automatic web search | At least 8192 context tokens and a model with tool support |

While loading a model or waiting for a chat response to begin, the extension checks Ollama
every 30 seconds and allows 10 seconds for each check. If Ollama stops responding, it
cancels the attempt; normal retries still apply. Slow loading can continue while Ollama
responds. Stop cancels the wait immediately.

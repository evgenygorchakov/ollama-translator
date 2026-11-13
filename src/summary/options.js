// Свои поля общей формы, как у dub/options.js.
import { normalizeUrl } from "../lib/settings.js";
import { WEB_DEFAULTS, getWebSettings, parseSearxngUrl } from "../lib/web-settings.js";
import { searchWeb } from "../lib/searxng.js";

const $ = (id) => document.getElementById(id);
let settings = await getWebSettings();
let checking = null;

function fill() {
  $("summaryWebEnabled").checked = settings.summaryWebEnabled;
  $("summarySearxngUrl").value = settings.summarySearxngUrl;
}

function status(text, kind = "") {
  $("web-status").textContent = text;
  $("web-status").dataset.kind = kind;
}

function cancelCheck() {
  checking?.abort();
  checking = null;
  $("webCheck").disabled = false;
}

function startCheck() {
  cancelCheck();
  checking = new AbortController();
  $("webCheck").disabled = true;
  return checking;
}

function finishCheck(controller) {
  if (checking !== controller) return;
  checking = null;
  $("webCheck").disabled = false;
}

async function checkSearxng(url, signal) {
  // До первого await: запрос прав должен оставаться в действии пользователя.
  if (!(await chrome.permissions.request({ origins: [`${url.origin}/*`] }))) {
    throw new Error(`Allow access to ${url.origin} to check SearXNG.`);
  }
  return searchWeb(url.href, "SearXNG documentation", { signal });
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  cancelCheck();
  const values = {
    summaryWebEnabled: $("summaryWebEnabled").checked,
    summarySearxngUrl: normalizeUrl($("summarySearxngUrl").value),
  };
  const url = parseSearxngUrl(values.summarySearxngUrl);
  if (values.summaryWebEnabled && !url) {
    status("Web search settings not saved: enter a SearXNG base URL, such as http://127.0.0.1:8888, without credentials, query or fragment.", "error");
    return;
  }
  // Выключение не требует рабочего адреса: оставляем последний сохранённый.
  values.summarySearxngUrl = url ? normalizeUrl(url.href) : settings.summarySearxngUrl;
  const urlChanged = values.summarySearxngUrl !== settings.summarySearxngUrl;
  const controller = startCheck();
  try {
    if (values.summaryWebEnabled && (!settings.summaryWebEnabled || urlChanged)) {
      status("Checking SearXNG before saving…", "checking");
      await checkSearxng(url, controller.signal);
    }
    if (controller.signal.aborted) return;
    // Оба поля вместе: новое Save должно перекрыть уже начатую запись предыдущего.
    await chrome.storage.local.set(values);
    const saved = await getWebSettings();
    if (controller.signal.aborted) return;
    settings = saved;
    fill();
    status(
      settings.summaryWebEnabled
        ? "Saved. Ask freely and Text workspace can search through SearXNG with a model that supports tools."
        : "Saved. Web search is off.",
      "ok",
    );
  } catch (err) {
    if (!controller.signal.aborted) {
      status(`Web search settings not saved: ${err.message || "could not save settings"}`, "error");
    }
  } finally {
    finishCheck(controller);
  }
});

$("webCheck").addEventListener("click", async () => {
  cancelCheck();
  const url = parseSearxngUrl($("summarySearxngUrl").value);
  if (!url) {
    status("Enter a SearXNG base URL, such as http://127.0.0.1:8888, without credentials, query or fragment.", "error");
    return;
  }
  const controller = startCheck();
  try {
    status("Checking SearXNG search…", "checking");
    const data = await checkSearxng(url, controller.signal);
    if (controller.signal.aborted) return;
    const partial = Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0;
    status(
      data.results.length
        ? `SearXNG JSON search works · results: ${data.results.length}${partial ? " · some search engines did not respond" : ""}`
        : "SearXNG JSON API works, but returned no results. Check its search engines.",
      data.results.length && !partial ? "ok" : "warn",
    );
  } catch (err) {
    if (!controller.signal.aborted) status(err.message || "Could not check SearXNG", "error");
  } finally {
    finishCheck(controller);
  }
});

for (const id of ["summaryWebEnabled", "summarySearxngUrl"]) {
  $(id).addEventListener("input", () => {
    cancelCheck();
    status("Unsaved web search changes.");
  });
}

$("reset").addEventListener("click", () => {
  cancelCheck();
  settings = { ...WEB_DEFAULTS };
  fill();
  status("");
});

fill();

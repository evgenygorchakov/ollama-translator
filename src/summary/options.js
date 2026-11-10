// Свои поля общей формы, как у dub/options.js.
import { normalizeUrl } from "../lib/settings.js";
import { WEB_DEFAULTS, getWebSettings, parseSearxngUrl } from "./lib/web-settings.js";
import { searchWeb } from "./lib/searxng.js";

const $ = (id) => document.getElementById(id);
let settings = await getWebSettings();

function fill() {
  $("summaryWebEnabled").checked = settings.summaryWebEnabled;
  $("summarySearxngUrl").value = settings.summarySearxngUrl;
}

function status(text, kind = "") {
  $("web-status").textContent = text;
  $("web-status").dataset.kind = kind;
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = {
    summaryWebEnabled: $("summaryWebEnabled").checked,
    summarySearxngUrl: normalizeUrl($("summarySearxngUrl").value),
  };
  const url = parseSearxngUrl(values.summarySearxngUrl);
  if (!url) {
    status("Web search settings not saved: enter a SearXNG base URL, such as http://127.0.0.1:8888, without credentials, query or fragment.", "error");
    return;
  }
  values.summarySearxngUrl = normalizeUrl(url.href);
  const patch = Object.fromEntries(
    Object.entries(values).filter(([key, value]) => value !== settings[key]),
  );
  try {
    // Запрашиваем из клика Save, до первого await: браузеру нужно действие пользователя.
    if (values.summaryWebEnabled) {
      const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
      if (!granted) {
        status(`Web search settings not saved: allow access to ${url.origin}`, "error");
        return;
      }
    }
    await chrome.storage.local.set(patch);
    settings = await getWebSettings();
    fill();
    status(
      settings.summaryWebEnabled
        ? "Saved. Ask freely can search through SearXNG with a model that supports tools."
        : "Saved. Web search is off.",
      "ok",
    );
  } catch {
    status("Web search settings could not be saved", "error");
  }
});

$("webCheck").addEventListener("click", async () => {
  const url = parseSearxngUrl($("summarySearxngUrl").value);
  if (!url) {
    status("Enter a SearXNG base URL, such as http://127.0.0.1:8888, without credentials, query or fragment.", "error");
    return;
  }
  $("webCheck").disabled = true;
  try {
    if (!(await chrome.permissions.request({ origins: [`${url.origin}/*`] }))) {
      status(`Allow access to ${url.origin} to check SearXNG.`, "error");
      return;
    }
    status("Checking SearXNG search…", "checking");
    const data = await searchWeb(url.href, "SearXNG documentation");
    const partial = Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0;
    status(
      data.results.length
        ? `SearXNG JSON search works · results: ${data.results.length}${partial ? " · some search engines did not respond" : ""}`
        : "SearXNG JSON API works, but returned no results. Check its search engines.",
      data.results.length && !partial ? "ok" : "warn",
    );
  } catch (err) {
    status(err.message || "Could not check SearXNG", "error");
  } finally {
    $("webCheck").disabled = false;
  }
});

$("reset").addEventListener("click", () => {
  settings = { ...WEB_DEFAULTS };
  fill();
  status("");
});

fill();

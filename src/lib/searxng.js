// JSON API SearXNG; используется и проверкой настроек, и инструментом модели.
import { ErrorCode, OllamaError, abortedError } from "./ollama.js";
import { parseSearxngUrl } from "./web-settings.js";

const TIMEOUT_MS = 30_000;

function failure(message) {
  return new OllamaError(ErrorCode.BAD_RESPONSE, message);
}

export async function searchWeb(baseUrl, query, { signal } = {}) {
  if (signal?.aborted) throw abortedError();
  const url = parseSearxngUrl(baseUrl);
  if (!url) throw failure("Check the SearXNG address in Settings. Use an HTTP(S) base URL without credentials, query or fragment.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
  url.search = new URLSearchParams({ q: query, format: "json", categories: "general" }).toString();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      const messages = {
        403: "SearXNG denied JSON search. Enable json in search.formats in settings.yml and restart SearXNG; also check access restrictions.",
        429: "SearXNG search limit reached. Try again later or check its limiter settings.",
      };
      throw failure(messages[response.status] ?? `SearXNG search failed (HTTP ${response.status}). Check the server.`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw failure("SearXNG did not return JSON. Check the server address and enable json in search.formats in settings.yml.");
    }
    if (!data || !Array.isArray(data.results) || data.error) {
      throw failure("SearXNG returned an invalid search response: missing results list or server error.");
    }
    return data;
  } catch (err) {
    if (signal?.aborted) throw abortedError();
    if (timeout.aborted) throw failure("SearXNG search timed out. Check the server and try again.");
    if (err instanceof OllamaError) throw err;
    throw failure(`Could not contact SearXNG at ${url.origin}. Check the container, address and browser permission in Settings.`);
  }
}

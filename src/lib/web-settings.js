import { parseServerUrl } from "./host-permission.js";
import { normalizeUrl } from "./settings.js";

export const WEB_DEFAULTS = Object.freeze({
  summaryWebEnabled: true,
  summarySearxngUrl: "http://127.0.0.1:8888",
});

// Можно указать подкаталог за reverse proxy, но не параметры поиска или учётные данные.
export function parseSearxngUrl(value) {
  const url = parseServerUrl(value);
  return url && !url.username && !url.password && !url.search && !url.hash ? url : null;
}

export async function getWebSettings() {
  const values = await chrome.storage.local.get(WEB_DEFAULTS);
  return {
    summaryWebEnabled: values.summaryWebEnabled === true,
    summarySearxngUrl: typeof values.summarySearxngUrl === "string"
      ? normalizeUrl(values.summarySearxngUrl) : WEB_DEFAULTS.summarySearxngUrl,
  };
}

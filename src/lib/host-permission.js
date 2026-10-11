// Доступ к адресу сервера (Ollama или сервер модуля) для страницы настроек.

import { normalizeUrl } from "./settings.js";

// → URL, если это адрес http(s), иначе null.
export function parseServerUrl(value) {
  try {
    const url = new URL(normalizeUrl(value));
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // невалидный адрес
  }
  return null;
}

// builtinHosts — "host:port" из host_permissions манифеста (http): для них разрешение уже есть.
// Для другого адреса нужно разрешение на его origin. Вызывать прямо из обработчика клика:
// chrome.permissions.request работает только по действию пользователя.
export async function ensureHostPermission(url, builtinHosts) {
  if (url.protocol === "http:" && builtinHosts.includes(url.host)) return true;
  return chrome.permissions.request({ origins: [`${url.origin}/*`] });
}

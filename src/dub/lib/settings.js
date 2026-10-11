// Настройки озвучки: в том же chrome.storage.local, что и общие, но под своими ключами с
// префиксом dub — src/lib/settings.js о них не знает. «Сбросить настройки» стирает и их.

import { clampNumbers, normalizeUrl } from "../../lib/settings.js";

export const DUB_DEFAULTS = Object.freeze({
  dubTtsUrl: "http://127.0.0.1:5011", // не localhost: на Windows он может резолвиться в ::1
  dubVoice: "", // пусто — голос по умолчанию на сервере
  dubOriginalVolume: 0.15, // громкость оригинала во время озвучки
  dubMaxSpeed: 1.5, // предел ускорения фразы: темп Silero × скорость воспроизведения
  dubSubtitles: false, // русские субтитры поверх видео
});

// Диапазоны числовых настроек: для ползунков в меню плеера и от мусора в storage.
export const DUB_LIMITS = Object.freeze({
  dubOriginalVolume: { min: 0, max: 1, step: 0.05 },
  dubMaxSpeed: { min: 1, max: 2, step: 0.1 },
});

// Эти настройки меняются в меню у кнопки «Перевести» в плеере, остальные — на странице
// настроек.
export const DUB_PLAYER_KEYS = Object.freeze([
  "dubOriginalVolume",
  "dubMaxSpeed",
  "dubSubtitles",
]);

// Silero, к которому расширению разрешено ходить без дополнительного запроса прав.
export const DUB_BUILTIN_HOSTS = Object.freeze(["localhost:5011", "127.0.0.1:5011"]);

function sanitize(values) {
  const next = clampNumbers(values, DUB_DEFAULTS, DUB_LIMITS);
  if ("dubTtsUrl" in next) next.dubTtsUrl = normalizeUrl(next.dubTtsUrl) || DUB_DEFAULTS.dubTtsUrl;
  if ("dubVoice" in next) next.dubVoice = typeof next.dubVoice === "string" ? next.dubVoice.trim() : "";
  if ("dubSubtitles" in next) next.dubSubtitles = next.dubSubtitles === true;
  return next;
}

export async function getDubSettings() {
  return sanitize(await chrome.storage.local.get(DUB_DEFAULTS));
}

export async function setDubSettings(patch) {
  await chrome.storage.local.set(sanitize(patch));
}

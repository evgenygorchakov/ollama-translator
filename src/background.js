// Service worker (ES-модуль): точка входа. Модули независимы друг от друга, общий у них
// только src/lib/. Чтобы оставить лишь перевод выделенного, уберите импорт page/ —
// кнопка «Перевести страницу» в popup тогда перестанет работать, остальное останется.

import "./page/background.js"; // перевод всей страницы: popup, Alt+Shift+T, меню страницы
import "./selection/background.js"; // перевод выделенного: меню по правому клику на выделении
import "./dub/background.js"; // озвучка YouTube-видео: кнопка в плеере
import "./summary/background.js"; // краткое содержание и суть: popup, меню страницы и выделенного
import { activity, stopAll } from "./lib/stop.js";

// «Стоп» (popup и Alt+Shift+S) и работа модели для popup — здесь, а не в модулях: так они
// работают при любом их наборе. Модули подписываются сами, через onStop и registerQueue.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return;
  if (msg?.type === "getActivity") {
    sendResponse(activity());
    return;
  }
  if (msg?.type !== "stopAll") return;
  stopAll().then(
    () => sendResponse({}),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "stop-all") return;
  stopAll().catch((err) => console.warn("[ot] модель не выгружена:", err.message));
});

// Переводы на диске не храним. Прежние версии кешировали их в IndexedDB — удаляем ту базу.
chrome.runtime.onInstalled.addListener(() => {
  indexedDB.deleteDatabase("ollama-translator");
});

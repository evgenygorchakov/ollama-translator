import { ensureMenu } from "../lib/menus.js";

const MENU_ID = "open-popup";

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu({
    id: MENU_ID,
    title: "Open Ollama Translator",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  // Без промежуточного await, чтобы сохранить жест пользователя.
  chrome.action.openPopup().catch((err) =>
    console.warn("[ot] не удалось открыть расширение:", err.message),
  );
});

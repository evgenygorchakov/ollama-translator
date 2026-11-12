import { resetAllContexts } from "../lib/context-reset.js";

chrome.runtime.onInstalled.addListener(() => {
  // Пункт мог сохраниться от предыдущей версии расширения.
  chrome.contextMenus.remove("open-popup", () => {
    void chrome.runtime.lastError;
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "resetContext" || sender.tab) return;
  resetAllContexts().then(
    () => sendResponse({}),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});

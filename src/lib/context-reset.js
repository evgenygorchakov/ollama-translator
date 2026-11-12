// Общий сброс диалогов. Модули сами отменяют запросы и очищают свои кэши;
// панели получают сообщение во всех вкладках, включая вложенные фреймы.
const listeners = new Set();

export function onContextReset(fn) {
  listeners.add(fn);
}

export async function resetAllContexts() {
  await Promise.all([...listeners].map((fn) => fn()));
  const tabs = await chrome.tabs.query({});
  // На служебных страницах и вкладках без панелей получателя нет.
  await Promise.allSettled(tabs.map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: "resetContext" }),
  ));
  const stored = await chrome.storage.session.get(null);
  const usageKeys = Object.keys(stored).filter((key) => key.startsWith("contextUsage:"));
  await chrome.storage.session.remove(usageKeys);
}

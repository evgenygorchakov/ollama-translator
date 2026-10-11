// Общее для background и popup: состояние перевода на вкладке.

// → { active, paused, done, requested, total, errors } или null, если content script ещё не внедрён
export async function getPageState(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "getState" });
  } catch {
    return null;
  }
}

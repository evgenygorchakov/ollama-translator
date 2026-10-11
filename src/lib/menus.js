// Пункты контекстного меню. Создаются в runtime.onInstalled, а он приходит и при обновлении
// Chrome, когда пункты уже есть: create тогда падает с «duplicate id» — обновляем пункт.

export function ensureMenu({ id, ...props }) {
  chrome.contextMenus.create({ id, ...props }, () => {
    const createError = chrome.runtime.lastError;
    if (!createError) return;
    chrome.contextMenus.update(id, props, () => {
      // обычно ошибка create — не дубль, а настоящая: без неё было бы видно только
      // «Cannot find menu item» от update
      const updateError = chrome.runtime.lastError;
      if (updateError) {
        console.warn(`[ot] пункт меню ${id}: create — ${createError.message}; update — ${updateError.message}`);
      }
    });
  });
}

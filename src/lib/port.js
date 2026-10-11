// Отправка в порт, который могли уже закрыть: после отключения postMessage бросает исключение,
// а ответ закрытому порту никому не нужен.
export function safePost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // порт уже закрыт
  }
}

// Порт закрылся. Когда вкладка уходит в bfcache, Chrome закрывает её порты с
// chrome.runtime.lastError; не прочитанный в onDisconnect, он попадает в ошибки расширения
// как «Unchecked runtime.lastError».
export function onPortClosed(port, listener) {
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    listener();
  });
}

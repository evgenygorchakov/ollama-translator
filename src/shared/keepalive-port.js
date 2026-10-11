// Порт content script → service worker с ping, пока ждём ответа: в Chrome само сообщение не
// даёт service worker'у уснуть. На время запроса к модели он держит себя и сам (lib/keepalive.js):
// в давно скрытой вкладке Chrome шлёт ping раз в минуту, а засыпает он через 30 с; в Firefox
// ping фон не держит вовсе.
// Общий для перевода страницы и выделенного; внедряется перед их скриптами.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const PING_MS = 20_000;

  // → { post, close }. Бросает, если подключиться нельзя (обычно расширение перезагружено).
  // post(message) — отправка; не бросает: если порт уже мёртв, вызывает onDisconnect.
  // onDisconnect — порт умер: его закрыл service worker или не прошёл ping. После close()
  // ни onMessage, ни onDisconnect уже не вызываются.
  // needsPing() — ждём ли сейчас ответа; без него ping идёт всегда.
  ns.connectPort = (name, { onMessage, onDisconnect, needsPing = () => true }) => {
    const port = chrome.runtime.connect({ name });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pingTimer);
      try {
        port.disconnect();
      } catch {
        // порт уже мёртв
      }
    };
    const lost = () => {
      if (closed) return;
      close();
      onDisconnect();
    };
    const post = (message) => {
      if (closed) return;
      try {
        port.postMessage(message);
      } catch {
        lost();
      }
    };
    const pingTimer = setInterval(() => {
      if (needsPing()) post({ type: "ping" });
    }, PING_MS);
    port.onMessage.addListener((msg) => {
      if (!closed) onMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // иначе Chrome пишет в ошибки «Unchecked runtime.lastError»
      lost();
    });
    return { post, close };
  };
})();

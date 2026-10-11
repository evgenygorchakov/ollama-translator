// Service worker засыпает через 30 с без событий и вызовов API, а ответ модели идёт минутами
// и событий не даёт. Ping из вкладок тут ненадёжен: в давно скрытой вкладке Chrome будит
// таймеры раз в минуту, а в Firefox сообщения порта таймер сна фона не сбрасывают вовсе.
// Поэтому, пока кто-то держит service worker, сами дёргаем дешёвый API — это работает в обоих.

const KEEPALIVE_MS = 20_000;
let holders = 0;
let timer = null;

// Не даёт service worker'у уснуть, пока не вызовут возвращённую функцию. Её повторный вызов
// ничего не делает.
export function keepAwake() {
  if (holders++ === 0) timer = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holders > 0) return;
    clearInterval(timer);
    timer = null;
  };
}

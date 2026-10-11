// Общий для всех модулей лимит одновременных запросов к модели (settings.concurrency).
// Работает в service worker.
// Ждущие в acquire() идут раньше tryAcquire(): срочное (перевод выделенного, priority.js)
// пользователь ждёт прямо сейчас, оно обгоняет очередь страницы, а через onWait перевод
// страницы уступает ему и идущий батч.

import { abortedError } from "./ollama.js";
import { keepAwake } from "./keepalive.js";

let busy = 0;
// Лимит — из последнего вызова tryAcquire/acquire: concurrency в настройках могли поменять,
// пока кто-то ждёт, и ждать по старому лимиту ему незачем.
let limit = 1;
const waiters = []; // { resolve }
const freeListeners = new Set();
const waitListeners = new Set();

// Пока занят хоть один слот, service worker не засыпает: ответ модели событий не даёт.
let letSleep = null; // от keepAwake(), пока слоты заняты

function updateKeepAlive() {
  if (busy > 0 && !letSleep) {
    letSleep = keepAwake();
  } else if (busy === 0 && letSleep) {
    letSleep();
    letSleep = null;
  }
}

// Без ожидания: true — слот занят, потом обязательно release().
export function tryAcquire(newLimit) {
  setLimit(newLimit);
  if (waiters.length || busy >= limit) return false;
  busy++;
  updateKeepAlive();
  return true;
}

// Ждёт слот; при отмене signal — OllamaError ABORTED. После успеха — обязательно release().
// → true, если слот пришлось ждать (за это время могли смениться настройки), иначе false.
export function acquire(newLimit, signal) {
  if (signal.aborted) return Promise.reject(abortedError());
  if (tryAcquire(newLimit)) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(abortedError());
      wake(); // ждущий мог задерживать tryAcquire
    };
    const waiter = {
      resolve: () => {
        signal.removeEventListener("abort", onAbort);
        resolve(true);
      },
    };
    waiters.push(waiter);
    signal.addEventListener("abort", onAbort, { once: true });
    // столько слотов должно освободиться, чтобы дождались все ждущие
    const needed = busy + waiters.length - limit;
    for (const fn of waitListeners) fn(needed);
  });
}

// Сколько запросов сейчас ждут слот в acquire().
export function waiting() {
  return waiters.length;
}

// Сколько слотов сейчас занято, то есть сколько запросов к модели идёт.
export function busyCount() {
  return busy;
}

export function release() {
  busy--;
  wake();
}

// fn вызывается, когда слот освободился и никто не ждёт его в acquire().
export function onSlotFree(fn) {
  freeListeners.add(fn);
}

// fn(needed) вызывается, когда acquire() встал ждать: можно прервать менее срочную работу —
// её release() отдаст слот ждущему. needed — сколько слотов всего должно освободиться
// (с учётом уже уступающих), чтобы дождались все ждущие.
export function onWait(fn) {
  waitListeners.add(fn);
}

function setLimit(newLimit) {
  if (newLimit === limit) return;
  limit = newLimit;
  wake(); // лимит вырос — ждущим и очереди страницы могли освободиться слоты
}

function wake() {
  while (waiters.length && busy < limit) {
    busy++;
    waiters.shift().resolve();
  }
  updateKeepAlive(); // release() уже уменьшил busy
  // ждущим отдали сколько могли; остались свободные слоты — будим очередь страницы
  if (!waiters.length && busy < limit) for (const fn of freeListeners) fn();
}

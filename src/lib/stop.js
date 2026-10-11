// «Стоп»: обрывает всю работу модели (перевод страниц и выделенного) и выгружает её из памяти.
// Модули подписываются через onStop и друг от друга не зависят. stopAll, registerQueue и activity
// работают в service worker, markModelUsed и isStopped — и в popup.

import { getSettings } from "./settings.js";
import { ErrorCode, unloadModel } from "./ollama.js";
import { busyCount } from "./slots.js";

// Флаг в storage.session: popup по нему не прогревает модель, которую только что выгрузили.
// Снимается, когда к модели снова пошёл запрос.
const STOPPED_KEY = "modelStopped";
// Модели, которые загружало расширение: "usedModel:<url>|<model>" → { url, model }. Ключ на
// модель, а не общий список: записи из service worker и popup друг друга не затрут.
const USED_PREFIX = "usedModel:";

const listeners = new Set();
const queues = new Set();
// последнее записанное значение флага; null — неизвестно (контекст только запущен)
let stopped = null;
// модели, уже записанные в storage из этого контекста
const recorded = new Set();

// fn() обрывает запросы модуля синхронно; может вернуть промис, если ему нужно доделать
// что-то ещё (например, разослать вкладкам паузу).
export function onStop(fn) {
  listeners.add(fn);
}

// Модуль сообщает, сколько его текстов ждёт модели: fn() → число.
export function registerQueue(fn) {
  queues.add(fn);
}

// Для popup: работает ли модель. busy — занятые слоты (запросы к модели идут), queued — тексты,
// которые ждут в очередях модулей.
export function activity() {
  let queued = 0;
  for (const fn of queues) queued += fn();
  return { busy: busyCount(), queued };
}

// Бросает, если какую-то модель выгрузить не удалось. Запросы к этому моменту уже оборваны.
export async function stopAll() {
  const tasks = [...listeners].map((fn) => fn());
  stopped = true;
  tasks.push(chrome.storage.session.set({ [STOPPED_KEY]: true }));
  try {
    await unloadUsed();
  } finally {
    await Promise.allSettled(tasks);
  }
}

// Выгружает все модели, которые загружало расширение: модель в настройках могли сменить, пока
// работала прежняя. Текущую — тоже: её могли загрузить до перезапуска браузера, а storage.session
// он очищает.
async function unloadUsed() {
  const [{ ollamaUrl, model }, stored] = await Promise.all([
    getSettings(),
    chrome.storage.session.get(null),
  ]);
  const used = new Map(); // ключ → { url, model }
  if (model) used.set(usedKey(ollamaUrl, model), { url: ollamaUrl, model });
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(USED_PREFIX)) used.set(key, value);
  }
  // Забываем до выгрузки: модель, которую снова запустят, пока идёт выгрузка, запишется заново.
  recorded.clear();
  const forgotten = chrome.storage.session.remove([...used.keys()]).catch(() => {});
  const list = [...used];
  const results = await Promise.allSettled(list.map(([, m]) => unloadModel(m.url, m.model)));
  await forgotten;
  // невыгруженные вернём — их выгрузит следующий «Стоп»; удалённую из Ollama выгружать незачем
  const failed = list.filter((_, i) => {
    const r = results[i];
    return r.status === "rejected" && r.reason?.code !== ErrorCode.MODEL_NOT_FOUND;
  });
  if (!failed.length) return;
  await chrome.storage.session.set(Object.fromEntries(failed)).catch(() => {});
  throw results[list.indexOf(failed[0])].reason;
}

function usedKey(url, model) {
  return `${USED_PREFIX}${url}|${model}`;
}

// Вызывать перед запросом к модели: снимает флаг «Стоп» и запоминает модель, чтобы «Стоп»
// выгрузил её, даже если в настройках к тому времени выберут другую. В storage пишет, только
// если флаг стоял или модель ещё не записана.
export function markModelUsed(url, model) {
  const key = usedKey(url, model);
  if (model && !recorded.has(key)) {
    recorded.add(key);
    chrome.storage.session.set({ [key]: { url, model } }).catch(() => recorded.delete(key));
  }
  if (stopped === false) return;
  stopped = false;
  chrome.storage.session.remove(STOPPED_KEY).catch(() => {});
}

export async function isStopped() {
  const data = await chrome.storage.session.get(STOPPED_KEY);
  return Boolean(data[STOPPED_KEY]);
}

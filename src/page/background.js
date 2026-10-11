// Перевод страницы, часть service worker: порт "translate", общая для всех вкладок очередь
// батчей, включение перевода на вкладке из popup, хоткея и контекстного меню.

import { getSettings } from "../lib/settings.js";
import { ErrorCode, abortedError } from "../lib/ollama.js";
import { createContext, toOllamaError, translateTexts } from "../lib/translate.js";
import { takeBatch } from "../lib/batcher.js";
import { getPageState } from "../lib/tabs.js";
import { onSlotFree, onWait, release, tryAcquire, waiting } from "../lib/slots.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { ensureMenu } from "../lib/menus.js";
import { markModelUsed, onStop, registerQueue } from "../lib/stop.js";
import "../lib/tags.js"; // обычный скрипт, см. в нём

const { hasTags } = globalThis.__ollamaTranslator.tags;

const CONTENT_SCRIPTS = [
  "src/shared/keepalive-port.js",
  "src/lib/tags.js",
  "src/lib/split.js",
  "src/page/render.js",
  "src/page/segment.js", // берёт sourceOf и hasText у render
  "src/page/content.js",
];
const CONTENT_CSS = ["src/page/content.css"];

// После этих ошибок остальная очередь вкладки обречена — сбрасываем её сразу.
const FATAL_CODES = new Set([
  ErrorCode.OLLAMA_DOWN,
  ErrorCode.FORBIDDEN_ORIGIN,
  ErrorCode.MODEL_NOT_FOUND,
]);

let settingsPromise = getSettings();
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") settingsPromise = getSettings();
});

// ---------- Клиенты (вкладки) и планировщик ----------

const clients = new Set();

// порт закрыт — сообщение пропадёт, onDisconnect приберёт клиента
function post(client, message) {
  if (!client.closed) safePost(client.port, message);
}

function failItems(client, items, err) {
  if (!items.length) return;
  post(client, { type: "error", ids: items.map((i) => i.id), code: err.code, message: err.message });
}

// Вкладка, куда пользователь заходил последней, обслуживается первой.
function nextClient() {
  let best = null;
  for (const c of clients) {
    if (c.queue.length && (!best || c.lastActivity > best.lastActivity)) best = c;
  }
  return best;
}

async function pump() {
  const settings = await settingsPromise;
  for (;;) {
    const client = nextClient();
    if (!client || !tryAcquire(settings.concurrency)) break;
    const batch = takeBatch(client.queue, {
      maxItems: settings.batchMaxItems,
      maxChars: settings.batchMaxChars,
      // уже уступавшие тексты — отдельным батчем: второй раз он не уступит. Тексты с тегами —
      // тоже: у них в промпте правило про теги, а без тегов запрос остаётся прежним
      group: (item) => `${Boolean(item.preempted)} ${hasTags(item.text)}`,
    });
    for (const item of batch) client.inFlight.set(item.id, item);
    runBatch(client, batch, settings);
  }
}
onSlotFree(pump); // слот освободил и перевод выделенного

// Идущие батчи в порядке запуска: controller → { generation, items, yielding, yielded,
// requestStartedAt }. yielding — батч попросили уступить слот, но он ещё может продолжить;
// yielded — уступил на деле (прерван или не стал делать следующий запрос).
const running = new Map();

// Запрос моложе этого при вытеснении прерываем (через ABORT_GRACE_MS) — потеряно немного. Более старый
// доводим до конца, иначе его ответ пропал бы целиком, а батч уступает слот перед следующим
// запросом к модели.
const ABORT_YOUNGER_MS = 10_000;
// Прерываем не сразу: за это время слот может освободить батч, который и так заканчивает, —
// тогда ничего не теряем.
const ABORT_GRACE_MS = 1500;

// Перевод выделенного ждёт слот: вытесняем самые свежие батчи (в них меньше всего сделано),
// пока уступающих не станет needed. Уже переведённое из батча отдаётся вкладке, остальное
// возвращается в начало очереди и переведётся после выделенного. Каждый текст уступает не
// больше одного раза — иначе частые переводы выделенного не дали бы странице продвинуться.
onWait((needed) => {
  const batches = [...running];
  let freeing = batches.filter(([c, b]) => b.yielding || c.signal.aborted).length;
  for (const [controller, batch] of batches.reverse()) {
    if (freeing >= needed) break;
    if (batch.yielding || controller.signal.aborted || batch.items[0].preempted) continue;
    batch.yielding = true;
    freeing++;
    if (Date.now() - batch.requestStartedAt < ABORT_YOUNGER_MS) {
      setTimeout(() => {
        if (!batch.yielding || !waiting()) return;
        batch.yielded = true;
        controller.abort();
      }, ABORT_GRACE_MS);
    }
  }
});

// Отдаёт вкладке готовое из батча (results[i] может не быть — батч прерван).
function deliver(client, items, results) {
  const done = items.map((item, i) => ({ item, r: results[i] })).filter(({ r }) => r);
  const ok = done.filter(({ r }) => "text" in r);
  if (ok.length) {
    post(client, {
      type: "result",
      ids: ok.map(({ item }) => item.id),
      translations: ok.map(({ r }) => r.text),
    });
  }
  for (const { item, r } of done) {
    if (r.error) post(client, { type: "error", ids: [item.id], ...r.error });
  }
}

// Слот занят в pump, освобождается здесь.
async function runBatch(client, items, settings) {
  const controller = new AbortController();
  const batch = {
    generation: client.generation,
    items,
    yielding: false,
    yielded: false,
    requestStartedAt: Date.now(),
  };
  const results = new Array(items.length);
  client.controllers.add(controller);
  running.set(controller, batch);
  markModelUsed(settings.ollamaUrl, settings.model);
  try {
    let err = null;
    try {
      const ctx = await createContext(settings, controller.signal);
      ctx.beforeRequest = () => {
        if (batch.yielding) {
          // вытеснен, пока шёл прошлый запрос; если ждавший уже получил слот или ушёл — работаем дальше
          if (waiting()) {
            batch.yielded = true;
            throw abortedError();
          }
          batch.yielding = false;
        }
        batch.requestStartedAt = Date.now();
      };
      await translateTexts(
        items.map((i) => i.text),
        ctx,
        results,
      );
    } catch (e) {
      err = toOllamaError(e);
    }
    // вкладку за это время могли закрыть или отменить на ней перевод
    const current = !client.closed && batch.generation === client.generation;
    // Готовое отдаём и после отмены: при «Стоп» вкладка только на паузе и ждёт эти id, а
    // выключенная запомнит переводы (memo в content.js). Иначе их переводили бы заново.
    deliver(client, items, results);
    const rest = items.filter((_, i) => !results[i]);
    if (err?.code === ErrorCode.ABORTED && (batch.yielded || !current)) {
      // уступили слот выделенному — недоделанное в начало очереди, кроме исчезнувшего со
      // страницы за время перевода; перевод отменён — ничего
      if (current) {
        const requeue = rest.filter((item) => item.wanted);
        for (const item of requeue) item.preempted = true;
        client.queue.unshift(...requeue);
      }
    } else if (err) {
      // сюда же — отмена по другой причине: иначе тексты молча пропали бы, а вкладка ждала бы их вечно
      console.error("[ot] батч не переведён:", err);
      // отменённое поколение не трогает очередь и тексты, запрошенные после отмены
      if (current) {
        failItems(client, rest, err);
        if (FATAL_CODES.has(err.code)) failItems(client, client.queue.splice(0), err);
      }
    }
  } finally {
    settle(client, items); // в finally: иначе после исключения текст ждали бы вечно (undrop)
    client.controllers.delete(controller);
    running.delete(controller);
    release(); // → pump через onSlotFree
  }
}

// client.inFlight: id → элемент, который переводится. item.wanted: false — вкладка текст
// отменила, в очередь он не вернётся.
// settle — батч закончился: тексты теперь в очереди, у вкладки или отброшены.
function settle(client, items) {
  for (const item of items) {
    // после отмены (cancelClient) вкладка могла запросить тот же id заново — под ним уже
    // элемент нового батча
    if (client.inFlight.get(item.id) === item) client.inFlight.delete(item.id);
  }
}

function cancelClient(client) {
  client.generation++;
  client.queue.length = 0;
  // начатые до отмены батчи отдадут вкладке только то, что успели, — новые запросы их не ждут
  client.inFlight = new Map();
  for (const c of client.controllers) c.abort();
}

// items — { id, text } из сообщения вкладки, дальше эти же объекты идут в очередь и в батч.
function enqueue(client, items) {
  for (const item of items) item.wanted = true;
  // свежие (только что ставшие видимыми) блоки — в начало очереди
  client.queue.unshift(...items);
  pump();
}

// Текст снова нужен — более ранняя отмена к нему уже не относится. → true, если он ещё
// переводится: тогда хватит снять отмену, второй раз его не запрашиваем.
// Отменённое поколение не в счёт (cancelClient начинает inFlight заново): оборванный батч отдаст
// вкладке только то, что успел. После «Стоп» и «Продолжить» вкладка запрашивает те же id, а он
// мог ещё не завершиться.
function undrop(client, { id }) {
  const item = client.inFlight.get(id);
  if (!item) return false;
  item.wanted = true;
  return true;
}

function dropQueued(client, ids) {
  const drop = new Set(ids);
  const kept = client.queue.filter((item) => !drop.has(item.id));
  client.queue.splice(0, client.queue.length, ...kept);
  // идущий батч доработает, но при вытеснении в очередь этого не вернёт
  for (const id of ids) {
    const item = client.inFlight.get(id);
    if (item) item.wanted = false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  const client = {
    port,
    queue: [], // { id, text, wanted, preempted? }
    inFlight: new Map(), // id → { id, text, wanted, … }, см. settle
    controllers: new Set(),
    lastActivity: Date.now(),
    generation: 0,
    paused: false, // «Стоп»: переводов не запускаем, пока вкладка не пришлёт resume
    closed: false,
  };
  clients.add(client);

  port.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "translate": {
        client.lastActivity = Date.now();
        if (client.paused) {
          // вкладка отправила это раньше, чем узнала о «Стоп», — напоминаем ей о паузе
          post(client, { type: "pause" });
          break;
        }
        const fresh = msg.items.filter((item) => !undrop(client, item));
        if (fresh.length) enqueue(client, fresh);
        break;
      }
      case "cancel":
        // с ids — блоки, исчезнувшие со страницы; без ids — отмена всего
        if (Array.isArray(msg.ids)) dropQueued(client, msg.ids);
        else cancelClient(client);
        break;
      case "resume":
        client.paused = false;
        break;
      case "ping":
        break; // само сообщение не даёт service worker'у уснуть
    }
  });

  onPortClosed(port, () => {
    client.closed = true;
    cancelClient(client);
    clients.delete(client);
  });
});

// ---------- «Стоп» ----------

// Оборванные батчи отдадут вкладкам только то, что успели перевести. Рассылаем паузу и
// вкладкам без порта: после перезапуска service worker'а
// порта может не быть, а при прокрутке такая вкладка снова запустила бы модель.
onStop(async () => {
  for (const client of clients) {
    client.paused = true;
    cancelClient(client);
  }
  for (const tab of await chrome.tabs.query({})) {
    // нет content script'а или туда нельзя (chrome://) — пауза там и не нужна
    if (tab.id > 0) chrome.tabs.sendMessage(tab.id, { type: "pause" }).catch(() => {});
  }
});

// Для «Стоп» в popup: тексты, которые ждут модели в очередях вкладок.
registerQueue(() => {
  let queued = 0;
  for (const client of clients) queued += client.queue.length;
  return queued;
});

// ---------- Включение перевода на вкладке: popup, хоткей, контекстное меню ----------

// Читаем storage напрямую: при изменении настроек content просит конфиг сразу же,
// settingsPromise к этому моменту может быть ещё старым.
async function pageConfig() {
  const s = await getSettings();
  return { lang: s.targetLang };
}

// Переключения одной вкладки идут по очереди: иначе хоткей + кнопка в popup оба увидят
// «не внедрён» и внедрят скрипты дважды.
const toggling = new Map(); // tabId → промис последнего переключения

// → состояние страницы после переключения { active, paused, done, requested, total, errors }
function toggleTab(tabId) {
  const next = (toggling.get(tabId) ?? Promise.resolve()).catch(() => {}).then(() => doToggleTab(tabId));
  toggling.set(tabId, next);
  const cleanup = () => {
    if (toggling.get(tabId) === next) toggling.delete(tabId);
  };
  next.then(cleanup, cleanup);
  return next;
}

async function doToggleTab(tabId) {
  const target = { tabId };
  let state = await getPageState(tabId);
  if (!state) await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
  if (!state?.active) await chrome.scripting.insertCSS({ target, files: CONTENT_CSS });
  state = await chrome.tabs.sendMessage(tabId, { type: "toggle", config: await pageConfig() });
  if (!state.active) await chrome.scripting.removeCSS({ target, files: CONTENT_CSS });
  return state;
}

function toggleFromBrowser(tab) {
  if (!tab?.id) return;
  toggleTab(tab.id).catch((err) => console.warn("[ot] не удалось перевести страницу:", err.message));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "getPageConfig") {
    pageConfig().then(sendResponse, () => sendResponse(null));
    return true;
  }
  // переключать вкладки — только страницам расширения (popup), не content scripts
  if (msg?.type !== "toggleTab" || sender.tab) return;
  toggleTab(msg.tabId).then(
    (state) => sendResponse({ state }),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translation") toggleFromBrowser(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu({
    id: "toggle-translation",
    title: "Перевести страницу / показать оригинал",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "toggle-translation") toggleFromBrowser(tab);
});

// Краткое содержание страницы, часть service worker: кнопка в popup (сообщение summarizeTab),
// пункт контекстного меню на странице, внедрение панели (panel.js) и порт "summary", по которому
// она просит краткое содержание. От перевода страницы, выделенного и озвучки не зависит.
//
// Один порт — один запрос. Панель → сюда: summarize { text, title, length }; ping.
// Отсюда → панели: source { used, total } — сколько символов текста ушло модели;
// progress { step: "part", part, parts } | { step: "merge" } | { step: "final" } — длинный текст:
// заметки по частям, сведение заметок, итог; partial { text } — ответ по мере генерации;
// result { text, cut } — готово, cut — ответ упёрся в num_ctx; error { code, message };
// stopped — «Стоп».
// Панель закрыли или сменили длину — порт отключился — запрос к Ollama отменён.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { getSettings } from "../lib/settings.js";
import { chatWithRetry, toOllamaError } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { ensureMenu } from "../lib/menus.js";
import { onStop, registerQueue } from "../lib/stop.js";
import {
  SUMMARY_LENGTHS,
  buildMergeRequest,
  buildNotesRequest,
  buildSummaryRequest,
} from "./lib/prompt.js";
import { cutText, inputChars, splitText } from "./lib/chunks.js";

const PORT_NAME = "summary";
const PAGE_MENU_ID = "summarize-page";
const PANEL_SCRIPTS = [
  "src/shared/keepalive-port.js",
  "src/shared/shadow-host.js",
  "src/shared/clipboard.js",
  "src/summary/lib/format.js",
  "src/summary/extract.js",
  "src/summary/panel.js",
];
// partial — не на каждый токен, а не чаще раза в столько
const PARTIAL_MS = 150;
// Дальше текст не читаем: при num_ctx 8192 это уже 9 частей, минуты на медленном железе.
const MAX_CHARS = 150_000;
// Заметки по частям — для стольких последних текстов (см. notesEntry).
const NOTES_CACHE_SIZE = 3;

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu({
    id: PAGE_MENU_ID,
    title: "Краткое содержание страницы",
    contexts: ["page"],
  });
});

// Панель — в главном фрейме. panel.js внедряем, только если его там ещё нет или остался
// осиротевший экземпляр после перезагрузки расширения.
async function openPanel(tabId) {
  const target = { tabId };
  const tryOpen = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: () => {
        const panel = window.__ollamaTranslator?.summary;
        if (!panel?.alive?.()) return false;
        panel.open();
        return true;
      },
    });
    return injection?.result === true;
  };
  if (await tryOpen()) return;
  await chrome.scripting.executeScript({ target, files: PANEL_SCRIPTS });
  if (!(await tryOpen())) throw new Error("панель не запустилась");
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== PAGE_MENU_ID || !tab?.id) return;
  // chrome://, Chrome Web Store, встроенный просмотрщик PDF — туда скрипты не внедрить
  openPanel(tab.id).catch((err) => console.warn("[ot] не удалось показать краткое содержание:", err.message));
});

// открывать панель — только страницам расширения (popup), не content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "summarizeTab" || sender.tab) return;
  openPanel(msg.tabId).then(
    () => sendResponse({}),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});

// partial не чаще раза в PARTIAL_MS. push(content) — накопленный ответ, cancel() — больше не слать.
function partialSender(port) {
  let timer = 0;
  let latest = "";
  return {
    push(content) {
      latest = content;
      timer ||= setTimeout(() => {
        timer = 0;
        safePost(port, { type: "partial", text: latest });
      }, PARTIAL_MS);
    },
    cancel() {
      clearTimeout(timer);
      timer = 0;
    },
  };
}

// ---------- Запросы к модели ----------

// job — запрос одной панели: { port, controller, queued }; queued — сколько запросов к модели
// у него ещё впереди, для «■ Стоп» в popup.

// Каждый запрос — со своим слотом (общий с переводом лимит, перед очередью перевода страниц):
// между частями длинного текста успевает перевод выделенного. → { content, doneReason }
function ask(job, build, opts) {
  return withPrioritySlot({ signal: job.controller.signal }, (ctx) =>
    chatWithRetry(build(ctx), ctx, opts),
  );
}

// Заметки по частям: key → { parts, notes, merged }. notes[i] — заметки по parts[i], как только
// готовы: оборванный запрос (смена длины, «Стоп») продолжится с той же части, а другая длина
// возьмёт merged — заметки одни на обе длины. Map в порядке использования, старые вытесняются.
const notesCache = new Map();

function notesEntry(key, text, budget) {
  let entry = notesCache.get(key);
  if (entry) notesCache.delete(key);
  else entry = { parts: splitText(text, budget), notes: [], merged: null };
  notesCache.set(key, entry);
  while (notesCache.size > NOTES_CACHE_SIZE) notesCache.delete(notesCache.keys().next().value);
  return entry;
}

// Заметки по частям не влезают в один запрос — сводим их группами, пока не влезут. Если модель
// не сократила, берём начало: лучше итог без конца, чем бесконечный цикл.
async function mergeNotes(job, text, { title, lang, budget }) {
  while (text.length > budget) {
    safePost(job.port, { type: "progress", step: "merge" });
    const merged = [];
    for (const group of splitText(text, budget)) {
      const { content } = await ask(job, (ctx) => buildMergeRequest({ text: group, title, lang }, ctx));
      merged.push(content.trim());
    }
    const next = merged.join("\n\n");
    if (next.length >= text.length) return cutText(next, budget);
    text = next;
  }
  return text;
}

// Длинный текст → заметки по частям, сведённые так, чтобы влезли в один запрос.
async function notesOf(job, text, { title, lang, budget }) {
  const entry = notesEntry(`${lang}|${budget}|${text}`, text, budget);
  if (entry.merged !== null) return entry.merged;
  const { parts, notes } = entry;
  const todo = parts.map((_, i) => i).filter((i) => notes[i] === undefined);
  for (const [k, i] of todo.entries()) {
    job.queued = todo.length - k; // оставшиеся части и итог
    safePost(job.port, { type: "progress", step: "part", part: i + 1, parts: parts.length });
    const { content } = await ask(job, (ctx) =>
      buildNotesRequest({ text: parts[i], title, part: i + 1, parts: parts.length, lang }, ctx),
    );
    notes[i] = content.trim(); // пусто — в части не нашлось важного, это не ошибка
  }
  const all = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join("\n\n");
  entry.merged = await mergeNotes(job, all, { title, lang, budget });
  return entry.merged;
}

// → { text, cut }
async function summarize(job, { text, title, length }) {
  const { numCtx, targetLang: lang } = await getSettings();
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length });
  const fromNotes = used.length > budget;
  const source = fromNotes ? await notesOf(job, used, { title, lang, budget }) : used;
  job.queued = 0;
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  const partial = partialSender(job.port);
  try {
    const { content, doneReason } = await ask(
      job,
      (ctx) => buildSummaryRequest({ text: source, title, length, lang, fromNotes }, ctx),
      { onContent: partial.push },
    );
    if (!content.trim()) throw new OllamaError(ErrorCode.BAD_RESPONSE, "модель вернула пустой ответ");
    return { text: content.trim(), cut: doneReason === "length" };
  } finally {
    partial.cancel();
  }
}

// ---------- Порты панелей ----------

const jobs = new Map(); // port → job

// «Стоп»: панель покажет «Остановлено» и «Повторить»; ошибку ABORTED она не получит. Готовые
// заметки остаются в кэше — повтор продолжит с прерванной части.
onStop(() => {
  for (const job of jobs.values()) {
    safePost(job.port, { type: "stopped" });
    job.controller.abort();
  }
});

// Для «Стоп» в popup: между частями длинного текста слоты на миг свободны.
registerQueue(() => {
  let queued = 0;
  for (const job of jobs.values()) queued += job.queued;
  return queued;
});

// Пока порт открыт, панель шлёт ping, чтобы service worker не уснул на долгом ответе.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const job = { port, controller: new AbortController(), queued: 0 };
  jobs.set(port, job);
  onPortClosed(port, () => {
    jobs.delete(port);
    job.controller.abort();
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "summarize" || typeof msg.text !== "string") return;
    const request = {
      text: msg.text,
      title: typeof msg.title === "string" ? msg.title : "",
      length: SUMMARY_LENGTHS.includes(msg.length) ? msg.length : SUMMARY_LENGTHS[0],
    };
    summarize(job, request)
      .then(
        (result) => safePost(port, { type: "result", ...result }),
        (e) => {
          const err = toOllamaError(e);
          if (err.code !== ErrorCode.ABORTED) {
            safePost(port, { type: "error", code: err.code, message: err.message });
          }
        },
      )
      .finally(() => {
        job.queued = 0;
      });
  });
});

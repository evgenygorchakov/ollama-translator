// Краткое содержание страницы и выделенного, часть service worker: кнопка в popup (сообщение
// summarizeTab), пункты контекстного меню на странице и на выделенном, внедрение панели
// (panel.js) и порт "summary", по которому она просит краткое содержание. От перевода страницы,
// выделенного и озвучки не зависит.
//
// Один порт — один запрос. Панель → сюда: summarize { text, title, length }; ping.
// Отсюда → панели: source { used, total } — сколько символов текста ушло модели;
// progress { step: "part", part, parts } | { step: "merge" } | { step: "final" } — длинный текст:
// заметки по частям, сведение заметок, итог; partial { text } — ответ по мере генерации;
// result { text, cut } — готово, cut — ответ упёрся в num_ctx; error { code, message };
// stopped — «Стоп».
// Панель закрыли или сменили длину — порт отключился — запрос к Ollama отменён.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { stripThinking } from "../lib/parse.js";
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
const SELECTION_MENU_ID = "summarize-selection";
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
  ensureMenu({
    id: SELECTION_MENU_ID,
    title: "Кратко о выделенном",
    contexts: ["selection"],
  });
});

// Панель — в главном фрейме, даже если выделение во вложенном. panel.js внедряем, только если
// его там ещё нет или остался осиротевший экземпляр после перезагрузки расширения.
// source — { kind: "page" } | { kind: "selection", text }, см. open в panel.js.
async function openPanel(tabId, source = { kind: "page" }) {
  const target = { tabId };
  const tryOpen = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: (src) => {
        const panel = window.__ollamaTranslator?.summary;
        if (!panel?.alive?.()) return false;
        panel.open(src);
        return true;
      },
      args: [source],
    });
    return injection?.result === true;
  };
  if (await tryOpen()) return;
  await chrome.scripting.executeScript({ target, files: PANEL_SCRIPTS });
  if (!(await tryOpen())) throw new Error("панель не запустилась");
}

// Выделенное со страницы, во фрейме выделения: в тексте из меню Chrome теряет переносы строк.
// Выделение в input/textarea Selection API не видит — тогда берём выделенное в поле с фокусом.
// Во фрейм с другого сайта activeTab доступа не даёт — тогда текст из меню.
async function selectedText(tabId, frameId, menuText) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        const text = window.getSelection()?.toString() ?? "";
        if (text.trim()) return text;
        const field = document.activeElement;
        if (field?.matches("textarea, input") && field.selectionEnd > field.selectionStart) {
          return field.value.slice(field.selectionStart, field.selectionEnd);
        }
        return "";
      },
    });
    if (injection?.result?.trim()) return injection.result;
  } catch {
    // фрейм недоступен — ниже текст из меню
  }
  return menuText;
}

async function openFromMenu(info, tab) {
  if (info.menuItemId === PAGE_MENU_ID) {
    await openPanel(tab.id);
  } else {
    const text = await selectedText(tab.id, info.frameId ?? 0, info.selectionText ?? "");
    await openPanel(tab.id, { kind: "selection", text });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (![PAGE_MENU_ID, SELECTION_MENU_ID].includes(info.menuItemId) || !tab?.id) return;
  // chrome://, Chrome Web Store, встроенный просмотрщик PDF — туда скрипты не внедрить
  openFromMenu(info, tab).catch((err) =>
    console.warn("[ot] не удалось показать краткое содержание:", err.message),
  );
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
      if (!content.trim()) return; // модель ещё рассуждает — показывать нечего
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

// Модели с thinking иногда пишут рассуждение и при think: false — его вырезаем, а пока оно не
// закрыто (ответ ещё идёт), не показываем и начатое.
function withoutThinking(content) {
  return stripThinking(content).replace(/<think>[\s\S]*$/i, "");
}

// Каждый запрос — со своим слотом (общий с переводом лимит, перед очередью перевода страниц):
// между частями длинного текста успевает перевод выделенного. onContent — см. chat в
// lib/ollama.js. И ему, и в ответе content — без рассуждения. → { content, doneReason }
function ask(job, build, { onContent } = {}) {
  return withPrioritySlot({ signal: job.controller.signal }, async (ctx) => {
    const res = await chatWithRetry(build(ctx), ctx, {
      onContent: onContent && ((content) => onContent(withoutThinking(content))),
    });
    return { ...res, content: withoutThinking(res.content) };
  });
}

// Заметки по частям: SHA-256 от key (модель, язык, размер части, текст) → { notes, merged }.
// notes[i] — заметки по i-й части splitText, как только готовы (null — ещё нет): оборванный
// запрос (смена длины, «Стоп») продолжится с той же части, а другая длина возьмёт merged —
// заметки одни на обе длины. Копия — в storage.session: service worker засыпает через 30 с
// простоя, а «Подробно» обычно нажимают, прочитав «Коротко». Map в порядке использования,
// старые вытесняются.
const NOTES_KEY = "summaryNotes";
let notesCache = null; // промис Map, из storage.session при первом обращении

function loadNotes() {
  notesCache ??= chrome.storage.session.get(NOTES_KEY).then(
    (data) => new Map(Array.isArray(data[NOTES_KEY]) ? data[NOTES_KEY] : []),
    () => new Map(),
  );
  return notesCache;
}

// Не записалось (не хватило квоты) — заметки остаются в памяти, пока service worker не уснёт.
async function saveNotes() {
  const cache = await loadNotes();
  await chrome.storage.session.set({ [NOTES_KEY]: [...cache] }).catch(() => {});
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// → { entry, parts }
async function notesEntry(key, text, budget) {
  const [cache, hash] = await Promise.all([loadNotes(), sha256(key)]);
  const parts = splitText(text, budget);
  let entry = cache.get(hash);
  cache.delete(hash);
  if (entry?.notes?.length !== parts.length) entry = { notes: parts.map(() => null), merged: null };
  cache.set(hash, entry);
  while (cache.size > NOTES_CACHE_SIZE) cache.delete(cache.keys().next().value);
  saveNotes();
  return { entry, parts };
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
async function notesOf(job, text, { title, lang, budget, model }) {
  const { entry, parts } = await notesEntry(`${model}|${lang}|${budget}|${text}`, text, budget);
  if (entry.merged !== null) return entry.merged;
  const { notes } = entry;
  const todo = parts.map((_, i) => i).filter((i) => notes[i] === null);
  for (const [k, i] of todo.entries()) {
    job.queued = todo.length - k; // оставшиеся части и итог
    safePost(job.port, { type: "progress", step: "part", part: i + 1, parts: parts.length });
    const { content } = await ask(job, (ctx) =>
      buildNotesRequest({ text: parts[i], title, part: i + 1, parts: parts.length, lang }, ctx),
    );
    notes[i] = content.trim(); // пусто — в части не нашлось важного, это не ошибка
    saveNotes();
  }
  job.queued = 1; // сведение заметок и итог
  const all = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join("\n\n");
  entry.merged = await mergeNotes(job, all, { title, lang, budget });
  saveNotes();
  return entry.merged;
}

// → { text, cut }
async function summarize(job, { text, title, length }) {
  const { numCtx, targetLang: lang, model } = await getSettings();
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length });
  const fromNotes = used.length > budget;
  const source = fromNotes ? await notesOf(job, used, { title, lang, budget, model }) : used;
  job.queued = 0;
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  const partial = partialSender(job.port);
  try {
    const { content, doneReason } = await ask(
      job,
      (ctx) => buildSummaryRequest({ text: source, title, length, lang, fromNotes }, ctx),
      { onContent: partial.push },
    );
    const cut = doneReason === "length";
    // пусто и обрезано — модель упёрлась в num_ctx, ещё рассуждая
    if (!content.trim()) {
      const message = cut
        ? "ответ обрезан: не хватило контекста модели (num_ctx в настройках)"
        : "модель вернула пустой ответ";
      throw new OllamaError(ErrorCode.BAD_RESPONSE, message);
    }
    return { text: content.trim(), cut };
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

// Краткое содержание и «В чём суть» страницы, выделенного и видео YouTube, часть service worker:
// кнопки в popup (сообщение summarizeTab), пункты контекстного меню на странице и на выделенном,
// внедрение панели (panel.js) и порт "summary", по которому она просит субтитры видео, краткое
// содержание и суть. На странице видео (www.youtube.com/watch) кнопки и пункты меню страницы
// работают с видео по его субтитрам. От перевода страницы, выделенного и озвучки не зависит.
//
// Один порт — один запрос. Панель → сюда: transcript { videoId } — субтитры видео текстом;
// summarize { text, title, length, kind, fresh } — краткое содержание; essence { text, title,
// kind, fresh } — суть: главная мысль и раскрытие вокруг неё, модель с thinking перед ответом
// рассуждает; fresh: true — заметки по частям этого текста считать заново, не из кэша (после
// «Сбросить» в панели); ask
// { text, title, kind, question, summary, history, mode } — вопрос по тексту, summary — ответ из
// панели или "", mode — его режим: "essence" — суть, иначе краткое содержание; history — прошлые
// вопросы и ответы [{ question, answer }] по порядку; clickbait { text, title, length, summary,
// model } — кликбейт ли название видео, summary — готовое краткое содержание длины length, model —
// модель, которая его написала; ping. kind — "video" (промпты для расшифровки видео) или любое
// другое — промпты для страницы. Все запросы по одному сообщению — к одной модели: у clickbait —
// к model, у остальных — к выбранной в popup, когда оно пришло.
// Отсюда → панели: transcript { title, text, kind, lang } — субтитры: kind — "asr"
// (автоматические) или "manual", lang — их язык; source { used, total, model } — сколько символов
// текста ушло модели и какой;
// progress { step: "part", part, parts } | { step: "merge" } | { step: "final" } — длинный текст:
// заметки по частям, сведение заметок, итог; { step: "think" } — модель начала рассуждать; у
// вопроса — { step: "search", part, parts } | { step: "final" }: поиск по частям, ответ;
// partial { text } — ответ по мере генерации; result { text, cut, thinkMs?, missed?, parts? } —
// готово, cut — ответ упёрся в num_ctx; thinkMs — сколько модель рассуждала, от первого куска
// рассуждения до первого куска ответа, у запросов без рассуждения поля нет; missed — у вопроса
// по длинному тексту: в скольких из parts частей модель упёрлась в предел, ничего не выписав; у
// clickbait — result { clickbait, reason }; error { code, message }, у субтитров code — из
// pageCaptions (lib/youtube-captions.js); stopped — «Стоп».
// Панель закрыли или сменили режим — порт отключился — запрос к Ollama отменён.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { stripThinking } from "../lib/parse.js";
import { getSettings } from "../lib/settings.js";
import { chatWithRetry, toOllamaError } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { ensureMenu } from "../lib/menus.js";
import { onStop, registerQueue } from "../lib/stop.js";
import { pageCaptions, parseJson3 } from "../lib/youtube-captions.js";
import {
  SUMMARY_LENGTHS,
  buildAnswerRequest,
  buildClickbaitRequest,
  buildEssenceRequest,
  buildMergeRequest,
  buildNotesRequest,
  buildSearchRequest,
  buildSummaryRequest,
  clickbaitOf,
  essenceQuestion,
  excerptOf,
  summaryQuestion,
} from "./lib/prompt.js";
import { transcriptText } from "./lib/transcript.js";
import {
  ESSENCE_NUM_CTX,
  cutText,
  essenceInputChars,
  excerptTokens,
  fitExcerpts,
  fitTurns,
  historyChars,
  inputChars,
  splitText,
} from "./lib/chunks.js";

const PORT_NAME = "summary";
// Пункты контекстного меню: selection — о выделенном, иначе о странице (на странице видео — о
// видео); mode — режим панели, "" — последняя длина краткого содержания (см. open в panel.js).
const MENUS = {
  "summarize-page": { title: "Summarize page", selection: false, mode: "" },
  "summarize-selection": { title: "Summarize selection", selection: true, mode: "" },
  "essence-page": { title: "Main point of the page", selection: false, mode: "essence" },
  "essence-selection": { title: "Main point of the selection", selection: true, mode: "essence" },
};
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
// Заметки по частям — для стольких последних текстов (см. notesEntry): у краткого содержания и
// сути заметки разные, на каждый текст до двух записей.
const NOTES_CACHE_SIZE = 6;

// Ошибки pageCaptions — для «Не получилось: …». NO_CAPTIONS и LIVE панель пишет по-своему.
const CAPTION_ERRORS = {
  NO_PLAYER: "YouTube player not found",
  NOT_READY: "the player hasn't loaded the video yet, wait a couple of seconds",
  LIVE: "live streams aren't supported",
  NO_CAPTIONS: "the video has no captions",
  NO_TOKEN: "YouTube didn't return captions: the player didn't request them with a token",
  EMPTY: "YouTube didn't return captions: empty response even with a token",
  FAILED: "captions failed to load",
};

chrome.runtime.onInstalled.addListener(() => {
  for (const [id, { title, selection }] of Object.entries(MENUS)) {
    ensureMenu({ id, title, contexts: [selection ? "selection" : "page"] });
  }
});

// Что сокращать на вкладке с адресом url: на странице видео YouTube — видео, иначе страницу.
// Адрес вкладки виден по activeTab. → source для openPanel
function pageSource(url) {
  try {
    const { hostname, pathname, searchParams } = new URL(url);
    const videoId = searchParams.get("v");
    if (hostname === "www.youtube.com" && pathname === "/watch" && videoId) {
      return { kind: "video", videoId };
    }
  } catch {
    // адреса нет или он не разбирается — страница
  }
  return { kind: "page" };
}

// Панель — в главном фрейме, даже если выделение во вложенном. panel.js внедряем, только если
// его там ещё нет или остался осиротевший экземпляр после перезагрузки расширения.
// source — { kind: "page" } | { kind: "selection", text } | { kind: "video", videoId }; mode —
// режим панели: "essence" — суть, "" — последняя длина краткого содержания. См. open в panel.js.
async function openPanel(tabId, source = { kind: "page" }, mode = "") {
  const target = { tabId };
  const tryOpen = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: (src, panelMode) => {
        const panel = window.__ollamaTranslator?.summary;
        if (!panel?.alive?.()) return false;
        panel.open(src, panelMode);
        return true;
      },
      args: [source, mode],
    });
    return injection?.result === true;
  };
  if (await tryOpen()) return;
  await chrome.scripting.executeScript({ target, files: PANEL_SCRIPTS });
  if (!(await tryOpen())) throw new Error("the panel didn't start");
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

async function openFromMenu(menu, info, tab) {
  if (!menu.selection) {
    await openPanel(tab.id, pageSource(tab.url), menu.mode);
  } else {
    const text = await selectedText(tab.id, info.frameId ?? 0, info.selectionText ?? "");
    await openPanel(tab.id, { kind: "selection", text }, menu.mode);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const menu = Object.hasOwn(MENUS, info.menuItemId) ? MENUS[info.menuItemId] : null;
  if (!menu || !tab?.id) return;
  // chrome://, Chrome Web Store, встроенный просмотрщик PDF — туда скрипты не внедрить
  openFromMenu(menu, info, tab).catch((err) =>
    console.warn("[ot] не удалось показать панель краткого содержания:", err.message),
  );
});

// открывать панель — только страницам расширения (popup), не content scripts. mode — как у
// openPanel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "summarizeTab" || sender.tab) return;
  const mode = msg.mode === "essence" ? "essence" : "";
  chrome.tabs
    .get(msg.tabId)
    .then((tab) => openPanel(tab.id, pageSource(tab.url), mode))
    .then(
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

// ---------- Субтитры видео ----------

// Субтитры видео в главном фрейме вкладки → { type: "transcript", title, text, kind, lang } или
// { type: "error", code, message }. Время у слов есть, но модели текст идёт без меток.
async function transcript(tabId, videoId) {
  let r;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: pageCaptions,
      args: [videoId, null],
    });
    r = injection?.result ?? { error: "FAILED", detail: "the page script didn't respond" };
  } catch (err) {
    r = { error: "FAILED", detail: err.message };
  }
  if (r.error) {
    const known = CAPTION_ERRORS[r.error] ?? CAPTION_ERRORS.FAILED;
    const message = r.detail ? `${known} (${r.detail})` : known;
    return { type: "error", code: r.error, message };
  }
  const text = transcriptText(parseJson3(r.json));
  console.debug(
    `[ot] краткое содержание ${videoId}: ${text.length} символов субтитров (${r.kind}, ${r.lang})`,
  );
  return { type: "transcript", title: r.title, text, kind: r.kind, lang: r.lang };
}

// ---------- Запросы к модели ----------

// job — запрос панели, краткое содержание или вопрос: { port, controller, queued }; queued —
// сколько запросов к модели у него ещё впереди, для «■ Стоп» в popup.

// Модели с thinking иногда пишут рассуждение и при think: false — его вырезаем, а пока оно не
// закрыто (ответ ещё идёт), не показываем и начатое.
function withoutThinking(content) {
  return stripThinking(content).replace(/<think>[\s\S]*$/i, "");
}

// Каждый запрос — со своим слотом (общий с переводом лимит, перед очередью перевода страниц):
// между частями длинного текста успевает перевод выделенного. numCtx — num_ctx, под который
// посчитан бюджет текста, model — модель, которой пишутся заметки и ответ (её видно в панели):
// запрос идёт с ними, а не с тем, что в настройках сейчас (у «Сути» num_ctx свой,
// ESSENCE_NUM_CTX). onContent, onThinking — см. chat в lib/ollama.js. И onContent, и в ответе
// content — без рассуждения. → { content, thinking, doneReason }
function ask(job, build, { numCtx, model, onContent, onThinking } = {}) {
  return withPrioritySlot({ signal: job.controller.signal, model }, async (ctx) => {
    const res = await chatWithRetry(build(numCtx ? { ...ctx, numCtx } : ctx), ctx, {
      onContent: onContent && ((content) => onContent(withoutThinking(content))),
      onThinking,
    });
    return { ...res, content: withoutThinking(res.content) };
  });
}

// Заметки по частям: SHA-256 от key (модель, язык, kind, режим, размер части, текст) →
// { notes, merged }. notes[i] — заметки по i-й части splitText, как только готовы (null — ещё
// нет): оборванный запрос (смена режима, «Стоп») продолжится с той же части, а другая длина
// возьмёт merged — заметки одни на обе длины краткого содержания, у «Сути» свои. Копия — в
// storage.session: service worker засыпает через 30 с простоя, а «Подробно» обычно нажимают,
// прочитав «Коротко». Map в порядке использования, старые вытесняются.
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

// fresh — начать с пустых заметок и заменить ими запись в кэше; запрос, оборванный сбросом,
// если и допишет заметку, то в прежнюю запись, которой в кэше уже нет. → { entry, parts }
async function notesEntry(key, text, budget, fresh) {
  const [cache, hash] = await Promise.all([loadNotes(), sha256(key)]);
  const parts = splitText(text, budget);
  let entry = cache.get(hash);
  cache.delete(hash);
  if (fresh || entry?.notes?.length !== parts.length) {
    entry = { notes: parts.map(() => null), merged: null };
  }
  cache.set(hash, entry);
  while (cache.size > NOTES_CACHE_SIZE) cache.delete(cache.keys().next().value);
  saveNotes();
  return { entry, parts };
}

// Заметки по частям не влезают в один запрос — сводим их группами, пока не влезут. Если модель
// не сократила, берём начало: лучше итог без конца, чем бесконечный цикл.
async function mergeNotes(job, text, { title, lang, kind, mode, budget, numCtx, model }) {
  while (text.length > budget) {
    safePost(job.port, { type: "progress", step: "merge" });
    const merged = [];
    for (const group of splitText(text, budget)) {
      const { content } = await ask(
        job,
        (ctx) => buildMergeRequest({ text: group, title, lang, kind, mode }, ctx),
        { numCtx, model },
      );
      merged.push(content.trim());
    }
    const next = merged.join("\n\n");
    if (next.length >= text.length) return cutText(next, budget);
    text = next;
  }
  return text;
}

// Длинный текст → заметки по частям, сведённые так, чтобы влезли в один запрос. mode —
// "summary" (для краткого содержания) или "essence" (для сути): заметки у них разные. fresh —
// не брать заметки из кэша, см. notesEntry.
async function notesOf(job, text, { title, lang, kind, mode, budget, numCtx, model, fresh }) {
  const key = `${model}|${lang}|${kind}|${mode}|${budget}|${text}`;
  const { entry, parts } = await notesEntry(key, text, budget, fresh);
  if (entry.merged !== null) return entry.merged;
  const { notes } = entry;
  const todo = parts.map((_, i) => i).filter((i) => notes[i] === null);
  for (const [k, i] of todo.entries()) {
    job.queued = todo.length - k; // оставшиеся части и итог
    safePost(job.port, { type: "progress", step: "part", part: i + 1, parts: parts.length });
    const { content } = await ask(
      job,
      (ctx) =>
        buildNotesRequest(
          { text: parts[i], title, part: i + 1, parts: parts.length, lang, kind, mode },
          ctx,
        ),
      { numCtx, model },
    );
    notes[i] = content.trim(); // пусто — в части не нашлось важного, это не ошибка
    saveNotes();
  }
  job.queued = 1; // сведение заметок и итог
  const all = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join("\n\n");
  entry.merged = await mergeNotes(job, all, { title, lang, kind, mode, budget, numCtx, model });
  saveNotes();
  return entry.merged;
}

// Последний запрос — тот, чей ответ панель показывает по мере генерации. Модель начала
// рассуждать — панели progress think, само рассуждение — в console.debug.
// numCtx, model — см. ask; fixedCtx — numCtx постоянный, не из настроек (у «Сути»): совет поднять
// num_ctx в настройках не поможет. → { text, cut }, после рассуждения ещё thinkMs
async function complete(job, build, { numCtx, model, fixedCtx = false }) {
  const partial = partialSender(job.port);
  let thinkStart = 0; // первый кусок рассуждения
  let thinkEnd = 0; // первый кусок ответа после него
  const onThinking = () => {
    if (thinkStart) return;
    thinkStart = Date.now();
    safePost(job.port, { type: "progress", step: "think" });
  };
  const onContent = (content) => {
    if (thinkStart && !thinkEnd && content.trim()) thinkEnd = Date.now();
    partial.push(content);
  };
  try {
    const { content, thinking, doneReason } = await ask(job, build, {
      numCtx,
      model,
      onContent,
      onThinking,
    });
    if (thinking) console.debug(`[ot] рассуждение модели:\n${thinking}`);
    const cut = doneReason === "length";
    // пусто и обрезано — модель упёрлась в num_ctx, ещё рассуждая
    if (!content.trim()) {
      const hint = fixedCtx ? "" : " (num_ctx in settings)";
      const message = !cut
        ? "the model returned an empty response"
        : thinking
          ? "the model kept reasoning until it ran out of context"
          : `response cut off: the model ran out of context${hint}`;
      throw new OllamaError(ErrorCode.BAD_RESPONSE, message);
    }
    const text = content.trim();
    if (!thinkStart) return { text, cut };
    return { text, cut, thinkMs: (thinkEnd || Date.now()) - thinkStart };
  } finally {
    partial.cancel();
  }
}

// fresh — см. notesOf. → { text, cut }
async function summarize(job, { text, title, kind, length, fresh }) {
  const { numCtx, targetLang: lang, model } = await getSettings();
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const fromNotes = used.length > budget;
  const notesOpts = { title, lang, kind, mode: "summary", budget, numCtx, model, fresh };
  const source = fromNotes ? await notesOf(job, used, notesOpts) : used;
  job.queued = 0;
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  return complete(
    job,
    (ctx) => buildSummaryRequest({ text: source, title, length, lang, kind, fromNotes }, ctx),
    { numCtx, model },
  );
}

// В чём суть: всё — с num_ctx «Сути», длинный текст — по своим заметкам, итог — с рассуждением,
// если модель умеет. fresh — см. notesOf. → { text, cut, thinkMs? }
async function essence(job, { text, title, kind, fresh }) {
  const { targetLang: lang, model } = await getSettings();
  const numCtx = ESSENCE_NUM_CTX;
  const budget = essenceInputChars();
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const fromNotes = used.length > budget;
  const notesOpts = { title, lang, kind, mode: "essence", budget, numCtx, model, fresh };
  const source = fromNotes ? await notesOf(job, used, notesOpts) : used;
  job.queued = 0;
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  return complete(
    job,
    (ctx) => buildEssenceRequest({ text: source, title, lang, kind, fromNotes }, ctx),
    { numCtx, model, fixedCtx: true },
  );
}

// Длинный текст: каждая часть выписывает, что относится к вопросу. Прошлые вопросы и ответы
// past — тоже, чтобы понять вопрос вроде «а подробнее?»; места под них — только своё, часть
// занимает всё остальное. Выписки кэшировать незачем: у каждого вопроса свои. Вместе с
// заголовками частей выписки сводятся к месту под текст — fitExcerpts.
// → { text, missed, parts }: text — выписки одним текстом, "" — ни в одной части ничего не
// нашлось; missed — в скольких частях модель упёрлась в предел, ничего не выписав (видимо,
// рассуждала): что в них, неизвестно.
async function search(job, text, { title, kind, question, past, numCtx, model }) {
  const budget = inputChars(numCtx);
  const parts = splitText(text, budget);
  const maxTokens = excerptTokens(numCtx);
  const turns = fitTurns(past, historyChars(numCtx) - question.length);
  const found = []; // { head, excerpt }
  let missed = 0;
  for (const [i, part] of parts.entries()) {
    job.queued = parts.length - i; // оставшиеся части и ответ
    safePost(job.port, { type: "progress", step: "search", part: i + 1, parts: parts.length });
    const { content, doneReason } = await ask(
      job,
      (ctx) =>
        buildSearchRequest(
          { text: part, title, part: i + 1, parts: parts.length, question, turns, maxTokens, kind },
          ctx,
        ),
      { numCtx, model },
    );
    const excerpt = excerptOf(content);
    if (excerpt) found.push({ head: `Part ${i + 1} of ${parts.length}:\n`, excerpt });
    else if (doneReason === "length" && !content.trim()) missed++;
  }
  const heads = found.reduce((sum, { head }) => sum + head.length + 2, 0); // и "\n\n" между
  const excerpts = fitExcerpts(found.map((f) => f.excerpt), budget - heads);
  const joined = found.map(({ head }, k) => head + excerpts[k]).join("\n\n");
  return { text: joined, missed, parts: parts.length };
}

// Вопрос по тексту. Ответ из панели (краткое содержание или суть, mode) — первым ответом в
// истории: вопросы бывают про него. Под «Сутью» — с её num_ctx.
// → { text, cut }, у длинного текста ещё missed и parts, если в каких-то частях модель ничего не
// успела выписать (см. search)
async function answer(job, { text, title, kind, question, summary, history, mode }) {
  const settings = await getSettings();
  const { targetLang: lang, model } = settings;
  const numCtx = mode === "essence" ? ESSENCE_NUM_CTX : settings.numCtx;
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const first = mode === "essence" ? essenceQuestion(kind) : summaryQuestion(kind);
  const past = summary ? [{ question: first, answer: summary }, ...history] : history;
  const fromExcerpts = used.length > budget;
  const found = fromExcerpts
    ? await search(job, used, { title, kind, question, past, numCtx, model })
    : null;
  // выписок нет, но не потому, что части ответили NONE, — «на странице этого нет» было бы неправдой
  if (found && !found.text && found.missed) {
    throw new OllamaError(
      ErrorCode.BAD_RESPONSE,
      "the model extracted nothing from the parts of the text: it kept hitting the response " +
        "length limit, apparently while reasoning",
    );
  }
  const source = found ? found.text : used;
  job.queued = 0;
  if (fromExcerpts) safePost(job.port, { type: "progress", step: "final" });
  const turns = fitTurns(past, historyChars(numCtx) + budget - source.length - question.length);
  const result = await complete(
    job,
    (ctx) =>
      buildAnswerRequest({ text: source, title, question, turns, lang, kind, fromExcerpts }, ctx),
    { numCtx, model, fixedCtx: mode === "essence" },
  );
  return found?.missed ? { ...result, missed: found.missed, parts: found.parts } : result;
}

// Кликбейт ли название видео: вопрос вдогонку к краткому содержанию длины length — тот же текст,
// те же заметки по частям из кэша, см. buildClickbaitRequest. Видео длиннее MAX_CHARS не
// проверяем: развязка может быть в непрочитанном конце. model — модель, которая написала
// summary: вопрос вдогонку — ей, и заметки из кэша — её, даже если в popup уже другая; "" — из
// настроек. → { clickbait, reason }, reason — что обещает название и что в видео.
async function clickbait(job, { text, title, length, summary, model: summaryModel }) {
  if (text.length > MAX_CHARS) {
    console.debug(`[ot] кликбейт «${title}»: не проверяю, учтено только начало видео`);
    return { clickbait: false, reason: "" };
  }
  const settings = await getSettings();
  const { numCtx, targetLang: lang } = settings;
  const model = summaryModel || settings.model;
  const budget = inputChars(numCtx);
  const fromNotes = text.length > budget;
  const notesOpts = { title, lang, kind: "video", mode: "summary", budget, numCtx, model };
  const source = fromNotes ? await notesOf(job, text, notesOpts) : text;
  job.queued = 0;
  const { content } = await ask(
    job,
    (ctx) => buildClickbaitRequest({ text: source, title, length, lang, fromNotes, summary }, ctx),
    { numCtx, model },
  );
  const verdict = clickbaitOf(content);
  if (!verdict) throw new OllamaError(ErrorCode.BAD_RESPONSE, "the model's response didn't match the schema");
  const reason = [verdict.claim, verdict.delivered].filter(Boolean).join("\n");
  console.debug(`[ot] кликбейт «${title}»: ${verdict.clickbait ? "да" : "нет"}\n${reason}`);
  return { clickbait: verdict.clickbait, reason };
}

// ---------- Порты панелей ----------

const jobs = new Map(); // port → job

// «Стоп»: панель покажет «Остановлено» и «Повторить»; ошибку ABORTED она не получит. Готовые
// заметки остаются в кэше — повтор продолжит с прерванной части; поиск ответа на вопрос
// начнётся заново.
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

const isString = (value) => typeof value === "string";
const isTurn = (turn) => isString(turn?.question) && isString(turn?.answer);

// Сообщение панели → промис summarize, essence, answer или clickbait; null — не запрос (ping) или
// битое.
function start(job, msg) {
  if (!isString(msg?.text)) return null;
  const title = isString(msg.title) ? msg.title : "";
  const kind = msg.kind === "video" ? "video" : "page";
  const length = SUMMARY_LENGTHS.includes(msg.length) ? msg.length : SUMMARY_LENGTHS[0];
  const fresh = msg.fresh === true;
  if (msg.type === "summarize") {
    return summarize(job, { text: msg.text, title, kind, length, fresh });
  }
  if (msg.type === "essence") {
    return essence(job, { text: msg.text, title, kind, fresh });
  }
  if (msg.type === "clickbait" && title.trim() && isString(msg.summary) && msg.summary.trim()) {
    const model = isString(msg.model) ? msg.model : "";
    return clickbait(job, { text: msg.text, title, length, summary: msg.summary, model });
  }
  if (msg.type === "ask" && isString(msg.question) && msg.question.trim()) {
    return answer(job, {
      text: msg.text,
      title,
      kind,
      question: msg.question.trim(),
      summary: isString(msg.summary) ? msg.summary : "",
      history: Array.isArray(msg.history) ? msg.history.filter(isTurn) : [],
      mode: msg.mode === "essence" ? "essence" : "summary",
    });
  }
  return null;
}

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
    // субтитры — без модели; после «Стоп» панель их уже не ждёт
    if (msg?.type === "transcript" && isString(msg.videoId) && port.sender?.tab?.id) {
      transcript(port.sender.tab.id, msg.videoId).then((reply) => {
        if (!job.controller.signal.aborted) safePost(port, reply);
      });
      return;
    }
    const work = start(job, msg);
    if (!work) return;
    work
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

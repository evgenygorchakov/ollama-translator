// Краткое содержание страницы и видео YouTube, часть service worker:
// кнопки в popup (сообщение summarizeTab),
// внедрение панели (panel.js) и порт "summary", по которому она просит субтитры видео, краткое
// содержание. На странице видео (www.youtube.com/watch) кнопки
// работают с видео по его субтитрам. От перевода страницы, выделенного и озвучки не зависит.
//
// Один порт — один запрос. Панель → сюда: transcript { videoId } — субтитры видео текстом;
// summarize { text, title, length, kind, fresh } — краткое содержание; fresh: true — заметки по
// частям этого текста считать заново, не из кэша (после «Сбросить» в панели); ask
// { text, title, kind, question, summary, history } — вопрос по тексту, summary — краткое
// содержание из панели или ""; chat — те же поля, свободный ответ с контекстом текста;
// history — прошлые вопросы и ответы только того же режима [{ question, answer }] по порядку;
// clickbait { text, title, length, summary,
// model } — кликбейт ли название видео, summary — готовое краткое содержание длины length, model —
// модель, которая его написала; ping. kind — "video" (промпты для расшифровки видео) или любое
// другое — промпты для страницы. Все запросы по одному сообщению — к одной модели: у clickbait —
// к model, у остальных — к выбранной в popup, когда оно пришло.
// Отсюда → панели: transcript { title, text, kind, lang } — субтитры: kind — "asr"
// (автоматические) или "manual", lang — их язык; source { used, total, model } — сколько символов
// текста ушло модели и какой;
// context { context: { total, usage: { input, output, used, total } | null } } — реальное окно
// и токены одного завершённого запроса; usage: null — точного расхода ещё нет.
// progress { step: "part", part, parts } | { step: "merge" } | { step: "final" } — длинный текст:
// заметки по частям, сведение заметок, итог; { step: "think" } — модель начала рассуждать; у
// вопроса — { step: "search", part, parts } | { step: "final" }: поиск по частям, ответ;
// partial { text } — ответ по мере генерации; result { text, cut, context, thinkMs?, missed?, parts? } —
// готово, cut — ответ упёрся в num_ctx; thinkMs — сколько модель рассуждала, от первого куска
// рассуждения до первого куска ответа, у запросов без рассуждения поля нет; missed — у вопроса
// по длинному тексту: в скольких из parts частей модель упёрлась в предел, ничего не выписав; у
// clickbait — result { clickbait, reason }; error { code, message }, у субтитров code — из
// pageCaptions (lib/youtube-captions.js); stopped — «Стоп».
// Панель закрыли или сменили режим — порт отключился — запрос к Ollama отменён.
// У chat ещё web-status { enabled }, progress { step: "web-search", detail },
// в result — sources [{ id, title, url }], webLimited. Ключ API остаётся только в background.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { stripThinking } from "../lib/parse.js";
import { getSettings } from "../lib/settings.js";
import { chatWithRetry, toOllamaError } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { onStop, registerQueue } from "../lib/stop.js";
import { pageCaptions, parseJson3 } from "../lib/youtube-captions.js";
import {
  SUMMARY_LENGTHS,
  buildAnswerRequest,
  buildChatRequest,
  buildClickbaitRequest,
  buildMergeRequest,
  buildNotesRequest,
  buildSearchRequest,
  buildSummaryRequest,
  clickbaitOf,
  excerptOf,
  summaryQuestion,
} from "./lib/prompt.js";
import { transcriptText } from "./lib/transcript.js";
import { getWebSettings } from "../lib/web-settings.js";
import { checkWebAccess, publicWebUrl, webChat } from "../lib/web.js";
import {
  cutText,
  excerptTokens,
  estimatedTokens,
  fitExcerpts,
  fitTurns,
  historyChars,
  inputChars,
  splitText,
} from "../lib/chunks.js";

const PORT_NAME = "summary";
const PANEL_SCRIPTS = [
  "src/shared/keepalive-port.js",
  "src/shared/theme.js",
  "src/shared/shadow-host.js",
  "src/shared/clipboard.js",
  "src/shared/context-usage.js",
  "src/summary/lib/format.js",
  "src/summary/extract.js",
  "src/summary/panel.js",
];
// partial — не на каждый токен, а не чаще раза в столько
const PARTIAL_MS = 150;
// Дальше текст не читаем: при num_ctx 8192 это уже 9 частей, минуты на медленном железе.
const MAX_CHARS = 150_000;
// Заметки по частям — для стольких последних текстов (см. notesEntry).
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
  // Удалённые пункты могли сохраниться от предыдущей версии расширения.
  for (const id of ["essence-page", "essence-selection", "summarize-selection", "summarize-page"]) {
    chrome.contextMenus.remove(id, () => {
      void chrome.runtime.lastError; // пункта уже нет — удалять нечего
    });
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

// Панель — в главном фрейме. panel.js внедряем, только если
// его там ещё нет или остался осиротевший экземпляр после перезагрузки расширения.
// source — { kind: "page" } | { kind: "video", videoId }; mode —
// режим панели: "ask" — только вопросы, "" — последняя длина краткого содержания.
// См. open в panel.js.
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

// открывать панель — только страницам расширения (popup), не content scripts. mode — как у
// openPanel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "summarizeTab" || sender.tab) return;
  const mode = msg.mode === "ask" ? "ask" : "";
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

// Сначала загружаем модель с настройками Ollama и узнаём реальное окно для бюджета текста.
// Сервер и модель фиксируем на всю операцию, включая промежуточные запросы.
async function prepareJob(job, model) {
  const settings = await getSettings();
  model ||= settings.model;
  if (!model) throw new OllamaError(ErrorCode.MODEL_NOT_FOUND, "No model selected in the popup");
  job.ollamaUrl = settings.ollamaUrl;
  job.queued = 1;
  safePost(job.port, { type: "progress", step: "context" });
  const numCtx = await withPrioritySlot(
    { signal: job.controller.signal, model, ollamaUrl: job.ollamaUrl },
    (ctx) => ctx.numCtx,
  );
  safePost(job.port, { type: "context", context: { total: numCtx, usage: null } });
  if (job.dialogue) reportDialogue(job, { total: numCtx, usage: null });
  if (!numCtx) {
    throw new OllamaError(ErrorCode.BAD_RESPONSE,
      "Ollama did not report the loaded model's context length. Update Ollama and try again.");
  }
  if (numCtx < 2048) {
    throw new OllamaError(ErrorCode.BAD_RESPONSE,
      "Summaries and questions need at least 2048 context tokens. Increase context length in Ollama.");
  }
  return { ...settings, model, numCtx };
}

// У диалога отдельный канал: заметки по длинной странице, веб-раунды и другие операции
// не заменяют его точный счётчик. Факты сокращения сохраняем и между этапами запроса.
function reportDialogue(job, patch) {
  job.dialogContext = { ...job.dialogContext, ...patch };
  safePost(job.port, { type: "dialog-context", context: job.dialogContext });
  return job.dialogContext;
}

function fitHistory(job, past, max, { stage = "answer", web = false } = {}) {
  const { turns, history } = fitTurns(past, max);
  const previous = job.dialogContext?.history;
  const limitingBudget = Math.min(history.budgetChars, previous?.limitingBudget ?? Infinity);
  const limitingStage = previous && previous.limitingBudget < history.budgetChars
    ? previous.limitingStage : stage;
  reportDialogue(job, {
    history: {
      ...history, stage, web, limitingBudget, limitingStage,
      usedEstimate: estimatedTokens(history.usedChars),
      budgetEstimate: estimatedTokens(limitingBudget),
    },
    omitted: job.dialogContext?.omitted || history.omittedTurns > 0,
    shortened: job.dialogContext?.shortened || history.shortenedAnswers > 0,
  });
  return turns;
}

// Каждый запрос — со своим слотом: между частями длинного текста успевает перевод выделенного.
// numCtx — окно, под которое уже посчитан бюджет, а не параметр запроса к Ollama.
// onContent, onThinking — см. chat в lib/ollama.js. И onContent, и в ответе
// content — без рассуждения. → { content, thinking, doneReason }
function ask(job, build, { numCtx, model, onContent, onThinking } = {}) {
  return withPrioritySlot({ signal: job.controller.signal, model, ollamaUrl: job.ollamaUrl }, async (ctx) => {
    if (numCtx && (!ctx.numCtx || ctx.numCtx < numCtx)) {
      throw new OllamaError(ErrorCode.BAD_RESPONSE,
        "Ollama's context length changed while reading the text. Try again to resize the text and history.");
    }
    if (!job.dialogue) safePost(job.port, { type: "context", context: { total: ctx.numCtx, usage: null } });
    const res = await chatWithRetry(build(ctx), ctx, {
      onContent: onContent && ((content) => onContent(withoutThinking(content))),
      onThinking,
    });
    if (!job.dialogue) safePost(job.port, { type: "context", context: res.context });
    return { ...res, content: withoutThinking(res.content) };
  });
}

// Заметки по частям: SHA-256 от key (модель, язык, kind, размер части, текст) →
// { notes, merged }. notes[i] — заметки по i-й части splitText, как только готовы (null — ещё
// нет): оборванный запрос (смена режима, «Стоп») продолжится с той же части, а другая длина
// возьмёт merged — заметки одни на обе длины краткого содержания. Копия — в
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
async function mergeNotes(job, text, { title, lang, kind, budget, numCtx, model }) {
  while (text.length > budget) {
    safePost(job.port, { type: "progress", step: "merge" });
    const merged = [];
    for (const group of splitText(text, budget)) {
      const { content } = await ask(
        job,
        (ctx) => buildMergeRequest({ text: group, title, lang, kind }, ctx),
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

// Длинный текст → заметки по частям, сведённые так, чтобы влезли в один запрос. fresh — не брать
// заметки из кэша, см. notesEntry.
async function notesOf(job, text, { title, lang, kind, budget, numCtx, model, fresh }) {
  const key = `${job.ollamaUrl}|${model}|${lang}|${kind}|summary|${budget}|${text}`;
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
          { text: parts[i], title, part: i + 1, parts: parts.length, lang, kind },
          ctx,
        ),
      { numCtx, model },
    );
    notes[i] = content.trim(); // пусто — в части не нашлось важного, это не ошибка
    saveNotes();
  }
  job.queued = 1; // сведение заметок и итог
  const all = notes.map((n, i) => `Part ${i + 1}:\n${n}`).join("\n\n");
  entry.merged = await mergeNotes(job, all, { title, lang, kind, budget, numCtx, model });
  saveNotes();
  return entry.merged;
}

// Последний запрос — тот, чей ответ панель показывает по мере генерации. Модель начала
// рассуждать — панели progress think, само рассуждение — в console.debug.
// numCtx, model — см. ask. → { text, cut }, после рассуждения ещё thinkMs
async function complete(job, build, { numCtx, model, run }) {
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
    const callbacks = {
      onContent,
      onThinking,
      onProgress(progress) {
        partial.cancel(); // промежуточный ответ не должен затереть статус поиска
        safePost(job.port, { type: "progress", ...progress });
      },
    };
    const { content, thinking, doneReason, sources, webLimited, context: measured } = run
      ? await run(callbacks)
      : await ask(job, build, { numCtx, model, ...callbacks });
    if (thinking) console.debug(`[ot] рассуждение модели:\n${thinking}`);
    const cut = doneReason === "length";
    let context = measured;
    if (job.dialogue) {
      const history = job.dialogContext.history;
      // История уже входит в measured. Это отдельная оценка места для СЛЕДУЮЩЕГО вопроса,
      // включая новый ответ и ссылки, которые панель добавит к нему при отправке.
      const sourceChars = sources?.length
        ? `\n\nSources consulted in this earlier reply:\n${sources.map((s) => `[${s.id}] ${s.title}: ${s.url}`).join("\n")}`.length
        : 0;
      context = reportDialogue(job, {
        ...measured,
        history: {
          ...history,
          ...(content.trim() ? {
            nextEstimate: estimatedTokens(history.usedChars + job.question.length + content.trim().length + sourceChars),
          } : {}),
        },
      });
    }
    // пусто и обрезано — модель упёрлась в num_ctx, ещё рассуждая
    if (!content.trim()) {
      const message = !cut
        ? "the model returned an empty response"
        : thinking
          ? "the model reached a length limit while reasoning; check context length in Ollama"
          : "response cut off: the model reached a length limit; check context length in Ollama";
      throw new OllamaError(ErrorCode.BAD_RESPONSE, message);
    }
    const text = content.trim();
    const result = { text, cut, context, ...(sources ? { sources, webLimited } : {}) };
    if (!thinkStart) return result;
    return { ...result, thinkMs: (thinkEnd || Date.now()) - thinkStart };
  } finally {
    partial.cancel();
  }
}

// fresh — см. notesOf. → { text, cut }
async function summarize(job, { text, title, kind, length, fresh }) {
  const { numCtx, targetLang: lang, model } = await prepareJob(job);
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const fromNotes = used.length > budget;
  const notesOpts = { title, lang, kind, budget, numCtx, model, fresh };
  const source = fromNotes ? await notesOf(job, used, notesOpts) : used;
  job.queued = 0;
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  return complete(
    job,
    (ctx) => buildSummaryRequest({ text: source, title, length, lang, kind, fromNotes }, ctx),
    { numCtx, model },
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
  const turns = fitHistory(job, past, historyChars(numCtx) - question.length, { stage: "search" });
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

// Вопрос по тексту. Краткое содержание из панели — первым ответом в истории: вопросы бывают
// про него.
// → { text, cut }, у длинного текста ещё missed и parts, если в каких-то частях модель ничего не
// успела выписать (см. search)
async function answer(job, { text, title, kind, question, summary, history }) {
  const { numCtx, targetLang: lang, model } = await prepareJob(job);
  const budget = inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const past = summary ? [{ question: summaryQuestion(kind), answer: summary }, ...history] : history;
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
  const turns = fitHistory(job, past, historyChars(numCtx) + budget - source.length - question.length);
  const result = await complete(
    job,
    (ctx) =>
      buildAnswerRequest({ text: source, title, question, turns, lang, kind, fromExcerpts }, ctx),
    { numCtx, model },
  );
  return found?.missed ? { ...result, missed: found.missed, parts: found.parts } : result;
}

// Свободный разговор: длинный текст — через общие с кратким содержанием заметки, короткий —
// целиком. Поиск выписок к вопросу здесь не нужен: вопрос может быть вообще не по тексту.
async function converse(job, { text, title, kind, question, summary, history }) {
  const { numCtx, targetLang: lang, model, ollamaUrl } = await prepareJob(job);
  const { summaryWebEnabled: web, summarySearxngUrl } = await getWebSettings();
  safePost(job.port, { type: "web-status", enabled: web });
  if (web) {
    job.queued = 1;
    await checkWebAccess({ searxngUrl: summarySearxngUrl, numCtx, ollamaUrl, model, signal: job.controller.signal });
  }
  // Веб-результатам и схемам инструментов оставляем отдельное место в том же num_ctx.
  const budget = web ? Math.floor(inputChars(numCtx) * 0.28) : inputChars(numCtx);
  const used = cutText(text, MAX_CHARS);
  safePost(job.port, { type: "source", used: used.length, total: text.length, model });
  const fromNotes = used.length > budget;
  const source = fromNotes
    ? await notesOf(job, used, { title, lang, kind, budget, numCtx, model })
    : used;
  const past = summary ? [{ question: summaryQuestion(kind), answer: summary }, ...history] : history;
  const historyBudget = web
    ? Math.floor(inputChars(numCtx) * 0.1)
    : historyChars(numCtx) + budget - source.length - question.length;
  const turns = fitHistory(job, past, historyBudget, { web });
  job.queued = web ? 1 : 0; // поиск между запросами модели тоже должен останавливаться кнопкой Stop
  if (fromNotes) safePost(job.port, { type: "progress", step: "final" });
  const pageUrl = web ? publicWebUrl(job.port.sender?.url) : null;
  const build = (ctx) => buildChatRequest(
    { text: source, title, question, turns, lang, kind, fromNotes, web, pageUrl }, ctx,
  );
  return complete(job, build, {
    numCtx,
    model,
    ...(web ? {
      run: (callbacks) => webChat({
        build,
        ask: (request, handlers) => ask(job, request, { numCtx, model, ...handlers }),
        searxngUrl: summarySearxngUrl,
        numCtx,
        signal: job.controller.signal,
        onTrim: () => reportDialogue(job, { webShortened: true }),
        ...callbacks,
      }),
    } : {}),
  });
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
  const settings = await prepareJob(job, summaryModel);
  const { numCtx, targetLang: lang } = settings;
  const model = summaryModel || settings.model;
  const budget = inputChars(numCtx);
  const fromNotes = text.length > budget;
  const notesOpts = { title, lang, kind: "video", budget, numCtx, model };
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

// Сообщение панели → промис summarize, answer, converse или clickbait; null — не запрос (ping) или
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
  if (msg.type === "clickbait" && title.trim() && isString(msg.summary) && msg.summary.trim()) {
    const model = isString(msg.model) ? msg.model : "";
    return clickbait(job, { text: msg.text, title, length, summary: msg.summary, model });
  }
  if (["ask", "chat"].includes(msg.type) && isString(msg.question) && msg.question.trim()) {
    job.dialogue = true;
    job.question = msg.question.trim();
    const respond = msg.type === "chat" ? converse : answer;
    return respond(job, {
      text: msg.text,
      title,
      kind,
      question: msg.question.trim(),
      summary: isString(msg.summary) ? msg.summary : "",
      history: Array.isArray(msg.history) ? msg.history.filter(isTurn) : [],
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

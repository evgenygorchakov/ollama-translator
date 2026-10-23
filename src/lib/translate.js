// Вызовы модели для перевода: ретраи, thinking, батч с делением пополам, одиночный запрос.
// Общее для всех модулей; работает в service worker.

import { ErrorCode, OllamaError, abortedError, chat, showModel } from "./ollama.js";
import { buildBatchRequest, buildSingleRequest, settingsPrompts } from "./prompt.js";
import { isBadTranslation, parseBatch, parseSingle } from "./parse.js";
import "./tags.js"; // обычный скрипт, см. в нём

const { hasTags, sameTags, closeTags } = globalThis.__ollamaTranslator.tags;

const RETRY_DELAYS_MS = [1000, 3000];

// Нужен ли think: false — зависит от модели; спрашиваем /api/show один раз.
const thinkingCache = new Map();
function modelHasThinking(baseUrl, model) {
  const key = `${baseUrl}|${model}`;
  if (!thinkingCache.has(key)) {
    const promise = showModel(baseUrl, model).then(({ capabilities }) =>
      capabilities.includes("thinking"),
    );
    promise.catch(() => thinkingCache.delete(key));
    thinkingCache.set(key, promise);
  }
  return thinkingCache.get(key);
}

// Общий промис /api/show не отменяем — его могут ждать и другие запросы, — но отменённый
// запрос перестаёт его ждать сразу и не держит слот.
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortedError());
    if (signal.aborted) return aborted();
    const onAbort = () => {
      clearTimeout(timer);
      aborted();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetryable(err) {
  return (
    err.code === ErrorCode.OLLAMA_DOWN || (err.code === ErrorCode.BAD_RESPONSE && err.status >= 500)
  );
}

// before() — необязательный хук перед каждой попыткой. Если он бросил, повторов больше нет:
// наружу идёт его ошибка, а если прошлая попытка упала с OLLAMA_DOWN — она (см. chatWithRetry).
async function withRetry(fn, signal, before) {
  let lastErr = null;
  for (let attempt = 0; ; attempt++) {
    try {
      before?.();
    } catch (err) {
      throw lastErr?.code === ErrorCode.OLLAMA_DOWN ? lastErr : err;
    }
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof OllamaError) || !isRetryable(err) || attempt >= RETRY_DELAYS_MS.length) {
        throw err;
      }
      lastErr = err;
      console.warn(`[ot] повтор через ${RETRY_DELAYS_MS[attempt]} мс:`, err.message);
      await sleep(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

export function toOllamaError(err) {
  if (err instanceof OllamaError) return err;
  console.error(err);
  return new OllamaError(ErrorCode.BAD_RESPONSE, String(err?.message ?? err));
}

// Контекст для translateOne/translateTexts: модель и её параметры — из настроек.
// prompts — системные промпты { batch, single, singleViaBatch }: batch — для JSON-батча, single —
// для одиночного запроса без JSON; singleViaBatch — одиночный сначала пробовать батчем из одного
// (см. translateOne). По умолчанию — промпты перевода страниц из настроек.
export async function createContext(settings, signal, prompts = settingsPrompts(settings)) {
  if (!settings.model) throw new OllamaError(ErrorCode.MODEL_NOT_FOUND, "Модель не выбрана в popup");
  return {
    baseUrl: settings.ollamaUrl,
    model: settings.model,
    temperature: settings.temperature,
    numCtx: settings.numCtx,
    prompts,
    signal,
    // Ollama могла ещё не подняться — те же ретраи, что у chat
    disableThinking: await withRetry(
      () => abortable(modelHasThinking(settings.ollamaUrl, settings.model), signal),
      signal,
    ),
  };
}

// ctx.beforeRequest() — необязательный хук перед каждым запросом к модели, в том числе повтором:
// может бросить, чтобы прервать перевод между запросами, не теряя ответ идущего.
// Если перед повтором хук бросил, а Ollama недоступна, наружу идёт OLLAMA_DOWN: о ней важнее
// узнать сразу, чем уступить слот и перекладывать обречённые тексты.
// onContent — см. chat в ollama.js; после повтора ответ в нём начинается заново.
export async function chatWithRetry(body, ctx, { onContent } = {}) {
  const res = await withRetry(
    () => chat(ctx.baseUrl, body, { signal: ctx.signal, onContent }),
    ctx.signal,
    ctx.beforeRequest,
  );
  if (res.evalDuration) {
    const speed = res.evalCount / (res.evalDuration / 1e9);
    console.debug(`[ot] ${res.evalCount} ток. за ${(res.evalDuration / 1e9).toFixed(1)} с, ${speed.toFixed(1)} ток/с`);
  }
  return res;
}

// acceptUnchanged: вернувшийся без изменений текст — не ошибка (выделенное могло быть уже на
// нужном языке или непереводимым).
// Теги (lib/tags.js) в переводе должны быть те же, что в оригинале. Не совпали в батче — ошибка,
// элемент переспросят одиночным запросом. Не совпали и в нём (final) — потерянные закрывающие
// теги ставим сами (closeTags), а если сломано что-то ещё, отдаём как есть: content покажет
// перевод под оригиналом.
function checked(original, translation, { acceptUnchanged = false, final = false } = {}) {
  if (isBadTranslation(original, translation)) {
    if (acceptUnchanged && translation.trim()) return { text: translation };
    return { error: { code: ErrorCode.BAD_RESPONSE, message: "Модель вернула пустой или непереведённый текст" } };
  }
  if (hasTags(original) && !sameTags(original, translation)) {
    const closed = final ? closeTags(original, translation) : null;
    console.warn(
      `[ot] теги не совпали, ${closed ? "закрыл потерянные" : final ? "покажу под оригиналом" : "переспрошу отдельно"}:`,
      original,
      "→",
      translation,
    );
    if (final) return { text: closed ?? translation };
    return { error: { code: ErrorCode.BAD_RESPONSE, message: "Модель испортила разметку абзаца" } };
  }
  return { text: translation };
}

// Упёрлись в num_ctx: обрезанный JSON батча не разберётся сам, а обрезанный текст — разберётся,
// поэтому doneReason проверяем до разбора. Повтор с другим промптом тоже не влезет.
function truncated() {
  return {
    error: {
      code: ErrorCode.BAD_RESPONSE,
      message: "Перевод обрезан: не хватило контекста модели (num_ctx в настройках)",
    },
  };
}

// Одиночный запрос идёт с промптом ctx.prompts.single. Свой промпт из настроек написан под
// JSON-батч (singleViaBatch), поэтому с ним сначала пробуем батч из одного элемента; если и он
// не разобран — промпт single. Это последняя попытка: перевод с испорченными тегами тоже отдаём
// (см. checked).
// opts: { acceptUnchanged } — см. checked. → { text } | { error }
export async function translateOne(text, ctx, opts = {}) {
  const checkOpts = { ...opts, final: true };
  if (ctx.prompts.singleViaBatch) {
    const { content, doneReason } = await chatWithRetry(buildBatchRequest([text], ctx), ctx);
    if (doneReason === "length") return truncated();
    const translations = parseBatch(content, 1);
    if (translations) return checked(text, translations[0], checkOpts);
    console.warn("[ot] ответ на батч из одного не разобран, перевожу одиночным запросом", content);
  }
  const { content, doneReason } = await chatWithRetry(buildSingleRequest(text, ctx), ctx);
  if (doneReason === "length") return truncated();
  return checked(text, parseSingle(content, text), checkOpts);
}

// → массив { text } | { error } той же длины, что texts. Если модель вернула не то число
// элементов, битый JSON или упёрлась в num_ctx — делим батч пополам, одиночные переводим без
// JSON-формата. out заполняется по мере готовности: если запрос отменят, вызывающий заберёт
// уже переведённое.
export async function translateTexts(texts, ctx, out = new Array(texts.length)) {
  await translateRange(texts, 0, texts.length, ctx, out);
  return out;
}

async function translateRange(texts, from, to, ctx, out) {
  if (to - from === 1) {
    out[from] = await translateOne(texts[from], ctx);
    return;
  }
  const part = texts.slice(from, to);
  const { content, doneReason } = await chatWithRetry(buildBatchRequest(part, ctx), ctx);
  // обрезанный по num_ctx JSON не разберётся; половине, скорее всего, хватит контекста
  const translations = doneReason === "length" ? null : parseBatch(content, part.length);
  if (translations) {
    // пустой или непереведённый элемент батча переспрашиваем по одному, остальные готовы сразу
    const retry = [];
    part.forEach((text, i) => {
      const r = checked(text, translations[i]);
      if (r.error) retry.push(from + i);
      else out[from + i] = r;
    });
    for (const i of retry) out[i] = await translateOne(texts[i], ctx);
    return;
  }
  if (doneReason === "length") {
    console.warn(`[ot] ответ на батч из ${part.length} обрезан по num_ctx, делю пополам`);
  } else {
    console.warn(`[ot] ответ на батч из ${part.length} не разобран, делю пополам`, content);
  }
  const mid = from + Math.ceil(part.length / 2);
  await translateRange(texts, from, mid, ctx, out);
  await translateRange(texts, mid, to, ctx, out);
}

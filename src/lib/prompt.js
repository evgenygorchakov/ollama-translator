// Промпты и тела запросов к /api/chat.

import { languageName } from "./languages.js";
import "./tags.js"; // обычный скрипт, см. в нём

const { hasTags } = globalThis.__ollamaTranslator.tags;

const KEEP_RULES =
  "Keep URLs, e-mails, code, numbers, product and brand names unchanged. " +
  "Preserve punctuation and leading/trailing symbols.";

// Дописывается после промпта, в том числе своего из настроек, — только если в запросе есть
// тексты с тегами (перевод на месте, lib/tags.js).
const TAG_RULES =
  "Tags like <t1>…</t1> mark links and formatting. Keep every tag exactly once, in the same " +
  "order, around the words that translate the tagged words; do not add, remove or renumber tags.";

function withTagRules(systemPrompt, texts) {
  return texts.some(hasTags) ? `${systemPrompt} ${TAG_RULES}` : systemPrompt;
}

// {targetLang} заменяется на название языка. Свой промпт из настроек — тот же шаблон.
export const DEFAULT_BATCH_PROMPT =
  "You are a professional translator. Translate every string in the `items` array from " +
  "English into natural, fluent {targetLang}. Return JSON {\"translations\": [...]} with " +
  "exactly the same number of elements in the same order, one translation per item. " +
  // без этой фразы модель оставляет короткие «Edit», «References» по-английски
  "Translate every item, including single words, headings and interface labels. " +
  `${KEEP_RULES} Do not merge, split, explain or comment.`;

// Промпты перевода страниц и выделенного: язык и свой промпт — из настроек.
// → { batch, single, singleViaBatch }, см. createContext в translate.js. Модуль со своими
// промптами (другая задача, другой язык) собирает такой же объект сам.
export function settingsPrompts({ targetLang, systemPrompt }) {
  const lang = languageName(targetLang);
  const custom = systemPrompt.trim();
  return {
    batch: (custom || DEFAULT_BATCH_PROMPT).replaceAll("{targetLang}", lang),
    single:
      `You are a professional translator. Translate the user's text from English into natural, ` +
      `fluent ${lang}. ${KEEP_RULES} Output only the translation, without quotes, ` +
      "explanations or comments.",
    // свой промпт написан под JSON-батч, а одиночный запрос идёт со встроенным
    singleViaBatch: Boolean(custom),
  };
}

// minItems/maxItems Ollama превращает в грамматику — модель физически не может вернуть
// другое число элементов (если не упрётся в лимит токенов).
export function batchSchema(count) {
  return {
    type: "object",
    properties: {
      translations: {
        type: "array",
        items: { type: "string" },
        minItems: count,
        maxItems: count,
      },
    },
    required: ["translations"],
  };
}

// opts — контекст перевода: { model, prompts, temperature, numCtx, disableThinking }
function baseRequest(opts) {
  return {
    model: opts.model,
    keep_alive: "30m",
    // think передаём только моделям с thinking: на остальных он может дать ошибку
    ...(opts.disableThinking ? { think: false } : {}),
    options: { temperature: opts.temperature, num_ctx: opts.numCtx },
  };
}

export function buildBatchRequest(texts, opts) {
  return {
    ...baseRequest(opts),
    format: batchSchema(texts.length),
    messages: [
      { role: "system", content: withTagRules(opts.prompts.batch, texts) },
      { role: "user", content: JSON.stringify({ items: texts }) },
    ],
  };
}

export function buildSingleRequest(text, opts) {
  return {
    ...baseRequest(opts),
    messages: [
      { role: "system", content: withTagRules(opts.prompts.single, [text]) },
      { role: "user", content: text },
    ],
  };
}

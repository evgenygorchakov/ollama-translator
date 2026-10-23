// Промпты краткого содержания и тела запросов к /api/chat. Язык — targetLang из настроек;
// свой промпт перевода (systemPrompt) сюда не относится.
// Длинный текст модель читает по частям: заметки по каждой (buildNotesRequest), если их много —
// сводит заметки (buildMergeRequest), и из заметок пишет итог (buildSummaryRequest, fromNotes).

import { languageName } from "../../lib/languages.js";
import { baseRequest } from "../../lib/prompt.js";

// Длины: ключ — в сообщении summarize и в storage (summaryLength).
const FORMATS = {
  short:
    "Write a short summary: first the main point in one or two sentences, then 3–5 key " +
    'points, each on its own line starting with "- ".',
  long:
    "Write a detailed summary: first an overview in two or three sentences, then the important " +
    "facts, numbers, arguments and conclusions as 8–15 points in total, across all headings, " +
    'each on its own line starting with "- ". If the text has distinct parts, start each group ' +
    'of points with a short heading on its own line starting with "## ". Merge related facts ' +
    "into one point instead of listing them one by one.",
};

export const SUMMARY_LENGTHS = Object.freeze(Object.keys(FORMATS));

// Без предела модель пересказывает часть почти целиком: заметки 10 частей не влезли бы в итог.
const NOTES_FORMAT =
  "Write at most 12 short points with the facts, numbers, names, arguments and conclusions " +
  "that matter most for the page as a whole, skipping minor details and examples; each point " +
  'on its own line starting with "- ".';

const PAGE_SOURCE =
  "The user message is text taken from a web page: it may be in any language and may contain " +
  "leftovers of menus, ads, buttons or comments — ignore them.";

const NOTES_SOURCE = "The user message holds notes on a long web page, part by part.";

const RULES =
  "Use only facts from the text, add nothing of your own. Plain text only: no bold or italics, " +
  'no tables, no code blocks; no preamble like "The article says" or "Summary:" and no ' +
  "closing remarks.";

function request(system, user, ctx) {
  return {
    ...baseRequest(ctx),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

function titled(title, text) {
  return title ? `Title: ${title}\n\n${text}` : text;
}

// ctx — контекст из withPrioritySlot: модель и её параметры. fromNotes — text это заметки по
// частям, а не текст страницы.
export function buildSummaryRequest({ text, title, length, lang, fromNotes = false }, ctx) {
  const name = languageName(lang);
  const source = fromNotes ? NOTES_SOURCE : PAGE_SOURCE;
  return request(
    `You summarize web pages in ${name}. ${FORMATS[length]} ${source} ${RULES} Write in ${name}.`,
    titled(title, text),
    ctx,
  );
}

// Заметки по одной части длинного текста; part — с единицы.
export function buildNotesRequest({ text, title, part, parts, lang }, ctx) {
  const name = languageName(lang);
  return request(
    "You take notes on one part of a long web page; a summary will be written later from the " +
      `notes on all parts. ${NOTES_FORMAT} ${PAGE_SOURCE} ${RULES} Write in ${name}.`,
    titled(title, `Part ${part} of ${parts}:\n\n${text}`),
    ctx,
  );
}

// Заметки по частям не влезли в один запрос: сводим их группу в заметки покороче.
export function buildMergeRequest({ text, title, lang }, ctx) {
  const name = languageName(lang);
  return request(
    "You condense notes on a long web page for a summary that will be written later. Merge " +
      "them into shorter notes: keep every important fact, number and name, drop repetitions. " +
      `${NOTES_FORMAT} ${NOTES_SOURCE} ${RULES} Write in ${name}.`,
    titled(title, text),
    ctx,
  );
}

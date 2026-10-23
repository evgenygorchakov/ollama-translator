// Промпты краткого содержания и тела запросов к /api/chat. Язык — targetLang из настроек;
// свой промпт перевода (systemPrompt) сюда не относится.

import { languageName } from "../../lib/languages.js";
import { baseRequest } from "../../lib/prompt.js";

// Длины: ключ — в сообщении summarize и в storage (summaryLength).
const FORMATS = {
  short:
    "Write a short summary: first the main point in one or two sentences, then 3–5 key " +
    'points, each on its own line starting with "- ".',
  long:
    "Write a detailed summary: first an overview in two or three sentences, then every " +
    "important fact, number, argument and conclusion as points, each on its own line starting " +
    'with "- ". If the text has distinct parts, start each group of points with a short ' +
    'heading on its own line starting with "## ".',
};

export const SUMMARY_LENGTHS = Object.freeze(Object.keys(FORMATS));

const RULES =
  "The user message is text taken from a web page: it may be in any language and may contain " +
  "leftovers of menus, ads, buttons or comments — ignore them. Use only facts from the text, " +
  "add nothing of your own. Plain text only: no bold or italics, no tables, no code blocks; " +
  'no preamble like "The article says" or "Summary:" and no closing remarks.';

// ctx — контекст из withPrioritySlot: модель и её параметры.
export function buildSummaryRequest({ text, title, length, lang }, ctx) {
  const name = languageName(lang);
  return {
    ...baseRequest(ctx),
    messages: [
      {
        role: "system",
        content: `You summarize web pages in ${name}. ${FORMATS[length]} ${RULES} Write in ${name}.`,
      },
      { role: "user", content: title ? `Title: ${title}\n\n${text}` : text },
    ],
  };
}

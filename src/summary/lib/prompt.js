// Промпты краткого содержания и тела запросов к /api/chat. Язык — targetLang из настроек;
// свой промпт перевода (systemPrompt) сюда не относится.
// Длинный текст модель читает по частям: заметки по каждой (buildNotesRequest), если их много —
// сводит заметки (buildMergeRequest), и из заметок пишет итог (buildSummaryRequest, fromNotes).
// Вопрос по тексту — buildAnswerRequest. Если текст длинный, каждая часть выписывает, что
// относится к вопросу (buildSearchRequest), а ответ пишется по выпискам (buildAnswerRequest,
// fromExcerpts).

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

const PAGE_NOISE =
  "it may be in any language and may contain leftovers of menus, ads, buttons or comments — " +
  "ignore them.";

const PAGE_SOURCE = `The user message is text taken from a web page: ${PAGE_NOISE}`;

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

// Краткое содержание из панели идёт в историю вопросов первым ответом — на этот вопрос.
export const SUMMARY_QUESTION = "Summarize the page.";

const ANSWER_RULES =
  "Answer only from the page text and add nothing of your own; if the page does not answer the " +
  "question, say so in one sentence. Answer briefly and to the point; when the answer is a " +
  'list, put each item on its own line starting with "- ". Plain text only: no bold or italics, ' +
  "no tables, no code blocks; no preamble and no closing remarks.";

// Системный промпт, прошлые вопросы и ответы turns ([{ question, answer }] по порядку) —
// сообщениями чата, и последний вопрос.
function chatRequest(system, turns, question, ctx) {
  return {
    ...baseRequest(ctx),
    messages: [
      { role: "system", content: system },
      ...turns.flatMap((turn) => [
        { role: "user", content: turn.question },
        { role: "assistant", content: turn.answer },
      ]),
      { role: "user", content: question },
    ],
  };
}

// Вопрос по тексту. Текст — в системном промпте, прошлые вопросы — после него: начало запроса от
// вопроса к вопросу одно и то же, и Ollama не разбирает текст заново. fromExcerpts — text это
// выписки к этому вопросу из частей длинного текста (buildSearchRequest), "" — ничего не нашлось.
export function buildAnswerRequest({ text, title, question, turns, lang, fromExcerpts = false }, ctx) {
  const name = languageName(lang);
  const source = fromExcerpts
    ? "The page is too long to read at once, so excerpts related to the last question were " +
      "copied out of its parts; they are at the end of these instructions."
    : `The page text is at the end of these instructions: ${PAGE_NOISE}`;
  const body = fromExcerpts
    ? `Excerpts:\n\n${titled(title, text || "None: nothing on the page relates to the last question.")}`
    : `Page text:\n\n${titled(title, text)}`;
  return chatRequest(
    `You answer the user's questions about a web page in ${name}. ${source} ${ANSWER_RULES} ` +
      `Write in ${name}.\n\n${body}`,
    turns,
    question,
    ctx,
  );
}

// Длинный текст: из одной его части (part — с единицы) выписать то, что относится к вопросу.
// turns — как у buildAnswerRequest: по ним понятен вопрос вроде «а подробнее?». maxTokens —
// предел длины выписки (num_predict). Ничего не нашлось — модель отвечает NONE, см. excerptOf.
export function buildSearchRequest({ text, title, part, parts, question, turns, maxTokens }, ctx) {
  const req = chatRequest(
    "You help answer the user's questions about a long web page that is read part by part; one " +
      `part of it is at the end of these instructions: ${PAGE_NOISE} Copy out of this part ` +
      "everything that helps answer the user's last question: facts, numbers, names, " +
      "definitions, with enough context to understand them, in the language of the page. " +
      "Earlier messages are previous questions and answers: use them only to understand what " +
      "the last question is about. Do not answer the question yourself, do not explain and add " +
      "nothing that is not in this part. Plain text only, no preamble. If nothing in this part " +
      "helps, reply with exactly NONE.\n\n" +
      titled(title, `Part ${part} of ${parts}:\n\n${text}`),
    turns,
    `${question}\n\n(Copy out what in this part of the page helps answer this, or reply NONE.)`,
    ctx,
  );
  return { ...req, options: { ...req.options, num_predict: maxTokens } };
}

// Ответ на buildSearchRequest → выписка; "" — в части ничего не нашлось. Вокруг NONE бывают
// кавычки, точки, звёздочки; \W для них не годится — под него попадает и кириллица.
export function excerptOf(content) {
  const text = content.trim();
  const bare = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return /^NONE\b/.test(bare) || /^none$/i.test(bare) ? "" : text;
}

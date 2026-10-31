// Промпты краткого содержания и тела запросов к /api/chat. Язык — targetLang из настроек;
// свой промпт перевода (systemPrompt) сюда не относится. kind — о чём текст: "page" — страница
// или выделенное на ней, "video" — расшифровка речи видео из субтитров.
// Длинный текст модель читает по частям: заметки по каждой (buildNotesRequest), если их много —
// сводит заметки (buildMergeRequest), и из заметок пишет итог (buildSummaryRequest, fromNotes).
// Вопрос по тексту — buildAnswerRequest. Если текст длинный, каждая часть выписывает, что
// относится к вопросу (buildSearchRequest), а ответ пишется по выпискам (buildAnswerRequest,
// fromExcerpts). Кликбейт ли название видео — buildClickbaitRequest вдогонку к краткому
// содержанию.

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

const PAGE_NOISE =
  "it may be in any language and may contain leftovers of menus, ads, buttons or comments — " +
  "ignore them.";

const VIDEO_NOISE =
  "Automatic captions may have no punctuation and contain recognition errors — read them by " +
  'meaning. A line starting with ">>" means another person starts speaking.';

// Слова промптов о тексте по kind.
const SUBJECTS = {
  page: {
    many: "web pages",
    one: "a web page",
    long: "a long web page",
    the: "the page",
    on: "on the page",
    from: "the page text",
    head: "Page text",
    preamble: "The article says",
    source: `The user message is text taken from a web page: ${PAGE_NOISE}`,
    text: `The page text is at the end of these instructions: ${PAGE_NOISE}`,
    excerpts:
      "The page is too long to read at once, so excerpts related to the last question were " +
      "copied out of its parts; they are at the end of these instructions.",
    part: `one part of it is at the end of these instructions: ${PAGE_NOISE}`,
  },
  video: {
    many: "videos",
    one: "a video",
    long: "a long video",
    the: "the video",
    on: "in the video",
    from: "the transcript",
    head: "Transcript",
    preamble: "The video says",
    source:
      "The user message is a transcript of a video's speech taken from its captions; it may be " +
      `in any language. ${VIDEO_NOISE}`,
    text:
      "The transcript of the video's speech, taken from its captions, is at the end of these " +
      `instructions; it may be in any language. ${VIDEO_NOISE}`,
    excerpts:
      "The video is too long to read at once, so excerpts related to the last question were " +
      "copied out of the parts of its transcript, taken from the captions; they are at the end " +
      `of these instructions. ${VIDEO_NOISE}`,
    part:
      "one part of its transcript, taken from the captions, is at the end of these " +
      `instructions; it may be in any language. ${VIDEO_NOISE}`,
  },
};

const subjectOf = (kind) => SUBJECTS[kind] ?? SUBJECTS.page;

// Без предела модель пересказывает часть почти целиком: заметки 10 частей не влезли бы в итог.
function notesFormat(s) {
  return (
    "Write at most 12 short points with the facts, numbers, names, arguments and conclusions " +
    `that matter most for ${s.the} as a whole, skipping minor details and examples; each point ` +
    'on its own line starting with "- ".'
  );
}

function notesSource(s) {
  return `The user message holds notes on ${s.long}, part by part.`;
}

function rules(s) {
  return (
    "Use only facts from the text, add nothing of your own. Plain text only: no bold or italics, " +
    `no tables, no code blocks; no preamble like "${s.preamble}" or "Summary:" and no ` +
    "closing remarks."
  );
}

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
// частям, а не сам текст.
export function buildSummaryRequest({ text, title, length, lang, kind, fromNotes = false }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  const source = fromNotes ? notesSource(s) : s.source;
  return request(
    `You summarize ${s.many} in ${name}. ${FORMATS[length]} ${source} ${rules(s)} ` +
      `Write in ${name}.`,
    titled(title, text),
    ctx,
  );
}

// Заметки по одной части длинного текста; part — с единицы.
export function buildNotesRequest({ text, title, part, parts, lang, kind }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  return request(
    `You take notes on one part of ${s.long}; a summary will be written later from the ` +
      `notes on all parts. ${notesFormat(s)} ${s.source} ${rules(s)} Write in ${name}.`,
    titled(title, `Part ${part} of ${parts}:\n\n${text}`),
    ctx,
  );
}

// Заметки по частям не влезли в один запрос: сводим их группу в заметки покороче.
export function buildMergeRequest({ text, title, lang, kind }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  return request(
    `You condense notes on ${s.long} for a summary that will be written later. Merge ` +
      "them into shorter notes: keep every important fact, number and name, drop repetitions. " +
      `${notesFormat(s)} ${notesSource(s)} ${rules(s)} Write in ${name}.`,
    titled(title, text),
    ctx,
  );
}

// Краткое содержание из панели идёт в историю вопросов первым ответом — на этот вопрос.
export function summaryQuestion(kind) {
  return `Summarize ${subjectOf(kind).the}.`;
}

function answerRules(s) {
  return (
    `Answer only from ${s.from} and add nothing of your own; if ${s.the} does not answer the ` +
    "question, say so in one sentence. Answer briefly and to the point; when the answer is a " +
    'list, put each item on its own line starting with "- ". Plain text only: no bold or italics, ' +
    "no tables, no code blocks; no preamble and no closing remarks."
  );
}

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
export function buildAnswerRequest(
  { text, title, question, turns, lang, kind, fromExcerpts = false },
  ctx,
) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  const source = fromExcerpts ? s.excerpts : s.text;
  const none = `None: nothing ${s.on} relates to the last question.`;
  const body = fromExcerpts
    ? `Excerpts:\n\n${titled(title, text || none)}`
    : `${s.head}:\n\n${titled(title, text)}`;
  return chatRequest(
    `You answer the user's questions about ${s.one} in ${name}. ${source} ${answerRules(s)} ` +
      `Write in ${name}.\n\n${body}`,
    turns,
    question,
    ctx,
  );
}

// Длинный текст: из одной его части (part — с единицы) выписать то, что относится к вопросу.
// turns — как у buildAnswerRequest: по ним понятен вопрос вроде «а подробнее?». maxTokens —
// предел длины выписки (num_predict). Ничего не нашлось — модель отвечает NONE, см. excerptOf.
export function buildSearchRequest(
  { text, title, part, parts, question, turns, maxTokens, kind },
  ctx,
) {
  const s = subjectOf(kind);
  const req = chatRequest(
    `You help answer the user's questions about ${s.long} that is read part by part; ${s.part} ` +
      "Copy out of this part everything that helps answer the user's last question: facts, " +
      "numbers, names, definitions, with enough context to understand them, in the language of " +
      `${s.the}. ` +
      "Earlier messages are previous questions and answers: use them only to understand what " +
      "the last question is about. Do not answer the question yourself, do not explain and add " +
      "nothing that is not in this part. Plain text only, no preamble. If nothing in this part " +
      "helps, reply with exactly NONE.\n\n" +
      titled(title, `Part ${part} of ${parts}:\n\n${text}`),
    turns,
    `${question}\n\n(Copy out what in this part of ${s.the} helps answer this, or reply NONE.)`,
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

// Ответ — две-три фразы. Предел — на случай, если модель зациклится в JSON (бесконечные
// пробелы): без него запрос держал бы модель, пока не закроют панель.
const CLICKBAIT_TOKENS = 512;

// Поля — в том порядке, в каком модели их писать: сначала разобраться, потом решать.
const CLICKBAIT_SCHEMA = {
  type: "object",
  properties: {
    claim: { type: "string" },
    delivered: { type: "string" },
    is_clickbait: { type: "boolean" },
  },
  required: ["claim", "delivered", "is_clickbait"],
};

// Броское название, которое лишь немного преувеличивает, — не кликбейт: иначе плашка была бы
// почти у каждого видео.
function clickbaitQuestion(name) {
  return (
    "Now a different task: judge whether the title of this video is clickbait. Clickbait means " +
    "the title promises something the video does not deliver — a fact, answer, event, result " +
    "or reveal that never comes — or misleads about what the video is: what the title states " +
    "did not happen or is not in the video, even if the video has something smaller or " +
    "related. A catchy, emotional or capitalized title, or one that only makes the video sound " +
    "somewhat bigger than it is, is not clickbait when the video does deliver what it " +
    "promises. Judge only from the text above, not from what you know about the topic. Reply " +
    "with JSON: claim — what the title promises, in one sentence; delivered — whether and how " +
    "the video delivers it, in one or two sentences; is_clickbait — true or false. Write claim " +
    `and delivered in ${name}.`
  );
}

// Кликбейт ли название видео — продолжение запроса краткого содержания (buildSummaryRequest с
// теми же параметрами): начало запроса то же, и Ollama не разбирает текст заново. summary —
// краткое содержание, которое модель на него написала.
export function buildClickbaitRequest({ text, title, length, lang, fromNotes, summary }, ctx) {
  const req = buildSummaryRequest({ text, title, length, lang, kind: "video", fromNotes }, ctx);
  return {
    ...req,
    format: CLICKBAIT_SCHEMA,
    options: { ...req.options, num_predict: CLICKBAIT_TOKENS },
    messages: [
      ...req.messages,
      { role: "assistant", content: summary },
      { role: "user", content: clickbaitQuestion(languageName(lang)) },
    ],
  };
}

// Ответ на buildClickbaitRequest → { clickbait, claim, delivered }; null — не JSON или вердикта
// нет.
export function clickbaitOf(content) {
  const text = content.trim();
  let data;
  try {
    data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (typeof data?.is_clickbait !== "boolean") return null;
  const str = (value) => (typeof value === "string" ? value.trim() : "");
  return { clickbait: data.is_clickbait, claim: str(data.claim), delivered: str(data.delivered) };
}

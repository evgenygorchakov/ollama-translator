// Промпты краткого содержания и тела запросов к /api/chat. Язык — targetLang из настроек;
// свой промпт перевода (systemPrompt) сюда не относится. kind — о чём текст: "page" — страница
// или выделенное на ней, "video" — расшифровка речи видео из субтитров.
// Длинный текст модель читает по частям: заметки по каждой (buildNotesRequest), если их много —
// сводит заметки (buildMergeRequest), и из заметок пишет итог (buildSummaryRequest, fromNotes).
// Вопрос по тексту — buildAnswerRequest. Если текст длинный, каждая часть выписывает, что
// относится к вопросу (buildSearchRequest), а ответ пишется по выпискам (buildAnswerRequest,
// fromExcerpts). Кликбейт ли название видео — buildClickbaitRequest вдогонку к краткому
// содержанию. «В чём суть» — buildEssenceRequest: главная мысль текста и раскрытие вокруг неё;
// длинный текст — так же по заметкам, но своим (mode: "essence").

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
    author: "the author",
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
    author: "the speaker",
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

// Для «Сути» важны не факты подряд, а что утверждается и чем обосновано.
function essenceNotesFormat(s) {
  return (
    `Write at most 12 short points: what the text claims or reports, how ${s.author} supports ` +
    "it (arguments, examples, numbers), and the conclusions and caveats, skipping minor " +
    'details; each point on its own line starting with "- ".'
  );
}

// Заметки по частям — под то, что из них напишут потом: краткое содержание или суть. Ключ —
// mode у buildNotesRequest и buildMergeRequest.
const NOTES = {
  summary: {
    goal: "a summary",
    keep: "keep every important fact, number and name",
    format: notesFormat,
  },
  essence: {
    goal: "an explanation of its main point",
    keep: "keep every claim with what supports it, the conclusions and caveats",
    format: essenceNotesFormat,
  },
};

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

// Заметки по одной части длинного текста; part — с единицы. mode — "summary" (для краткого
// содержания) или "essence" (для сути), см. NOTES.
export function buildNotesRequest({ text, title, part, parts, lang, kind, mode = "summary" }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  const notes = NOTES[mode] ?? NOTES.summary;
  return request(
    `You take notes on one part of ${s.long}; ${notes.goal} will be written later from the ` +
      `notes on all parts. ${notes.format(s)} ${s.source} ${rules(s)} Write in ${name}.`,
    titled(title, `Part ${part} of ${parts}:\n\n${text}`),
    ctx,
  );
}

// Заметки по частям не влезли в один запрос: сводим их группу в заметки покороче. mode — как у
// buildNotesRequest.
export function buildMergeRequest({ text, title, lang, kind, mode = "summary" }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  const notes = NOTES[mode] ?? NOTES.summary;
  return request(
    `You condense notes on ${s.long} for ${notes.goal} that will be written later. Merge ` +
      `them into shorter notes: ${notes.keep}, drop repetitions. ` +
      `${notes.format(s)} ${notesSource(s)} ${rules(s)} Write in ${name}.`,
    titled(title, text),
    ctx,
  );
}

// «В чём суть»: не пересказ по порядку, а главная мысль и всё, что её раскрывает.
const ESSENCE_TASK =
  "Find the main point of the text and explain the content around it. The main point is a " +
  'claim, not a topic: "remote work slows down the growth of junior developers because…", not ' +
  '"an article about remote work". It may be stated anywhere, often at the end, or follow from ' +
  "the text as a whole: do not just take the first paragraph.";

const ESSENCE_KINDS =
  "What the main point is depends on the kind of text: for news, what happened and why it " +
  "matters; for instructions, what problem they solve and what the key technique is; for " +
  "research, what was found, how, and where its limits are; for an interview or a talk, the " +
  "speaker's position; for an opinion piece, its thesis. If the text has no single main point " +
  "(a digest, a list, a forum thread, a catalog), say so in one sentence, then name its 2–3 " +
  "main topics and briefly explain each; do not invent a thesis.";

function essenceFormat(s) {
  return (
    "Write the main point in one or two sentences as the first paragraph, without a label " +
    'like "Main point:". Then explain it in sections, each starting with a heading on its own ' +
    'line starting with "## ": what the main point rests on (each argument and what supports ' +
    `it), what follows from it, ${s.author}'s caveats. Use only the sections ` +
    'that fit the text; put points on their own lines starting with "- ". Explain in detail ' +
    `why ${s.author} thinks so instead of retelling facts in order; leave out everything ` +
    "unrelated to the main point, even important facts."
  );
}

const ESSENCE_LIMITS =
  "Use only what the text says directly or almost directly: no hidden meaning or subtext, no " +
  "knowledge of your own, do not explain terms, and say that one thing causes or follows from " +
  "another only if the text says so.";

// Итог «Сути». Модели с thinking перед ответом рассуждают. Ловушка: ctx.disableThinking — true
// как раз у моделей с thinking (под ним baseRequest ставит think: false), поэтому при нём —
// think: true. Модель без thinking получает тот же промпт и отвечает без рассуждения.
// fromNotes — как у buildSummaryRequest.
export function buildEssenceRequest({ text, title, lang, kind, fromNotes = false }, ctx) {
  const name = languageName(lang);
  const s = subjectOf(kind);
  const source = fromNotes ? notesSource(s) : s.source;
  const req = request(
    `You explain the main point of ${s.many} in ${name}. ${ESSENCE_TASK} ${ESSENCE_KINDS} ` +
      `${essenceFormat(s)} ${source} ${ESSENCE_LIMITS} ${rules(s)} Write in ${name}.`,
    titled(title, text),
    ctx,
  );
  return ctx.disableThinking ? { ...req, think: true } : req;
}

// Краткое содержание из панели идёт в историю вопросов первым ответом — на этот вопрос.
export function summaryQuestion(kind) {
  return `Summarize ${subjectOf(kind).the}.`;
}

// То же для вопросов под «Сутью»: первым ответом в истории — суть.
export function essenceQuestion(kind) {
  return `What is the main point of ${subjectOf(kind).the}? Explain it.`;
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

// Сколько текста отдавать модели за раз под num_ctx и как его резать.

// Промпт, заголовок и служебные токены чата.
const PROMPT_TOKENS = 512;
// Место под ответ: подробное краткое содержание — до ~1500 токенов; при маленьком num_ctx —
// четверть контекста.
const ANSWER_TOKENS = 2048;
// С запасом: английский текст — около 4 символов на токен, русский и код — меньше.
const CHARS_PER_TOKEN = 3;

// → сколько символов текста влезает в один запрос с этим num_ctx
export function inputChars(numCtx) {
  const answer = Math.min(ANSWER_TOKENS, numCtx / 4);
  return Math.floor((numCtx - PROMPT_TOKENS - answer) * CHARS_PER_TOKEN);
}

// Начало текста не длиннее max: по границе абзаца, если она в последней пятой части, иначе по
// концу предложения, иначе по пробелу.
export function cutText(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const min = max * 0.8;
  for (const sep of ["\n", ". ", " "]) {
    const at = head.lastIndexOf(sep);
    if (at >= min) return head.slice(0, at + sep.length).trimEnd();
  }
  return head;
}

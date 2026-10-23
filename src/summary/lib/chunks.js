// Сколько текста отдавать модели за раз под num_ctx и как его резать.

// Промпт, заголовок и служебные токены чата.
const PROMPT_TOKENS = 512;
// Место под ответ: подробное краткое содержание — до ~1500 токенов; при маленьком num_ctx —
// четверть контекста.
const ANSWER_TOKENS = 2048;
// С запасом: у gemma4 и qwen3.8 английский текст — около 5 символов на токен, русский — около
// 4. Китайскому и японскому (меньше 2) не хватит.
const CHARS_PER_TOKEN = 3;

function answerTokens(numCtx) {
  return Math.min(ANSWER_TOKENS, numCtx / 4);
}

// → сколько символов текста влезает в один запрос с этим num_ctx
export function inputChars(numCtx) {
  return Math.floor((numCtx - PROMPT_TOKENS - answerTokens(numCtx)) * CHARS_PER_TOKEN);
}

// Вопросу и прошлым вопросам с ответами — половина места под ответ: ответ на вопрос обычно
// короче подробного краткого содержания. Плюс место, которое не занял текст, — это считает
// вызывающий.
export function historyChars(numCtx) {
  return Math.floor((answerTokens(numCtx) / 2) * CHARS_PER_TOKEN);
}

// Выписка к вопросу из одной части длинного текста — не длиннее этого (num_predict): половина
// места под ответ, другую занимает история (historyChars). Выписки всех частей вместе потом
// сводятся к месту под текст — fitExcerpts.
export function excerptTokens(numCtx) {
  return Math.floor(answerTokens(numCtx) / 2);
}

// Выписки из частей длинного текста — вместе не длиннее max символов. Каждой — поровну от
// оставшегося места, начиная с коротких: короткая остаётся целиком, а что она не заняла,
// достаётся длинным. Длинные режем cutText — остаётся начало.
export function fitExcerpts(excerpts, max) {
  const out = [...excerpts];
  const order = excerpts.map((_, i) => i).sort((a, b) => excerpts[a].length - excerpts[b].length);
  let left = Math.max(0, max);
  for (const [k, i] of order.entries()) {
    out[i] = cutText(excerpts[i], Math.floor(left / (order.length - k)));
    left -= out[i].length;
  }
  return out;
}

// Последние из turns ([{ question, answer }] по порядку), которые вместе влезают в max символов.
// Последний берём всегда, ответ в нём, если не влезает, — началом: без него не понять вопрос
// вроде «а подробнее?».
export function fitTurns(turns, max) {
  const out = [];
  let left = max;
  for (let i = turns.length - 1; i >= 0; i--) {
    const { question, answer } = turns[i];
    const size = question.length + answer.length;
    if (size > left) {
      const head = out.length ? "" : cutText(answer, Math.max(0, left - question.length));
      if (head) out.push({ question, answer: head });
      break;
    }
    out.unshift(turns[i]);
    left -= size;
  }
  return out;
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

// Части не длиннее max, по абзацам. Примерно поровну: иначе последняя часть могла бы выйти из
// пары строк. Размер части пересчитываем по остатку текста, а кусок, который в него не влезает,
// берём, если влезает хотя бы его половина. Абзац длиннее восьмой части max режем cutText на
// куски — с ними части ровнее. Куски одного абзаца в одной части — через пробел, как были.
export function splitText(text, max) {
  if (text.length <= max) return [text];
  const pieceMax = Math.floor(max / 8);
  // с запасом: части по абзацам не заполнить до символа
  const count = Math.ceil(text.length / (max * 0.9));
  const parts = [];
  let part = "";
  let left = text.length; // символов не в готовых частях
  for (let para of text.split("\n")) {
    let sep = "\n";
    while (para) {
      const piece = para.length <= pieceMax ? para : cutText(para, pieceMax) || para.slice(0, pieceMax);
      para = para.slice(piece.length).trimStart();
      const target = Math.ceil(left / Math.max(1, count - parts.length));
      const next = part.length + 1 + piece.length;
      if (part && (next > max || next - piece.length / 2 > target)) {
        parts.push(part);
        left -= part.length + 1;
        part = "";
      }
      part = part ? `${part}${sep}${piece}` : piece;
      sep = " ";
    }
  }
  if (part) parts.push(part);
  return parts;
}

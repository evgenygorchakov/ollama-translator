// Субтитры YouTube для озвучки: слова с абсолютным временем (parseJson3 из
// lib/youtube-captions.js) → фразы. Чистые функции, время в секундах.

import { endsSentence } from "../../lib/youtube-captions.js";

const PAUSE_S = 0.7; // пауза между словами не короче — граница фразы
const MAX_PHRASE_S = 12; // фразу длиннее режем по самой длинной паузе внутри
const MAX_PHRASE_CHARS = 200;
const MIN_PHRASE_S = 1; // обрывок короче подклеиваем к соседу…
const MAX_GLUE_GAP_S = 1.5; // …если тот не дальше этого: иначе фраза растянулась бы на тишину
const CLAUSE_END = /[,;:]["'”’»)\]]*$/;

const round = (s) => Math.round(s * 1000) / 1000;
const duration = (words) => words.at(-1).end - words[0].start;
const textLength = (words) => words.reduce((sum, w) => sum + w.text.length + 1, -1);

// Слова → фразы [{ id, start, end, text }]. Граница — смена говорящего, конец предложения
// (если пунктуация есть) и пауза от PAUSE_S. Длинные фразы режем, обрывки подклеиваем.
// Разбор детерминированный: те же субтитры дают те же id.
export function toPhrases(words) {
  const groups = [];
  let group = [];
  for (const word of words) {
    const prev = group.at(-1);
    if (prev && (word.speaker || endsSentence(prev.text) || word.start - prev.end >= PAUSE_S)) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  return glueShort(groups.flatMap(splitLong)).map((g, id) => ({
    id,
    start: round(g[0].start),
    end: round(g.at(-1).end),
    text: g.map((w) => w.text).join(" "),
  }));
}

// Режем по самой длинной паузе (с точностью до 50 мс), при равных — после запятой, потом
// ближе к середине.
function splitLong(group) {
  if (group.length < 2 || (duration(group) <= MAX_PHRASE_S && textLength(group) <= MAX_PHRASE_CHARS)) {
    return [group];
  }
  let best = 1;
  let bestKey = null;
  for (let i = 1; i < group.length; i++) {
    const key = [
      Math.round((group[i].start - group[i - 1].end) * 20),
      CLAUSE_END.test(group[i - 1].text) ? 1 : 0,
      -Math.abs(2 * i - group.length),
    ];
    if (!bestKey || greater(key, bestKey)) {
      best = i;
      bestKey = key;
    }
  }
  return [...splitLong(group.slice(0, best)), ...splitLong(group.slice(best))];
}

function greater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// Обрывок короче MIN_PHRASE_S — к ближайшему по времени соседу, если тот рядом и это тот же
// говорящий. Фраза при этом может чуть превысить MAX_PHRASE_S.
function glueShort(groups) {
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (duration(group) >= MIN_PHRASE_S) {
      out.push(group);
      continue;
    }
    const prev = out.at(-1);
    const next = groups[i + 1];
    const prevGap = prev && !group[0].speaker ? group[0].start - prev.at(-1).end : Infinity;
    const nextGap = next && !next[0].speaker ? next[0].start - group.at(-1).end : Infinity;
    if (Math.min(prevGap, nextGap) > MAX_GLUE_GAP_S) out.push(group);
    else if (prevGap <= nextGap) prev.push(...group);
    else groups[i + 1] = [...group, ...next];
  }
  return out;
}

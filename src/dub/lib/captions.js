// Субтитры YouTube для озвучки: json3 → слова с абсолютным временем → фразы. Чистые функции,
// время в секундах.

const PAUSE_S = 0.7; // пауза между словами не короче — граница фразы
const MAX_PHRASE_S = 12; // фразу длиннее режем по самой длинной паузе внутри
const MAX_PHRASE_CHARS = 200;
const MIN_PHRASE_S = 1; // обрывок короче подклеиваем к соседу…
const MAX_GLUE_GAP_S = 1.5; // …если тот не дальше этого: иначе фраза растянулась бы на тишину
// У автосубтитров известно только начало слова, длительность прикидываем по его длине.
const WORD_S_PER_CHAR = 0.07;
const WORD_MIN_S = 0.2;
const WORD_MAX_S = 1;

// Неречевое: [Music], [APPLAUSE], (laughs), ♪.
const NOISE = /\[[^\]]*\]|\([^)]*\)|[♪♫]/g;
// Говорит другой человек: >> у автосубтитров, тире в начале строки у ручных.
const SPEAKER_ARROWS = /^>>+/;
const SPEAKER_DASH = /^\s*[-–—]\s+/;
const HAS_WORD = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[.?!…]["'”’»)\]]*$/;
const CLAUSE_END = /[,;:]["'”’»)\]]*$/;
// Точка после сокращения или инициала — не конец предложения. «I.» — местоимение в конце
// предложения («So do I.»), а не инициал.
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|jr|sr|vs|e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|[a-hj-z])\.$/i;

const round = (s) => Math.round(s * 1000) / 1000;
const duration = (words) => words.at(-1).end - words[0].start;
const textLength = (words) => words.reduce((sum, w) => sum + w.text.length + 1, -1);

// json3 → слова [{ start, end, text, speaker }] по порядку времени. speaker — с этого слова
// говорит другой человек. Время слова: у автосубтитров — из segs[].tOffsetMs, у ручных есть
// только начало и длительность реплики — делим её между словами по числу букв.
export function parseJson3(json) {
  const words = [];
  let speaker = false;
  for (const event of json?.events ?? []) {
    if (!Array.isArray(event.segs)) continue; // описание окна субтитров, не текст
    const start = (event.tStartMs ?? 0) / 1000;
    const end = start + (event.dDurationMs ?? 0) / 1000;
    for (const piece of pieces(event.segs, start, end)) {
      const tokens = [];
      // неречевое убираем до деления на строки: у ручных ремарка бывает в две строки
      for (const line of piece.text.replace(NOISE, " ").split("\n")) {
        if (SPEAKER_DASH.test(line)) speaker = true;
        for (let text of line.replace(SPEAKER_DASH, " ").split(/\s+/)) {
          if (SPEAKER_ARROWS.test(text)) {
            speaker = true;
            text = text.replace(SPEAKER_ARROWS, "");
          }
          if (!text) continue;
          if (!HAS_WORD.test(text)) {
            // отдельно стоящий знак: конец предложения — к предыдущему слову, прочее не нужно
            const prev = tokens.at(-1) ?? words.at(-1);
            if (prev && /[.?!…]/.test(text)) prev.text += text;
            continue;
          }
          tokens.push({ text, speaker });
          speaker = false;
        }
      }
      const letters = tokens.reduce((sum, t) => sum + t.text.length, 0);
      const span = Math.max(0, piece.end - piece.start);
      let before = 0;
      for (const { text, speaker: newSpeaker } of tokens) {
        const wordStart = piece.start + (span * before) / letters;
        before += text.length;
        let wordEnd = piece.start + (span * before) / letters;
        // слово автосубтитров: его кусок тянется до следующего слова или до конца показа строки
        if (tokens.length === 1) wordEnd = Math.min(wordEnd, wordStart + guessDuration(text));
        words.push({ start: wordStart, end: wordEnd, text, speaker: newSpeaker });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < words.length; i++) {
    words[i].end = Math.max(words[i].start, Math.min(words[i].end, words[i + 1].start));
  }
  return words;
}

// Куски события с известным временем: у автосубтитров каждый seg (обычно одно слово) со своим
// tOffsetMs, у ручных — вся реплика.
function pieces(segs, start, end) {
  if (!segs.some((seg) => seg.tOffsetMs != null)) {
    return [{ text: segs.map((seg) => seg.utf8 ?? "").join(""), start, end }];
  }
  const at = (seg) => start + (seg.tOffsetMs ?? 0) / 1000;
  return segs.map((seg, i) => ({
    text: seg.utf8 ?? "",
    start: at(seg),
    end: i + 1 < segs.length ? at(segs[i + 1]) : end,
  }));
}

function guessDuration(text) {
  return Math.min(WORD_MAX_S, Math.max(WORD_MIN_S, text.length * WORD_S_PER_CHAR));
}

function endsSentence(text) {
  return SENTENCE_END.test(text) && !ABBREVIATION.test(text);
}

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

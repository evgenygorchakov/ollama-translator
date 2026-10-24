// Субтитры видео → текст для модели. Слова — из parseJson3 (lib/youtube-captions.js). Строка —
// кусок речи до паузы или до смены говорящего, новый говорящий — с «>> ». Меток времени нет.

import { endsSentence } from "../../lib/youtube-captions.js";

const PAUSE_S = 1.5; // пауза между словами не короче — новая строка
// Строку длиннее LINE_CHARS заканчиваем на конце предложения. У автосубтитров пунктуации часто
// нет — тогда строку длиннее MAX_LINE_CHARS режем по самой длинной паузе во второй её половине.
const LINE_CHARS = 300;
const MAX_LINE_CHARS = 600;

const lineText = (line) => line.map((w) => w.text).join(" ");

// → индекс слова, с которого начать новую строку
function longestPause(line) {
  let best = line.length - 1;
  let bestGap = -Infinity;
  let head = -1; // длина строки до слова i, с пробелами
  for (let i = 1; i < line.length; i++) {
    head += line[i - 1].text.length + 1;
    if (head < MAX_LINE_CHARS / 2) continue;
    const gap = line[i].start - line[i - 1].end;
    if (gap > bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

// Слова [{ start, end, text, speaker }] → строки через "\n".
export function transcriptText(words) {
  const lines = [];
  let line = [];
  let chars = 0; // длина line с пробелами
  for (const word of words) {
    const prev = line.at(-1);
    if (
      prev &&
      (word.speaker ||
        word.start - prev.end >= PAUSE_S ||
        (chars >= LINE_CHARS && endsSentence(prev.text)))
    ) {
      lines.push(line);
      line = [];
      chars = 0;
    }
    chars += (line.length ? 1 : 0) + word.text.length;
    line.push(word);
    if (chars > MAX_LINE_CHARS && line.length > 1) {
      const at = longestPause(line);
      lines.push(line.slice(0, at));
      line = line.slice(at);
      chars = lineText(line).length;
    }
  }
  if (line.length) lines.push(line);
  return lines.map((l) => (l[0].speaker ? ">> " : "") + lineText(l)).join("\n");
}

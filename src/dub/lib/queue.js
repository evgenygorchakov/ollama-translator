// Планировщик озвучки: что переводить и что синтезировать следующим. Чистые функции, время в
// секундах. phrases — фразы по порядку времени, isPending(id) — фразу ещё надо перевести: она не
// переведена и сейчас не переводится.

export const AHEAD_S = 180; // переводим вперёд на столько от позиции воспроизведения
// Переведено вперёд меньше — переводим сразу. Больше — ждём, пока непереведённого в окне
// наберётся на полный батч: иначе при просмотре шли бы батчи из одной-двух фраз.
export const REFILL_S = 120;
export const READY_S = 30; // столько от позиции нужно, чтобы смотреть (как в dub/content.js)
export const VOICE_AHEAD_S = 90; // синтезируем вперёд на столько от позиции

// Фраза ещё нужна (не кончилась до позиции) и попадает в окно перевода.
function inWindow(phrase, position) {
  return phrase.end > position && phrase.start < position + AHEAD_S;
}

// Следующий батч: подряд идущие непереведённые фразы от первой, которая ещё не кончилась, в
// окне [позиция, позиция + AHEAD_S], в пределах maxItems/maxChars (хотя бы одна фраза).
// Подряд идущие фразы — контекст для модели: автосубтитры режутся посреди предложения.
// Батч, который начинается в первых READY_S, дальше них не идёт: их пользователь ждёт, а ответ
// на батч приходит целиком.
// → массив фраз; пустой — переводить пока нечего.
export function nextBatch(phrases, isPending, position, { maxItems, maxChars }) {
  const from = phrases.findIndex((p) => p.end > position && isPending(p.id));
  if (from < 0 || !inWindow(phrases[from], position)) return [];
  const until = position + (phrases[from].start < position + READY_S ? READY_S : AHEAD_S);
  const batch = [];
  let chars = 0;
  let full = false;
  for (let i = from; i < phrases.length; i++) {
    const phrase = phrases[i];
    if (!isPending(phrase.id) || phrase.start >= until) break;
    if (batch.length >= maxItems || (batch.length && chars + phrase.text.length > maxChars)) {
      full = true;
      break;
    }
    batch.push(phrase);
    chars += phrase.text.length;
  }
  if (!full && phrases[from].start >= position + REFILL_S) return [];
  return batch;
}

// Идущий батч стоит оборвать после перемотки: он весь вне окна или перед ним есть
// непереведённое из первых READY_S — без него пользователь не начнёт смотреть.
export function isStale(phrases, isPending, position, batch) {
  if (!batch.some((p) => inWindow(p, position))) return true;
  const until = Math.min(batch[0].start, position + READY_S);
  return phrases.some((p) => p.end > position && p.start < until && isPending(p.id));
}

// Сколько фраз в окне ещё ждёт перевода.
export function pendingCount(phrases, isPending, position) {
  let count = 0;
  for (const phrase of phrases) {
    if (inWindow(phrase, position) && isPending(phrase.id)) count++;
  }
  return count;
}

// Следующая фраза для синтеза — ближайшая к позиции из тех, что ещё не кончились и начинаются
// в окне [позиция, позиция + VOICE_AHEAD_S]. needsVoice(id) — фраза переведена, но ещё не
// озвучена. Синтез по одной: сервер однопоточный. → индекс фразы или -1.
export function nextVoice(phrases, needsVoice, position) {
  for (let i = 0; i < phrases.length; i++) {
    const phrase = phrases[i];
    if (phrase.start >= position + VOICE_AHEAD_S) break;
    if (phrase.end > position && needsVoice(phrase.id)) return i;
  }
  return -1;
}

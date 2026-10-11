// Подгонка длины русской фразы под место английской. Чистые функции, время в секундах.
// Сначала темп Silero — это естественнее, чем ускорять запись, — а остаток покрывает ускорение
// воспроизведения во вкладке. Вместе не быстрее dubMaxSpeed.

const TAIL_S = 1.5; // последняя фраза может звучать столько после своего конца
const MIN_SLOT_S = 0.3;
// Не влезает не больше чем во столько раз — хватит ускорения воспроизведения, синтез заново
// не нужен.
const TOLERANCE = 1.1;
// Темпы Silero быстрее обычного (medium) и во сколько раз они примерно ускоряют речь.
const TEMPOS = [
  { name: "fast", speed: 1.2 },
  { name: "x-fast", speed: 1.5 },
];

// Место фразы: от её начала до начала следующей, у последней — до её конца плюс TAIL_S.
export function slotOf(phrases, index) {
  const phrase = phrases[index];
  const next = phrases[index + 1];
  const end = next ? next.start : phrase.end + TAIL_S;
  return Math.max(MIN_SLOT_S, end - phrase.start);
}

// Темп Silero для фразы, которая обычным темпом звучит duration при месте slot. rates — темпы
// сервера (пусто у старой версии server.py). → имя темпа или null: фраза влезает или ускорять
// нечем. Берём самый быстрый темп, который не быстрее нужного, а если нужно меньше fast — fast.
// Темп быстрее maxSpeed не берём.
export function pickTempo(duration, slot, rates, maxSpeed) {
  const need = duration / slot;
  if (need <= TOLERANCE) return null;
  const usable = TEMPOS.filter((t) => rates.includes(t.name) && t.speed <= maxSpeed);
  return (usable.findLast((t) => t.speed <= need) ?? usable[0])?.name ?? null;
}

// Ускорение воспроизведения: то, что не покрыл темп. duration — длительность записи, speedup —
// во сколько раз темп Silero её укоротил (1 — обычный темп). Вместе с темпом не больше
// maxSpeed; замедлять не замедляем. Округлено до сотых.
export function playbackRate(duration, slot, speedup, maxSpeed) {
  const rate = Math.max(1, Math.min(duration / slot, maxSpeed / speedup));
  return Math.round(rate * 100) / 100;
}

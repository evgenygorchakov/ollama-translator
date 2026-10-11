// Нарезка очереди на батчи по количеству элементов и суммарной длине текста.

// Забирает из начала очереди (мутирует её) следующий батч. Хотя бы один элемент берётся
// всегда, даже если он один длиннее maxChars. group(item) — необязательно: батч состоит
// только из элементов той же группы, что и первый.
export function takeBatch(queue, { maxItems, maxChars, group = () => null }) {
  let count = 0;
  let chars = 0;
  while (count < queue.length && count < maxItems) {
    if (count > 0 && group(queue[count]) !== group(queue[0])) break;
    const len = queue[count].text.length;
    if (count > 0 && chars + len > maxChars) break;
    chars += len;
    count++;
  }
  return queue.splice(0, count);
}

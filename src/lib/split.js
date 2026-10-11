// Деление длинного текста ряда на части, которые модель переводит по отдельности.
//
// Нужен только content script'у (segment.js), поэтому, как и tags.js, это обычный скрипт без
// export: content внедряет его файлом после tags.js. Функции — в
// globalThis.__ollamaTranslator.split.
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  const { tags } = ns;

  const MAX_PART_CHARS = 2000;

  // Лежит ли позиция i внутри тега: spans — из tags.tagSpans.
  const insideTag = (spans, i) => spans.some(([from, to]) => i > from && i < to);

  // Предложения; граница посреди тега (<t1>U.S. Navy</t1>) — не граница.
  function sentences(text) {
    const spans = tags.tagSpans(text);
    const list = [];
    let from = 0;
    for (const m of text.matchAll(/(?<=[.!?…])\s+/g)) {
      if (insideTag(spans, m.index)) continue;
      list.push(text.slice(from, m.index));
      from = m.index + m[0].length;
    }
    list.push(text.slice(from));
    return list;
  }

  // Где резать предложение длиннее MAX_PART_CHARS: по последнему пробелу во второй половине
  // предела, а нет его — посреди слова. Посреди тега — перед ним или после него. 0 — негде.
  function cutAt(s) {
    const spans = tags.tagSpans(s);
    for (let i = MAX_PART_CHARS; i > MAX_PART_CHARS / 2; i--) {
      if (s[i] === " " && !insideTag(spans, i)) return i;
    }
    const span = spans.find(([from, to]) => MAX_PART_CHARS > from && MAX_PART_CHARS < to);
    if (!span) return MAX_PART_CHARS;
    return span[0] > 0 ? span[0] : span[1] < s.length ? span[1] : 0;
  }

  // Длинный текст режем по предложениям на куски ≤ MAX_PART_CHARS. Внутри тега не режем: части
  // переводятся отдельно, и теги в каждой должны быть парными.
  function splitLong(text) {
    if (text.length <= MAX_PART_CHARS) return [text];
    const parts = [];
    let current = "";
    for (let s of sentences(text)) {
      while (s.length > MAX_PART_CHARS) {
        const at = cutAt(s);
        if (!at) break; // всё предложение — один тег
        if (current) {
          parts.push(current);
          current = "";
        }
        parts.push(s.slice(0, at).trim());
        s = s.slice(at).trim();
      }
      if (current && current.length + 1 + s.length > MAX_PART_CHARS) {
        parts.push(current);
        current = s;
      } else {
        current = current ? `${current} ${s}` : s;
      }
    }
    if (current) parts.push(current);
    return parts;
  }

  ns.split = { splitLong };
})();

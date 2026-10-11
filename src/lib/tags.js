// Теги форматирования в тексте для модели: «Read <t1>the docs</t1> before running
// <t2>npm install</t2>.» По ним перевод раскладывается обратно по ссылкам, жирному и коду абзаца.
//
// Нужен и service worker'у (проверить ответ модели), и content script'у (собрать текст ряда и
// разложить перевод), поэтому это обычный скрипт без export: content внедряет его файлом, а
// background подключает через import "./tags.js" ради побочного эффекта. Функции — в
// globalThis.__ollamaTranslator.tags.
(() => {
  // модели иногда пишут <T1> или </ t1>
  const TAG_RE = /<\s*(\/?)\s*t(\d+)\s*>/gi;

  // → [{ close, id, index, end }] — разметка тегов по порядку
  function tokens(text) {
    return Array.from(text.matchAll(TAG_RE), (m) => ({
      close: m[1] === "/",
      id: Number(m[2]),
      index: m.index,
      end: m.index + m[0].length,
    }));
  }

  const wrapTag = (id, text) => `<t${id}>${text}</t${id}>`;

  const hasTags = (text) => tokens(text).length > 0;

  // Те же теги в том же порядке. Текст для модели собран так, что его теги идут парами
  // <tN>…</tN> без вложенности, каждый по разу, — значит, и в переводе так же.
  function sameTags(source, translation) {
    const seq = (text) => tokens(text).map((t) => (t.close ? -t.id : t.id)).join();
    return seq(source) === seq(translation);
  }

  // → [{ id, text }]: обычный текст (id: null) и содержимое тегов по порядку. Содержимое тега
  // есть всегда, даже пустое, обычный текст — только непустой. Теги — парами (см. sameTags).
  function splitTags(text) {
    const pieces = [];
    let at = 0;
    for (const t of tokens(text)) {
      const piece = text.slice(at, t.index);
      if (t.close) pieces.push({ id: t.id, text: piece });
      else if (piece) pieces.push({ id: null, text: piece });
      at = t.end;
    }
    if (at < text.length) pieces.push({ id: null, text: text.slice(at) });
    return pieces;
  }

  const stripTags = (text) => text.replace(TAG_RE, "");

  // → [[начало, конец]] каждого тега вместе с разметкой: текст внутри резать нельзя.
  function tagSpans(text) {
    const spans = [];
    let open = null;
    for (const t of tokens(text)) {
      if (!t.close) open = t;
      else if (open?.id === t.id) {
        spans.push([open.index, t.end]);
        open = null;
      }
    }
    return spans;
  }

  (globalThis.__ollamaTranslator ??= {}).tags = {
    wrapTag,
    hasTags,
    sameTags,
    splitTags,
    stripTags,
    tagSpans,
  };
})();

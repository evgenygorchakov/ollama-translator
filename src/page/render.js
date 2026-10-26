// Вставка и удаление перевода. Текст модели — недоверенный: только textContent и Text.data.
//
// Перевод встаёт вместо оригинала — в существующие текстовые узлы ряда: узлы страницы не
// переносим, не оборачиваем и не удаляем (React и Vue держат на них ссылки и падают на
// removeChild), меняем только их data. Наш span после ряда — только для ⚠ и для перевода
// абзаца, который на месте не разложить (модель испортила теги).
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const { tags } = ns;

  // { lang } — из настроек, приходит с командой toggle
  let config = { lang: "ru" };
  // span'ы, которые вставили мы, — чтобы отличить их от копий, сделанных страницей
  const created = new WeakSet();
  // Текстовые узлы, куда мы записали перевод: узел → { original, text }. Map, а не WeakMap:
  // removeAll обходит все. Узлы забываем вместе с их сегментом, так что отцепленные не копятся.
  const replaced = new Map();

  function configure(next) {
    config = next;
  }

  // ---------- Вместо оригинала ----------

  // Исходный текст узла: если в нём наш перевод — оригинал. Если страница его переписала, её
  // текст новее.
  function sourceOf(node) {
    const r = replaced.get(node);
    return r && node.data === r.text ? r.original : node.data;
  }

  function write(node, text) {
    replaced.set(node, { original: sourceOf(node), text });
    if (node.data !== text) node.data = text;
  }

  // Страница сама записала в узел (свои записи content.js от наблюдателя прячет): её текст
  // новее, даже если совпал с нашим. Так бывает с пустой строкой — узлы ряда, кроме первого, мы
  // опустошаем, а страница могла очистить узел и сама. Оригинал в такой узел не вернём.
  function forgetNode(node) {
    replaced.delete(node);
  }

  // Страница записала в узел с нашим переводом его же оригинал — перерисовала тот же текст
  // (React, виртуальный список). Тогда возвращаем перевод → true.
  function rewrite(node) {
    const r = replaced.get(node);
    if (!r || node.data !== r.original) return false;
    if (r.text !== r.original) node.data = r.text;
    return true;
  }

  // Оригинал возвращаем, только если в узле всё ещё наш текст.
  function restoreNode(node) {
    const r = replaced.get(node);
    if (!r) return;
    replaced.delete(node);
    if (node.data === r.text) node.data = r.original;
  }

  function restore(seg) {
    for (const node of seg.nodes) restoreNode(node);
  }

  // Узел с текстом, а не из одних пробелов. Общее с segment.js: перевод раскладывается по тем
  // же узлам, по которым он строит слоты.
  const hasText = (node) => /\S/.test(sourceOf(node));

  // Перевод по слотам ряда (segment.js): содержимое тега — в слот с тем же номером, обычный
  // текст — в обычный слот между теми же тегами. Если в оригинале там ничего не было (модель
  // вставила слова между двумя ссылками), — в соседний слот: до первого тега — в него, дальше — в
  // предыдущий тег. Одни пробелы без слота пропускаем: пробел на странице и так есть.
  // → текст для каждого слота или null, если модель испортила теги.
  function layout(seg, text) {
    const { slots } = seg;
    if (slots.every((slot) => slot.id === null)) return [text];
    if (!tags.sameTags(seg.parts.join(" "), text)) return null;
    const byId = new Map(); // номер тега → слот
    const plainAfter = new Map(); // сколько тегов перед обычным слотом → слот
    let tagsBefore = 0;
    slots.forEach((slot, i) => {
      if (slot.id === null) {
        plainAfter.set(tagsBefore, i);
      } else {
        byId.set(slot.id, i);
        tagsBefore++;
      }
    });
    const out = slots.map(() => "");
    let neighbor = slots.findIndex((slot) => slot.id !== null);
    tagsBefore = 0;
    for (const piece of tags.splitTags(text)) {
      let i;
      if (piece.id !== null) {
        i = neighbor = byId.get(piece.id);
        tagsBefore++;
      } else {
        i = plainAfter.get(tagsBefore);
        if (i === undefined) {
          if (!/\S/.test(piece.text)) continue;
          i = neighbor;
        }
      }
      out[i] += piece.text;
    }
    return out;
  }

  // В каждом слоте текст — в первый узел с текстом; остальные узлы слота пустеют, пробельные
  // между ними не трогаем. Пробел на краю слота ставим, если он есть в переводе или в оригинале:
  // модель могла склеить слово с соседней ссылкой или вставить слова там, где пробела не было.
  // Слот из одних пробелов (между двумя ссылками) меняем, только если для него есть слова. Код
  // (keep) остаётся оригиналом.
  function replace(seg, texts) {
    seg.slots.forEach((slot, i) => {
      if (slot.keep) return;
      const text = texts[i];
      const words = /\S/.test(text);
      const filled = slot.nodes.filter(hasText);
      if (!filled.length && !words) {
        slot.nodes.forEach(restoreNode); // слова от прошлой записи
        return;
      }
      const nodes = filled.length ? filled : slot.nodes.slice(0, 1);
      const lead = sourceOf(nodes[0]).match(/^\s*/)[0];
      const trail = sourceOf(nodes[nodes.length - 1]).match(/\s*$/)[0];
      const value = words
        ? (/^\s/.test(text) ? "" : lead) + text + (/\s$/.test(text) ? "" : trail)
        : lead || trail; // слова слота модель перенесла в соседние — пробел оставляем
      nodes.forEach((node, j) => write(node, j ? "" : value));
    });
  }

  // узлы, где должен стоять перевод: с текстом и не в коде
  const targets = (seg) => seg.slots.flatMap((slot) => (slot.keep ? [] : slot.nodes.filter(hasText)));

  // Ряд тот же, а текстовые узлы другие: фреймворк пересоздал их с тем же текстом. В старых,
  // где ещё наш перевод, возвращаем оригинал и забываем их. fresh — тот же ряд из нового скана.
  function setNodes(seg, fresh) {
    for (const node of seg.nodes) if (!fresh.nodes.includes(node)) restoreNode(node);
    seg.nodes = fresh.nodes;
    seg.slots = fresh.slots;
  }

  // ---------- Под оригиналом и ⚠ ----------

  // Перевод — блок после якоря ряда. ⚠ — строчный, ему место в конце ряда: у строки, которая
  // кончается <br> (тогда якорь — он), — перед ним. Блок же — после <br>: иначе <br> между
  // блоком и следующей строкой дал бы лишнюю пустую строку.
  function ensureSpan(seg, inline) {
    if (!seg.span?.isConnected) {
      seg.span = document.createElement("span");
      created.add(seg.span);
      seg.span.setAttribute("data-ot", "");
    }
    const { span, anchor } = seg;
    if (inline && anchor.localName === "br") {
      if (span.nextSibling !== anchor) anchor.before(span);
    } else if (anchor.nextSibling !== span) {
      anchor.after(span);
    }
    span.lang = config.lang;
    span.onclick = null;
    span.removeAttribute("title");
    return span;
  }

  function removeSpan(seg) {
    seg.span?.remove();
    seg.span = null;
  }

  // ---------- Сегмент ----------

  function setTranslation(seg, text) {
    const texts = seg.inPlace ? layout(seg, text) : null;
    if (texts) {
      removeSpan(seg); // ⚠ или перевод под оригиналом от прошлой попытки
      replace(seg, texts);
      return;
    }
    // Модель испортила теги или текст страницы похож на них (segment.js): на месте остаётся
    // оригинал со ссылками, а под ним — перевод без тегов.
    restore(seg);
    const span = ensureSpan(seg, false);
    span.className = "ot-tr";
    span.textContent = seg.inPlace ? tags.stripTags(text) : text;
  }

  // Оригинал при ошибке остаётся на месте, ⚠ — после ряда.
  function setError(seg, message, onRetry) {
    restore(seg);
    const span = ensureSpan(seg, true);
    span.className = "ot-tr ot-error";
    span.textContent = "⚠";
    span.title = `Translation failed: ${message}\nClick to retry`;
    span.onclick = (e) => {
      // блок может быть ссылкой или кнопкой — клик не должен уходить дальше
      e.preventDefault();
      e.stopPropagation();
      onRetry();
    };
  }

  // Стоит ли перевод на месте оригинала, а не под ним: страница могла переписать узлы.
  function isReplaced(seg) {
    if (seg.span || !seg.inPlace) return false;
    const nodes = targets(seg);
    return nodes.length > 0 && nodes.every((n) => n.isConnected && replaced.get(n)?.text === n.data);
  }

  // Виден ли перевод или ⚠: страница могла выкинуть span при перерисовке или переписать узлы.
  function isShown(seg) {
    return seg.span ? seg.span.isConnected : isReplaced(seg);
  }

  function remove(seg) {
    removeSpan(seg);
    restore(seg);
  }

  function removeAll() {
    for (const el of document.querySelectorAll("[data-ot]")) el.remove();
    for (const [node, r] of replaced) if (node.data === r.text) node.data = r.original;
    replaced.clear();
  }

  // Копии наших span'ов внутри root: страница склонировала блок с переводом (карусели,
  // шаблоны строк) или пересобрала его через innerHTML. Сами они не уйдут, а в копию блока
  // мы вставим свой перевод — вышло бы два. keep(el) — оставить копию на месте.
  function removeCopies(root, keep) {
    for (const el of root.querySelectorAll("[data-ot]")) {
      if (!created.has(el) && !keep(el)) el.remove();
    }
  }

  ns.render = {
    configure,
    sourceOf,
    hasText,
    setTranslation,
    setError,
    setNodes,
    forgetNode,
    rewrite,
    isReplaced,
    isShown,
    remove,
    removeAll,
    removeCopies,
  };
})();

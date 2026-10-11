// Поиск переводимых фрагментов в DOM. Обычный скрипт (не модуль): экспорт через
// window.__ollamaTranslator.segment.
//
// Фрагмент (segment) — непрерывный «ряд» строчного содержимого внутри блочного элемента:
// у листового <p> это всё его содержимое, а у <li>Текст<ul>…</ul></li> — только «Текст»
// (вложенный список станет своими фрагментами). Перевод встаёт на место текста ряда или
// вставляется сразу после него.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const { tags, split, render } = ns;

  const BLOCK_TAGS = new Set([
    "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "DT", "DD",
    "BLOCKQUOTE", "FIGCAPTION", "CAPTION", "SUMMARY",
  ]);
  // localName: у SVG/MathML он в нижнем регистре, у HTML — тоже
  const SKIP_TAGS = new Set([
    "script", "style", "noscript", "pre", "textarea", "input", "select", "svg", "math",
    "iframe", "template", "object", "canvas", "video", "audio",
  ]);
  // Строчный код внутри абзаца переводим вместе с абзацем (модель его сохранит, а на месте
  // оставим оригинал), но фрагмент, где латиница есть только в коде, пропускаем.
  const CODE_SELECTOR = "code, kbd, samp";
  // Элементы форматирования. Те, что выделяют часть текста ряда (ссылка, жирное или код посреди
  // абзаца), помечаются для модели тегами <t1>…</t1> (lib/tags.js), и перевод раскладывается по
  // ним обратно. Сюда же — строчные боксы со своими рамкой, фоном и размером (кнопка, бейдж,
  // чип): иначе весь перевод ряда мог бы встать в такой бокс. Остальные строчные обёртки (span,
  // font…) прозрачны.
  const FORMAT_TAGS = new Set([
    "a", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup",
    "code", "kbd", "samp", "var", "abbr", "cite", "q", "dfn", "time",
  ]);
  const INLINE_BOXES = new Set(["inline-block", "inline-flex", "inline-grid", "inline-table"]);

  const LATIN = /[A-Za-z]/g;
  const CYRILLIC = /[Ѐ-ӿ]/g;

  let displayCache = new WeakMap();
  function displayOf(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el).display;
      displayCache.set(el, d);
    }
    return d;
  }

  // Блок — элемент со своим box, которому принадлежат ряды. Теги из BLOCK_TAGS — блоки, даже
  // строчные (пункты меню), но не с display: contents: box'а нет, IntersectionObserver такой
  // элемент не увидит. Его ряды принадлежат блоку выше, а делить ряды он продолжает (splitsRows).
  function isBlock(el) {
    const d = displayOf(el);
    if (d === "contents") return false;
    return BLOCK_TAGS.has(el.tagName) || (!d.startsWith("inline") && d !== "none");
  }

  function isSkipped(el) {
    return (
      SKIP_TAGS.has(el.localName) ||
      el.hasAttribute("data-ot") ||
      el.getAttribute("translate") === "no" ||
      el.classList.contains("notranslate") ||
      (el.isContentEditable && !el.parentElement?.isContentEditable) ||
      displayOf(el) === "none"
    );
  }

  function nearestBlock(node, root) {
    let el = node.parentElement;
    while (el && el !== root && !isBlock(el)) el = el.parentElement;
    return el ?? root;
  }

  // Блок, которому принадлежит элемент (сам элемент, если он блочный; body — блок всегда).
  function blockOf(el) {
    return el === document.body || isBlock(el) ? el : nearestBlock(el, document.body);
  }

  // display запоминается до resetCache(): его вызывают перед каждым проходом (первичный скан,
  // обработка мутаций), а не в каждой функции — общие предки и блоки проход считает один раз.
  // Стили между проходами могли поменяться.
  function resetCache() {
    displayCache = new WeakMap();
  }

  // Лежит ли элемент (или кто-то из предков) в пропускаемом поддереве.
  function isExcluded(el) {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (isSkipped(e)) return true;
    }
    return false;
  }

  function topChild(node, block) {
    while (node.parentNode !== block) node = node.parentNode;
    return node;
  }

  // Делит ли узел ряды: блочный элемент или тег из BLOCK_TAGS без box'а — <li> с
  // display: contents остаётся отдельным пунктом. Наш span с переводом тоже display: block,
  // но границей не считается: текст, дописанный после него, — продолжение того же ряда.
  // Вынесенный из потока (position: absolute или fixed, float) — тоже: ряд его обтекает. Так
  // прячут текст для скринридеров, в том числе внутри ссылок посреди абзаца.
  function splitsRows(node) {
    if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute("data-ot")) return false;
    if (!BLOCK_TAGS.has(node.tagName) && !isBlock(node)) return false;
    const { position, cssFloat } = getComputedStyle(node);
    return position !== "absolute" && position !== "fixed" && cssFloat === "none";
  }

  // Делит ли ряды узел или что-то в его строчном содержимом: блок внутри <span> делит ряды
  // так же, как рядом с ним. Внутрь блоков не заходим (вынесенный из потока не делит ряды, что
  // бы в нём ни было), в пропускаемое и скрытое — тоже.
  function hasRowSplit(node) {
    if (splitsRows(node)) return true;
    if (node.nodeType !== Node.ELEMENT_NODE || isSkipped(node) || isBlock(node)) return false;
    for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
      if (hasRowSplit(child)) return true;
    }
    return false;
  }

  // Делит ли ряды кто-то из предков узла ниже ancestor. Блочными они быть не могут по
  // построению, а <li> с display: contents — могут.
  function splitsAbove(node, ancestor) {
    for (let el = node.parentNode; el !== ancestor; el = el.parentNode) {
      if (splitsRows(el)) return true;
    }
    return false;
  }

  // Кончается ли ряд между соседними узлами блока a и b (a раньше). Граница может быть и
  // внутри строчной обёртки: в <a><span>Title</span><div>…</div><span>Meta</span></a> у Title
  // и Meta общий верхний потомок блока, но это два ряда. → узел, после которого ряд кончается
  // (предок a под общим с b предком), или null — ряд продолжается.
  function rowEnd(a, b, block) {
    let common = b.parentNode;
    while (common !== block && !common.contains(a)) common = common.parentNode;
    const from = topChild(a, common);
    const to = topChild(b, common);
    if (splitsAbove(a, common) || splitsAbove(b, common)) return from;
    for (let n = from.nextSibling; n !== to; n = n.nextSibling) if (hasRowSplit(n)) return from;
    return null;
  }

  // Текст узла без нашего перевода: иначе повторное сканирование увидело бы русский текст,
  // сняло бы фрагмент, вернуло бы оригинал и перевело снова — текст мигал бы. Непустой узел —
  // как в render: слоты строим по тем же узлам, по которым он раскладывает перевод.
  const { sourceOf, hasText } = render;

  function count(text, re) {
    return text.match(re)?.length ?? 0;
  }

  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  // элементы форматирования между узлом и блоком, внешние первыми
  function formatting(node, block) {
    const list = [];
    for (let el = node.parentElement; el && el !== block; el = el.parentElement) {
      if (FORMAT_TAGS.has(el.localName) || INLINE_BOXES.has(displayOf(el))) list.push(el);
    }
    return list.reverse();
  }

  const inCode = (node) => Boolean(node.parentElement.closest(CODE_SELECTOR));

  // Слоты ряда для перевода на месте: обычный текст между тегами и содержимое каждого тега, со
  // своими текстовыми узлами. Тег получает внешний элемент форматирования, который выделяет не
  // весь текст ряда: в обёртке всего ряда (<li><a>Home</a></li>) перевод и так останется.
  // Форматирование внутри тега (<a>…<b>…</b></a>) не сохраняется. keep — в слоте только код:
  // на месте оставляем оригинал, как бы его ни переписала модель.
  // → [{ id: number | null, nodes, keep }]
  function makeSlots(nodes, block) {
    const filled = nodes.filter(hasText);
    const common = formatting(filled[0], block).filter((el) => filled.every((n) => el.contains(n)));
    const tagged = new Set();
    for (const node of filled) {
      const el = formatting(node, block).find((e) => !common.includes(e));
      if (el) tagged.add(el);
    }
    const slots = [];
    let lastEl;
    let nextId = 1;
    for (const node of nodes) {
      // узел из одних пробелов — в слот своего тега, если он внутри тега
      const el = formatting(node, block).find((e) => tagged.has(e)) ?? null;
      if (slots.length && el === lastEl) slots[slots.length - 1].nodes.push(node);
      else slots.push({ id: el ? nextId++ : null, nodes: [node], keep: false });
      lastEl = el;
    }
    for (const slot of slots) {
      slot.keep = slot.id !== null && slot.nodes.filter(hasText).every(inCode);
    }
    return slots;
  }

  const slotText = ({ id, nodes }) => {
    const text = nodes.map(sourceOf).join("");
    return id === null ? text : tags.wrapTag(id, text);
  };

  // nodes — текстовые узлы ряда; anchor — узел, после которого ряд кончается: <br> или предок
  // последнего узла.
  function makeSegment(block, nodes, anchor) {
    const text = normalize(nodes.map(sourceOf).join(""));
    const codeFreeText = nodes.filter((node) => !inCode(node)).map(sourceOf).join("");
    const latin = count(codeFreeText, LATIN);
    if (latin < 2 || count(text, CYRILLIC) >= latin) return null;
    // текст страницы, похожий на наши теги, раскладка приняла бы за разметку — такой ряд под оригиналом
    const slots = tags.hasTags(text) ? null : makeSlots(nodes, block);
    return {
      block,
      anchor, // ⚠ и перевод под рядом вставим после него
      nodes,
      inPlace: Boolean(slots),
      slots,
      // без элементов форматирования тегов нет, и текст тот же, что без слотов
      parts: split.splitLong(slots ? normalize(slots.map(slotText).join("")) : text),
    };
  }

  // → [{ block, anchor, nodes, inPlace, slots, parts: string[] }] в порядке документа:
  // фрагменты блоков внутри root. nodes — текстовые узлы ряда; inPlace — перевод встанет на их
  // место, по слотам (makeSlots), а в parts тогда теги. У строчного root своих рядов нет — его
  // текст входит в ряды блока выше.
  // opts.ownRows — только ряды самого root (блока), без вложенных блоков: хватает, когда
  // поменялось строчное содержимое root, а не поддерево. <br> тоже делит ряды: каждая строка
  // переводится отдельно, потому что текст через <br> не перенести, не двигая узлы.
  function findSegments(root = document.body, { ownRows = false } = {}) {
    if (isExcluded(root)) return [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (isSkipped(node) || (ownRows && isBlock(node))) return NodeFilter.FILTER_REJECT;
        return node.tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });

    // блок → его текстовые узлы и <br>, в порядке документа
    const rootIsBlock = root === document.body || isBlock(root);
    const byBlock = new Map();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const block = nearestBlock(node, root);
      if (block === root && !rootIsBlock) continue;
      let list = byBlock.get(block);
      if (!list) byBlock.set(block, (list = []));
      list.push(node);
    }

    const segments = [];
    for (const [block, nodes] of byBlock) {
      let run = [];
      // anchor по умолчанию — ряд кончается вместе с блоком
      const close = (anchor = null) => {
        const last = run[run.length - 1];
        const seg = last ? makeSegment(block, run, anchor ?? topChild(last, block)) : null;
        if (seg) segments.push(seg);
        run = [];
      };
      for (const node of nodes) {
        const end = run.length ? rowEnd(run[run.length - 1], node, block) : null;
        if (end) close(end);
        if (node.tagName === "BR") close(node);
        else run.push(node);
      }
      close();
    }

    // по первому узлу: якорь строки внутри <font>…<br>…</font> — <br>, а последней — сам <font>
    segments.sort((a, b) =>
      a === b
        ? 0
        : a.nodes[0].compareDocumentPosition(b.nodes[0]) & Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
    );
    return segments;
  }

  ns.segment = { findSegments, blockOf, isBlock, isExcluded, resetCache };
})();

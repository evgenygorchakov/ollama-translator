// Основной текст страницы для краткого содержания: без меню, боковых колонок, подвала, форм и
// скрытого. Обычный скрипт: функции — в window.__ollamaTranslator.summaryExtract.
(() => {
  const ns = (window.__ollamaTranslator ??= {});

  // Корень с основным текстом — не меньше стольких символов, иначе весь body.
  const MIN_ROOT_CHARS = 500;
  // Поддеревья, которые не читаем. header пропускаем отдельно — только шапку сайта (isSiteHeader),
  // form и aria-hidden — тоже отдельно (WRAPPER_SELECTOR). hidden="until-found" — свёрнутое, но
  // находимое поиском по странице, его читаем. [data-ot] — разметка перевода страницы
  // (page/render.js): ⚠ и перевод под оригиналом, а оригинал и так на месте.
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object",
    "video", "audio", "img", "picture", "input", "select", "textarea", "button",
    "nav", "aside", "footer", "dialog", "[hidden]:not([hidden='until-found' i])",
    "[aria-modal='true']", "[data-ot]",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
    "[role='search']", "[role='menu']", "[role='menubar']", "[role='toolbar']", "[role='dialog']",
    "[role='alertdialog']", "[contenteditable='true']",
  ].join(", ");
  // Обычно это поиск, подписка, иконки — их не читаем. Но бывает, что они оборачивают всю
  // страницу: ASP.NET WebForms кладёт её в form, а открытое модальное окно (cookie-баннер) ставит
  // aria-hidden всему приложению. Такую обёртку — больше половины видимого текста корня (см.
  // visibleChars) — читаем.
  const WRAPPER_SELECTOR = "form, [aria-hidden='true']";
  // white-space-collapse, при которых перенос строки в тексте виден. При остальных перенос в
  // исходнике HTML — просто пробел.
  const KEEPS_BREAKS = new Set(["preserve", "preserve-breaks", "break-spaces"]);
  // Перед и после них — пустая строка: модели легче видеть заголовки и абзацы.
  const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table"]);

  // Самый большой article, если он хотя бы вдвое больше следующего (лента из карточек, комментарии
  // — тоже article), иначе main, иначе body (у XML-документа его нет — тогда корень).
  function pickRoot() {
    const body = document.body ?? document.documentElement;
    const main = document.querySelector("main, [role='main']");
    const articles = [...(main ?? body).querySelectorAll("article")]
      .map((el) => ({ el, chars: el.textContent.length }))
      .sort((a, b) => b.chars - a.chars);
    const [first, second] = articles;
    if (first && first.chars >= MIN_ROOT_CHARS && (!second || first.chars >= 2 * second.chars)) {
      return first.el;
    }
    if (main && main.textContent.length >= MIN_ROOT_CHARS) return main;
    return body;
  }

  // шапка внутри статьи — с заголовком, её читаем
  function isSiteHeader(el) {
    return el.localName === "header" && !el.closest("article, main, [role='main']");
  }

  // Что ставить вокруг текста элемента: блок — с новой строки, ячейка таблицы — через пробел.
  function gapOf(el, display) {
    if (PARAGRAPH_TAGS.has(el.localName)) return "\n\n";
    if (display === "table-cell") return " ";
    return display.startsWith("inline") || display === "contents" ? "" : "\n";
  }

  // Текст поддерева в out (массив строк). Пункты списков — с «- », вложенные списки — плоско.
  // Открытые shadow root читаем вместо light DOM, а слоты в них — по их содержимому; закрытые
  // не видны. breaks — переносы строк в тексте node видны (KEEPS_BREAKS); wrapperChars — от
  // скольких символов видимого текста form и aria-hidden считаем обёрткой страницы
  // (WRAPPER_SELECTOR).
  function collect(node, out, { breaks, wrapperChars }) {
    const children =
      node.localName === "slot" && node.assignedNodes().length
        ? node.assignedNodes()
        : (node.shadowRoot ?? node).childNodes;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(breaks ? child.data : child.data.replace(/[\r\n]+/g, " "));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.localName === "br") {
        out.push("\n");
        continue;
      }
      if (child.matches(SKIP_SELECTOR) || isSiteHeader(child)) continue;
      if (child.matches(WRAPPER_SELECTOR) && visibleChars(child, wrapperChars) < wrapperChars) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const opts = { breaks: KEEPS_BREAKS.has(style.whiteSpaceCollapse), wrapperChars };
      if (child.localName === "li") {
        // <li><p>…</p></li>: маркер — перед текстом, а не перед пустой строкой абзаца
        const inner = [];
        collect(child, inner, opts);
        const text = normalize(inner.join(""));
        if (text) out.push("\n- ", text.replace(/\n+/g, "\n"), "\n");
        continue;
      }
      const gap = gapOf(child, style.display);
      out.push(gap);
      collect(child, out, opts);
      out.push(gap);
    }
  }

  // Длина видимого текста: без скриптов и стилей — на SPA JSON с данными страницы бывает больше
  // самого текста. textContent короче min — дальше не считаем: innerText почти никогда не длиннее,
  // а для него нужна раскладка. У элементов не из HTML (XML-документ) innerText нет — textContent.
  function visibleChars(el, min = 0) {
    const all = el.textContent.length;
    return all < min ? all : (el.innerText ?? el.textContent).length;
  }

  // Пробелы и пустые строки: подряд — одной. Им же чистим выделенный текст.
  function normalize(text) {
    return text
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // → { title, text }
  function page() {
    const root = pickRoot();
    const out = [];
    collect(root, out, {
      breaks: KEEPS_BREAKS.has(getComputedStyle(root).whiteSpaceCollapse),
      wrapperChars: visibleChars(root) / 2,
    });
    return { title: document.title.trim(), text: normalize(out.join("")) };
  }

  ns.summaryExtract = { page, normalize };
})();

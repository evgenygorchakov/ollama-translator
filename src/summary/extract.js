// Основной текст страницы для краткого содержания: без меню, боковых колонок, подвала, форм и
// скрытого. Обычный скрипт: функции — в window.__ollamaTranslator.summaryExtract.
(() => {
  const ns = (window.__ollamaTranslator ??= {});

  // Корень с основным текстом — не меньше стольких символов, иначе весь body.
  const MIN_ROOT_CHARS = 500;
  // Поддеревья, которые не читаем. header пропускаем отдельно — только шапку сайта (isSiteHeader).
  const SKIP_SELECTOR = [
    "script", "style", "noscript", "template", "svg", "math", "canvas", "iframe", "object",
    "video", "audio", "img", "picture", "input", "select", "textarea", "button", "form",
    "nav", "aside", "footer", "dialog", "[hidden]", "[aria-hidden='true']", "[aria-modal='true']",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
    "[role='search']", "[role='menu']", "[role='menubar']", "[role='toolbar']", "[role='dialog']",
    "[role='alertdialog']", "[contenteditable='true']",
  ].join(", ");
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
  // не видны.
  function collect(node, out) {
    const children =
      node.localName === "slot" && node.assignedNodes().length
        ? node.assignedNodes()
        : (node.shadowRoot ?? node).childNodes;
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) {
        out.push(child.data);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.localName === "br") {
        out.push("\n");
        continue;
      }
      if (child.matches(SKIP_SELECTOR) || isSiteHeader(child)) continue;
      const style = getComputedStyle(child);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (child.localName === "li") {
        // <li><p>…</p></li>: маркер — перед текстом, а не перед пустой строкой абзаца
        const inner = [];
        collect(child, inner);
        const text = normalize(inner.join(""));
        if (text) out.push("\n- ", text.replace(/\n+/g, "\n"), "\n");
        continue;
      }
      const gap = gapOf(child, style.display);
      out.push(gap);
      collect(child, out);
      out.push(gap);
    }
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
    const out = [];
    collect(pickRoot(), out);
    return { title: document.title.trim(), text: normalize(out.join("")) };
  }

  ns.summaryExtract = { page, normalize };
})();

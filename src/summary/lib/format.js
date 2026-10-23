// Ответ модели → блоки для панели: абзацы, пункты, подзаголовки. Модель просят писать простой
// текст со строками «- » и «## », но Markdown она пишет всё равно — его снимаем.
//
// Нужен только content script'у (panel.js), поэтому это обычный скрипт без export: панель
// внедряется вместе с ним. Функции — в globalThis.__ollamaTranslator.summaryFormat.
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});

  const HEADING = /^#{1,6}\s+/;
  // номер пункта — до двух цифр: «2024. Год начался…» — абзац, а не пункт
  const BULLET = /^(?:[-*•–—]|\d{1,2}[.)])\s+/;
  // строка целиком жирная («**Итоги:**») — модель так пишет подзаголовки
  const BOLD_LINE = /^\*\*[^*]+\*\*:?$/;

  function unmark(line) {
    return line
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
  }

  // → [{ kind: "p" | "li" | "h", text }]
  function blocks(text) {
    const out = [];
    for (const raw of String(text ?? "").split("\n")) {
      const line = raw.trim();
      let kind = "p";
      let rest = line;
      if (HEADING.test(line)) {
        kind = "h";
        rest = line.replace(HEADING, "");
      } else if (BULLET.test(line)) {
        kind = "li";
        rest = line.replace(BULLET, "");
      } else if (BOLD_LINE.test(line)) {
        kind = "h";
      }
      const clean = unmark(rest);
      if (clean) out.push({ kind, text: clean });
    }
    return out;
  }

  // Для «Копировать»: тот же текст без Markdown, пункты — «- », перед подзаголовком пустая строка.
  function plain(text) {
    return blocks(text)
      .map((b) => (b.kind === "li" ? `- ${b.text}` : b.kind === "h" ? `\n${b.text}` : b.text))
      .join("\n")
      .trim();
  }

  ns.summaryFormat = { blocks, plain };
})();

// Всплывашка с переводом выделенного. Внедряется по клику в контекстном меню, переводит через
// порт "translate-selection". От перевода страницы не зависит. Текст модели — только textContent.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  ns.selection?.dispose(); // осиротевший экземпляр после перезагрузки расширения

  const PORT_NAME = "translate-selection";
  const MARGIN = 8;

  const STYLE = `
    :host { all: initial; }
    .box {
      --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de;
      --btn-hover: #f3f4f6; --error: #cf222e; --accent: #0969da;
      box-sizing: border-box;
      width: max-content; min-width: 220px; max-width: min(420px, calc(100vw - ${2 * MARGIN}px));
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      .box {
        --bg: #22272e; --fg: #e6edf3; --muted: #9198a1; --border: #444c56;
        --btn-hover: #2d333b; --error: #ff7b72; --accent: #4493f8;
      }
    }
    .head {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 4px 4px 12px; border-bottom: 1px solid var(--border);
      color: var(--muted); font-size: 12px;
    }
    .title { flex: 1; }
    button {
      all: unset; cursor: pointer; padding: 2px 8px; border-radius: 4px;
      color: var(--muted); font: inherit;
    }
    button:hover { background: var(--btn-hover); color: var(--fg); }
    button:focus-visible { outline: 2px solid var(--accent); }
    button[hidden] { display: none; }
    .close { font-size: 16px; line-height: 1; }
    .body {
      padding: 8px 12px 10px; max-height: 50vh; overflow: auto;
      white-space: pre-wrap; overflow-wrap: anywhere; user-select: text;
    }
    .status { color: var(--muted); }
    .error { color: var(--error); }
    .retry { margin-top: 6px; color: var(--accent); padding: 2px 0; }
  `;

  let current = null; // { host, box, body, copyBtn, closeBtn, conn, anchor, text, translation }

  function clean(text) {
    return String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // для сравнения с menuText: Chrome теряет в нём переносы строк
  function squash(text) {
    return String(text ?? "").replace(/\s+/g, " ").trim();
  }

  // → { text, anchor } — anchor() отдаёт текущую рамку выделения в координатах окна, или null.
  // Рамку берём заново при каждой прокрутке: так всплывашка едет за текстом и в прокручиваемых
  // блоках, не только при прокрутке страницы.
  function readSelection(menuText) {
    // выделение внутри input/textarea Selection API не видит — берём текст и рамку поля.
    // Фокус мог остаться в поле со старым выделением, поэтому поле — если меню открыли на его
    // тексте (startsWith: длинное выделение Chrome может отдать в меню обрезанным) или если
    // на странице ничего не выделено.
    const field = document.activeElement;
    let fromField = null;
    if (field?.matches("textarea, input") && field.selectionEnd > field.selectionStart) {
      fromField = {
        text: field.value.slice(field.selectionStart, field.selectionEnd),
        anchor: () => field.getBoundingClientRect(),
      };
      const want = squash(menuText);
      if (want && squash(fromField.text).startsWith(want)) return fromField;
    }
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (fromField && !text.trim()) return fromField;
    const range = sel?.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
    const rect = range?.getBoundingClientRect();
    const anchor = rect && (rect.width || rect.height) ? () => range.getBoundingClientRect() : null;
    return { text, anchor };
  }

  // Под выделением, если не влезает — над ним; без выделения — в правом верхнем углу.
  function place() {
    const { host, box, anchor } = current;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const maxLeft = Math.max(MARGIN, vw - w - MARGIN);
    const rect = anchor?.();
    let left;
    let top;
    if (rect && (rect.width || rect.height)) {
      left = Math.min(Math.max(rect.left, MARGIN), maxLeft);
      top = rect.bottom + MARGIN;
      const above = rect.top - MARGIN - h;
      if (top + h > vh - MARGIN && above >= MARGIN) top = above;
    } else {
      // выделенный текст пропал со страницы — в угол
      left = maxLeft;
      top = MARGIN;
    }
    // выделение выше экрана, ушло из вида при прокрутке — всплывашка остаётся у края окна
    top = Math.min(Math.max(top, MARGIN), Math.max(MARGIN, vh - h - MARGIN));
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
  }

  function setBody(className, text) {
    const { body, copyBtn } = current;
    body.replaceChildren();
    const p = document.createElement("div");
    p.className = className;
    p.textContent = text;
    body.append(p);
    copyBtn.hidden = className !== "result";
    return p;
  }

  function showResult(translation) {
    current.translation = translation;
    setBody("result", translation);
    place();
  }

  // canRetry: false — повтор не поможет (текст слишком длинный, расширение перезагружено)
  function showError(message, canRetry = true) {
    showMessage("error", `Перевод не удался: ${message}`, canRetry);
  }

  function showMessage(className, text, canRetry) {
    setBody(className, text);
    if (canRetry) {
      const retry = document.createElement("button");
      retry.className = "retry";
      retry.textContent = "Повторить";
      retry.addEventListener("click", translate);
      current.body.append(retry);
    }
    place();
  }

  function stopPort() {
    current.conn?.close();
    current.conn = null;
  }

  function translate() {
    const state = current;
    stopPort();
    setBody("status", "Перевожу…");
    place();
    // после stopPort() порт ничего не вызывает — ответ всегда к этому state
    try {
      state.conn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => {
          stopPort();
          if (msg?.type === "result") showResult(msg.text);
          else if (msg?.type === "stopped") showMessage("status", "Перевод остановлен", true);
          else showError(msg?.message ?? "неизвестная ошибка", msg?.code !== "TEXT_TOO_LONG");
        },
        onDisconnect: () => {
          state.conn = null;
          showError("соединение с расширением прервалось");
        },
      });
    } catch {
      showError("расширение перезагружено, обновите страницу", false);
      return;
    }
    state.conn.post({ type: "translate", text: state.text }); // порт мёртв — onDisconnect покажет ошибку
  }

  // Буфер обмена: navigator.clipboard есть не везде (нет на http-страницах), тогда execCommand.
  async function copy() {
    const { translation, copyBtn, box } = current;
    let ok = true;
    try {
      await navigator.clipboard.writeText(translation);
    } catch {
      const area = document.createElement("textarea");
      area.value = translation;
      area.style.cssText = "position:fixed;opacity:0;";
      box.append(area);
      area.focus();
      area.select();
      try {
        ok = document.execCommand("copy"); // false — страница или браузер не дали скопировать
      } catch {
        ok = false;
      }
      area.remove();
      copyBtn.focus();
    }
    copyBtn.textContent = ok ? "Скопировано" : "Не скопировалось";
    setTimeout(() => {
      if (copyBtn.isConnected) copyBtn.textContent = "Копировать";
    }, 1500);
  }

  function onPointerDown(e) {
    if (current && !e.composedPath().includes(current.host)) close();
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && current) close();
  }

  // Клик в другом фрейме (вложенном, родительском или соседнем) сюда не доходит, но фокус
  // уходит туда — тогда закрываемся. Переход в другую вкладку или окно тоже снимает фокус, но
  // тогда фокуса нет и у документа вкладки. Если он с другого сайта и проверить нельзя —
  // закрываемся: лучше лишний раз, чем всплывашка, которую не закрыть кликом мимо.
  function focusStillInTab() {
    try {
      return window.top.document.hasFocus();
    } catch {
      return true;
    }
  }

  function onBlur() {
    setTimeout(() => {
      if (current && focusStillInTab()) close();
    });
  }

  // scroll не всплывает — ловим на перехвате, тогда видна прокрутка любого блока
  let placeFrame = 0;
  function onScrollOrResize() {
    if (!current || placeFrame) return;
    placeFrame = requestAnimationFrame(() => {
      placeFrame = 0;
      if (current) place();
    });
  }

  function close() {
    if (!current) return;
    stopPort(); // отключение порта отменяет запрос к Ollama
    current.host.remove();
    current = null;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
    window.removeEventListener("blur", onBlur);
  }

  function build() {
    const { host, shadow } = ns.shadowHost(
      "ot-selection-bubble",
      "position:fixed!important;z-index:2147483647!important;display:block!important;" +
        "margin:0!important;padding:0!important;",
      STYLE,
    );

    const box = document.createElement("div");
    box.className = "box";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Перевод выделенного");

    const head = document.createElement("div");
    head.className = "head";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Перевод";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Копировать";
    copyBtn.hidden = true;
    copyBtn.addEventListener("click", () => copy());
    const closeBtn = document.createElement("button");
    closeBtn.className = "close";
    closeBtn.textContent = "×";
    closeBtn.title = "Закрыть (Esc)";
    closeBtn.addEventListener("click", close);
    head.append(title, copyBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "body";

    box.append(head, body);
    shadow.append(box);
    return { host, box, body, copyBtn, closeBtn };
  }

  // menuText — выделение из контекстного меню (Chrome теряет в нём переносы строк);
  // inSelectionFrame — выделение в этом фрейме, его текст и положение можно взять со страницы.
  // maxChars — лимит длины из selection/background.js.
  function open(menuText, inSelectionFrame, maxChars) {
    close();
    const fromPage = inSelectionFrame ? readSelection(menuText) : { text: "", anchor: null };
    const text = clean(fromPage.text) || clean(menuText);
    current = { ...build(), anchor: fromPage.anchor, text, conn: null };
    document.documentElement.append(current.host);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });
    window.addEventListener("blur", onBlur);
    if (!inSelectionFrame) {
      // выделение во фрейме другого сайта и фокус там же: без фокуса здесь ни Esc, ни клик
      // по фрейму (через onBlur) всплывашку не закроют
      window.focus();
      current.closeBtn.focus({ preventScroll: true });
    }
    if (!text) {
      setBody("error", "Не нашёл выделенного текста");
      place();
    } else if (text.length > maxChars) {
      // без «Повторить»: повтор не поможет
      setBody("error", `Выделено слишком много: ${text.length} символов, максимум ${maxChars}`);
      place();
    } else {
      translate();
    }
  }

  // alive: false у экземпляра, осиротевшего после перезагрузки расширения
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };
  ns.selection = { open, alive, dispose: close };
})();

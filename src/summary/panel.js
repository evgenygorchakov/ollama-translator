// Панель с кратким содержанием страницы или выделенного. Внедряется по кнопке в popup или из
// контекстного меню, ответ модели получает через порт "summary" по мере генерации. От перевода
// страницы, выделенного и озвучки не зависит. Текст модели — только textContent.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  ns.summary?.dispose(); // осиротевший экземпляр после перезагрузки расширения

  const { summaryFormat: format, summaryExtract: extract } = ns;
  const PORT_NAME = "summary";
  const LENGTH_KEY = "summaryLength";
  // ключи — SUMMARY_LENGTHS из lib/prompt.js
  const LENGTHS = [
    ["short", "Коротко"],
    ["long", "Подробно"],
  ];
  const DEFAULT_LENGTH = "short";
  // Короче — сокращать нечего.
  const MIN_CHARS = 200;
  const MARGIN = 8;

  // Надписи для страницы и выделенного — по source.kind из open().
  const WORDING = {
    page: {
      title: "Краткое содержание",
      reading: "Читаю страницу…",
      parts: "Страница длинная — читаю по частям",
      partly: "Учтено начало страницы",
      whole: "Учтён весь текст страницы",
      tooShort: "На странице почти нет текста — сокращать нечего",
    },
    selection: {
      title: "Кратко о выделенном",
      reading: "Читаю выделенное…",
      parts: "Выделено много — читаю по частям",
      partly: "Учтено начало выделенного",
      whole: "Учтён весь выделенный текст",
      tooShort: "Выделено слишком мало — тут почти нечего сокращать",
    },
  };

  const STYLE = `
    :host { all: initial; }
    .panel {
      --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --border: #d0d7de;
      --btn-hover: #f3f4f6; --error: #cf222e; --accent: #0969da; --accent-fg: #ffffff;
      box-sizing: border-box; display: flex; flex-direction: column;
      width: min(400px, calc(100vw - ${2 * MARGIN}px));
      max-height: calc(100vh - ${2 * MARGIN}px);
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
      text-align: left;
    }
    @media (prefers-color-scheme: dark) {
      .panel {
        --bg: #22272e; --fg: #e6edf3; --muted: #9198a1; --border: #444c56;
        --btn-hover: #2d333b; --error: #ff7b72; --accent: #4493f8; --accent-fg: #0d1117;
      }
    }
    .head {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 4px 4px 12px; border-bottom: 1px solid var(--border);
    }
    .title { flex: 1; font-size: 13px; font-weight: 600; }
    .bar {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px; border-bottom: 1px solid var(--border); font-size: 12px;
    }
    .spacer { flex: 1; }
    button {
      all: unset; cursor: pointer; padding: 2px 8px; border-radius: 4px;
      color: var(--muted); font: inherit;
    }
    button:hover { background: var(--btn-hover); color: var(--fg); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    button[hidden] { display: none; }
    .close { font-size: 16px; line-height: 1; }
    .lengths {
      display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    }
    .lengths button { padding: 2px 10px; border-radius: 0; }
    .lengths button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); }
    .body {
      flex: 1 1 auto; min-height: 0; overflow: auto;
      padding: 10px 12px; overflow-wrap: anywhere; user-select: text;
    }
    .body p { margin: 0 0 8px; }
    .body h3 { margin: 12px 0 4px; font: inherit; font-weight: 600; }
    .body h3:first-child { margin-top: 0; }
    .body ul { margin: 0 0 8px; padding-left: 20px; }
    .body li { margin: 2px 0; }
    .body > :last-child { margin-bottom: 0; }
    .foot {
      padding: 6px 12px; border-top: 1px solid var(--border);
      color: var(--muted); font-size: 12px;
    }
    .foot[hidden] { display: none; }
    .status { color: var(--muted); }
    .error { color: var(--error); }
    .retry { margin-top: 6px; color: var(--accent); padding: 2px 0; }
  `;

  // { host, panel, body, foot, copyBtn, lengthBtns, words, source: { title, text }, length,
  //   results: { [length]: { text, cut, sent } }, sent: { used, total } | null, conn }
  // words — надписи из WORDING.
  // sent — сколько текста ушло модели в последнем запросе (сообщение source).
  let current = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function percent(part, whole) {
    return Math.max(1, Math.floor((part / whole) * 100));
  }

  // status — что идёт сейчас («Пишу…»), cut — ответ упёрся в num_ctx.
  function renderFoot(status = "", cut = false) {
    const { foot, sent, words } = current;
    const parts = [];
    if (status) parts.push(status);
    if (sent) {
      parts.push(
        sent.used < sent.total
          ? `${words.partly}: ${percent(sent.used, sent.total)}% текста`
          : words.whole,
      );
    }
    const lines = [parts.join(" · ")];
    if (cut) lines.push("Ответ обрезан: не хватило контекста модели (num_ctx в настройках)");
    foot.replaceChildren(...lines.filter(Boolean).map((line) => el("div", null, line)));
    foot.hidden = !foot.childNodes.length;
  }

  function renderText(text) {
    const nodes = [];
    let list = null;
    for (const block of format.blocks(text)) {
      if (block.kind === "li") {
        if (!list) nodes.push((list = el("ul")));
        list.append(el("li", null, block.text));
      } else {
        list = null;
        nodes.push(el(block.kind === "h" ? "h3" : "p", null, block.text));
      }
    }
    current.body.replaceChildren(...nodes);
  }

  // canRetry: false — повтор не поможет (текста нет, расширение перезагружено)
  function showMessage(className, text, canRetry) {
    const { body, copyBtn } = current;
    body.replaceChildren(el("div", className, text));
    copyBtn.hidden = true;
    if (canRetry) {
      const retry = el("button", "retry", "Повторить");
      retry.addEventListener("click", () => request(current.length));
      body.append(retry);
    }
  }

  function showError(message, canRetry = true) {
    showMessage("error", `Не получилось: ${message}`, canRetry);
    renderFoot();
  }

  function showResult(result) {
    current.sent = result.sent;
    renderText(result.text);
    current.copyBtn.hidden = false;
    renderFoot("", result.cut);
  }

  function setLength(length) {
    current.length = length;
    for (const [key, btn] of current.lengthBtns) btn.setAttribute("aria-pressed", String(key === length));
  }

  function stopPort() {
    current.conn?.close();
    current.conn = null;
  }

  function request(length) {
    const state = current;
    stopPort(); // отключение порта отменяет прежний запрос к Ollama
    setLength(length);
    const done = state.results[length];
    if (done) {
      showResult(done);
      return;
    }
    state.sent = null;
    showMessage("status", state.words.reading, false);
    renderFoot();
    // после stopPort() порт ничего не вызывает — ответ всегда к этому state и этой длине
    try {
      state.conn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => onMessage(state, length, msg),
        onDisconnect: () => {
          state.conn = null;
          showError("соединение с расширением прервалось");
        },
      });
    } catch {
      showError("расширение перезагружено, обновите страницу", false);
      return;
    }
    const { title, text } = state.source;
    state.conn.post({ type: "summarize", text, title, length }); // порт мёртв — onDisconnect покажет ошибку
  }

  // длинный текст модель читает по частям — см. summary/background.js
  function progressText({ step, part, parts }) {
    if (step === "part") return `${current.words.parts}: ${part} из ${parts}…`;
    if (step === "merge") return "Свожу заметки по частям…";
    return "Пишу краткое содержание…";
  }

  function onMessage(state, length, msg) {
    switch (msg?.type) {
      case "source":
        state.sent = { used: msg.used, total: msg.total };
        renderFoot();
        break;
      case "progress":
        showMessage("status", progressText(msg), false);
        renderFoot();
        break;
      case "partial":
        renderText(msg.text);
        renderFoot("Пишу…");
        break;
      case "result":
        stopPort();
        state.results[length] = { text: msg.text, cut: Boolean(msg.cut), sent: state.sent };
        showResult(state.results[length]);
        break;
      case "stopped":
        stopPort();
        showMessage("status", "Остановлено", true);
        renderFoot();
        break;
      case "error":
        stopPort();
        showError(msg.message ?? "неизвестная ошибка");
        break;
    }
  }

  function chooseLength(length) {
    const state = current;
    if (state.source.text.length < MIN_CHARS) return;
    // эта длина уже готова или идёт — ничего не делаем; после ошибки — повтор
    if (length === state.length && (state.conn || state.results[length])) return;
    request(length);
    saveLength(length);
  }

  async function saveLength(length) {
    try {
      await chrome.storage.local.set({ [LENGTH_KEY]: length });
    } catch {
      // расширение перезагружено — request() уже сказал об этом
    }
  }

  async function savedLength() {
    try {
      const { [LENGTH_KEY]: value } = await chrome.storage.local.get(LENGTH_KEY);
      return LENGTHS.some(([key]) => key === value) ? value : DEFAULT_LENGTH;
    } catch {
      return DEFAULT_LENGTH; // расширение перезагружено — request() скажет об этом
    }
  }

  async function copy() {
    const { results, length, copyBtn, panel } = current;
    const result = results[length];
    if (!result) return;
    const ok = await ns.copyText(format.plain(result.text), panel);
    copyBtn.focus();
    copyBtn.textContent = ok ? "Скопировано" : "Не скопировалось";
    setTimeout(() => {
      if (copyBtn.isConnected) copyBtn.textContent = "Копировать";
    }, 1500);
  }

  function close() {
    if (!current) return;
    stopPort();
    current.host.remove();
    current = null;
  }

  function build(words) {
    const { host, shadow } = ns.shadowHost(
      "ot-summary-panel",
      `position:fixed!important;top:${MARGIN}px!important;right:${MARGIN}px!important;` +
        "z-index:2147483647!important;display:block!important;margin:0!important;padding:0!important;",
      STYLE,
    );

    const panel = el("div", "panel");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", words.title);

    const head = el("div", "head");
    const closeBtn = el("button", "close", "×");
    closeBtn.title = "Закрыть (Esc)";
    closeBtn.addEventListener("click", close);
    head.append(el("span", "title", words.title), closeBtn);

    const bar = el("div", "bar");
    const lengths = el("div", "lengths");
    const lengthBtns = new Map();
    for (const [key, label] of LENGTHS) {
      const btn = el("button", null, label);
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => chooseLength(key));
      lengthBtns.set(key, btn);
      lengths.append(btn);
    }
    const copyBtn = el("button", null, "Копировать");
    copyBtn.hidden = true;
    copyBtn.addEventListener("click", () => copy());
    bar.append(lengths, el("span", "spacer"), copyBtn);

    const body = el("div", "body");
    const foot = el("div", "foot");
    foot.hidden = true;

    panel.append(head, bar, body, foot);
    shadow.append(panel);
    // Esc — только когда фокус в панели: на странице Esc может быть нужен ей самой
    host.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    });
    return { host, panel, body, foot, copyBtn, lengthBtns };
  }

  // source — { kind: "page" } или { kind: "selection", text } из summary/background.js: текст
  // страницы панель берёт сама, выделенный — оттуда (выделение могло быть во вложенном фрейме).
  // Заголовок страницы — модели для контекста, и для выделенного тоже.
  function open(source = { kind: "page" }) {
    close();
    const selection = source.kind === "selection";
    const words = WORDING[selection ? "selection" : "page"];
    const text = selection
      ? { title: document.title.trim(), text: extract.normalize(String(source.text ?? "")) }
      : extract.page();
    current = { ...build(words), words, source: text, results: {}, sent: null, conn: null };
    setLength(DEFAULT_LENGTH);
    document.documentElement.append(current.host);
    if (current.source.text.length < MIN_CHARS) {
      showMessage("status", words.tooShort, false);
      return;
    }
    const state = current;
    savedLength().then((length) => {
      if (current === state) request(length);
    });
  }

  // alive: false у экземпляра, осиротевшего после перезагрузки расширения
  const alive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };
  ns.summary = { open, alive, dispose: close };
})();

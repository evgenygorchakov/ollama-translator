// Панель с кратким содержанием страницы или выделенного и вопросами по тексту. Внедряется по
// кнопке в popup или из контекстного меню, ответ модели получает через порт "summary" по мере
// генерации: у краткого содержания и у каждого вопроса свой порт. От перевода страницы,
// выделенного и озвучки не зависит. Текст модели — только textContent.
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
  const MAX_QUESTION = 1000;
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
      ask: "Спросить о странице…",
      search: "Страница длинная — ищу ответ по частям",
    },
    selection: {
      title: "Кратко о выделенном",
      reading: "Читаю выделенное…",
      parts: "Выделено много — читаю по частям",
      partly: "Учтено начало выделенного",
      whole: "Учтён весь выделенный текст",
      tooShort: "Выделено слишком мало — тут почти нечего сокращать",
      ask: "Спросить о выделенном…",
      search: "Выделено много — ищу ответ по частям",
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
    button:disabled { opacity: 0.5; cursor: default; }
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
    .summary > :last-child, .answer > :last-child { margin-bottom: 0; }
    .turn { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
    .question {
      margin-bottom: 6px; padding: 4px 8px; border-radius: 6px;
      background: var(--btn-hover); font-weight: 600; white-space: pre-wrap;
    }
    .note { margin-top: 6px; color: var(--muted); font-size: 12px; }
    .note[hidden] { display: none; }
    .ask {
      display: flex; align-items: flex-end; gap: 6px;
      padding: 8px 12px; border-top: 1px solid var(--border);
    }
    .ask[hidden] { display: none; }
    textarea {
      flex: 1; box-sizing: border-box; min-width: 0; max-height: 120px; margin: 0;
      padding: 4px 8px; resize: none; overflow-y: auto;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px; font: inherit;
    }
    textarea::placeholder { color: var(--muted); opacity: 1; }
    textarea:focus { outline: none; border-color: var(--accent); }
    .send { padding: 5px 10px; background: var(--accent); color: var(--accent-fg); }
    .send:hover { background: var(--accent); color: var(--accent-fg); }
    .send:focus-visible { outline-offset: 1px; }
    .foot {
      padding: 6px 12px; border-top: 1px solid var(--border);
      color: var(--muted); font-size: 12px;
    }
    .foot[hidden] { display: none; }
    .status { color: var(--muted); }
    .error { color: var(--error); }
    .retry { margin-top: 6px; color: var(--accent); padding: 2px 0; }
    .retry:disabled { background: none; color: var(--accent); }
  `;

  // { host, panel, body, summaryBox, thread, foot, ask, askInput, askBtn, copyBtn, lengthBtns,
  //   words, source: { title, text }, length, results: { [length]: { text, cut, sent } },
  //   sent: { used, total } | null, conn, turns, askConn }
  // words — надписи из WORDING.
  // sent — сколько текста ушло модели в последнем запросе (сообщение source).
  // turns — вопросы по порядку: { question, answer, cut, sent, missed, node, answerBox, note };
  // answer — null, пока готового ответа нет (идёт, ошибка, остановлено); missed — { count, parts }
  // из result (см. summary/background.js) или null. askConn — порт идущего вопроса.
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

  // ответ модели → абзацы, пункты, подзаголовки
  function textNodes(text) {
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
    return nodes;
  }

  function renderText(text) {
    current.summaryBox.replaceChildren(...textNodes(text));
  }

  // Сообщение вместо текста; onRetry — для кнопки «Повторить», без него кнопки нет.
  function messageNodes(className, text, onRetry) {
    const nodes = [el("div", className, text)];
    if (onRetry) {
      const retry = el("button", "retry", "Повторить");
      retry.addEventListener("click", onRetry);
      nodes.push(retry);
    }
    return nodes;
  }

  // canRetry: false — повтор не поможет (текста нет, расширение перезагружено)
  function showMessage(className, text, canRetry) {
    const { summaryBox, copyBtn } = current;
    summaryBox.replaceChildren(
      ...messageNodes(className, text, canRetry && (() => request(current.length))),
    );
    copyBtn.hidden = true;
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

  // ---------- Вопросы ----------

  // Пока идёт ответ, другой вопрос не отправить — ни новый, ни повтор.
  function syncAsk() {
    const busy = Boolean(current.askConn);
    current.askBtn.disabled = busy;
    for (const btn of current.thread.querySelectorAll(".retry")) btn.disabled = busy;
  }

  function stopAsk() {
    current.askConn?.close();
    current.askConn = null;
    syncAsk();
  }

  // Ответ дописывается — прокрутка идёт за ним, если читатель и так был внизу.
  function keepBottom(update) {
    const { body } = current;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    update();
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  // notes — строки под ответом
  function showAnswer(turn, nodes, notes = []) {
    keepBottom(() => {
      turn.answerBox.replaceChildren(...nodes);
      turn.note.replaceChildren(...notes.map((line) => el("div", null, line)));
      turn.note.hidden = !notes.length;
    });
  }

  // canRetry — как у showMessage
  function showAnswerMessage(turn, className, text, canRetry) {
    showAnswer(turn, messageNodes(className, text, canRetry && (() => sendQuestion(turn))));
  }

  function showAnswerError(turn, message, canRetry = true) {
    showAnswerMessage(turn, "error", `Не получилось: ${message}`, canRetry);
  }

  // Под готовым ответом: сколько текста учтено, обрезан ли ответ.
  function answerNotes({ sent, cut, missed }) {
    const notes = [];
    if (sent && sent.used < sent.total) {
      notes.push(`${current.words.partly}: ${percent(sent.used, sent.total)}% текста`);
    }
    if (missed) {
      notes.push(
        `Не учтено частей текста: ${missed.count} из ${missed.parts} — модель упёрлась в предел ` +
          "длины ответа, ничего из них не выписав",
      );
    }
    if (cut) notes.push("Ответ обрезан: не хватило контекста модели (num_ctx в настройках)");
    return notes;
  }

  // Готовые вопросы и ответы до turn — история для модели.
  function historyBefore(turn) {
    const { turns } = current;
    return turns
      .slice(0, turns.indexOf(turn))
      .filter((t) => t.answer !== null)
      .map(({ question, answer }) => ({ question, answer }));
  }

  // Вопрос — модели; повтор после ошибки — тоже сюда.
  function sendQuestion(turn) {
    const state = current;
    if (state.askConn) return; // идёт ответ на другой вопрос
    Object.assign(turn, { answer: null, cut: false, sent: null, missed: null });
    showAnswerMessage(turn, "status", "Думаю…", false);
    // после stopAsk() порт ничего не вызывает — ответ всегда к этому вопросу
    try {
      state.askConn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => onAnswerMessage(turn, msg),
        onDisconnect: () => {
          state.askConn = null;
          syncAsk();
          showAnswerError(turn, "соединение с расширением прервалось");
        },
      });
    } catch {
      showAnswerError(turn, "расширение перезагружено, обновите страницу", false);
      return;
    }
    syncAsk();
    const { title, text } = state.source;
    state.askConn.post({
      type: "ask",
      text,
      title,
      question: turn.question,
      summary: state.results[state.length]?.text ?? "",
      history: historyBefore(turn),
    });
  }

  // длинный текст: поиск ответа по частям, потом ответ — см. summary/background.js
  function searchProgressText({ step, part, parts }) {
    if (step === "search") return `${current.words.search}: ${part} из ${parts}…`;
    return "Пишу ответ…";
  }

  function onAnswerMessage(turn, msg) {
    switch (msg?.type) {
      case "source":
        turn.sent = { used: msg.used, total: msg.total };
        break;
      case "progress":
        showAnswerMessage(turn, "status", searchProgressText(msg), false);
        break;
      case "partial":
        showAnswer(turn, textNodes(msg.text));
        break;
      case "result":
        stopAsk();
        Object.assign(turn, {
          answer: msg.text,
          cut: Boolean(msg.cut),
          missed: msg.missed ? { count: msg.missed, parts: msg.parts } : null,
        });
        showAnswer(turn, textNodes(msg.text), answerNotes(turn));
        break;
      case "stopped":
        stopAsk();
        showAnswerMessage(turn, "status", "Остановлено", true);
        break;
      case "error":
        stopAsk();
        showAnswerError(turn, msg.message ?? "неизвестная ошибка");
        break;
    }
  }

  function buildTurn(question) {
    const node = el("div", "turn");
    const answerBox = el("div", "answer");
    const note = el("div", "note");
    note.hidden = true;
    node.append(el("div", "question", question), answerBox, note);
    return { node, answerBox, note };
  }

  // Пока идёт ответ, следующий вопрос можно набирать, но не отправить.
  function askQuestion() {
    const { askInput, askConn, turns, thread, body } = current;
    const question = askInput.value.trim();
    if (!question || askConn) return;
    askInput.value = "";
    fitInput();
    const turn = {
      question,
      answer: null,
      cut: false,
      sent: null,
      missed: null,
      ...buildTurn(question),
    };
    turns.push(turn);
    thread.append(turn.node);
    sendQuestion(turn);
    body.scrollTop = body.scrollHeight; // к новому вопросу
  }

  // Поле растёт по тексту до max-height из STYLE, дальше прокручивается.
  function fitInput() {
    const { askInput } = current;
    askInput.style.height = "auto";
    const borders = askInput.offsetHeight - askInput.clientHeight;
    askInput.style.height = `${askInput.scrollHeight + borders}px`;
  }

  function close() {
    if (!current) return;
    stopPort();
    stopAsk();
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
    const summaryBox = el("div", "summary");
    const thread = el("div");
    body.append(summaryBox, thread);
    const foot = el("div", "foot");
    foot.hidden = true;

    const ask = el("div", "ask");
    const askInput = el("textarea");
    askInput.rows = 1;
    askInput.maxLength = MAX_QUESTION;
    askInput.placeholder = words.ask;
    askInput.setAttribute("aria-label", words.ask);
    askInput.addEventListener("input", () => fitInput());
    askInput.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        askQuestion();
      } else if (e.key === "Escape" && askInput.value) {
        // Esc в поле с текстом стирает набранное, а панель с перепиской закроет следующий Esc
        e.stopPropagation();
        askInput.value = "";
        fitInput();
      }
    });
    const askBtn = el("button", "send", "Спросить");
    // фокус — в поле до отправки: кнопку на время ответа отключаем, и фокус с неё ушёл бы на
    // страницу
    askBtn.addEventListener("click", () => {
      askInput.focus();
      askQuestion();
    });
    ask.append(askInput, askBtn);

    panel.append(head, bar, body, foot, ask);
    shadow.append(panel);
    // Клавиши из панели на страницу не пускаем: пока пишут вопрос, срабатывали бы горячие
    // клавиши сайта. Esc закрывает панель — только когда фокус в ней: на странице Esc может быть
    // нужен ей самой.
    for (const type of ["keydown", "keyup", "keypress"]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    host.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.isComposing) close();
    });
    return { host, panel, body, summaryBox, thread, foot, ask, askInput, askBtn, copyBtn, lengthBtns };
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
    current = {
      ...build(words),
      words,
      source: text,
      results: {},
      sent: null,
      conn: null,
      turns: [],
      askConn: null,
    };
    setLength(DEFAULT_LENGTH);
    document.documentElement.append(current.host);
    if (current.source.text.length < MIN_CHARS) {
      current.ask.hidden = true;
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

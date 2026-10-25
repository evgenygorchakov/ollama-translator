// Панель с кратким содержанием или сутью страницы, выделенного или видео YouTube и вопросами по
// тексту. Внедряется по кнопке в popup или из контекстного меню, ответ модели получает через порт
// "summary" по мере генерации: у ответа панели и у каждого вопроса свой порт. Текст видео — его
// субтитры, их панель просит по тому же порту. От перевода страницы, выделенного и озвучки не
// зависит. Текст модели — только textContent.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  ns.summary?.dispose(); // осиротевший экземпляр после перезагрузки расширения

  const { summaryFormat: format, summaryExtract: extract } = ns;
  const PORT_NAME = "summary";
  const LENGTH_KEY = "summaryLength";
  // Режимы: длины краткого содержания (ключи — SUMMARY_LENGTHS из lib/prompt.js) и суть. В
  // storage — только последняя длина: «Суть» открывают своей кнопкой.
  const MODES = [
    ["short", "Коротко"],
    ["long", "Подробно"],
    ["essence", "Суть"],
  ];
  const LENGTHS = ["short", "long"];
  const DEFAULT_LENGTH = "short";
  // Короче — сокращать нечего.
  const MIN_CHARS = 200;
  const MAX_QUESTION = 1000;
  const MARGIN = 8;

  // Надписи по source.kind из open(). loading, noCaptions и live — только у видео. title —
  // заголовок краткого содержания, essence — сути.
  const WORDING = {
    page: {
      title: "Краткое содержание",
      essence: "В чём суть",
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
      essence: "В чём суть выделенного",
      reading: "Читаю выделенное…",
      parts: "Выделено много — читаю по частям",
      partly: "Учтено начало выделенного",
      whole: "Учтён весь выделенный текст",
      tooShort: "Выделено слишком мало — тут почти нечего сокращать",
      ask: "Спросить о выделенном…",
      search: "Выделено много — ищу ответ по частям",
    },
    video: {
      title: "Краткое содержание видео",
      essence: "В чём суть видео",
      loading: "Загружаю субтитры…",
      reading: "Читаю субтитры…",
      parts: "Видео длинное — читаю по частям",
      partly: "Учтено начало видео",
      whole: "Учтены все субтитры",
      tooShort: "В субтитрах почти нет речи — сокращать нечего",
      noCaptions: "У видео нет субтитров — сокращать нечего",
      live: "Трансляции не поддерживаются",
      ask: "Спросить о видео…",
      search: "Видео длинное — ищу ответ по частям",
    },
  };
  // Ошибки субтитров (см. summary/background.js), после которых повтор не поможет: код → надпись
  // из WORDING.
  const NO_TEXT = { NO_CAPTIONS: "noCaptions", LIVE: "live" };

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
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
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
    .badge {
      margin-left: 8px; padding: 1px 6px; border-radius: 4px;
      background: #ffd33d; color: #1f2328; font-size: 12px; cursor: help;
    }
    .modes {
      display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden;
    }
    .modes button { padding: 2px 10px; border-radius: 0; }
    .modes button[aria-pressed="true"] { background: var(--accent); color: var(--accent-fg); }
    .body {
      flex: 1 1 auto; min-height: 0; overflow: auto;
      padding: 10px 12px; overflow-wrap: anywhere; user-select: text;
    }
    .body p { margin: 0 0 8px; }
    .body .thesis {
      margin-bottom: 10px; padding: 6px 10px; border-left: 3px solid var(--accent);
      border-radius: 0 6px 6px 0; background: var(--btn-hover); font-weight: 600;
    }
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

  // { host, panel, heading, headingText, body, summaryBox, thread, foot, ask, askInput, askBtn,
  //   resetBtn, copyBtn, modeBtns, kind, words, videoId, source: { title, text } | null,
  //   captions: { kind, lang } | null, mode, results: { [mode]: { text, cut, thinkMs, sent } },
  //   stale, sent: { used, total, model } | null, conn, thinkTimer, turns, askConn, checked,
  //   checkConn }
  // kind и words — source.kind из open() и надписи для него из WORDING. source — текст для модели;
  // у видео null, пока субтитры не загружены. captions — какие субтитры взяты.
  // mode — режим из MODES; results — готовые ответы по режимам, thinkMs — сколько модель
  // рассуждала (без рассуждения — undefined). stale — Set режимов, сброшенных «Сбросить»: их
  // первый запрос после сброса считает заметки по частям заново.
  // conn — порт идущего запроса: субтитров или ответа панели (краткого содержания или сути).
  // thinkTimer — таймер «Обдумываю… N с», пока модель рассуждает.
  // sent — сколько текста ушло модели в последнем запросе и какой модели (сообщение source).
  // turns — вопросы по порядку: { question, answer, cut, sent, missed, mode, node, answerBox,
  // note }; answer — null, пока готового ответа нет (идёт, ошибка, остановлено); missed —
  // { count, parts } из result (см. summary/background.js) или null; mode — режим панели, когда
  // вопрос ушёл модели. askConn — порт идущего вопроса.
  // checked — название видео на кликбейт проверено, checkConn — порт идущей проверки.
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

  // Ответ упёрся в num_ctx. У «Сути» он постоянный — настройки тут не помогут.
  function cutNote(mode) {
    return mode === "essence"
      ? "Ответ обрезан: не хватило контекста модели"
      : "Ответ обрезан: не хватило контекста модели (num_ctx в настройках)";
  }

  // status — что идёт сейчас («Пишу…»); у готового ответа cut — он упёрся в num_ctx, thinkMs —
  // сколько модель рассуждала.
  function renderFoot(status = "", { cut = false, thinkMs } = {}) {
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
    if (current.captions) {
      const { kind, lang } = current.captions;
      parts.push(`Субтитры: ${kind === "asr" ? "автоматические" : "ручные"}, ${lang}`);
    }
    const model = [];
    if (sent?.model) model.push(`Модель: ${sent.model}`);
    if (thinkMs !== undefined) model.push(`рассуждала ${Math.round(thinkMs / 1000)} с`);
    const lines = [parts.join(" · "), model.join(" · ")];
    if (cut) lines.push(cutNote(current.mode));
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

  // Ответ панели. У сути первый абзац — сама мысль, он выделен. localName, а не tagName: в
  // XHTML-документе tagName в нижнем регистре.
  function renderText(text) {
    const nodes = textNodes(text);
    if (current.mode === "essence" && nodes[0]?.localName === "p") nodes[0].classList.add("thesis");
    current.summaryBox.replaceChildren(...nodes);
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
      ...messageNodes(className, text, canRetry && (() => request(current.mode))),
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
    renderFoot("", result);
  }

  // Режим — кнопки и заголовок панели.
  function setMode(mode) {
    const { modeBtns, headingText, panel, words } = current;
    current.mode = mode;
    for (const [key, btn] of modeBtns) btn.setAttribute("aria-pressed", String(key === mode));
    const title = mode === "essence" ? words.essence : words.title;
    headingText.textContent = title;
    panel.setAttribute("aria-label", title);
  }

  function stopPort() {
    current.conn?.close();
    current.conn = null;
    stopThinking();
  }

  // «Обдумываю… N с», пока модель рассуждает: с progress think до первого куска ответа. Конец
  // запроса, смена режима и закрытие панели останавливают его через stopPort().
  function startThinking() {
    stopThinking();
    const started = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      showMessage("status", `Обдумываю… ${seconds} с`, false);
    };
    tick();
    current.thinkTimer = setInterval(tick, 1000);
  }

  function stopThinking() {
    clearInterval(current.thinkTimer);
    current.thinkTimer = 0;
  }

  function request(mode) {
    const state = current;
    stopPort(); // отключение порта отменяет прежний запрос к Ollama
    setMode(mode);
    if (!state.source) {
      loadTranscript(state); // ответ панели — когда загрузятся
      return;
    }
    const done = state.results[mode];
    if (done) {
      showResult(done);
      return;
    }
    state.sent = null;
    showMessage("status", state.words.reading, false);
    renderFoot();
    // после stopPort() порт ничего не вызывает — ответ всегда к этому state и этому режиму
    try {
      state.conn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => onMessage(state, mode, msg),
        onDisconnect: () => {
          state.conn = null;
          stopThinking();
          showError("соединение с расширением прервалось");
        },
      });
    } catch {
      showError("расширение перезагружено, обновите страницу", false);
      return;
    }
    const { title, text } = state.source;
    const { kind } = state;
    // После сброса первый запрос режима — с fresh: фон считает заметки по частям заново. Заметки
    // у длин краткого содержания общие — пересчитанные для одной годятся и другой.
    const fresh = state.stale.has(mode);
    for (const key of LENGTHS.includes(mode) ? LENGTHS : [mode]) state.stale.delete(key);
    // порт мёртв — onDisconnect покажет ошибку
    state.conn.post(
      mode === "essence"
        ? { type: "essence", text, title, kind, fresh }
        : { type: "summarize", text, title, length: mode, kind, fresh },
    );
  }

  // «Сбросить»: оборвать идущие запросы, забыть ответы всех режимов, вопросы и проверку названия
  // (плашка уходит). Модель сами не спрашиваем: режим, и текущий тоже, выбирают кнопкой — например,
  // сменив модель в popup. Текст и субтитры не перечитываем.
  function reset() {
    const state = current;
    stopPort();
    stopAsk();
    stopCheck();
    state.results = {};
    state.sent = null;
    state.turns = [];
    state.thread.replaceChildren();
    state.checked = false;
    state.heading.querySelector(".badge")?.remove();
    state.stale = new Set(MODES.map(([key]) => key));
    showMessage("status", "Ответы забыты — выберите режим, и модель ответит заново", false);
    renderFoot();
  }

  // Поле вопроса и «Сбросить» — только когда есть что сокращать: у видео — после субтитров.
  function showControls(shown) {
    current.ask.hidden = !shown;
    current.resetBtn.hidden = !shown;
  }

  // Субтитры видео — по порту, как и краткое содержание: загружает их summary/background.js.
  function loadTranscript(state) {
    showMessage("status", state.words.loading, false);
    renderFoot();
    try {
      state.conn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => onTranscript(state, msg),
        onDisconnect: () => {
          state.conn = null;
          showError("соединение с расширением прервалось");
        },
      });
    } catch {
      showError("расширение перезагружено, обновите страницу", false);
      return;
    }
    state.conn.post({ type: "transcript", videoId: state.videoId });
  }

  function onTranscript(state, msg) {
    switch (msg?.type) {
      case "transcript":
        stopPort();
        state.source = { title: String(msg.title ?? ""), text: String(msg.text ?? "") };
        state.captions = { kind: msg.kind, lang: String(msg.lang ?? "") };
        if (state.source.text.length < MIN_CHARS) {
          showMessage("status", state.words.tooShort, false);
          renderFoot();
          break;
        }
        showControls(true);
        request(state.mode);
        break;
      case "stopped":
        stopPort();
        showMessage("status", "Остановлено", true);
        break;
      case "error":
        stopPort();
        if (NO_TEXT[msg.code]) {
          state.source = { title: "", text: "" }; // текста нет: ни длины, ни повтор не помогут
          showMessage("status", state.words[NO_TEXT[msg.code]], false);
        } else {
          showError(msg.message ?? "неизвестная ошибка");
        }
        break;
    }
  }

  // длинный текст модель читает по частям — см. summary/background.js
  function progressText({ step, part, parts }) {
    if (step === "part") return `${current.words.parts}: ${part} из ${parts}…`;
    if (step === "merge") return "Свожу заметки по частям…";
    return current.mode === "essence" ? "Ищу главную мысль…" : "Пишу краткое содержание…";
  }

  function onMessage(state, mode, msg) {
    switch (msg?.type) {
      case "source":
        state.sent = { used: msg.used, total: msg.total, model: String(msg.model ?? "") };
        renderFoot();
        break;
      case "progress":
        if (msg.step === "think") startThinking();
        else showMessage("status", progressText(msg), false);
        renderFoot();
        break;
      case "partial":
        stopThinking();
        renderText(msg.text);
        renderFoot("Пишу…");
        break;
      case "result":
        stopPort();
        state.results[mode] = {
          text: msg.text,
          cut: Boolean(msg.cut),
          thinkMs: typeof msg.thinkMs === "number" ? msg.thinkMs : undefined,
          sent: state.sent,
        };
        showResult(state.results[mode]);
        if (LENGTHS.includes(mode)) checkTitle(mode); // после сути не проверяем
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

  // «Суть» в storage не пишем: «Краткое содержание» открывает последнюю длину.
  function chooseMode(mode) {
    const state = current;
    if (state.source && state.source.text.length < MIN_CHARS) return;
    // этот режим уже готов или идёт — ничего не делаем; после ошибки — повтор, после сброса —
    // запрос заново
    if (mode === state.mode && (state.conn || state.results[mode])) return;
    // субтитры ещё загружаются — ответ этого режима будет, когда загрузятся
    if (!state.source && state.conn) setMode(mode);
    else request(mode);
    if (LENGTHS.includes(mode)) saveLength(mode);
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
      return LENGTHS.includes(value) ? value : DEFAULT_LENGTH;
    } catch {
      return DEFAULT_LENGTH; // расширение перезагружено — request() скажет об этом
    }
  }

  async function copy() {
    const { results, mode, copyBtn, panel } = current;
    const result = results[mode];
    if (!result) return;
    const ok = await ns.copyText(format.plain(result.text), panel);
    copyBtn.focus();
    copyBtn.textContent = ok ? "Скопировано" : "Не скопировалось";
    setTimeout(() => {
      if (copyBtn.isConnected) copyBtn.textContent = "Копировать";
    }, 1500);
  }

  // ---------- Кликбейт ----------

  // Название видео — на кликбейт, после готового краткого содержания длины length: ту модель,
  // что его написала, спрашивают вдогонку к нему. Один раз на панель; не получилось — плашки
  // нет, проверка повторится после следующего готового краткого содержания. После обрезанного
  // (упёрлось в num_ctx) не проверяем: вопрос вдогонку не влезет, и Ollama выкинет из запроса
  // сообщение с названием и текстом. Название из одних пробелов фон не проверяет и не отвечает —
  // порт висел бы до закрытия панели.
  function checkTitle(length) {
    const state = current;
    const result = state.results[length];
    if (state.kind !== "video" || state.checked || state.checkConn || result.cut) return;
    if (!state.source.title.trim()) return;
    try {
      state.checkConn = ns.connectPort(PORT_NAME, {
        onMessage: (msg) => onCheck(msg),
        onDisconnect: () => {
          state.checkConn = null;
          console.warn("[ot] не удалось проверить название видео: соединение прервалось");
        },
      });
    } catch {
      return; // расширение перезагружено
    }
    const { title, text } = state.source;
    const model = result.sent?.model ?? "";
    state.checkConn.post({ type: "clickbait", text, title, length, summary: result.text, model });
  }

  function stopCheck() {
    current.checkConn?.close();
    current.checkConn = null;
  }

  // Причина — что обещает название и что в видео — в подсказке у плашки.
  function onCheck(msg) {
    switch (msg?.type) {
      case "result":
        stopCheck();
        current.checked = true;
        if (msg.clickbait) {
          const badge = el("span", "badge", "Кликбейт!");
          if (msg.reason) badge.title = String(msg.reason);
          current.heading.append(badge);
        }
        break;
      case "stopped":
        stopCheck();
        break;
      case "error":
        stopCheck();
        console.warn("[ot] не удалось проверить название видео:", msg.message);
        break;
    }
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
  function answerNotes({ sent, cut, missed, mode }) {
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
    if (cut) notes.push(cutNote(mode));
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

  // Вопрос — модели; повтор после ошибки — тоже сюда. Первым ответом в истории — ответ панели в
  // текущем режиме, под «Сутью» вопрос идёт с её num_ctx (см. summary/background.js).
  function sendQuestion(turn) {
    const state = current;
    if (state.askConn) return; // идёт ответ на другой вопрос
    Object.assign(turn, { answer: null, cut: false, sent: null, missed: null, mode: state.mode });
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
      kind: state.kind,
      question: turn.question,
      summary: state.results[state.mode]?.text ?? "",
      history: historyBefore(turn),
      mode: state.mode,
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
      mode: null,
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
    stopCheck();
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
    // заголовок меняется по режиму (setMode), плашка «Кликбейт!» — после него
    const heading = el("span", "title");
    const headingText = el("span", null, words.title);
    heading.append(headingText);
    const closeBtn = el("button", "close", "×");
    closeBtn.title = "Закрыть (Esc)";
    closeBtn.addEventListener("click", close);
    head.append(heading, closeBtn);

    const bar = el("div", "bar");
    const modes = el("div", "modes");
    const modeBtns = new Map();
    for (const [key, label] of MODES) {
      const btn = el("button", null, label);
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => chooseMode(key));
      modeBtns.set(key, btn);
      modes.append(btn);
    }
    const resetBtn = el("button", null, "Сбросить");
    resetBtn.title = "Забыть ответы и вопросы — например, чтобы спросить заново другой моделью";
    resetBtn.addEventListener("click", () => reset());
    const copyBtn = el("button", null, "Копировать");
    copyBtn.hidden = true;
    copyBtn.addEventListener("click", () => copy());
    bar.append(modes, el("span", "spacer"), resetBtn, copyBtn);

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
    return {
      host,
      panel,
      heading,
      headingText,
      body,
      summaryBox,
      thread,
      foot,
      ask,
      askInput,
      askBtn,
      resetBtn,
      copyBtn,
      modeBtns,
    };
  }

  // Текст для модели: страницы — из документа, выделенного — из source; у видео — null, субтитры
  // загрузит request().
  function sourceText(kind, source) {
    if (kind === "video") return null;
    if (kind === "page") return extract.page();
    return { title: document.title.trim(), text: extract.normalize(String(source.text ?? "")) };
  }

  // source — { kind: "page" }, { kind: "selection", text } или { kind: "video", videoId } из
  // summary/background.js: текст страницы панель берёт сама, выделенный — оттуда (выделение могло
  // быть во вложенном фрейме), субтитры видео просит у него по порту. Заголовок страницы — модели
  // для контекста, и для выделенного тоже; у видео — его название.
  // Видео потом может смениться без перезагрузки страницы — панель остаётся о прежнем.
  // mode — режим из MODES («В чём суть» — "essence"); "" — последняя длина краткого содержания.
  function open(source = { kind: "page" }, mode = "") {
    close();
    const kind = Object.hasOwn(WORDING, source.kind) ? source.kind : "page";
    const words = WORDING[kind];
    current = {
      ...build(words),
      kind,
      words,
      videoId: kind === "video" ? String(source.videoId) : null,
      source: sourceText(kind, source),
      captions: null,
      mode: null,
      results: {},
      stale: new Set(),
      sent: null,
      conn: null,
      thinkTimer: 0,
      turns: [],
      askConn: null,
      checked: false,
      checkConn: null,
    };
    const initial = MODES.some(([key]) => key === mode) ? mode : null;
    setMode(initial ?? DEFAULT_LENGTH);
    document.documentElement.append(current.host);
    if (!current.source) {
      showControls(false); // спрашивать и сбрасывать — когда будут субтитры
    } else if (current.source.text.length < MIN_CHARS) {
      showControls(false);
      showMessage("status", words.tooShort, false);
      return;
    }
    if (initial) {
      request(initial);
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

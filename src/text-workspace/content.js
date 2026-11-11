// UI режима целиком здесь; ни перевод, ни summary о нём не знают.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  if (ns.textWorkspace?.alive()) return;
  ns.textWorkspace?.dispose();
  const config = ns.textWorkspaceConfig;
  const MARGIN = 12;
  const POINTER_GAP = 12;
  let disposed = false;
  let enabled = false;
  let cursorEnabled = true;
  let color = config.color(config.defaultColor);
  let settingsVersion = 0;
  let current = null;
  let dragging = false;
  let selectionPointer = null;
  let selectionTimer = 0;
  let placeFrame = 0;
  let dismissed = null;
  let cursorStyle = null;

  function alive() {
    try { return !disposed && Boolean(chrome.runtime?.id); }
    catch { return false; }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(className, text, label, action) {
    const node = element("button", className, text);
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.addEventListener("click", action);
    return node;
  }

  function applyCursor() {
    cursorStyle?.remove();
    cursorStyle = null;
    if (!enabled || !cursorEnabled || disposed) return;
    cursorStyle = element("style");
    cursorStyle.dataset.otTextWorkspace = "cursor";
    // Временно заменяем также pointer, text, help, resize и остальные состояния.
    cursorStyle.textContent = `
      @media (pointer: fine) {
        :root, :root *, :root *::before, :root *::after {
          cursor: ${ns.uiTheme.cursor(color.fill)} !important;
        }
      }
    `;
    document.documentElement.append(cursorStyle);
  }

  function applyColor(box) {
    box.style.setProperty("--accent-fill", color.fill);
    box.style.setProperty("--accent-ink", color.ink);
  }

  function sameSelection(a, b) {
    return a && b && a.text === b.text &&
      a.range.startContainer === b.range.startContainer && a.range.startOffset === b.range.startOffset &&
      a.range.endContainer === b.range.endContainer && a.range.endOffset === b.range.endOffset;
  }

  function readSelection() {
    if (!enabled || disposed || dragging || document.activeElement === current?.host) return;
    const pointer = selectionPointer;
    selectionPointer = null;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection.rangeCount || selection.isCollapsed) {
      if (current && !current.expanded) close(false);
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    const parent = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!parent || parent.getRootNode() !== document ||
        parent.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
    const candidate = { text, range };
    if (sameSelection(candidate, current) || sameSelection(candidate, dismissed)) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    // Смещение относительно текста сохраняет привязку при прокрутке, в том числе внутри блока.
    candidate.pointerOffset = pointer ? { x: pointer.x - rect.left, y: pointer.y - rect.top } : null;
    close(false);
    dismissed = null;
    current = build(candidate);
    document.documentElement.append(current.host);
    current.resize.observe(current.box);
    place();
  }

  function scheduleSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(readSelection, 120);
  }

  function place() {
    const state = current;
    if (!state) return;
    const rects = state.range.getClientRects();
    const rect = rects[rects.length - 1] ?? state.range.getBoundingClientRect();
    const width = state.box.offsetWidth;
    const height = state.box.offsetHeight;
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + MARGIN;
    const topEdge = (viewport?.offsetTop ?? 0) + MARGIN;
    const rightEdge = leftEdge + (viewport?.width ?? document.documentElement.clientWidth) - 2 * MARGIN;
    const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 2 * MARGIN;
    let left = rect.right - 28;
    let top = rect.bottom + 8;
    if (state.pointerOffset) {
      const bounds = state.range.getBoundingClientRect();
      const x = bounds.left + state.pointerOffset.x;
      const y = bounds.top + state.pointerOffset.y;
      // Не перекрываем курсор: иначе hover сразу откроет панель без движения мыши.
      left = x + POINTER_GAP;
      top = y + POINTER_GAP;
      if (left + width > rightEdge) left = x - width - POINTER_GAP;
      if (top + height > bottomEdge) top = y - height - POINTER_GAP;
    } else if (top + height > bottomEdge && rect.top - height - 8 >= topEdge) {
      top = rect.top - height - 8;
    }
    left = Math.min(Math.max(left, leftEdge), Math.max(leftEdge, rightEdge - width));
    top = Math.min(Math.max(top, topEdge), Math.max(topEdge, bottomEdge - height));
    if (!state.range.startContainer.isConnected) left = Math.max(leftEdge, rightEdge - width);
    state.host.style.setProperty("left", `${left}px`, "important");
    state.host.style.setProperty("top", `${top}px`, "important");
  }

  function schedulePlace() {
    if (!current || placeFrame) return;
    placeFrame = requestAnimationFrame(() => {
      placeFrame = 0;
      place();
    });
  }

  function showNotice(state, text, error = false) {
    state.notice.textContent = text;
    state.notice.toggleAttribute("data-error", error);
  }

  function renderContext(state) {
    const view = ns.contextUsage(state.context ?? {});
    state.foot.hidden = !view.text;
    state.contextLabel.textContent = view.text;
    state.contextLabel.title = view.title + (state.model ? ` Model: ${state.model}.` : "");
    state.meter.hidden = view.ratio === null;
    state.meterFill.style.width = `${(view.ratio ?? 0) * 100}%`;
    const warnings = [];
    if (state.omitted) warnings.push("Older messages were left out to fit the context.");
    if (state.cut) warnings.push("An answer reached the generation limit.");
    if (view.ratio >= .8 || state.historyNear) warnings.push("Context is nearly full.");
    if (warnings.length) warnings.push("Reset starts a fresh conversation.");
    state.warning.textContent = warnings.join(" ");
  }

  function updateComposer(state) {
    state.send.textContent = state.busy ? "■" : "↑";
    state.send.setAttribute("aria-label", state.busy ? "Stop answer" : "Send question");
    state.send.title = state.busy ? "Stop answer" : "Send question (Enter)";
    state.send.toggleAttribute("data-busy", state.busy);
    state.send.disabled = !state.busy && (!state.input.value.trim() || state.text.length > config.maxText);
    state.input.readOnly = state.busy;
    state.input.placeholder = state.history.length ? "Ask a follow-up…" : "Ask about this text…";
    state.panel.setAttribute("aria-busy", String(state.busy));
  }

  function expand(state, focus = false) {
    if (current !== state) return;
    clearTimeout(state.hoverTimer);
    if (!state.expanded) {
      state.expanded = true;
      state.trigger.hidden = true;
      state.panel.hidden = false;
      place();
    }
    if (focus) state.input.focus({ preventScroll: true });
  }

  function finish(state) {
    state.conn?.close();
    state.conn = null;
    state.busy = false;
    state.pending?.row.removeAttribute("data-pending");
    updateComposer(state);
  }

  function stop(state) {
    if (!state.busy) return;
    finish(state);
    if (!state.pending.answer.textContent) state.pending.answer.textContent = "Answer stopped.";
    state.pending.label.textContent = "Stopped · not added to history";
    state.input.value = state.pending.question;
    showNotice(state, "Stopped. Send the question again to retry.");
    updateComposer(state);
    renderContext(state);
  }

  function fail(state, message) {
    finish(state);
    state.pending.answer.textContent = "No completed answer.";
    state.pending.label.textContent = "Not added to history";
    state.input.value = state.pending.question;
    showNotice(state, message, true);
    updateComposer(state);
    renderContext(state);
  }

  function addTurn(state, question) {
    const row = element("div", "turn");
    row.setAttribute("data-pending", "");
    const ask = element("p", "question", question);
    ask.dir = "auto";
    const answer = element("p", "answer");
    answer.dir = "auto";
    const tools = element("div", "answer-tools");
    const label = element("span", "", "Generating…");
    const copy = button("", "Copy", "Copy answer", async () => {
      const ok = await ns.copyText(answer.textContent, state.box);
      if (current !== state) return;
      copy.focus({ preventScroll: true });
      copy.textContent = ok ? "Copied" : "Couldn't copy";
      setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy"; }, 1500);
    });
    copy.hidden = true;
    tools.append(label, copy);
    row.append(ask, answer, tools);
    state.thread.append(row);
    // Ограничиваем и DOM длинной сессии, независимо от числа успешных запросов.
    while (state.thread.children.length > config.maxTurns) state.thread.firstElementChild.remove();
    state.thread.hidden = false;
    state.thread.scrollTop = state.thread.scrollHeight;
    return { row, answer, label, copy, question };
  }

  function submit(state) {
    if (current !== state || state.busy) return;
    const question = state.input.value.trim();
    if (!question || state.text.length > config.maxText) return;
    if (!alive()) {
      showNotice(state, "The extension was reloaded. Reload this page to use Text workspace.", true);
      return;
    }
    state.busy = true;
    state.context = { total: state.context?.total ?? null, usage: null };
    state.suggestions.hidden = true;
    state.pending = addTurn(state, question);
    state.input.value = "";
    showNotice(state, "");
    updateComposer(state);
    renderContext(state);
    try {
      state.conn = ns.connectPort(config.port, {
        onMessage(msg) {
          if (current !== state || !state.busy) return;
          const pending = state.pending;
          if (msg?.type === "context") {
            state.context = msg.context;
            state.model = msg.model;
            state.omitted ||= msg.omitted > 0;
            state.historyNear = msg.historyTokens >= msg.historyBudget * .8;
            renderContext(state);
          } else if (msg?.type === "partial") {
            const atBottom = state.thread.scrollHeight - state.thread.scrollTop - state.thread.clientHeight < 40;
            pending.answer.textContent = msg.text;
            if (atBottom) state.thread.scrollTop = state.thread.scrollHeight;
          } else if (msg?.type === "result") {
            finish(state);
            pending.answer.textContent = msg.text;
            pending.label.textContent = msg.cut ? "Answer reached the length limit" : "Ollama";
            pending.copy.hidden = false;
            state.history.push({ question, answer: msg.text });
            let chars = state.history.reduce((n, t) => n + t.question.length + t.answer.length, 0);
            while (state.history.length > config.maxTurns || chars > config.maxHistoryChars) {
              const removed = state.history.shift();
              chars -= removed.question.length + removed.answer.length;
              state.omitted = true;
            }
            state.context = msg.context;
            state.cut ||= msg.cut;
            showNotice(state, "");
            updateComposer(state);
            renderContext(state);
            state.thread.scrollTop = state.thread.scrollHeight;
          } else if (msg?.type === "stopped") {
            stop(state);
          } else if (msg?.type === "error") {
            fail(state, msg.message || "The request failed. Try again.");
          }
        },
        onDisconnect() {
          if (current === state && state.busy) fail(state, "Connection to the extension was lost. Try again, or reload the page if the extension was updated.");
        },
      });
      state.conn.post({ type: "ask", text: state.text, question, history: state.history });
    } catch {
      fail(state, "The extension was reloaded. Reload this page to continue.");
    }
  }

  function reset(state) {
    finish(state);
    state.history = [];
    state.pending = null;
    state.context = null;
    state.omitted = false;
    state.cut = false;
    state.historyNear = false;
    state.thread.replaceChildren();
    state.thread.hidden = true;
    state.input.value = "";
    state.suggestions.hidden = false;
    showNotice(state, state.text.length > config.maxText ? `Select less text: the limit is ${config.maxText.toLocaleString("en-US")} characters.` : "", state.text.length > config.maxText);
    updateComposer(state);
    renderContext(state);
    state.input.focus({ preventScroll: true });
  }

  function build(selection) {
    const { host, shadow } = ns.shadowHost("ot-text-workspace",
      "position:fixed!important;z-index:2147483647!important;display:block!important;" +
      "margin:0!important;padding:0!important;width:max-content!important;height:auto!important;" +
      "border:0!important;transform:none!important;", ns.textWorkspaceStyle);
    const state = {
      ...selection, host, history: [], conn: null, busy: false, expanded: false,
      context: null, omitted: false, cut: false, historyNear: false,
      previousFocus: document.activeElement, hoverTimer: 0,
    };
    const box = element("div", "workspace");
    applyColor(box);
    const trigger = button("trigger", "", "Ask about selection (Alt+Enter)", () => expand(state, true));
    trigger.append(element("span", "spark", "✦"), element("span", "", "Ask"));
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.addEventListener("pointerenter", () => {
      state.hoverTimer = setTimeout(() => expand(state), 140);
    });
    trigger.addEventListener("pointerleave", () => clearTimeout(state.hoverTimer));
    trigger.addEventListener("focus", () => expand(state, true));
    const panel = element("div", "panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Text workspace");
    const head = element("div", "head");
    const mark = element("span", "mark spark", "✦");
    mark.setAttribute("aria-hidden", "true");
    head.append(mark, element("span", "title", "Text workspace"),
      button("", "Reset", "Reset conversation", () => reset(state)),
      button("close", "×", "Close (Esc)", () => close(true)));
    const source = element("div", "source");
    const quote = element("div", "quote", state.text);
    quote.dir = "auto";
    source.append(element("div", "eyebrow", `Selection · ${state.text.length.toLocaleString("en-US")} characters`), quote);
    const suggestions = element("div", "suggestions");
    for (const [title, question] of [
      ["Explain", "Explain this passage in simple terms. Answer in the selected translation language."],
      ["Summarize", "Summarize the main idea of this passage. Answer in the selected translation language."],
      ["Rewrite", "Rewrite this passage more clearly, preserving its meaning. Write in the selected translation language."],
    ]) {
      suggestions.append(button("", title, title, () => {
        state.input.value = question;
        updateComposer(state);
        state.input.focus({ preventScroll: true });
      }));
    }
    const thread = element("div", "thread");
    thread.hidden = true;
    thread.setAttribute("role", "region");
    thread.setAttribute("aria-label", "Conversation");
    thread.tabIndex = 0;
    const notice = element("div", "notice");
    notice.setAttribute("role", "status");
    const form = element("form", "composer");
    const input = element("textarea");
    input.rows = 2;
    input.maxLength = config.maxQuestion;
    input.setAttribute("aria-label", "Question about selected text");
    input.dir = "auto";
    input.addEventListener("input", () => updateComposer(state));
    input.addEventListener("keydown", (event) => {
      // Не отправляем незаконченный ввод IME; Shift+Enter оставляем для новой строки.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit(state);
      }
    });
    const composeTools = element("div", "compose-tools");
    const send = button("send", "↑", "Send question (Enter)", () => {
      if (state.busy) stop(state);
      else submit(state);
    });
    composeTools.append(element("span", "hint", "Enter to send · Shift+Enter for a new line"), send);
    form.append(input, composeTools);
    form.addEventListener("submit", (event) => { event.preventDefault(); submit(state); });
    const foot = element("div", "foot");
    const contextLabel = element("div", "context");
    const meter = element("div", "meter");
    meter.setAttribute("aria-hidden", "true");
    const meterFill = element("div", "meter-fill");
    meter.append(meterFill);
    const warning = element("div", "warning");
    warning.setAttribute("role", "status");
    foot.append(contextLabel, meter, warning);
    panel.append(head, source, suggestions, thread, notice, form, foot);
    box.append(trigger, panel);
    shadow.append(box);
    // Не даём обычным горячим клавишам/обработчикам сайта перехватывать ввод в панели.
    for (const event of ["keydown", "keyup", "keypress", "pointerdown", "pointerup", "click"]) {
      box.addEventListener(event, (e) => e.stopPropagation());
    }
    Object.assign(state, { box, trigger, panel, suggestions, thread, notice, input, send,
      foot, contextLabel, meter, meterFill, warning, resize: new ResizeObserver(schedulePlace) });
    if (state.text.length > config.maxText) {
      showNotice(state, `Select less text: the limit is ${config.maxText.toLocaleString("en-US")} characters.`, true);
    }
    updateComposer(state);
    renderContext(state);
    return state;
  }

  function close(restoreFocus = false) {
    const state = current;
    if (!state) return;
    current = null;
    dismissed = { text: state.text, range: state.range };
    clearTimeout(state.hoverTimer);
    state.conn?.close();
    state.resize.disconnect();
    const hadFocus = document.activeElement === state.host;
    state.host.remove();
    if (restoreFocus && hadFocus && state.previousFocus?.isConnected) {
      state.previousFocus.focus({ preventScroll: true });
    }
  }

  function pointerDown(event) {
    if (current && event.composedPath().includes(current.host)) return;
    close(false);
    dismissed = null;
    selectionPointer = null;
    dragging = event.button === 0;
  }

  function pointerUp(event) {
    dragging = false;
    if (current && event.composedPath().includes(current.host)) return;
    if (event.type === "pointerup" && event.button === 0) {
      selectionPointer = event.pointerType === "mouse" || event.pointerType === "pen"
        ? { x: event.clientX, y: event.clientY } : null;
      scheduleSelection();
    }
  }

  function keyDown(event) {
    selectionPointer = null;
    if (event.key === "Escape" && current) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.altKey && event.key === "Enter" && current) {
      event.preventDefault();
      expand(current, true);
    }
  }

  function settingsChanged(changes, area) {
    if (area !== "local" || ![config.enabledKey, config.cursorKey, config.colorKey].some((key) => key in changes)) return;
    if (config.enabledKey in changes && changes[config.enabledKey].newValue !== true) {
      dispose();
      return;
    }
    void refreshSettings();
  }

  async function refreshSettings() {
    const version = ++settingsVersion;
    try {
      const stored = await chrome.storage.local.get({
        [config.enabledKey]: false, [config.cursorKey]: true, [config.colorKey]: config.defaultColor,
      });
      if (disposed || version !== settingsVersion) return;
      enabled = stored[config.enabledKey] === true;
      cursorEnabled = stored[config.cursorKey] !== false;
      color = config.color(stored[config.colorKey]);
      if (!enabled) { dispose(); return; }
      if (current) applyColor(current.box);
      applyCursor();
    } catch { dispose(); }
  }

  const pageHide = () => { dragging = false; selectionPointer = null; close(false); };
  function dispose() {
    if (disposed) return;
    disposed = true;
    close(false);
    cursorStyle?.remove();
    clearTimeout(selectionTimer);
    cancelAnimationFrame(placeFrame);
    document.removeEventListener("selectionchange", scheduleSelection);
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("pointerup", pointerUp, true);
    document.removeEventListener("pointercancel", pointerUp, true);
    document.removeEventListener("keydown", keyDown, true);
    document.removeEventListener("scroll", schedulePlace, true);
    window.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("resize", schedulePlace);
    window.visualViewport?.removeEventListener("scroll", schedulePlace);
    window.removeEventListener("pagehide", pageHide);
    window.removeEventListener("pageshow", refreshSettings);
    try { chrome.storage.onChanged.removeListener(settingsChanged); } catch { /* расширение перезагружено */ }
  }

  document.addEventListener("selectionchange", scheduleSelection);
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("pointerup", pointerUp, true);
  document.addEventListener("pointercancel", pointerUp, true);
  document.addEventListener("keydown", keyDown, true);
  document.addEventListener("scroll", schedulePlace, { capture: true, passive: true });
  window.addEventListener("resize", schedulePlace, { passive: true });
  window.visualViewport?.addEventListener("resize", schedulePlace, { passive: true });
  window.visualViewport?.addEventListener("scroll", schedulePlace, { passive: true });
  window.addEventListener("pagehide", pageHide);
  window.addEventListener("pageshow", refreshSettings);
  chrome.storage.onChanged.addListener(settingsChanged);
  ns.textWorkspace = { alive, dispose };
  void refreshSettings();
})();

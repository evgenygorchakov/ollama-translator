// Оригинал при наведении: указатель задержался на переведённом ряду — над рядом всплывает
// исходный текст, а сам ряд подсвечивается. Только у рядов, где перевод встал на место оригинала:
// у перевода под оригиналом и у ⚠ оригинал и так на странице. Подсказка указатель не ловит, так
// что ссылки и кнопки под ней не закрывает. Включает и выключает content.js вместе с переводом.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const { render } = ns;

  const SHOW_DELAY_MS = 500;
  // Подсказка уже на экране: столько ждём, прежде чем перейти к другому ряду или спрятать её, —
  // указатель, пересекающий промежуток между абзацами, её не дёргает.
  const SWITCH_DELAY_MS = 300;
  const MARGIN = 8; // от краёв окна
  const GAP = 4; // от ряда
  const CURSOR_HEIGHT = 24; // стрелка указателя уходит вниз от его точки
  const HIGHLIGHT = "ot-original"; // ::highlight в content.css

  const STYLE = `
    :host { all: initial; }
    .tip {
      --bg: #ffffff; --fg: #1f2328; --border: #d0d7de;
      box-sizing: border-box;
      width: max-content; max-width: min(560px, calc(100vw - ${2 * MARGIN}px));
      max-height: 50vh; overflow: hidden;
      padding: 6px 10px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
      text-align: left; white-space: normal; overflow-wrap: anywhere;
    }
    @media (prefers-color-scheme: dark) {
      .tip { --bg: #22272e; --fg: #e6edf3; --border: #444c56; }
    }
  `;

  // блок → его сегменты (content.js); null — подсказка выключена
  let rowsOf = null;
  let ui = null; // { host, tip }
  let shown = null; // сегмент, чей оригинал на экране
  let candidate = null; // переведённый ряд под указателем
  let timer = null;
  let frame = 0;
  let pointer = { target: null, x: 0, y: 0 };

  const normalize = (text) => text.replace(/\s+/g, " ").trim();

  function rangeOf(seg) {
    const range = document.createRange();
    const last = seg.nodes[seg.nodes.length - 1];
    range.setStart(seg.nodes[0], 0);
    range.setEnd(last, last.length);
    return range;
  }

  // Текстовый узел под указателем или ближайший к нему. Chrome до 128 знает только
  // caretRangeFromPoint, Firefox — только caretPositionFromPoint.
  function textAt(x, y) {
    const caret = document.caretPositionFromPoint?.(x, y);
    const node = caret ? caret.offsetNode : document.caretRangeFromPoint?.(x, y)?.startContainer;
    return node?.nodeType === Node.TEXT_NODE ? node : null;
  }

  // Переведённый на месте ряд под указателем: ряд текстового узла под ним, если указатель в
  // рамке ряда, — так и промежутки между строками абзаца считаются рядом. Ряд узла ищем у блоков
  // над ним, ближние первыми. Рамку меряем только у этого ряда: в блоке с сотнями строк через
  // <br> мерить на каждый кадр все — дорого.
  function rowAt({ target, x, y }) {
    const node = target && textAt(x, y);
    for (let el = node?.parentElement; el; el = el.parentElement) {
      const seg = rowsOf(el)?.find((s) => s.nodes.includes(node));
      if (!seg) continue;
      if (!render.isReplaced(seg)) return null;
      const r = rangeOf(seg).getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? seg : null;
    }
    return null;
  }

  function build() {
    // Своё имя тега: правила сайта вида div { … } до него не дотянутся. Но элемент с дефисом в
    // имени не определён, а сайты на веб-компонентах прячут такие (:not(:defined)) — отсюда
    // visibility и opacity. Слоем ниже пузыря перевода выделенного: его не закроет.
    const host = document.createElement("ot-original-tip");
    host.style.cssText =
      "position:fixed!important;z-index:2147483646!important;display:block!important;" +
      "visibility:visible!important;opacity:1!important;" +
      "margin:0!important;padding:0!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.setAttribute("role", "tooltip");
    shadow.append(style, tip);
    return { host, tip };
  }

  // Над рядом, не влезает — под ним. Если ряд не оставляет места ни над собой, ни под собой
  // (длинный абзац), — над указателем или под ним: строку, которую читают, подсказка не закроет.
  function place(rect) {
    const { host, tip } = ui;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const { y } = pointer;
    const tops = [rect.top - GAP - h, rect.bottom + GAP, y - MARGIN - h, y + CURSOR_HEIGHT];
    const top = tops.find((t) => t >= MARGIN && t + h <= vh - MARGIN) ?? MARGIN;
    const left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
  }

  // Текст страницы — тоже только через textContent.
  function show(seg) {
    const original = normalize(seg.nodes.map(render.sourceOf).join(""));
    // модель оставила текст как есть (имя, название) — показывать нечего
    if (!render.isReplaced(seg) || original === normalize(seg.nodes.map((n) => n.data).join(""))) {
      hide();
      return;
    }
    ui ??= build();
    ui.tip.textContent = original;
    if (!ui.host.isConnected) document.documentElement.append(ui.host);
    shown = seg;
    const range = rangeOf(seg);
    place(range.getBoundingClientRect());
    CSS.highlights.set(HIGHLIGHT, new Highlight(range));
  }

  function hide() {
    if (!shown) return;
    shown = null;
    ui.host.remove();
    CSS.highlights.delete(HIGHLIGHT);
  }

  // Ряд под указателем сменился — через паузу показываем его оригинал или прячем подсказку.
  // Пока указатель на том же ряду, таймер не перезапускаем.
  function check() {
    frame = 0;
    const row = rowAt(pointer);
    if (row === candidate) return;
    candidate = row;
    clearTimeout(timer);
    if (row === shown) return;
    timer = setTimeout(() => (row ? show(row) : hide()), shown ? SWITCH_DELAY_MS : SHOW_DELAY_MS);
  }

  function onPointerMove(e) {
    // тянут выделение или что-то перетаскивают — подсказка мешала бы
    if (e.pointerType !== "mouse" || e.buttons) return;
    pointer = { target: e.target, x: e.clientX, y: e.clientY };
    frame ||= requestAnimationFrame(check);
  }

  // указатель ушёл из окна или во фрейм
  function onPointerOut(e) {
    if (e.relatedTarget || e.pointerType !== "mouse") return;
    pointer = { target: null, x: 0, y: 0 };
    frame ||= requestAnimationFrame(check);
  }

  // Клик (по ссылке, начало выделения) и Esc прячут подсказку. Ряд под указателем остаётся
  // candidate, так что снова она покажется, только когда указатель уйдёт с него и вернётся.
  function dismiss() {
    clearTimeout(timer);
    hide();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") dismiss();
  }

  // Прокрутка унесла ряд из-под подсказки и указателя — прячем её и ждём, где окажется указатель.
  // Прокрутка в стороне (карусель, лента в соседней колонке) не мешает.
  function onScroll(e) {
    if ([shown, candidate].some((seg) => seg && e.target.contains(seg.block))) reset();
  }

  function reset() {
    clearTimeout(timer);
    hide();
    candidate = null;
  }

  // Страница поменялась под неподвижным указателем (content.js зовёт после разбора мутаций):
  // ряд с подсказкой мог вернуться к оригиналу или получить новые узлы, а под указателем мог
  // оказаться другой ряд или диалог.
  function refresh() {
    if (!rowsOf) return;
    if (shown) show(shown); // заново текст, место и подсветка, а если ряд не на месте — спрячет
    if (pointer.target) frame ||= requestAnimationFrame(check);
  }

  // rows(block) → сегменты блока
  function start(rows) {
    rowsOf = rows;
    document.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    document.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
    document.addEventListener("pointerdown", dismiss, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", reset, { passive: true });
  }

  function stop() {
    if (!rowsOf) return;
    rowsOf = null;
    cancelAnimationFrame(frame);
    frame = 0;
    reset();
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("pointerdown", dismiss, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reset);
  }

  ns.hover = { start, stop, refresh };
})();

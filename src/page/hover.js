// Оригинал при наведении: указатель задержался на переведённом ряду — над рядом всплывает
// исходный текст, а сам ряд подсвечивается. Только у рядов, где перевод встал на место оригинала:
// у перевода под оригиналом и у ⚠ оригинал и так на странице. Подсказка указатель не ловит, так
// что ссылки и кнопки под ней не закрывает. Включает и выключает content.js вместе с переводом.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const { render, segment, shadowHost } = ns;

  const SHOW_DELAY_MS = 500;
  // Подсказка уже на экране: столько ждём, прежде чем перейти к другому ряду или спрятать её, —
  // указатель, пересекающий промежуток между абзацами, её не дёргает.
  const SWITCH_DELAY_MS = 300;
  const MARGIN = 8; // от краёв окна
  const GAP = 4; // от ряда
  const CURSOR_HEIGHT = 24; // стрелка указателя уходит вниз от его точки
  const LINE_HEIGHT = 20; // строка подсказки, px
  const HIGHLIGHT = "ot-original"; // ::highlight в content.css

  // Длинный оригинал обрезаем многоточием: строк — сколько влезет в полэкрана (show).
  const STYLE = `
    :host { all: initial; }
    .tip {
      --bg: #ffffff; --fg: #1f2328; --border: #d0d7de;
      box-sizing: border-box;
      width: max-content; max-width: min(560px, calc(100vw - ${2 * MARGIN}px));
      display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden;
      padding: 6px 10px;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--border); border-radius: 6px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      font: 14px/${LINE_HEIGHT}px system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
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
  let shownAt = null; // рамка ряда, когда показали подсказку
  let candidate = null; // переведённый ряд под указателем
  let timer = null;
  let frame = 0;
  let scrollFrame = 0;
  let scrollRoots = []; // теневые корни над рядом с подсказкой
  let pointer = null; // { x, y }; null — указатель вне окна

  // Ряд — его текстовые узлы, а не всё от первого до последнего: между ними может стоять
  // вынесенное из потока (выпадающее меню в ссылке, плавающая картинка), а это другие ряды.
  function rangesOf(seg) {
    return seg.nodes
      .filter((node) => node.data)
      .map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range;
      });
  }

  // рамка вокруг текста ряда
  function rectOf(ranges) {
    const box = { top: Infinity, left: Infinity, bottom: -Infinity, right: -Infinity };
    for (const range of ranges) {
      const r = range.getBoundingClientRect();
      if (!r.width && !r.height) continue; // скрытый узел
      box.top = Math.min(box.top, r.top);
      box.left = Math.min(box.left, r.left);
      box.bottom = Math.max(box.bottom, r.bottom);
      box.right = Math.max(box.right, r.right);
    }
    return box;
  }

  // Текстовый узел под указателем или ближайший к нему. Chrome до 128 знает только
  // caretRangeFromPoint, Firefox — только caretPositionFromPoint.
  function textAt(x, y) {
    const caret = document.caretPositionFromPoint?.(x, y);
    const node = caret ? caret.offsetNode : document.caretRangeFromPoint?.(x, y)?.startContainer;
    return node?.nodeType === Node.TEXT_NODE ? node : null;
  }

  // Переведённый на месте ряд в точке at: ряд текстового узла под ней, если она в рамке ряда, —
  // так и промежутки между строками абзаца считаются рядом. Ряд узла ищем у блоков над ним,
  // ближние первыми. Рамку меряем только у этого ряда: в блоке с сотнями строк через <br> мерить
  // на каждый кадр все — дорого.
  function rowAt(at) {
    const node = at && textAt(at.x, at.y);
    for (let el = node?.parentElement; el; el = el.parentElement) {
      const seg = rowsOf(el)?.find((s) => s.nodes.includes(node));
      if (!seg) continue;
      if (!render.isReplaced(seg)) return null;
      const r = rectOf(rangesOf(seg));
      return at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom ? seg : null;
    }
    return null;
  }

  // Теневые деревья над узлом: прокрутка в них до document не доходит (scroll не composed).
  // Узел, вставленный в <slot>, лежит в дереве своего слота.
  function shadowRootsAbove(node) {
    const roots = [];
    for (let n = node; n; n = n.assignedSlot ?? n.parentNode ?? n.host) {
      if (n.nodeType === Node.DOCUMENT_FRAGMENT_NODE) roots.push(n);
    }
    return roots;
  }

  function watchScroll(roots) {
    for (const root of scrollRoots) root.removeEventListener("scroll", onScroll, true);
    scrollRoots = roots;
    for (const root of roots) root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }

  function build() {
    const { host, shadow } = shadowHost(
      "ot-original-tip",
      // слоем ниже пузыря перевода выделенного: его не закроет
      "position:fixed!important;z-index:2147483646!important;display:block!important;" +
        "margin:0!important;padding:0!important;pointer-events:none!important;",
      STYLE,
    );
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.setAttribute("role", "tooltip");
    shadow.append(tip);
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
    const tops = [rect.top - GAP - h, rect.bottom + GAP];
    if (pointer) tops.push(pointer.y - MARGIN - h, pointer.y + CURSOR_HEIGHT);
    const top = tops.find((t) => t >= MARGIN && t + h <= vh - MARGIN) ?? MARGIN;
    const left = Math.min(Math.max(rect.left, MARGIN), Math.max(MARGIN, vw - w - MARGIN));
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
  }

  // Текст страницы — тоже только через textContent.
  function show(seg) {
    const { normalize } = segment;
    const original = normalize(seg.nodes.map(render.sourceOf).join(""));
    // модель оставила текст как есть (имя, название) — показывать нечего
    if (!render.isReplaced(seg) || original === normalize(seg.nodes.map((n) => n.data).join(""))) {
      hide();
      return;
    }
    ui ??= build();
    ui.tip.textContent = original;
    const lines = Math.max(1, Math.floor(window.innerHeight / 2 / LINE_HEIGHT));
    ui.tip.style.setProperty("-webkit-line-clamp", String(lines));
    if (!ui.host.isConnected) document.documentElement.append(ui.host);
    shown = seg;
    const ranges = rangesOf(seg);
    shownAt = rectOf(ranges);
    place(shownAt);
    CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
    watchScroll(shadowRootsAbove(seg.block));
  }

  function hide() {
    if (!shown) return;
    shown = null;
    ui.host.remove();
    CSS.highlights.delete(HIGHLIGHT);
    watchScroll([]);
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
    // за паузу страница могла сдвинуть или спрятать ряд — показываем, только если он на месте
    timer = setTimeout(() => {
      if (row && rowAt(pointer) !== row) reset();
      else if (row) show(row);
      else hide();
    }, shown ? SWITCH_DELAY_MS : SHOW_DELAY_MS);
  }

  function onPointerMove(e) {
    // тянут выделение или что-то перетаскивают — подсказка мешала бы
    if (e.pointerType !== "mouse" || e.buttons) return;
    pointer = { x: e.clientX, y: e.clientY };
    frame ||= requestAnimationFrame(check);
  }

  // указатель ушёл из окна или во фрейм
  function onPointerOut(e) {
    if (e.relatedTarget || e.pointerType !== "mouse") return;
    pointer = null;
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

  // Прокрутка унесла ряд из-под подсказки или указателя — прячем её и ждём, куда двинется
  // указатель. Прокрутка в стороне (карусель, лента в соседней колонке) и подстройка прокрутки под
  // подгруженное выше (scroll anchoring) ряд не двигают — подсказка остаётся.
  function onScroll() {
    if (shown || candidate) scrollFrame ||= requestAnimationFrame(afterScroll);
  }

  function afterScroll() {
    scrollFrame = 0;
    const moved = (seg) => {
      const r = rectOf(rangesOf(seg));
      return Math.abs(r.top - shownAt.top) > 1 || Math.abs(r.left - shownAt.left) > 1;
    };
    const gone = (seg) => (seg === shown ? moved(seg) : rowAt(pointer) !== seg);
    if ([shown, candidate].some((seg) => seg && gone(seg))) reset();
  }

  function reset() {
    clearTimeout(timer);
    hide();
    candidate = null;
  }

  // Страница поменялась под неподвижным указателем (content.js зовёт после разбора мутаций):
  // ряд с подсказкой мог вернуться к оригиналу или получить новые узлы, а над ним — лечь диалог.
  // Тогда подсказку прячем, иначе обновляем. Новую без движения указателя не показываем, но если
  // указатель уже перешёл на другой ряд и ждёт его подсказку, этот переход не обрываем.
  function refresh() {
    if (!shown) return;
    const row = rowAt(pointer);
    if (row === shown) show(shown);
    else if (row && row === candidate) hide();
    else reset();
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
    cancelAnimationFrame(scrollFrame);
    frame = scrollFrame = 0;
    reset();
    pointer = null;
    document.removeEventListener("pointermove", onPointerMove, true);
    document.removeEventListener("pointerout", onPointerOut, true);
    document.removeEventListener("pointerdown", dismiss, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", reset);
  }

  ns.hover = { start, stop, refresh };
})();

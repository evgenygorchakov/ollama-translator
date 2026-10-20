// Оркестрация на странице: сегменты → IntersectionObserver → очередь → порт в background.
// Батчи и параллельность — на стороне background (общие для всех вкладок).
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  ns.content?.dispose(); // осиротевший экземпляр после перезагрузки расширения
  const { segment, render, hover } = ns;

  const FLUSH_MS = 50;
  const MUTATION_DEBOUNCE_MS = 300;
  const MAX_RECONNECTS = 3;
  const MAX_SPARE = 1000;
  const MAX_MEMO = 5000;
  // От этих настроек зависит перевод: сменились — запомненные переводы не годятся.
  const TRANSLATION_KEYS = ["targetLang", "model", "systemPrompt"];

  let active = false;
  // { lang }, с которым включён перевод (pageConfig в background)
  let config = null;
  // «Стоп»: готовое остаётся на странице, новое не запрашиваем до «Продолжить»
  let paused = false;
  // seg: { block, anchor, nodes, inPlace, slots, parts, index,
  //        status: "idle"|"pending"|"done"|"error", span }
  let segments = new Set();
  let segmentsByBlock = new Map();
  let nextIndex = 0;
  // Одинаковые тексты на странице переводим один раз: текст → запись.
  // entry: { id, text, status: "new"|"queued"|"done"|"error", translation, error, epoch,
  //          segments: Set }
  let entries = new Map();
  let entriesById = new Map();
  // Неготовые записи, текстов которых сейчас нет на странице: виртуальные списки при прокрутке
  // перерисовывают те же строки — ошибка или ответ уже идущего батча их дождутся. Готовые сюда
  // не попадают: их перевод есть в memo (shelve). Текст → запись, старые первыми; сверх
  // MAX_SPARE забываем — иначе на бесконечной ленте память росла бы, пока включён перевод.
  // Забытый текст, который ещё переводился, вернувшись, получит новый id и переведётся заново, а
  // ответ на старый id пропустим. Бывает редко: к тому времени его батч обычно давно закончен.
  let spare = new Map();
  // Готовые переводы, пока открыта страница: текст → перевод, давно не нужные первыми.
  // Переживают выключение перевода, поэтому «Показать оригинал» и снова «Перевести» модель не
  // запускают. На диск ничего не пишем: страницу закрыли или перезагрузили — переводы забыты.
  // memoEpoch растёт при смене настроек перевода: ответы на запросы, отправленные раньше, могут
  // быть от прежней модели или на прежнем языке — их не запоминаем.
  let memo = new Map();
  let memoEpoch = 0;
  let nextId = 1;
  let outbox = [];
  let flushTimer = null;
  let observer = null;
  let mutationObserver = null;
  let mutationTimer = null;
  let addedNodes = new Set();
  let removedFrom = new Set(); // родители удалённых узлов
  let conn = null; // { post, close } из ns.connectPort
  let reconnects = 0;
  // Тексты, отправленные до выключения перевода: id → запись. Их батчи оборваны, но готовое
  // из них background ещё пришлёт — запомним в memo (stop).
  let draining = new Map();

  // ---------- Запись в DOM ----------

  // Наши записи в DOM не должны будить MutationObserver: иначе каждый вставленный перевод
  // пересканировал бы свой блок. JS однопоточный, так что между двумя takeRecords в DOM пишем
  // только мы. Значит, любая запись, которую видит onMutations, — от страницы. Чужие записи,
  // накопленные до нас, обрабатываем до своей: страница писала в узел раньше нас, и узел, куда
  // мы сейчас запишем перевод, onMutations забыть не должен.
  let quieting = false;
  function quiet(fn) {
    if (quieting || !mutationObserver) return fn();
    const pending = mutationObserver.takeRecords();
    if (pending.length) onMutations(pending);
    quieting = true;
    try {
      return fn();
    } finally {
      mutationObserver.takeRecords();
      quieting = false;
    }
  }

  // ---------- Состояние сегмента ----------

  // Пока перевод не готов, на странице оригинал; готов — перевод, ошибка — ⚠.
  function update(seg) {
    if (seg.status === "removed") return;
    const parts = seg.parts.map((text) => entries.get(text));
    const failed = parts.find((e) => e.status === "error");
    if (parts.every((e) => e.status === "done")) {
      seg.status = "done";
      quiet(() => render.setTranslation(seg, parts.map((e) => e.translation).join(" ")));
    } else if (failed) {
      seg.status = "error";
      quiet(() => render.setError(seg, failed.error, () => retry(seg)));
    }
  }

  function request(seg) {
    seg.status = "pending";
    for (const text of seg.parts) {
      let entry = entries.get(text);
      if (!entry) {
        entry = { id: nextId++, text, status: "new", epoch: memoEpoch, segments: new Set() };
        if (memo.has(text)) {
          entry.status = "done";
          entry.translation = memo.get(text);
        }
        entries.set(text, entry);
        entriesById.set(entry.id, entry);
      }
      spare.delete(text);
      entry.segments.add(seg);
      if (entry.status === "new") enqueue(entry);
    }
    update(seg); // все части могли быть уже переведены в другом месте страницы
  }

  function retry(seg) {
    resume(); // ⚠ нажали после «Стоп» — значит, модель снова нужна
    seg.status = "pending";
    quiet(() => render.remove(seg));
    for (const text of seg.parts) {
      const entry = entries.get(text);
      // new — часть, которую «Стоп» снял с очереди, когда у абзаца уже была ⚠: resume() такой
      // абзац не подхватит, и без запроса здесь он остался бы непереведённым
      if (entry.status === "error" || entry.status === "new") enqueue(entry);
    }
  }

  function resolve(ids, apply) {
    for (const id of ids) {
      const entry = entriesById.get(id) ?? draining.get(id);
      if (!entry) continue;
      draining.delete(id);
      apply(entry);
      for (const seg of entry.segments) update(seg);
      // ответ на отменённый запрос: перевод теперь в memo, запись не нужна
      if (entry.status === "done" && spare.get(entry.text) === entry) forget(entry);
    }
  }

  function fail(list, message) {
    for (const entry of list) {
      entry.status = "error";
      entry.error = message;
      for (const seg of entry.segments) update(seg);
    }
  }

  // ---------- Список сегментов ----------

  function register(seg) {
    seg.index = nextIndex++;
    seg.status = "idle";
    segments.add(seg);
    let list = segmentsByBlock.get(seg.block);
    if (!list) segmentsByBlock.set(seg.block, (list = []));
    list.push(seg);
    // повторный observe уже видимого блока тоже даст событие — новый сегмент не потеряется
    observer.observe(seg.block);
  }

  function forget(entry) {
    entries.delete(entry.text);
    entriesById.delete(entry.id); // ответ background на старый id, если придёт, пропустим
    spare.delete(entry.text);
  }

  // У записи не осталось сегментов. Готовая больше не нужна: перевод в memo (remember заодно
  // освежит его там). Остальные ждут в spare: ошибка при перерисовке покажет ⚠ сразу, а не новым
  // запросом, а ответ на отменённый запрос, если его батч ещё идёт, применится.
  function shelve(entry) {
    if (entry.status === "done") {
      remember(entry);
      forget(entry);
      return;
    }
    spare.set(entry.text, entry);
    if (spare.size > MAX_SPARE) forget(spare.values().next().value);
  }

  // Сегмент исчез со страницы или его текст поменялся. Тексты, которые больше никому
  // не нужны, снимаем с очереди, а записи откладываем (shelve).
  function unregister(seg, cancelIds) {
    quiet(() => render.remove(seg));
    seg.status = "removed";
    segments.delete(seg);
    const list = segmentsByBlock.get(seg.block);
    const i = list?.indexOf(seg) ?? -1;
    if (i >= 0) list.splice(i, 1);
    if (list && !list.length) {
      segmentsByBlock.delete(seg.block);
      observer.unobserve(seg.block);
    }
    for (const text of seg.parts) {
      const entry = entries.get(text);
      if (!entry) continue;
      entry.segments.delete(seg);
      if (entry.segments.size) continue;
      if (entry.status === "queued") {
        const queued = outbox.indexOf(entry);
        if (queued >= 0) outbox.splice(queued, 1);
        else cancelIds.push(entry.id);
        // появится снова — запросим тот же id: если его батч ещё идёт, background не станет
        // переводить второй раз, а ответ батча применится
        entry.status = "new";
      }
      shelve(entry);
    }
  }

  const sameParts = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

  // Пересканирует поддерево (ownRows — только собственные ряды блока root): уже известные
  // сегменты (тот же блок и место вставки) не трогает, с другим текстом — заменяет, а те,
  // что больше не нашлись, снимает (например, к ряду дописали текст и место вставки сдвинулось).
  function rescan(root, cancelIds, ownRows = false) {
    // копии там, где мы не переводим, не трогаем: в поле ввода её мог вставить из буфера
    // сам пользователь
    quiet(() => render.removeCopies(root, (el) => segment.isExcluded(el.parentElement)));
    const kept = new Set();
    for (const seg of segment.findSegments(root, { ownRows })) {
      const old = segmentsByBlock.get(seg.block)?.find((s) => s.anchor === seg.anchor);
      if (old && old.inPlace === seg.inPlace && sameParts(old.parts, seg.parts)) {
        // текст тот же, а узлы фреймворк мог пересоздать
        quiet(() => render.setNodes(old, seg));
        // страница выкинула наш span при перерисовке или переписала текст, где стоял перевод
        if ((old.status === "done" || old.status === "error") && !render.isShown(old)) update(old);
        kept.add(old);
        continue;
      }
      if (old) unregister(old, cancelIds);
      register(seg);
      kept.add(seg);
    }
    for (const [block, list] of segmentsByBlock) {
      if (ownRows ? block !== root : !root.contains(block)) continue;
      for (const seg of [...list]) if (!kept.has(seg)) unregister(seg, cancelIds);
    }
  }

  function pruneDisconnected(cancelIds) {
    for (const seg of segments) {
      if (!seg.block.isConnected || !seg.anchor.isConnected) unregister(seg, cancelIds);
    }
  }

  function sendCancel(ids) {
    if (ids.length) conn?.post({ type: "cancel", ids }); // порт мёртв — background и так всё отменил
  }

  // ---------- Динамические страницы ----------

  // свои вставки: span[data-ot] и всё внутри него
  function isOurs(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(el?.closest("[data-ot]"));
  }

  // style меняют и анимации (transform, top…), а показать или скрыть блок может только display
  const styleProbe = document.createElement("div");
  function displayChanged(el, oldStyle) {
    styleProbe.style.cssText = oldStyle ?? "";
    return styleProbe.style.display !== el.style?.display;
  }

  // Узел, который может входить в ряд: текст или элемент — строчный с текстом либо блочный,
  // который делит ряды (<hr>, пустой рекламный div). Скрипты, стили и комментарии — нет.
  const INVISIBLE_TAGS = new Set(["script", "style", "noscript", "template", "link", "meta"]);
  function mayAffectRows(node) {
    if (node.nodeType === Node.TEXT_NODE) return true;
    return node.nodeType === Node.ELEMENT_NODE && !INVISIBLE_TAGS.has(node.localName);
  }

  function carriesText(el) {
    return el.localName === "br" || /\S/.test(el.textContent);
  }

  // Узлы, куда в этой задаче уже вернули перевод (onTextWritten).
  let rewritten = null;

  // Страница записала текст в узел. Если там стоял наш перевод, а она записала оригинал, — она
  // перерисовала тот же текст, и перевод возвращаем сразу: колбэк наблюдателя — микрозадача, до
  // отрисовки, так что английский не мелькнёт. Но не второй раз за задачу: страница, которая сама
  // следит за DOM, тут же записала бы оригинал снова, и спор с ней шёл бы бесконечным циклом
  // микрозадач. Иначе узел теперь страницы, что бы она ни записала (render.forgetNode), —
  // пересканируем его блок.
  function onTextWritten(node) {
    if (!rewritten?.has(node) && render.rewrite(node)) {
      if (!rewritten) {
        rewritten = new Set();
        setTimeout(() => (rewritten = null));
      }
      rewritten.add(node);
      return;
    }
    render.forgetNode(node);
    addedNodes.add(node);
  }

  function onMutations(records) {
    // Изменённые текстовые узлы разбираем после цикла, по разу на узел: если вернуть перевод
    // сразу, следующую запись о том же узле приняли бы за новый текст страницы.
    const written = new Set();
    for (const record of records) {
      const { type, target } = record;
      if (type === "characterData") {
        // SPA поменяли текст узла на месте
        if (!isOurs(target)) written.add(target);
      } else if (type === "attributes") {
        // скрытое показали через class/style/hidden/open (меню, вкладки, аккордеоны).
        // classList.toggle и запись style на каждый scroll дают запись и без изменений —
        // её отсеиваем первой, это дешевле всего.
        if (target.getAttribute(record.attributeName) === record.oldValue || isOurs(target)) continue;
        if (record.attributeName === "style" && !displayChanged(target, record.oldValue)) continue;
        addedNodes.add(target);
      } else if (!INVISIBLE_TAGS.has(target.localName) && !isOurs(target)) {
        // (CSS-in-JS дописывает правила текстовыми узлами в <style>)
        for (const node of record.addedNodes) {
          if (!isOurs(node) && mayAffectRows(node)) addedNodes.add(node);
        }
        // наш span тоже: если его выкинул фреймворк при перерисовке, rescan вставит его заново
        for (const node of record.removedNodes) {
          if (!mayAffectRows(node)) continue;
          removedFrom.add(target);
          break;
        }
      }
    }
    if (written.size) quiet(() => written.forEach(onTextWritten));
    if (addedNodes.size || removedFrom.size) {
      mutationTimer ??= setTimeout(processMutations, MUTATION_DEBOUNCE_MS);
    }
  }

  function processMutations() {
    mutationTimer = null;
    if (!active) return;
    segment.resetCache();
    // Появившееся или изменившееся поддерево сканируем целиком, а у блока вокруг него — только
    // собственные ряды, без вложенных блоков. Так узел, добавленный прямо в body, не
    // пересканирует всю страницу.
    const trees = new Set();
    const rows = new Set();
    const inBody = (node) => node.isConnected && document.body.contains(node);
    for (const node of addedNodes) {
      if (!inBody(node)) continue;
      if (node === document.body) {
        trees.add(node); // сменили class у body — показать или скрыть могли что угодно
        continue;
      }
      // в скрытом, <style>, <script>, notranslate… переводить нечего
      if (segment.isExcluded(node.parentElement)) continue;
      const block = segment.blockOf(node.parentElement);
      if (node.nodeType === Node.TEXT_NODE) {
        rows.add(block);
        continue;
      }
      // Элемент с текстом — поддерево, которое надо просмотреть (скрытое — дёшево: его
      // фрагменты просто снимем), а видимый строчный — ещё и часть ряда. Блочный делит ряды,
      // а скрытый мог из них пропасть — это важно, только если в блоке уже есть наши фрагменты.
      // Поэтому тултип с display: none, добавленный в body, всю страницу не пересканирует.
      const withText = carriesText(node);
      if (withText) trees.add(node);
      const inRow = withText && !segment.isExcluded(node) && !segment.isBlock(node);
      if (inRow || segmentsByBlock.has(block)) rows.add(block);
    }
    // Удалённое меняет ряды, только если его удалили из блока с нашими фрагментами, иначе
    // хватит pruneDisconnected.
    for (const parent of removedFrom) {
      if (!inBody(parent) || segment.isExcluded(parent)) continue;
      const block = segment.blockOf(parent);
      if (segmentsByBlock.has(block)) rows.add(block);
    }
    addedNodes = new Set();
    removedFrom = new Set();

    const cancelIds = [];
    pruneDisconnected(cancelIds);
    // поддерево внутри другого и ряды блока внутри поддерева просмотрит сканирование целиком
    const inTree = (node, self) => [...trees].some((root) => root !== self && root.contains(node));
    for (const root of trees) if (!inTree(root, root)) rescan(root, cancelIds);
    for (const block of rows) if (!inTree(block)) rescan(block, cancelIds, true);
    sendCancel(cancelIds);
    hover?.refresh(); // ряд под подсказкой могли переписать или снять
  }

  // ---------- Очередь и порт ----------

  function enqueue(entry) {
    entry.status = "queued";
    entry.epoch = memoEpoch;
    outbox.push(entry);
    flushTimer ??= setTimeout(flush, FLUSH_MS);
  }

  function flush() {
    flushTimer = null;
    if (!active || !outbox.length) return;
    const batch = outbox.splice(0);
    let c;
    try {
      c = getConn();
    } catch (err) {
      // подключиться не вышло: обычно «Extension context invalidated» — расширение перезагрузили
      console.error("[ot]", err);
      fail(batch, "Нет связи с расширением — обновите страницу");
      return;
    }
    // порт умер, а onDisconnect ещё не пришёл — post вызовет onPortDisconnect, батч вернётся в очередь
    c.post({
      type: "translate",
      items: batch.map(({ id, text }) => ({ id, text })),
    });
  }

  function hasQueued() {
    for (const entry of entries.values()) if (entry.status === "queued") return true;
    return false;
  }

  // Записанный заново перевод переезжает в конец: вытесняем давно не нужные, а не давно
  // переведённые.
  function remember(entry) {
    if (entry.epoch !== memoEpoch) return;
    memo.delete(entry.text);
    memo.set(entry.text, entry.translation);
    if (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value);
  }

  function onPortMessage(msg) {
    reconnects = 0;
    if (msg.type === "result") {
      resolve(msg.ids, (entry) => {
        entry.translation = msg.translations[msg.ids.indexOf(entry.id)];
        entry.status = "done";
        remember(entry);
      });
    } else if (msg.type === "error") {
      console.warn(`[ot] ${msg.code}: ${msg.message}`);
      resolve(msg.ids, (entry) => {
        entry.status = "error";
        entry.error = msg.message;
      });
    } else if (msg.type === "pause") {
      pause();
    }
  }

  function closePort() {
    conn?.close();
    conn = null;
  }

  // Service worker упал или перезапустился — его очередь потеряна, отправляем заново.
  function onPortDisconnect() {
    closePort();
    if (!active) return;
    const lost = [...entries.values()].filter((e) => e.status === "queued" && !outbox.includes(e));
    if (++reconnects > MAX_RECONNECTS) {
      fail(lost, "Связь с расширением потеряна");
      return;
    }
    for (const entry of lost) enqueue(entry);
  }

  function getConn() {
    conn ??= ns.connectPort("translate", {
      onMessage: onPortMessage,
      onDisconnect: onPortDisconnect,
      needsPing: hasQueued, // пока ждём ответов, держим service worker живым
    });
    return conn;
  }

  // ---------- Включение / выключение ----------

  function onIntersect(records) {
    const visible = [];
    for (const record of records) {
      if (!record.isIntersecting) continue;
      observer.unobserve(record.target);
      if (paused) continue; // resume() начнёт наблюдать за блоком снова
      for (const seg of segmentsByBlock.get(record.target) ?? []) {
        if (seg.status === "idle") visible.push(seg);
      }
    }
    visible.sort((a, b) => a.index - b.index);
    for (const seg of visible) request(seg);
  }

  // ---------- «Стоп» и «Продолжить» ----------

  // Background уже оборвал запросы вкладки и очистил её очередь (или вот-вот это сделает):
  // всё запрошенное, но не готовое, возвращаем в исходное состояние. Вызывается и повторно:
  // так background отвечает на запросы, отправленные до паузы.
  function pause() {
    if (!active) return;
    paused = true;
    clearTimeout(flushTimer);
    flushTimer = null;
    outbox = [];
    for (const entry of entries.values()) if (entry.status === "queued") entry.status = "new";
    for (const seg of segments) if (seg.status === "pending") seg.status = "idle";
  }

  function resume() {
    if (!active || !paused) return;
    paused = false;
    // без порта нечего и снимать: клиент нового порта в background начинает без паузы
    conn?.post({ type: "resume" });
    // уже наблюдаемые блоки observe не тронет; остальные IntersectionObserver отдаст сразу,
    // если они в видимой зоне
    for (const [block, list] of segmentsByBlock) {
      if (list.some((seg) => seg.status === "idle")) observer.observe(block);
    }
  }

  function start(next) {
    active = true;
    paused = false;
    reconnects = 0;
    // порт мог остаться с прошлого включения (stop), а «Стоп» ставит на паузу и его
    conn?.post({ type: "resume" });
    config = next;
    render.configure(config);
    // видимое + один экран вперёд
    observer = new IntersectionObserver(onIntersect, { rootMargin: "100% 0px" });
    segment.resetCache(); // стили могли поменяться с прошлого включения
    const found = segment.findSegments(document.body);
    for (const seg of found) register(seg);
    // подгружаемые ленты и SPA
    mutationObserver = new MutationObserver(onMutations);
    mutationObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "open"],
      attributeOldValue: true,
    });
    // оригинал при наведении; без hover.js перевод работает и так
    hover?.start((block) => segmentsByBlock.get(block));
    console.info(`[ot] найдено фрагментов: ${found.length}`);
  }

  function stop() {
    active = false;
    paused = false;
    observer?.disconnect();
    observer = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    clearTimeout(mutationTimer);
    mutationTimer = null;
    addedNodes = new Set();
    removedFrom = new Set();
    clearTimeout(flushTimer);
    flushTimer = null;
    hover?.stop();
    // Порт не закрываем: оборванные отменой батчи ещё пришлют готовое, и снова включённый
    // перевод возьмёт его из memo, а не у модели. Умрёт порт — onPortDisconnect не станет
    // переподключаться: active уже false.
    conn?.post({ type: "cancel" });
    draining = new Map();
    for (const entry of entries.values()) {
      // пока текст был на странице, memo мог его вытеснить
      if (entry.status === "done") remember(entry);
      if (entry.status !== "queued" || outbox.includes(entry)) continue;
      entry.segments.clear(); // ответ не должен попасть на страницу
      draining.set(entry.id, entry);
    }
    render.removeAll();
    segments = new Set();
    segmentsByBlock = new Map();
    entries = new Map();
    entriesById = new Map();
    spare = new Map();
    outbox = [];
  }

  // requested — фрагменты, дошедшие до видимой зоны (остальные ждут прокрутки)
  function getState() {
    let done = 0;
    let errors = 0;
    let requested = 0;
    for (const seg of segments) {
      if (seg.status === "idle") continue;
      requested++;
      if (seg.status === "done") done++;
      else if (seg.status === "error") errors++;
    }
    return { active, paused, done, errors, requested, total: segments.size };
  }

  // toggle на паузе выключает перевод — это «Показать оригинал»
  function onMessage(msg, _sender, sendResponse) {
    switch (msg?.type) {
      case "toggle":
        if (active) stop();
        else start(msg.config);
        sendResponse(getState());
        break;
      case "getState":
        sendResponse(getState());
        break;
      case "pause": // «Стоп», рассылка из background
        pause();
        break;
      case "resume": // «Продолжить» в popup
        resume();
        sendResponse(getState());
        break;
    }
  }

  // Смена языка — перевод заново: готовые переводы в entries на старом языке. Сравниваем с тем,
  // что на странице: сброс настроек присылает ключи и без смены значений.
  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    const changed = (key) => key in changes && changes[key].oldValue !== changes[key].newValue;
    if (TRANSLATION_KEYS.some(changed)) {
      memo = new Map();
      memoEpoch++;
    }
    if (!active || !("targetLang" in changes)) return;
    chrome.runtime.sendMessage({ type: "getPageConfig" }).then(
      (next) => {
        if (!next || !active || next.lang === config.lang) return;
        const wasPaused = paused;
        stop();
        start(next);
        // после «Стоп» модель не запускаем, пока не нажмут «Продолжить»
        if (wasPaused) pause();
      },
      () => {}, // расширение перезагружено — неважно
    );
  }

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // Новый экземпляр внедряется только тогда, когда старый не ответил на getState, — значит,
  // расширение перезагрузили, и старый надо полностью снести, вместе с подписками: если
  // контекст ещё жив, они продолжили бы отвечать на toggle.
  function dispose() {
    stop();
    closePort();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // контекст расширения уже мёртв — подписки и так не сработают
    }
  }

  ns.content = { getState, dispose };
})();

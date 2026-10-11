// Озвучка YouTube-видео, content script: панель в левом верхнем углу плеера — кнопка
// «Перевести» и меню настроек озвучки — и русские субтитры над панелью плеера (если включены в
// меню). Нажатие ставит видео на паузу, пока service worker переводит и озвучивает первые
// READY_S секунд от позиции, потом видео идёт с русским голосом (его проигрывает
// dub/player.js), а подготовка — с опережением. Протокол порта "dub" и сообщений меню — в
// dub/background.js.
// С переводом страницы может делить isolated world, поэтому в общем namespace занимает только
// ключ dub и на сообщения перевода страницы не отвечает.
(() => {
  const ns = (window.__ollamaTranslator ??= {});
  const dub = (ns.dub ??= {}); // createPlayer в нём уже положил dub/player.js
  dub.dispose?.(); // осиротевший экземпляр после перезагрузки расширения

  const PLAYER_POLL_MS = 500;
  const PLAYER_POLLS = 20; // плеер не появился за 10 с — ждём следующего перехода
  const READY_S = 30; // видео идёт, когда готово столько от позиции (как в dub/lib/queue.js)
  const RESUME_S = 15; // подготовка отстала — видео продолжается, когда готово столько
  const POSITION_EVERY_S = 5; // при просмотре сообщаем позицию service worker'у так часто
  const LINGER_S = 0.6; // перевод держится на экране после конца фразы
  // Порт умирает сразу после подключения столько раз подряд — связи нет, переподключаться незачем.
  const FAST_FAIL_MS = 5000;
  const MAX_FAST_FAILS = 3;
  // Настройки меню не прочитались (service worker перезапускается) — пробуем ещё столько раз.
  const SETTINGS_RETRY_MS = 3000;
  const SETTINGS_RETRIES = 3;

  // Панель — полоска кнопок «Перевести», меню и ✕, а под ней меню, как меню настроек YouTube.
  const PANEL_STYLE = `
    :host { all: initial; }
    .panel {
      display: flex; flex-direction: column; align-items: flex-start;
      font: 500 14px/20px "YouTube Noto", Roboto, Arial, Helvetica, sans-serif;
      transition: opacity 0.25s cubic-bezier(0, 0, 0.2, 1);
    }
    /* панель YouTube спряталась — прячемся и мы, если меню закрыто, а панель не под мышью */
    .panel.autohide:not(.open):not(:hover):not(:has(:focus-visible)) {
      opacity: 0; pointer-events: none;
      transition: opacity 0.1s cubic-bezier(0.4, 0, 1, 1);
    }
    .bar {
      display: flex; max-width: 480px; border-radius: 18px; overflow: hidden;
      background: rgba(0, 0, 0, 0.6); color: #fff;
    }
    button {
      all: unset; box-sizing: border-box; display: flex; align-items: center; cursor: pointer;
      padding: 6px 12px; font: inherit;
    }
    button[hidden] { display: none; }
    button:hover, .open .settings { background: rgba(255, 255, 255, 0.15); }
    button:focus-visible { outline: 2px solid #fff; outline-offset: -2px; }
    .bar > button + button { padding: 6px 10px; border-left: 1px solid rgba(255, 255, 255, 0.2); }
    .main {
      display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .main.busy { cursor: progress; }
    .main.error { background: rgba(170, 30, 30, 0.85); }
    .main.error:hover { background: rgba(200, 40, 40, 0.9); }
    svg {
      width: 20px; height: 20px;
      fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round;
    }
    .menu {
      box-sizing: border-box; width: 280px; margin-top: 8px; padding: 8px 0;
      border-radius: 12px; background: rgba(28, 28, 28, 0.9); color: #eee;
      font-weight: 400; font-size: 13px; text-shadow: 0 0 2px rgba(0, 0, 0, 0.5);
      color-scheme: dark;
    }
    .menu[hidden] { display: none; }
    .item { display: block; padding: 8px 16px; }
    .row { display: flex; justify-content: space-between; gap: 12px; }
    .value { color: #fff; font-weight: 500; font-variant-numeric: tabular-nums; }
    .hint { color: #aaa; font-size: 12px; line-height: 16px; }
    input[type="range"] {
      display: block; width: 100%; margin: 6px 0 2px; accent-color: #3ea6ff; cursor: pointer;
    }
    .toggle {
      position: relative; display: flex; align-items: center; justify-content: space-between;
      gap: 12px; cursor: pointer;
    }
    .toggle:hover, .link:hover { background: rgba(255, 255, 255, 0.1); }
    .toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .switch {
      flex: none; position: relative; width: 36px; height: 14px; margin-right: 3px;
      border-radius: 7px; background: rgba(255, 255, 255, 0.3); transition: background 0.1s;
    }
    .switch::before {
      content: ""; position: absolute; top: -3px; left: -3px; width: 20px; height: 20px;
      border-radius: 50%; background: #bdbdbd; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
      transition: transform 0.1s, background 0.1s;
    }
    input:checked + .switch { background: rgba(62, 166, 255, 0.5); }
    input:checked + .switch::before { transform: translateX(22px); background: #3ea6ff; }
    input:focus-visible + .switch { outline: 2px solid #fff; outline-offset: 4px; }
    .link {
      display: block; width: 100%; margin-top: 4px; padding: 8px 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.15); color: #aaa; font-size: 12px;
    }
  `;

  // Ползунки меню: настройка → подпись, вид значения и подсказка.
  const RANGES = {
    dubOriginalVolume: {
      label: "Громкость оригинала",
      format: (v) => `${Math.round(v * 100)}%`,
    },
    dubMaxSpeed: {
      label: "Ускорение речи, не больше",
      format: (v) => `×${v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}`,
      hint: "Когда перевод длиннее оригинала. Для ещё не озвученных фраз",
    },
  };

  // Размер шрифта — от высоты плеера (cqh), как у субтитров YouTube.
  const SUBTITLE_STYLE = `
    :host { all: initial; }
    .frame { position: absolute; inset: 0; container-type: size; pointer-events: none; }
    .line {
      position: absolute; left: 50%; bottom: max(12px, 5cqh); transform: translateX(-50%);
      box-sizing: border-box; width: max-content; max-width: 80%;
      padding: 0.1em 0.45em; border-radius: 4px;
      background: rgba(8, 8, 8, 0.75); color: #fff; text-align: center;
      font: 400 clamp(14px, 4.2cqh, 42px)/1.3 "YouTube Noto", Roboto, Arial, Helvetica, sans-serif;
      transition: bottom 0.2s cubic-bezier(0, 0, 0.2, 1);
    }
    /* панель YouTube видна — поднимаемся над ней */
    .frame.raised .line { bottom: 64px; }
    .line:empty { display: none; }
  `;

  // Кнопка «Перевести». idle — «Перевести»; ad — нажали во время рекламы, начнём после неё;
  // loading — загрузка субтитров; preparing — подготовка первых READY_S с, видео ждёт; on —
  // озвучка идёт; buffering — подготовка отстала, видео ждёт следующие RESUME_S с; stopped —
  // «Стоп» в popup, нажатие продолжает; error — ошибка, нажатие повторяет; none — нет английских
  // субтитров; live — трансляция, панели нет. В stopped и error рядом крестик — выключить
  // озвучку. Голос звучит в on и buffering.
  let state = "idle";
  // Озвучку включили и не выключали: перевод на экране, если субтитры включены в меню.
  // Остаётся и после «Стоп» и ошибки.
  let enabled = false;
  let subtitles = false; // настройка dubSubtitles из меню
  // Ключи настроек меню: сменились в storage — просим значения заново. Пусто — ещё не прочитаны.
  let settingKeys = [];
  let saving = 0; // сохранения настроек из этой вкладки, на которые service worker не ответил
  let staleSettings = false; // пока они шли, настройки сменились — перечитать после них
  let settingsTimer = null;
  let videoId = null; // видео на странице /watch; null — другая страница
  let phrases = null; // [{ id, start, end, text }] по порядку времени, от service worker'а
  let kind = ""; // asr — автоматические субтитры, manual — ручные
  let translations = new Map(); // id → перевод; "" — модель не перевела, фразу пропускаем
  let conn = null; // { post, close } из ns.connectPort
  let connectedAt = 0;
  let fastFails = 0;
  let pausedByUs = false; // видео на паузу поставили мы, нам и продолжать
  // Пользователь запустил видео, не дождавшись догрузки: не останавливаем его, пока подготовка
  // не догонит.
  let overridden = false;
  let lastPosted = -Infinity; // последняя позиция, отправленная service worker'у
  let enabledAt = 0; // performance.now() включения — для подсказки, сколько шла подготовка
  let onHint = ""; // подсказка на кнопке «Озвучка ✓»
  let player = null; // #movie_player, в котором стоят панель и субтитры
  let classObserver = null;
  let pollTimer = null;

  // Свой тег: правила сайта вида div { … } до него не дотянутся. Стили — внутри shadow, текст
  // только через textContent (на YouTube innerHTML к тому же запрещён Trusted Types).
  function shadowHost(tag, hostCss, css) {
    const host = document.createElement(tag);
    host.style.cssText = hostCss;
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    shadow.append(style);
    return { host, shadow };
  }

  function element(tag, className, text = "") {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  // label — подсказка при наведении и имя для экранного диктора
  function button(className, onPress, text = "", label = "") {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", onPress);
    if (label) {
      node.title = label;
      node.setAttribute("aria-label", label);
    }
    return node;
  }

  // Значок меню — три ползунка: линия на высоте y с ручкой в x.
  function slidersIcon() {
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const [y, x] of [[6, 15], [12, 9], [18, 13]]) {
      const line = document.createElementNS(svgNs, "path");
      line.setAttribute("d", `M4 ${y}H${x - 3}M${x + 3} ${y}H20`);
      const knob = document.createElementNS(svgNs, "circle");
      knob.setAttribute("cx", x);
      knob.setAttribute("cy", y);
      knob.setAttribute("r", 2);
      svg.append(line, knob);
    }
    return svg;
  }

  function buildPanel() {
    const { host, shadow } = shadowHost(
      "ot-dub-panel",
      "position:absolute!important;top:12px!important;left:12px!important;" +
        "z-index:60!important;margin:0!important;padding:0!important;",
      PANEL_STYLE,
    );
    // до плеера события не пускаем: клик по нему — пауза, двойной клик — полный экран
    const events = "click dblclick mousedown mouseup pointerdown pointerup keydown keyup contextmenu";
    for (const type of events.split(" ")) host.addEventListener(type, (e) => e.stopPropagation());

    const main = button("main", onClick);
    const settings = button("settings", () => setMenu(ui.menu.hidden), "", "Настройки перевода");
    settings.append(slidersIcon());
    settings.setAttribute("aria-expanded", "false");
    settings.hidden = true; // пока service worker не прислал настройки
    const close = button("close", () => turnOff(), "✕", "Выключить озвучку");
    close.hidden = true;
    const bar = element("div", "bar");
    bar.append(main, settings, close);

    const menu = element("div", "menu");
    menu.hidden = true;
    const ranges = {}; // настройка → { input, value }
    for (const [key, { label, hint }] of Object.entries(RANGES)) {
      const input = document.createElement("input");
      input.type = "range";
      input.setAttribute("aria-label", label);
      input.addEventListener("input", () => onRangeInput(key));
      input.addEventListener("change", () => saveSetting(key, Number(input.value)));
      const value = element("span", "value");
      const row = element("div", "row");
      row.append(element("span", "", label), value);
      const item = element("div", "item");
      item.append(row, input);
      if (hint) item.append(element("div", "hint", hint));
      menu.append(item);
      ranges[key] = { input, value };
    }
    const subtitlesBox = document.createElement("input");
    subtitlesBox.type = "checkbox";
    subtitlesBox.setAttribute("role", "switch");
    subtitlesBox.addEventListener("change", onSubtitlesToggle);
    const toggle = element("label", "item toggle");
    toggle.append(element("span", "", "Русские субтитры"), subtitlesBox, element("span", "switch"));
    const options = button("link", openOptions, "Голос и Silero — в настройках расширения");
    menu.append(toggle, options);

    const panel = element("div", "panel");
    panel.append(bar, menu);
    shadow.append(panel);

    // Мышью фокус в панели не оставляем: иначе пробел и стрелки доставались бы ей, а не YouTube.
    let byPointer = false;
    host.addEventListener("pointerdown", () => (byPointer = true));
    host.addEventListener("keydown", () => (byPointer = false));
    for (const type of ["click", "change"]) {
      shadow.addEventListener(type, () => {
        if (byPointer) setTimeout(() => shadow.activeElement?.blur());
      });
    }
    return { host, panel, main, settings, close, menu, ranges, subtitles: subtitlesBox };
  }

  // Слой на весь плеер, мышь проходит сквозь него к видео.
  function buildSubtitles() {
    const { host, shadow } = shadowHost(
      "ot-dub-subtitles",
      "position:absolute!important;inset:0!important;z-index:45!important;" +
        "margin:0!important;padding:0!important;pointer-events:none!important;",
      SUBTITLE_STYLE,
    );
    const frame = document.createElement("div");
    frame.className = "frame";
    const line = document.createElement("div");
    line.className = "line";
    line.lang = "ru";
    frame.append(line);
    shadow.append(frame);
    return { host, frame, line };
  }

  const ui = buildPanel();
  const sub = buildSubtitles();
  const voice = dub.createPlayer({
    getVideo: mainVideo,
    adShowing,
    onMissing: onVoiceMissing,
    onEvict: (ids) => conn?.post({ type: "evicted", ids }),
  });

  // text — надпись, hint — подсказка при наведении
  function render(next, text, hint = "") {
    state = next;
    ui.main.textContent = text;
    ui.main.title = hint;
    const busy = awaited();
    ui.main.classList.toggle("busy", busy);
    ui.main.classList.toggle("error", next === "error");
    ui.main.setAttribute("aria-busy", String(busy));
    ui.close.hidden = next !== "stopped" && next !== "error";
    // в остальных состояниях голос молчит, а оригинал звучит как обычно
    if (next === "on" || next === "buffering") voice.activate();
    else voice.deactivate();
    updateVisibility();
  }

  // Пользователь ждёт подготовку: субтитры, первые READY_S с или догрузку.
  function awaited() {
    return state === "loading" || state === "preparing" || state === "buffering";
  }

  // Трансляцию узнаём по значку LIVE в плеере ещё до нажатия, а после нажатия — по ответу.
  // Во время подготовки, при ошибке и с открытым меню панель видна и без панели YouTube.
  function updateVisibility() {
    if (!player) return;
    const live = state === "live" || player.querySelector(".ytp-time-display.ytp-live") !== null;
    if (live) setMenu(false); // панели нет — нет и меню
    const display = live ? "none" : "block";
    ui.host.style.setProperty("display", display, "important");
    sub.host.style.setProperty("display", display, "important");
    const autohide = player.classList.contains("ytp-autohide");
    const pinned = state === "ad" || state === "error" || awaited();
    ui.panel.classList.toggle("autohide", !pinned && autohide);
    sub.frame.classList.toggle("raised", !autohide);
  }

  function currentVideoId() {
    if (location.pathname !== "/watch") return null;
    return new URLSearchParams(location.search).get("v");
  }

  // Загрузка страницы и каждый переход внутри YouTube (это SPA): другое видео — всё сначала.
  function sync() {
    const id = currentVideoId();
    if (id !== videoId) {
      videoId = id;
      reset();
    }
    attach(0);
  }

  function reset() {
    setMenu(false);
    closePort();
    enabled = false;
    phrases = null;
    kind = "";
    translations = new Map();
    voice.clear();
    pausedByUs = false;
    overridden = false;
    render("idle", "Перевести");
    showSubtitle();
  }

  // Панель и субтитры — в текущем #movie_player: плеер может появиться позже или быть
  // пересоздан. Вне /watch (мини-плеер на главной и т. п.) их нет.
  function attach(attempt) {
    clearTimeout(pollTimer);
    const found = videoId ? document.getElementById("movie_player") : null;
    if (found !== player) {
      classObserver?.disconnect();
      classObserver = null;
      listenMedia(player, false);
      player = found;
      listenMedia(player, true);
      voice.attach(player);
    }
    if (!player) {
      ui.host.remove();
      sub.host.remove();
      if (videoId && attempt < PLAYER_POLLS) {
        pollTimer = setTimeout(() => attach(attempt + 1), PLAYER_POLL_MS);
      }
      return;
    }
    if (sub.host.parentNode !== player) player.append(sub.host);
    if (ui.host.parentNode !== player) player.append(ui.host);
    if (!classObserver) {
      // ytp-autohide — YouTube прячет свою панель, ad-showing — идёт реклама
      classObserver = new MutationObserver(() => {
        updateVisibility();
        showSubtitle();
        voice.refresh();
      });
      classObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
    }
    updateVisibility();
    showSubtitle();
  }

  // ---------- Видео ----------

  // События <video> не всплывают, но проходят фазу захвата через плеер: так их видно, даже если
  // YouTube заменит элемент <video>.
  const MEDIA_EVENTS = { timeupdate: onTimeUpdate, seeked: onSeeked, play: onPlay };

  function listenMedia(target, on) {
    if (!target) return;
    for (const [type, fn] of Object.entries(MEDIA_EVENTS)) {
      if (on) target.addEventListener(type, fn, true);
      else target.removeEventListener(type, fn, true);
    }
  }

  function mainVideo() {
    return player?.querySelector("video") ?? null;
  }

  function currentTime() {
    return mainVideo()?.currentTime ?? 0;
  }

  // Во время рекламы время <video> — время рекламы.
  function adShowing() {
    return player?.classList.contains("ad-showing") ?? false;
  }

  function onTimeUpdate(e) {
    if (e.target !== mainVideo()) return;
    if (state === "ad") {
      if (!adShowing()) begin(); // реклама кончилась, время снова видео
    } else if (state === "preparing") {
      updateProgress(); // видео могли запустить, не дожидаясь перевода
    }
    showSubtitle();
    if (Math.abs(e.target.currentTime - lastPosted) >= POSITION_EVERY_S) postPosition();
  }

  function onSeeked(e) {
    if (e.target !== mainVideo()) return;
    showSubtitle();
    if (!enabled) return;
    overridden = false;
    postPosition();
    updateProgress();
  }

  // Пользователь запустил видео сам — больше его не трогаем. Не дождался догрузки — смотрит
  // дальше, недоготовленные фразы идут без голоса.
  function onPlay(e) {
    if (e.target !== mainVideo()) return;
    pausedByUs = false;
    if (state === "buffering") {
      overridden = true;
      render("on", "Озвучка ✓", onHint);
    }
  }

  // Видео на паузу ставим только при нажатии, а продолжаем, только если ставили сами.
  function holdVideo() {
    const video = mainVideo();
    if (!video || video.paused || video.ended) return;
    pausedByUs = true;
    video.pause();
  }

  function releaseVideo() {
    if (!pausedByUs) return;
    pausedByUs = false;
    mainVideo()
      ?.play()
      .catch(() => {});
  }

  // ---------- Субтитры ----------

  // Перевод фразы, которая идёт в момент t: последней из начавшихся, если не кончилась.
  function subtitleAt(t) {
    if (!phrases?.length) return "";
    let lo = 0;
    let hi = phrases.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (phrases[mid].start <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const phrase = phrases[found];
    if (!phrase || t > phrase.end + LINGER_S) return "";
    return translations.get(phrase.id) ?? "";
  }

  function showSubtitle() {
    const text = enabled && subtitles && !adShowing() ? subtitleAt(currentTime()) : "";
    if (sub.line.textContent !== text) sub.line.textContent = text;
  }

  // ---------- Включение, подготовка, выключение ----------

  // Озвучка работает: service worker'у нужна позиция, нажатие выключает.
  function running() {
    return state === "on" || awaited();
  }

  function onClick() {
    if (!videoId) return;
    if (state === "ad" || running()) turnOff();
    else turnOn();
  }

  // «Перевести», «▶ Продолжить» и повтор после ошибки. Во время рекламы ни позиции, ни видео,
  // которое ставить на паузу, нет — начинаем, когда она кончится (onTimeUpdate).
  function turnOn() {
    enabled = true;
    fastFails = 0;
    overridden = false;
    voice.unlock(); // только в обработчике нажатия: иначе браузер не даст включить звук
    if (!settingKeys.length) loadSettings(); // без них оригинал звучал бы в полную громкость
    if (adShowing()) render("ad", "Переведу после рекламы", "Нажмите, чтобы отменить");
    else begin();
  }

  function begin() {
    enabledAt = performance.now();
    render("loading", "Загружаю субтитры…");
    updateProgress(); // субтитры уже есть — сразу к подготовке
    if (state !== "on") holdVideo();
    showSubtitle();
    sendStart();
  }

  // Порт закрыт — service worker обрывает подготовку. Фразы, переводы и звук помним: повторное
  // включение на этом видео их не ждёт.
  function turnOff() {
    enabled = false;
    closePort();
    releaseVideo();
    render("idle", "Перевести");
    showSubtitle();
  }

  // Доля готовых фраз в span секунд от t. Готова — звук у плеера или произносить нечего
  // (модель не перевела, Silero нечего читать).
  function readyShare(t, span) {
    let due = 0;
    let done = 0;
    for (const p of phrases) {
      if (p.end <= t || p.start >= t + span) continue;
      due++;
      if (voice.has(p.id)) done++;
    }
    return due ? done / due : 1;
  }

  // Подготовка: процент на кнопке, готовы первые READY_S с — видео продолжается с голосом.
  // Догрузка: готовы следующие RESUME_S с — видео продолжается. Во время рекламы ждём её
  // конца: время <video> — её время.
  function updateProgress() {
    if (!phrases || adShowing()) return;
    const t = currentTime();
    if (state === "loading" || state === "preparing") {
      const share = readyShare(t, READY_S);
      if (share < 1) {
        render(
          "preparing",
          `Готовлю озвучку… ${Math.floor(share * 100)}%`,
          `Перевожу и озвучиваю первые ${READY_S} с от текущей позиции\nНажмите, чтобы отменить`,
        );
        return;
      }
      const readyIn = (performance.now() - enabledAt) / 1000;
      const count = `${phrases.length} ${plural(phrases.length, "фраза", "фразы", "фраз")}`;
      const source = kind === "asr" ? "автоматические" : "ручные";
      onHint =
        `Субтитры: ${count} (${source})\nПодготовка: ${readyIn.toFixed(1)} с\n` +
        "Нажмите, чтобы выключить";
      resume();
    } else if (state === "buffering") {
      if (readyShare(t, RESUME_S) === 1) resume();
    } else if (state === "on" && overridden && readyShare(t, RESUME_S) === 1) {
      overridden = false; // подготовка догнала видео: отстанет снова — снова подождём
    }
  }

  // Голос включён, видео продолжается, если ждало подготовку.
  function resume() {
    render("on", "Озвучка ✓", onHint);
    releaseVideo();
  }

  // Видео дошло до фразы, звука которой ещё нет: ждём его на паузе.
  function onVoiceMissing() {
    if (state !== "on" || overridden) return;
    holdVideo();
    render(
      "buffering",
      "Догружаю озвучку…",
      "Подготовка отстала от видео, оно продолжится само\nНажмите, чтобы выключить озвучку",
    );
    postPosition(); // service worker'у — готовить отсюда
  }

  function showError({ code, message, detail }) {
    releaseVideo();
    if (code === "LIVE" || code === "NO_CAPTIONS") {
      enabled = false;
      closePort();
      if (code === "LIVE") render("live", "");
      else render("none", message);
      showSubtitle();
      return;
    }
    render("error", `⚠ ${message}`, [detail, "Нажмите, чтобы повторить"].filter(Boolean).join("\n"));
  }

  // «Стоп» в popup или Alt+Shift+S: голос смолкает, видео, которое ждало подготовку,
  // продолжается.
  // → false, если озвучка и так не работала.
  function onStopped() {
    if (!enabled || state === "error") return false;
    releaseVideo();
    render("stopped", "▶ Продолжить", "Озвучка остановлена кнопкой «Стоп»\nНажмите, чтобы продолжить");
    return true;
  }

  // ---------- Меню ----------

  // Меню закрывают его значок, Esc и нажатие мимо панели. Esc ловим во всём документе: в
  // открытом мышью меню фокуса нет.
  const MENU_EVENTS = { pointerdown: onPointerOutside, keydown: onMenuKey };

  function setMenu(open) {
    ui.menu.hidden = !open;
    ui.panel.classList.toggle("open", open);
    ui.settings.setAttribute("aria-expanded", String(open));
    for (const [type, fn] of Object.entries(MENU_EVENTS)) {
      if (open) document.addEventListener(type, fn, true);
      else document.removeEventListener(type, fn, true);
    }
  }

  function onPointerOutside(e) {
    if (!e.composedPath().includes(ui.host)) setMenu(false);
  }

  // Esc закрывает только меню, YouTube его не получает. Фокус был в панели — возвращаем его
  // значку меню.
  function onMenuKey(e) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    setMenu(false);
    if (e.composedPath().includes(ui.host)) ui.settings.focus();
  }

  // Ключи, умолчания и диапазоны знает service worker (dub/lib/settings.js): он присылает
  // настройки меню и сохраняет их. → { values, limits }.
  async function requestSettings(patch) {
    const r = await chrome.runtime.sendMessage({ type: "dubSettings", patch });
    if (!r?.values) throw new Error(r?.error ?? "service worker не ответил");
    return r;
  }

  // Не прочитались — пробуем ещё SETTINGS_RETRIES раз, а потом при включении озвучки.
  function loadSettings(attempt = 0) {
    clearTimeout(settingsTimer);
    requestSettings().then(
      (r) => {
        // ответ мог устареть: пока он шёл, меню сохранило новое
        if (saving) staleSettings = true;
        else applySettings(r);
      },
      (err) => {
        console.warn("[ot] озвучка: настройки не прочитались:", err.message);
        if (!settingKeys.length && attempt < SETTINGS_RETRIES) {
          settingsTimer = setTimeout(() => loadSettings(attempt + 1), SETTINGS_RETRY_MS);
        }
      },
    );
  }

  function applySettings({ values, limits }) {
    settingKeys = Object.keys(values);
    for (const [key, { input }] of Object.entries(ui.ranges)) {
      Object.assign(input, limits[key]); // до value: иначе его обрежет прежний диапазон
      input.value = values[key];
      showRange(key);
    }
    subtitles = values.dubSubtitles;
    ui.subtitles.checked = subtitles;
    voice.setLevel(values.dubOriginalVolume);
    ui.settings.hidden = false;
    showSubtitle();
  }

  function showRange(key) {
    const { input, value } = ui.ranges[key];
    value.textContent = RANGES[key].format(Number(input.value));
  }

  // Громкость оригинала меняется сразу, пока ползунок тянут, а сохраняется, когда отпустят.
  function onRangeInput(key) {
    showRange(key);
    if (key === "dubOriginalVolume") voice.setLevel(Number(ui.ranges[key].input.value));
  }

  function onSubtitlesToggle() {
    subtitles = ui.subtitles.checked;
    showSubtitle();
    saveSetting("dubSubtitles", subtitles);
  }

  // Сохранённое разойдётся по вкладкам YouTube через storage.onChanged, и в эту тоже. Здесь меню
  // уже показывает новое: пока сохранения идут, значения из storage его не трогают (иначе
  // ползунок отскакивал бы к прежнему), а после них меню сверяется со storage. Не сохранилось —
  // тоже сверяется: вернётся к сохранённому.
  function saveSetting(key, value) {
    saving++;
    requestSettings({ [key]: value })
      .catch((err) => {
        console.warn("[ot] озвучка: настройка не сохранилась:", err.message);
        staleSettings = true;
      })
      .finally(() => {
        if (--saving || !staleSettings) return;
        staleSettings = false;
        loadSettings();
      });
  }

  // Настройки меню сменили в другой вкладке, сбросили на странице настроек или сохранили здесь.
  function onStorageChanged(changes, area) {
    if (area !== "local" || !settingKeys.some((key) => key in changes)) return;
    if (saving) staleSettings = true;
    else loadSettings();
  }

  // Голос и адрес Silero — на странице настроек. Content script её не откроет, просим service
  // worker.
  function openOptions() {
    setMenu(false);
    try {
      chrome.runtime.sendMessage({ type: "dubOptions" }).catch(() => {});
    } catch {
      // расширение перезагружено
    }
  }

  // ---------- Порт ----------

  function onPortMessage(msg) {
    fastFails = 0;
    switch (msg?.type) {
      case "phrases":
        if (!msg.list.length) {
          showError({ code: "NO_CAPTIONS", message: "В субтитрах нет речи" });
          break;
        }
        phrases = msg.list;
        kind = msg.kind;
        voice.setPhrases(phrases);
        updateProgress();
        showSubtitle();
        break;
      case "translated":
        msg.ids.forEach((id, i) => {
          translations.set(id, msg.texts[i]);
          if (!msg.texts[i]) voice.add(id, null); // произносить нечего
        });
        updateProgress();
        showSubtitle();
        break;
      case "audio":
        voice.add(msg.id, msg.data, msg.duration, msg.rate);
        updateProgress();
        break;
      case "error":
        showError(msg);
        break;
      case "stopped":
        onStopped();
        break;
    }
  }

  // Service worker уснул (готовить было нечего) или перезапустился: при подготовке и догрузке
  // подключаемся сразу, при просмотре — со следующей позицией (postPosition), после «Стоп» и
  // ошибки — по нажатию.
  function onPortLost() {
    conn = null;
    if (!enabled) return;
    fastFails = Date.now() - connectedAt < FAST_FAIL_MS ? fastFails + 1 : 0;
    if (fastFails > MAX_FAST_FAILS) {
      showError({ code: "PORT", message: "Связь с расширением потеряна" });
      return;
    }
    if (awaited()) sendStart();
  }

  function closePort() {
    conn?.close();
    conn = null;
  }

  // Service worker получает всё, что вкладка уже знает, и продолжает с текущей позиции.
  function sendStart() {
    if (!conn) {
      try {
        conn = ns.connectPort("dub", {
          onMessage: onPortMessage,
          onDisconnect: onPortLost,
          needsPing: awaited,
        });
      } catch {
        showError({ code: "EXTENSION", message: "Расширение перезагружено, обновите страницу" });
        return;
      }
      connectedAt = Date.now();
    }
    // во время рекламы время <video> — её время: шлём последнюю позицию видео
    if (!adShowing()) lastPosted = currentTime();
    // порт мёртв — onDisconnect подключится заново
    conn.post({
      type: "start",
      videoId,
      time: lastPosted,
      phrases,
      translations: [...translations],
      voiced: voice.ids(),
    });
  }

  // После «Стоп» и ошибки позиция service worker'у не нужна: его не будим.
  function postPosition() {
    if (adShowing() || !running()) return;
    lastPosted = currentTime();
    if (conn) conn.post({ type: "position", time: lastPosted });
    else if (state !== "loading") sendStart();
  }

  // Вкладка без порта узнаёт о «Стоп» так. Порт мог подключиться, пока шло сообщение: его сессию
  // «Стоп» не застал — закрываем, иначе перевод пошёл бы дальше.
  function onRuntimeMessage(msg) {
    if (msg?.type === "dubStopped" && onStopped()) closePort();
  }

  function plural(n, one, few, many) {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return one;
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
    return many;
  }

  function dispose() {
    closePort();
    setMenu(false);
    clearTimeout(pollTimer);
    clearTimeout(settingsTimer);
    classObserver?.disconnect();
    listenMedia(player, false);
    voice.dispose();
    ui.host.remove();
    sub.host.remove();
    document.removeEventListener("yt-navigate-finish", sync);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      // контекст расширения уже недействителен
    }
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  document.addEventListener("yt-navigate-finish", sync);
  sync();
  loadSettings();

  dub.dispose = dispose;
})();

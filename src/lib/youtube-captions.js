// Субтитры YouTube-видео — для озвучки (dub/) и краткого содержания (summary/): загрузка на
// вкладке и json3 → слова со временем. Время в секундах.

// Субтитры видео на вкладке. Функцию выполняют через
// chrome.scripting.executeScript({ world: "MAIN", func }): API плеера
// (#movie_player.getPlayerResponse и другие) виден только из мира страницы. На страницу браузер
// передаёт лишь текст функции, поэтому она самодостаточна: без импортов и внешних переменных.
//
// С 2025 года /api/timedtext без токена PO (proof of origin) отвечает 200 с пустым телом.
// Токен берём из запроса субтитров, который делает сам плеер.
//
// lang — язык субтитров ("en"): ручные на нём, иначе автоматические. null — ручные на языке
// речи (язык автоматических), иначе автоматические, иначе дорожка плеера по умолчанию, иначе
// первая. Машинный перевод субтитров YouTube не берём.
// → { json: { events }, kind: "asr" | "manual", lang, title } — сырые события json3 (их разбирает
//   parseJson3) и название видео. Или { error, detail? }, error: NO_PLAYER, NOT_READY, LIVE,
//   NO_CAPTIONS, NO_TOKEN, EMPTY, FAILED.
export async function pageCaptions(videoId, lang) {
  const PLAYER_WAIT_MS = 3000;
  const TOKEN_WAIT_MS = 8000;
  const FETCH_TIMEOUT_MS = 15_000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // После перехода на другое видео без перезагрузки страницы плеер обновляет ответ не сразу.
  async function waitPlayer() {
    const deadline = Date.now() + PLAYER_WAIT_MS;
    for (;;) {
      const player = document.getElementById("movie_player");
      const response = player?.getPlayerResponse?.();
      if (response?.videoDetails?.videoId === videoId) return { player, response };
      if (Date.now() > deadline) return { error: player?.getPlayerResponse ? "NOT_READY" : "NO_PLAYER" };
      await sleep(250);
    }
  }

  // Токен плеер получает сам, когда показывает субтитры, и передаёт в запросе /api/timedtext.
  // → { pot, potc?, c?, cver? } из самого свежего такого запроса для этого видео, или null.
  function findToken(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      let url;
      try {
        url = new URL(entries[i].name);
      } catch {
        continue;
      }
      if (!url.pathname.endsWith("/api/timedtext") || url.searchParams.get("v") !== videoId) continue;
      if (!url.searchParams.get("pot")) continue;
      const token = {};
      for (const key of ["pot", "potc", "c", "cver"]) {
        const value = url.searchParams.get(key);
        if (value) token[key] = value;
      }
      return token;
    }
    return null;
  }

  // Ждёт запрос плеера с токеном. PerformanceObserver видит и запросы, которые в журнал
  // performance уже не попадают: его размер ограничен.
  function waitToken() {
    return new Promise((resolve) => {
      const observer = new PerformanceObserver((list) => {
        const token = findToken(list.getEntries());
        if (token) finish(token);
      });
      const timer = setTimeout(() => finish(null), TOKEN_WAIT_MS);
      function finish(token) {
        clearTimeout(timer);
        observer.disconnect();
        resolve(token);
      }
      observer.observe({ type: "resource" });
    });
  }

  // Включает субтитры плеера на время, чтобы он запросил их с токеном. Уже включённую дорожку
  // плеер заново не запрашивает, а его прежний запрос YouTube из журнала performance
  // вычищает, поэтому сначала выключаем.
  // → restore(): вернуть субтитрам прежнее состояние.
  function showCaptions(player, track) {
    const before = player.getOption("captions", "track"); // {} или undefined — выключены
    player.loadModule("captions");
    const list = player.getOption("captions", "tracklist") ?? [];
    const target = list.find((t) => t.vss_id === track.vssId) ?? { languageCode: track.languageCode };
    player.setOption("captions", "track", {});
    player.setOption("captions", "track", target);
    return () => {
      try {
        if (before?.languageCode) {
          player.setOption("captions", "track", before);
        } else {
          player.setOption("captions", "track", {});
          player.unloadModule("captions");
        }
      } catch (err) {
        console.warn("[ot] не удалось вернуть субтитры плеера:", err);
      }
    };
  }

  try {
    const ready = await waitPlayer();
    if (ready.error) return ready;
    const { player, response } = ready;
    if (response.videoDetails.isLive) return { error: "LIVE" };

    // дорожки на нужном языке: ручные важнее автоматических
    const tracklist = response.captions?.playerCaptionsTracklistRenderer;
    const tracks = tracklist?.captionTracks ?? [];
    const base = (code) => String(code ?? "").split("-")[0].toLowerCase();
    const speech = lang ?? tracks.find((t) => t.kind === "asr")?.languageCode;
    const spoken = speech ? tracks.filter((t) => base(t.languageCode) === base(speech)) : [];
    const audio = tracklist?.audioTracks?.[tracklist.defaultAudioTrackIndex ?? 0];
    const track =
      spoken.find((t) => t.kind !== "asr") ??
      spoken[0] ??
      (lang ? null : (tracks[audio?.defaultCaptionTrackIndex] ?? tracks[0]));
    if (!track?.baseUrl) return { error: "NO_CAPTIONS" };

    // запрос с токеном мог быть недавно, если субтитры включены
    let token = findToken(performance.getEntriesByType("resource"));
    if (!token) {
      const waiting = waitToken(); // до включения субтитров: иначе запрос можно пропустить
      const restore = showCaptions(player, track);
      try {
        token = await waiting;
      } finally {
        restore();
      }
    }
    if (!token) return { error: "NO_TOKEN" };
    const url = new URL(track.baseUrl, location.href);
    for (const [key, value] of Object.entries(token)) url.searchParams.set(key, value);
    url.searchParams.set("fmt", "json3");
    const reply = await fetch(url.href, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
    const text = await reply.text();
    if (!text.trim()) return { error: "EMPTY" };
    return {
      json: { events: JSON.parse(text).events ?? [] },
      kind: track.kind === "asr" ? "asr" : "manual",
      lang: track.languageCode,
      title: response.videoDetails.title ?? "",
    };
  } catch (err) {
    return { error: "FAILED", detail: String(err?.message ?? err) };
  }
}

// У автосубтитров известно только начало слова, длительность прикидываем по его длине.
const WORD_S_PER_CHAR = 0.07;
const WORD_MIN_S = 0.2;
const WORD_MAX_S = 1;

// Неречевое: [Music], [APPLAUSE], (laughs), ♪.
const NOISE = /\[[^\]]*\]|\([^)]*\)|[♪♫]/g;
// Говорит другой человек: >> у автосубтитров, тире в начале строки у ручных.
const SPEAKER_ARROWS = /^>>+/;
const SPEAKER_DASH = /^\s*[-–—]\s+/;
const HAS_WORD = /[\p{L}\p{N}]/u;
const SENTENCE_END = /[.?!…]["'”’»)\]]*$/;
// Точка после сокращения или инициала — не конец предложения. «I.» — местоимение в конце
// предложения («So do I.»), а не инициал.
const ABBREVIATION = /^(mr|mrs|ms|dr|prof|st|jr|sr|vs|e\.g|i\.e|a\.m|p\.m|u\.s|u\.k|[a-hj-z])\.$/i;

// json3 → слова [{ start, end, text, speaker }] по порядку времени. speaker — с этого слова
// говорит другой человек. Время слова: у автосубтитров — из segs[].tOffsetMs, у ручных есть
// только начало и длительность реплики — делим её между словами по числу букв.
export function parseJson3(json) {
  const words = [];
  let speaker = false;
  for (const event of json?.events ?? []) {
    if (!Array.isArray(event.segs)) continue; // описание окна субтитров, не текст
    const start = (event.tStartMs ?? 0) / 1000;
    const end = start + (event.dDurationMs ?? 0) / 1000;
    for (const piece of pieces(event.segs, start, end)) {
      const tokens = [];
      // неречевое убираем до деления на строки: у ручных ремарка бывает в две строки
      for (const line of piece.text.replace(NOISE, " ").split("\n")) {
        if (SPEAKER_DASH.test(line)) speaker = true;
        for (let text of line.replace(SPEAKER_DASH, " ").split(/\s+/)) {
          if (SPEAKER_ARROWS.test(text)) {
            speaker = true;
            text = text.replace(SPEAKER_ARROWS, "");
          }
          if (!text) continue;
          if (!HAS_WORD.test(text)) {
            // отдельно стоящий знак: конец предложения — к предыдущему слову, прочее не нужно
            const prev = tokens.at(-1) ?? words.at(-1);
            if (prev && /[.?!…]/.test(text)) prev.text += text;
            continue;
          }
          tokens.push({ text, speaker });
          speaker = false;
        }
      }
      const letters = tokens.reduce((sum, t) => sum + t.text.length, 0);
      const span = Math.max(0, piece.end - piece.start);
      let before = 0;
      for (const { text, speaker: newSpeaker } of tokens) {
        const wordStart = piece.start + (span * before) / letters;
        before += text.length;
        let wordEnd = piece.start + (span * before) / letters;
        // слово автосубтитров: его кусок тянется до следующего слова или до конца показа строки
        if (tokens.length === 1) wordEnd = Math.min(wordEnd, wordStart + guessDuration(text));
        words.push({ start: wordStart, end: wordEnd, text, speaker: newSpeaker });
      }
    }
  }
  words.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < words.length; i++) {
    words[i].end = Math.max(words[i].start, Math.min(words[i].end, words[i + 1].start));
  }
  return words;
}

// Куски события с известным временем: у автосубтитров каждый seg (обычно одно слово) со своим
// tOffsetMs, у ручных — вся реплика.
function pieces(segs, start, end) {
  if (!segs.some((seg) => seg.tOffsetMs != null)) {
    return [{ text: segs.map((seg) => seg.utf8 ?? "").join(""), start, end }];
  }
  const at = (seg) => start + (seg.tOffsetMs ?? 0) / 1000;
  return segs.map((seg, i) => ({
    text: seg.utf8 ?? "",
    start: at(seg),
    end: i + 1 < segs.length ? at(segs[i + 1]) : end,
  }));
}

function guessDuration(text) {
  return Math.min(WORD_MAX_S, Math.max(WORD_MIN_S, text.length * WORD_S_PER_CHAR));
}

// Слово parseJson3 заканчивает предложение.
export function endsSentence(text) {
  return SENTENCE_END.test(text) && !ABBREVIATION.test(text);
}

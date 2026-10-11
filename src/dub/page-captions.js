// Озвучка YouTube-видео: английские субтитры видео на вкладке. Функцию выполняет
// dub/background.js через chrome.scripting.executeScript({ world: "MAIN", func }): API плеера
// (#movie_player.getPlayerResponse и другие) виден только из мира страницы. На страницу браузер
// передаёт лишь текст функции, поэтому она самодостаточна: без импортов и внешних переменных.
//
// С 2025 года /api/timedtext без токена PO (proof of origin) отвечает 200 с пустым телом.
// Токен берём из запроса субтитров, который делает сам плеер.
//
// → { json: { events }, kind: "asr" | "manual", lang } — сырые события json3, на фразы их режет
//   service worker. Или { error, detail? }, error: NO_PLAYER, NOT_READY, LIVE, NO_CAPTIONS,
//   NO_TOKEN, EMPTY, FAILED.
export async function pageCaptions(videoId) {
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

    // ручные английские важнее автоматических
    const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const english = tracks.filter((t) => /^en\b/i.test(t.languageCode ?? ""));
    const track = english.find((t) => t.kind !== "asr") ?? english[0];
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
    };
  } catch (err) {
    return { error: "FAILED", detail: String(err?.message ?? err) };
  }
}

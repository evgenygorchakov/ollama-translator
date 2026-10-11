// Озвучка YouTube-видео, content script: звук фраз и синхронизация с <video>. Фраза звучит,
// когда видео доходит до её начала; следующая ждёт, пока смолкнет предыдущая. Пауза, перемотка,
// скорость и громкость YouTube действуют и на голос. Оригинал, пока голос включён, приглушён
// через Web Audio. Плеер создаёт dub/content.js: он решает, когда голос включён и что делать,
// если звука фразы ещё нет.
// Внедряется перед content.js и кладёт фабрику в ns.dub.createPlayer.
(() => {
  const ns = (window.__ollamaTranslator ??= {});

  const TICK_MS = 100;
  const MAX_LAG_S = 3; // ждущая фраза опоздала больше — пропускаем
  const KEEP_BEHIND_S = 60; // звук фраз дальше позади позиции выбрасываем…
  const KEEP_AHEAD_S = 150; // …и дальше впереди: он остаётся после перемотки назад
  const EVICT_EVERY_S = 5;
  const FADE_S = 0.05; // плавность смены громкости оригинала
  const HAVE_FUTURE_DATA = 3; // readyState: видео не ждёт данных

  // getVideo() — <video> плеера, adShowing() — идёт реклама. onMissing(phrase) — видео дошло до
  // фразы, звука которой ещё нет; onEvict(ids) — звук этих фраз выброшен.
  function createPlayer({ getVideo, adShowing, onMissing, onEvict }) {
    let phrases = []; // [{ id, start, end, text }] по порядку времени
    let byId = new Map();
    // id → { data, duration, rate }: wav в base64, длительность записи, ускорение
    // воспроизведения. data null — произносить нечего.
    const clips = new Map();
    let active = false; // голос включён
    let level = 1; // громкость оригинала, пока голос включён
    let cursor = 0; // первая фраза, начало которой видео ещё не прошло
    let waiting = []; // [{ phrase, offset, at, reported }] — фразы в очереди на звук
    let current = null; // { item, clip, audio, url } — фраза, которая звучит
    let useDataUrl = false; // blob: не загрузился (CSP, Firefox) — звук через data:
    let inAd = false;
    let evictedAt = -Infinity;
    let timer = null;
    let host = null; // #movie_player: события его <video> ловим на фазе захвата
    let warnedAutoplay = false;

    // <video> подключается к AudioContext один раз и навсегда: контекст один, узлы — по
    // элементу (YouTube переиспользует его между видео).
    let audioContext = null;
    const gains = new WeakMap(); // <video> → GainNode; null — не вышло, приглушаем через volume
    let ducked = null; // приглушено через video.volume: { video, volume — прежняя, set — наша }

    // ---------- Громкость оригинала ----------

    // Вызывать из обработчика нажатия: без жеста пользователя AudioContext стартует
    // остановленным, а видео, подключённое к остановленному контексту, немое.
    function unlock() {
      try {
        if (!audioContext) {
          audioContext = new AudioContext();
          audioContext.addEventListener("statechange", () => {
            if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
            applyLevel();
          });
        }
        audioContext.resume().catch(() => {});
      } catch (err) {
        console.warn("[ot] озвучка: Web Audio недоступен:", err);
      }
    }

    // → false, если подключать рано: AudioContext ещё не запущен (applyLevel повторит по
    // statechange).
    function connect(video) {
      if (audioContext && audioContext.state !== "running") return false;
      let gain = null;
      try {
        if (!audioContext) throw new Error("нет AudioContext");
        const source = audioContext.createMediaElementSource(video);
        gain = audioContext.createGain();
        source.connect(gain).connect(audioContext.destination);
      } catch (err) {
        console.warn("[ot] озвучка: оригинал приглушаю через video.volume:", err.message);
      }
      gains.set(video, gain);
      return true;
    }

    // Оригинал звучит на level, пока голос включён и нет рекламы, иначе — как обычно.
    function applyLevel() {
      const video = getVideo();
      const target = active && !inAd ? level : 1;
      if (ducked && (ducked.video !== video || target === 1)) restoreVolume();
      if (!video || (target === 1 && !gains.get(video))) return;
      if (!gains.has(video) && !connect(video)) return;
      const gain = gains.get(video);
      if (gain) gain.gain.setTargetAtTime(target, audioContext.currentTime, FADE_S);
      else duckVolume(video, target);
    }

    // Запасной путь, если Web Audio не вышел: YouTube может запомнить такую громкость как
    // пользовательскую, поэтому прежнюю возвращаем сразу, как голос выключат.
    function duckVolume(video, target) {
      ducked ??= { video, volume: video.volume, set: video.volume };
      ducked.set = ducked.volume * target;
      video.volume = ducked.set;
    }

    function restoreVolume() {
      const { video, volume, set } = ducked;
      ducked = null;
      if (Math.abs(video.volume - set) < 1e-3) video.volume = volume;
    }

    function onVolumeChange() {
      const video = getVideo();
      // громкость сменили в YouTube — это новая обычная громкость, приглушаем уже её
      if (ducked?.video === video && Math.abs(video.volume - ducked.set) >= 1e-3) {
        ducked.volume = video.volume;
        duckVolume(video, level);
      }
      applyVoiceVolume();
    }

    // ---------- Голос ----------

    function applyRate() {
      const video = getVideo();
      if (!current || !video) return;
      const rate = video.playbackRate * current.clip.rate;
      current.audio.defaultPlaybackRate = rate;
      current.audio.playbackRate = rate;
    }

    // Голос громкий, как оригинал до приглушения; mute YouTube глушит и его.
    function applyVoiceVolume() {
      const video = getVideo();
      if (!current || !video) return;
      const volume = ducked?.video === video ? ducked.volume : video.volume;
      current.audio.volume = video.muted ? 0 : Math.min(1, Math.max(0, volume));
    }

    function toBlobUrl(data) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    }

    // item.offset — с какого места фразы начинать, в секундах видео.
    function play(item, clip) {
      const audio = new Audio();
      const url = useDataUrl ? `data:audio/wav;base64,${clip.data}` : toBlobUrl(clip.data);
      current = { item, clip, audio, url };
      audio.addEventListener("ended", () => current?.audio === audio && next());
      audio.addEventListener("error", () => current?.audio === audio && onAudioError());
      audio.src = url; // до темпа и позиции: загрузка сбрасывает их
      audio.preservesPitch = true;
      audio.currentTime = item.offset * clip.rate;
      applyRate();
      applyVoiceVolume();
      audio.play().catch((err) => {
        if (err.name !== "NotAllowedError" || current?.audio !== audio) return;
        if (!warnedAutoplay) console.warn("[ot] озвучка: браузер не дал включить звук:", err.message);
        warnedAutoplay = true;
        next();
      });
    }

    // blob: скорее всего не пустил CSP сайта или Firefox: дальше звук идёт через data:.
    function onAudioError() {
      const { item, clip, audio } = current;
      const via = useDataUrl ? "data:" : "blob:";
      console.warn(`[ot] озвучка: звук фразы ${item.phrase.id} не загрузился (${via}):`, audio.error?.message);
      if (useDataUrl) {
        next();
        return;
      }
      useDataUrl = true;
      stopCurrent();
      play(item, clip);
    }

    function stopCurrent() {
      if (!current) return;
      const { audio, url } = current;
      current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load(); // отпускает декодер
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }

    // Тишина: фраза обрывается, очередь пуста.
    function silence() {
      stopCurrent();
      waiting = [];
    }

    function playing(video) {
      return !video.paused && !video.seeking && video.readyState >= HAVE_FUTURE_DATA;
    }

    // Фраза отзвучала — следующая, если видео идёт.
    function next() {
      stopCurrent();
      const video = getVideo();
      if (video && playing(video)) startNext(video.currentTime);
    }

    // Первая из очереди, которая не опоздала больше MAX_LAG_S и у которой есть звук. Звука ещё
    // нет — фраза ждёт его, пока не опоздает (onMissing — один раз).
    function startNext(t) {
      while (waiting.length) {
        const item = waiting[0];
        if (t - item.at > MAX_LAG_S) {
          waiting.shift();
          continue;
        }
        const clip = clips.get(item.phrase.id);
        if (!clip) {
          if (!item.reported) {
            item.reported = true;
            onMissing(item.phrase);
          }
          return;
        }
        waiting.shift();
        if (clip.data && item.offset * clip.rate < clip.duration) {
          play(item, clip);
          return;
        }
      }
    }

    // Индекс первой фразы, которая начинается после t.
    function firstAfter(t) {
      let lo = 0;
      let hi = phrases.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (phrases[mid].start <= t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // Видео оказалось в t: перемотка, конец рекламы, включение голоса. Фраза, внутри которой
    // оно оказалось, звучит с этого места, если от неё осталось больше половины, иначе ждём
    // следующую.
    function seekTo(t) {
      silence();
      cursor = firstAfter(t);
      const phrase = phrases[cursor - 1];
      if (!phrase) return;
      const clip = clips.get(phrase.id);
      const length = clip?.data ? clip.duration / clip.rate : phrase.end - phrase.start;
      const offset = t - phrase.start;
      if (offset < length / 2) waiting.push({ phrase, offset, at: t, reported: false });
    }

    // Звук фраз далеко от позиции не нужен: service worker синтезирует снова, если вернёмся.
    function evict(t) {
      evictedAt = t;
      const ids = [];
      for (const [id, clip] of clips) {
        const phrase = byId.get(id);
        if (!clip.data || !phrase || clip === current?.clip) continue;
        if (phrase.end < t - KEEP_BEHIND_S || phrase.start > t + KEEP_AHEAD_S) {
          clips.delete(id);
          ids.push(id);
        }
      }
      if (ids.length) onEvict(ids);
    }

    function tick() {
      const video = getVideo();
      if (!video) return;
      // во время рекламы время <video> — её время: голоса нет, оригинал как обычно
      if (adShowing() !== inAd) {
        inAd = !inAd;
        if (inAd) silence();
        else seekTo(video.currentTime);
        applyLevel();
      }
      if (inAd || !playing(video)) return;
      const t = video.currentTime;
      // время ушло назад без перемотки (YouTube сменил источник) — с нового места
      if (cursor > 0 && t < phrases[cursor - 1].start - 1) seekTo(t);
      while (cursor < phrases.length && phrases[cursor].start <= t) {
        const phrase = phrases[cursor++];
        waiting.push({ phrase, offset: 0, at: phrase.start, reported: false });
      }
      if (!current) startNext(t);
      if (Math.abs(t - evictedAt) >= EVICT_EVERY_S) evict(t);
    }

    // ---------- События <video> ----------

    const MEDIA_EVENTS = {
      timeupdate: tick, // в фоновой вкладке таймер могут замедлить, а это событие идёт всегда
      pause: () => current?.audio.pause(),
      waiting: () => current?.audio.pause(), // YouTube догружает видео
      playing: () => current?.audio.paused && current.audio.play().catch(() => {}),
      seeking: silence,
      seeked: () => seekTo(getVideo().currentTime),
      ratechange: applyRate,
      volumechange: onVolumeChange,
      ended: silence,
    };

    function onMediaEvent(e) {
      if (active && !inAd && e.target === getVideo()) MEDIA_EVENTS[e.type]();
    }

    // События <video> не всплывают, но проходят фазу захвата через плеер.
    function attach(element) {
      if (element === host) return;
      for (const type of Object.keys(MEDIA_EVENTS)) {
        host?.removeEventListener(type, onMediaEvent, true);
        element?.addEventListener(type, onMediaEvent, true);
      }
      host = element;
    }

    // ---------- Снаружи ----------

    function setPhrases(list) {
      phrases = list;
      byId = new Map(list.map((p) => [p.id, p]));
      if (active && !inAd) seekTo(getVideo()?.currentTime ?? 0);
    }

    // Звук фразы от service worker'а; data null — произносить нечего.
    function add(id, data, duration, rate) {
      clips.set(id, {
        data: typeof data === "string" ? data : null,
        duration: Number.isFinite(duration) ? duration : 0,
        rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
      });
    }

    function setLevel(value) {
      level = Math.min(1, Math.max(0, value));
      applyLevel();
    }

    function activate() {
      if (active) return;
      active = true;
      timer = setInterval(tick, TICK_MS);
      inAd = adShowing();
      applyLevel();
      if (!inAd) seekTo(getVideo()?.currentTime ?? 0);
    }

    // Голос смолкает, оригинал — как обычно. Звук фраз остаётся: повторное включение на том
    // же видео его не ждёт.
    function deactivate() {
      if (!active) return;
      active = false;
      clearInterval(timer);
      silence();
      applyLevel();
    }

    // Другое видео: звук прежнего не нужен.
    function clear() {
      deactivate();
      clips.clear();
      setPhrases([]);
      cursor = 0;
    }

    return {
      attach,
      unlock,
      setPhrases,
      add,
      has: (id) => clips.has(id),
      ids: () => [...clips.keys()],
      setLevel,
      activate,
      deactivate,
      // класс плеера сменился: могла начаться или кончиться реклама
      refresh: () => active && tick(),
      clear,
      dispose() {
        clear();
        attach(null);
      },
    };
  }

  (ns.dub ??= {}).createPlayer = createPlayer;
})();

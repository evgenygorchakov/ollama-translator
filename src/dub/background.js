// Озвучка YouTube-видео, часть service worker: порт "dub" от кнопки «Перевести» в плеере,
// сессия на порт.
// Субтитры видео (page-captions.js в мире страницы) → фразы → перевод с опережением от позиции
// воспроизведения → синтез Silero с подгонкой длины → звук фраз вкладке, проигрывает она.
// От перевода страницы и выделенного не зависит.
//
// Вкладка → сюда: start { videoId, time, phrases?, translations?, voiced? } — включение,
// «Продолжить» и повтор после ошибки; position { time } — после перемотки и раз в 5 с при
// просмотре; evicted { ids } — вкладка выбросила звук этих фраз; ping.
// Вкладка закрыла порт — озвучку выключили или сменили видео.
// Отсюда → вкладке: phrases { list, kind }, translated { ids, texts }, audio { id, data,
// duration, rate } — звук фразы (wav в base64, его длительность и ускорение воспроизведения;
// data null — произносить нечего), error { code, message, detail }, stopped.
// Фразы, переводы и список фраз со звуком хранит вкладка и присылает их в start: после
// перезапуска service worker'а субтитры не загружаются, а готовое не переводится и не
// синтезируется заново.
// Меню в плеере — сообщениями, без порта: dubSettings { patch? } → { values, limits } — его
// настройки (DUB_PLAYER_KEYS), patch сначала сохраняется; dubOptions — открыть страницу
// настроек.

import { ErrorCode } from "../lib/ollama.js";
import { toOllamaError, translateTexts } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { getSettings } from "../lib/settings.js";
import { keepAwake } from "../lib/keepalive.js";
import { onStop, registerQueue } from "../lib/stop.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { pageCaptions } from "./page-captions.js";
import { parseJson3, toPhrases } from "./lib/captions.js";
import { isStale, nextBatch, nextVoice, pendingCount } from "./lib/queue.js";
import { DUB_PROMPTS } from "./lib/prompt.js";
import { DUB_LIMITS, DUB_PLAYER_KEYS, getDubSettings, setDubSettings } from "./lib/settings.js";
import { TtsError, TtsErrorCode, getVoices, startHint, synthesize } from "./lib/tts.js";
import { wavDuration } from "./lib/wav.js";
import { pickTempo, playbackRate, slotOf } from "./lib/fit.js";

const PORT_NAME = "dub";
const YOUTUBE_TABS = "https://www.youtube.com/*";
// Столько фраз подряд Silero не озвучил — дело не во фразах, а в сервере.
const MAX_VOICE_FAILURES = 3;
const BASE64_CHUNK = 0x8000; // String.fromCharCode по 32 КБ: предел числа аргументов

let os = ""; // для подсказки, как запустить Silero
chrome.runtime.getPlatformInfo().then(
  (info) => (os = info.os),
  () => {},
);

// Ошибки pageCaptions: message — на кнопке, detail — подсказка при наведении.
const CAPTION_ERRORS = {
  NO_PLAYER: { message: "Плеер YouTube не найден" },
  NOT_READY: { message: "Плеер ещё не загрузил видео", detail: "Подождите пару секунд" },
  LIVE: { message: "Трансляции не поддерживаются" },
  NO_CAPTIONS: { message: "Нет английских субтитров" },
  NO_TOKEN: { message: "YouTube не отдал субтитры", detail: "Плеер не запросил субтитры с токеном" },
  EMPTY: { message: "YouTube не отдал субтитры", detail: "Пустой ответ и с токеном" },
  FAILED: { message: "Субтитры не загрузились" },
};

// Ошибки Ollama на кнопке; подробности — в подсказке.
const OLLAMA_ERRORS = {
  [ErrorCode.OLLAMA_DOWN]: "Ollama не отвечает",
  [ErrorCode.MODEL_NOT_FOUND]: "Выберите модель в popup",
  [ErrorCode.FORBIDDEN_ORIGIN]: "Ollama не пускает расширение",
};

// Ошибки Silero на кнопке; подробности — в подсказке.
const TTS_ERRORS = {
  [TtsErrorCode.TTS_DOWN]: "Silero не отвечает",
  [TtsErrorCode.VOICE_NOT_FOUND]: "Голос не найден в Silero",
  [TtsErrorCode.BAD_RESPONSE]: "Silero не озвучивает",
};

class DubError extends Error {
  constructor({ code, message, detail = "" }) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// → { phrases, kind }; бросает DubError.
async function loadPhrases(tabId, frameId, videoId) {
  let r;
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: pageCaptions,
      args: [videoId],
    });
    r = injection?.result ?? { error: "FAILED", detail: "скрипт на странице не ответил" };
  } catch (err) {
    r = { error: "FAILED", detail: err.message };
  }
  if (r.error) {
    const known = CAPTION_ERRORS[r.error] ?? CAPTION_ERRORS.FAILED;
    throw new DubError({ code: r.error, message: known.message, detail: r.detail ?? known.detail });
  }
  const phrases = toPhrases(parseJson3(r.json));
  console.debug(`[ot] озвучка ${videoId}: ${phrases.length} фраз (${r.kind})`);
  return { phrases, kind: r.kind };
}

// Фразы, присланные вкладкой в start.
function validPhrases(list) {
  return (
    Array.isArray(list) &&
    list.every(
      (p) =>
        Number.isInteger(p?.id) &&
        Number.isFinite(p.start) &&
        Number.isFinite(p.end) &&
        typeof p.text === "string",
    )
  );
}

// 83.2 → «1:23»
function clock(s) {
  const sec = Math.floor(s);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// Сообщения порта Chrome передаёт как JSON, поэтому звук — строкой base64.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const parts = [];
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK)));
  }
  return btoa(parts.join(""));
}

// ---------- Сессии ----------

// Сессия — порт одной вкладки. run — работа озвучки, пока её не остановили «Стоп» или ошибка:
// { controller, videoId, looping, batch, voicing, server, failures }. batch — идущий перевод:
// { phrases, ids, controller }. voicing — идёт цикл синтеза, server — промис serverInfo,
// failures — сколько фраз подряд Silero не озвучил.
const sessions = new Set();

// Фразу ещё надо перевести: не переведена и сейчас не переводится.
function pending(session) {
  const inFlight = session.run?.batch?.ids;
  return (id) => !session.translations.has(id) && !inFlight?.has(id);
}

// Фразу надо озвучить: перевод есть и не пустой, а звука у вкладки нет.
function needsVoice(session) {
  return (id) => Boolean(session.translations.get(id)) && !session.voiced.has(id);
}

// Субтитры видео: свои или присланные вкладкой. Загрузку не обрываем: если озвучку остановят и
// снова включат, она пригодится.
async function ensurePhrases(session, run) {
  if (session.phrases) return;
  const loading = (session.loading ??= loadPhrases(session.tabId, session.frameId, session.videoId));
  let result;
  try {
    result = await loading;
  } catch (err) {
    if (session.loading === loading) session.loading = null; // повтор загрузит заново
    throw err;
  }
  if (session.run !== run || session.phrases) return;
  session.phrases = result.phrases;
  safePost(session.port, { type: "phrases", list: result.phrases, kind: result.kind });
}

// Цикл подготовки: батч за батчем, пока планировщику есть что переводить. Новая позиция снова
// запускает его (setPosition). Пока цикл идёт, service worker не засыпает: между запросами к
// модели слоты его не держат.
async function work(session, run) {
  if (run.looping) return;
  run.looping = true;
  const letSleep = keepAwake();
  try {
    await ensurePhrases(session, run);
    while (session.run === run) {
      const { batchMaxItems: maxItems, batchMaxChars: maxChars } = await getSettings();
      if (session.run !== run) break;
      const batch = nextBatch(session.phrases, pending(session), session.position, {
        maxItems,
        maxChars,
      });
      if (!batch.length) break;
      await translateBatch(session, run, batch);
      if (session.run === run) voice(session, run);
    }
  } catch (err) {
    if (session.run === run) fail(session, err);
  } finally {
    run.looping = false;
    letSleep();
  }
}

// Переводит батч и отдаёт вкладке. Оборван после перемотки — готовое отдаёт, остальное
// переведётся, когда до него дойдёт очередь. Другие ошибки бросает.
async function translateBatch(session, run, batch) {
  const controller = new AbortController();
  run.batch = { phrases: batch, ids: new Set(batch.map((p) => p.id)), controller };
  const signal = AbortSignal.any([run.controller.signal, controller.signal]);
  const out = new Array(batch.length);
  const startedAt = Date.now();
  let error = null;
  try {
    // пользователь ждёт прямо сейчас — встаём перед очередью перевода страниц
    await withPrioritySlot({ signal, prompts: DUB_PROMPTS }, (ctx) =>
      translateTexts(batch.map((p) => p.text), ctx, out),
    );
  } catch (err) {
    error = err;
  } finally {
    run.batch = null;
  }
  // Готовое отдаём и после «Стоп»: вкладка его покажет и в следующий start пришлёт обратно.
  // Другое видео — переводы не к нему.
  if (session.videoId === run.videoId) deliver(session, batch, out);
  const done = out.filter(Boolean).length;
  console.debug(
    `[ot] озвучка: фразы ${batch[0].id}–${batch.at(-1).id} ` +
      `(${clock(batch[0].start)}–${clock(batch.at(-1).end)}), переведено ${done} из ` +
      `${batch.length} за ${((Date.now() - startedAt) / 1000).toFixed(1)} с`,
  );
  if (error && !(controller.signal.aborted && !run.controller.signal.aborted)) throw error;
}

// Фразу, которую модель так и не перевела, отдаём пустой: вкладка её пропустит, а
// планировщик не станет переводить снова.
function deliver(session, batch, out) {
  const ids = [];
  const texts = [];
  batch.forEach((phrase, i) => {
    const r = out[i];
    if (!r) return; // батч оборван раньше
    if (r.error) {
      console.warn(`[ot] озвучка: фраза ${phrase.id} не переведена:`, r.error.message, phrase.text);
    }
    const text = r.text ?? "";
    session.translations.set(phrase.id, text);
    ids.push(phrase.id);
    texts.push(text);
  });
  if (ids.length) safePost(session.port, { type: "translated", ids, texts });
}

// ---------- Синтез ----------

// Цикл синтеза: по одной фразе, ближайшей к позиции, пока в окне есть переведённое без звука.
// Идёт параллельно с переводом: пока Ollama переводит следующий батч, Silero озвучивает
// готовый — он на процессоре и за видеопамять с ней не спорит. Запускают его start, новая
// позиция и каждый переведённый батч.
async function voice(session, run) {
  if (run.voicing) return;
  run.voicing = true;
  const letSleep = keepAwake();
  try {
    // заодно проверка, что Silero жив: без него и переводить незачем
    run.server ??= serverInfo(run);
    const { rates } = await run.server;
    while (session.run === run && session.phrases) {
      const index = nextVoice(session.phrases, needsVoice(session), session.position);
      if (index < 0) break;
      await voiceOne(session, run, index, rates);
    }
  } catch (err) {
    if (session.run === run) fail(session, err);
  } finally {
    run.voicing = false;
    letSleep();
  }
}

// → { voices, defaultVoice, rates } от Silero.
async function serverInfo(run) {
  const { dubTtsUrl } = await getDubSettings();
  const info = await getVoices(dubTtsUrl, { signal: run.controller.signal });
  if (!info.rates.length) {
    console.debug("[ot] озвучка: у Silero нет темпов (старый server.py), длину подгоняю ускорением");
  }
  return info;
}

// Синтезирует фразу и отдаёт звук вкладке. Фразу, которую Silero не озвучил, отдаёт без звука,
// но если так подряд MAX_VOICE_FAILURES раз — бросает.
async function voiceOne(session, run, index, rates) {
  const phrase = session.phrases[index];
  const text = session.translations.get(phrase.id);
  let clip = null;
  try {
    clip = await synthesizeFitted(session.phrases, index, text, rates, run.controller.signal);
    run.failures = 0;
  } catch (err) {
    const skippable = err instanceof TtsError && err.code === TtsErrorCode.BAD_RESPONSE;
    if (!skippable || ++run.failures >= MAX_VOICE_FAILURES) throw err;
    console.warn(`[ot] озвучка: фраза ${phrase.id} не озвучена:`, err.message, text);
  }
  // Готовое отдаём и после «Стоп», как переводы. Другое видео — звук не к нему.
  if (session.videoId !== run.videoId) return;
  session.voiced.add(phrase.id);
  safePost(
    session.port,
    clip
      ? { type: "audio", id: phrase.id, data: toBase64(clip.wav), duration: clip.duration, rate: clip.rate }
      : { type: "audio", id: phrase.id, data: null },
  );
}

// Звук фразы, подогнанный под её место (fit.js): { wav, duration, rate }, null — произносить
// нечего. Не влезает — синтезируем заново быстрым темпом, остаток — rate воспроизведения.
async function synthesizeFitted(phrases, index, text, rates, signal) {
  const { dubTtsUrl: url, dubVoice: voice, dubMaxSpeed: maxSpeed } = await getDubSettings();
  const slot = slotOf(phrases, index);
  // обычный темп явно: на сервере по умолчанию может стоять другой
  const medium = rates.includes("medium") ? "medium" : "";
  const wav = await synthesize(url, { text, voice, rate: medium }, { signal });
  if (!wav) return null;
  let clip = { wav, duration: lengthOf(wav), speedup: 1, tempo: medium || "обычный" };
  const tempo = pickTempo(clip.duration, slot, rates, maxSpeed);
  if (tempo) {
    const faster = await synthesize(url, { text, voice, rate: tempo }, { signal });
    const duration = faster ? lengthOf(faster) : Infinity;
    // темп, который запись не укоротил, ни к чему
    if (duration < clip.duration) {
      clip = { wav: faster, duration, speedup: clip.duration / duration, tempo };
    }
  }
  const rate = playbackRate(clip.duration, slot, clip.speedup, maxSpeed);
  console.debug(
    `[ot] озвучка: фраза ${phrases[index].id} — ${clip.duration.toFixed(1)} с речи на ` +
      `${slot.toFixed(1)} с места, темп ${clip.tempo}, ускорение ×${rate}`,
  );
  return { wav: clip.wav, duration: clip.duration, rate };
}

function lengthOf(wav) {
  try {
    return wavDuration(wav);
  } catch (err) {
    throw new TtsError(TtsErrorCode.BAD_RESPONSE, `Silero прислал не wav: ${err.message}`);
  }
}

// ---------- Ошибки и позиция ----------

// Ошибка останавливает работу сессии до следующего start (нажатие на кнопку с ошибкой).
function fail(session, err) {
  session.run.controller.abort();
  session.run = null;
  if (err instanceof DubError) {
    safePost(session.port, { type: "error", code: err.code, message: err.message, detail: err.detail });
    return;
  }
  if (err instanceof TtsError) {
    console.warn("[ot] озвучка: синтез остановлен:", err.message);
    const hints = {
      [TtsErrorCode.TTS_DOWN]: startHint(os),
      [TtsErrorCode.VOICE_NOT_FOUND]: "Выберите голос в настройках расширения",
    };
    const message = TTS_ERRORS[err.code] ?? "Синтез не удался";
    const detail = [err.message, hints[err.code]].filter(Boolean).join("\n");
    safePost(session.port, { type: "error", code: err.code, message, detail });
    return;
  }
  const e = toOllamaError(err);
  console.warn("[ot] озвучка: перевод остановлен:", e.message);
  const message = OLLAMA_ERRORS[e.code] ?? "Перевод не удался";
  safePost(session.port, { type: "error", code: e.code, message, detail: e.message });
}

// Перемотка: идущий батч, который больше не нужен или мешает начать смотреть с нового места,
// обрываем, а цикл подготовки продолжает с новой позиции.
function setPosition(session, time) {
  session.position = Math.max(0, time);
  const run = session.run;
  if (!run) return;
  const batch = run.batch;
  if (batch && isStale(session.phrases, pending(session), session.position, batch.phrases)) {
    console.debug(`[ot] озвучка: перемотка на ${clock(session.position)}, обрываю батч`);
    batch.controller.abort();
  }
  work(session, run);
  voice(session, run);
}

function start(session, msg) {
  if (typeof msg.videoId !== "string") return;
  if (msg.videoId !== session.videoId) {
    session.run?.controller.abort();
    session.run = null;
    session.videoId = msg.videoId;
    session.phrases = null;
    session.loading = null;
    session.translations = new Map();
  }
  if (!session.phrases && validPhrases(msg.phrases)) session.phrases = msg.phrases;
  for (const entry of Array.isArray(msg.translations) ? msg.translations : []) {
    if (Array.isArray(entry) && Number.isInteger(entry[0])) {
      session.translations.set(entry[0], String(entry[1] ?? ""));
    }
  }
  // звук хранит вкладка, и только она знает, что у неё есть
  session.voiced = new Set(Array.isArray(msg.voiced) ? msg.voiced.filter(Number.isInteger) : []);
  // «Стоп» застал порт до этого start: вкладка отправила его, ещё не зная о «Стоп»
  if (session.stopPending) {
    session.stopPending = false;
    safePost(session.port, { type: "stopped" });
    return;
  }
  // после «Стоп» и ошибки — работа заново
  session.run ??= {
    controller: new AbortController(),
    videoId: msg.videoId,
    looping: false,
    batch: null,
    voicing: false,
    server: null,
    failures: 0,
  };
  setPosition(session, Number.isFinite(msg.time) ? msg.time : 0);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || !port.sender?.tab?.id) return;
  const session = {
    port,
    tabId: port.sender.tab.id,
    frameId: port.sender.frameId ?? 0,
    videoId: null,
    phrases: null, // [{ id, start, end, text }], по порядку времени
    loading: null, // промис loadPhrases
    translations: new Map(), // id → перевод; "" — фразу пропускаем
    voiced: new Set(), // id фраз, звук которых у вкладки (или произносить нечего)
    position: 0,
    run: null,
    stopPending: false, // «Стоп» был раньше первого start — ответить на него stopped
  };
  sessions.add(session);
  port.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case "start":
        start(session, msg);
        break;
      case "position":
        if (Number.isFinite(msg.time)) setPosition(session, msg.time);
        break;
      case "evicted":
        // позиция ушла от этих фраз; вернётся — синтезируем снова
        for (const id of Array.isArray(msg.ids) ? msg.ids : []) session.voiced.delete(id);
        break;
      case "ping":
        break; // само сообщение не даёт service worker'у уснуть
    }
  });
  // озвучку выключили, сменили видео или закрыли вкладку — запросы к Ollama и Silero обрываем
  onPortClosed(port, () => {
    sessions.delete(session);
    if (session.run?.looping) console.debug("[ot] озвучка: вкладка отключилась, перевод оборван");
    session.run?.controller.abort();
    session.run = null;
  });
});

// ---------- Меню в плеере ----------

function pickPlayerKeys(values) {
  const keys = DUB_PLAYER_KEYS.filter((key) => key in values);
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}

// Новые значения вкладки узнают из storage.onChanged и просят их снова.
async function playerSettings(patch) {
  if (patch && typeof patch === "object") await setDubSettings(pickPlayerKeys(patch));
  return { values: pickPlayerKeys(await getDubSettings()), limits: DUB_LIMITS };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab) return;
  if (msg?.type === "dubOptions") {
    chrome.runtime
      .openOptionsPage()
      .catch((err) => console.warn("[ot] страница настроек не открылась:", err.message));
    return;
  }
  if (msg?.type !== "dubSettings") return;
  playerSettings(msg.patch).then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true;
});

// ---------- «Стоп» ----------

// Работа сессий обрывается до «Продолжить» на кнопке. Вкладки без порта (service worker
// перезапускался, пока переводить было нечего) тоже узнают: иначе при просмотре они
// подключились бы снова и запустили модель. Вкладка, которая подключится, пока идёт запрос
// вкладок, тоже получит dubStopped и закроет порт.
onStop(async () => {
  const connected = new Set();
  for (const session of sessions) {
    connected.add(session.tabId);
    if (!session.videoId) session.stopPending = true;
    if (!session.run) continue;
    session.run.controller.abort();
    session.run = null;
    safePost(session.port, { type: "stopped" });
  }
  for (const tab of await chrome.tabs.query({ url: YOUTUBE_TABS })) {
    if (connected.has(tab.id)) continue;
    chrome.tabs.sendMessage(tab.id, { type: "dubStopped" }).catch(() => {});
  }
});

// Для «Стоп» в popup: фразы в окне перевода, которые ждут модели.
registerQueue(() => {
  let queued = 0;
  for (const session of sessions) {
    if (session.run?.looping && session.phrases) {
      queued += pendingCount(session.phrases, pending(session), session.position);
    }
  }
  return queued;
});

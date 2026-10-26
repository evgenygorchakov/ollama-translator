// Клиент HTTP API Silero (tools/silero/server.py). Только fetch, без chrome.* — работает и в
// service worker, и на странице настроек.

export const TtsErrorCode = Object.freeze({
  TTS_DOWN: "TTS_DOWN",
  VOICE_NOT_FOUND: "VOICE_NOT_FOUND",
  BAD_RESPONSE: "BAD_RESPONSE",
  ABORTED: "ABORTED",
});

export class TtsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TtsError";
    this.code = code;
  }
}

// Как запустить сервер, если он не отвечает. os — из chrome.runtime.getPlatformInfo().
export function startHint(os) {
  return os === "win"
    ? 'Start it: Start-ScheduledTask "Silero TTS" in PowerShell or tools/silero/silero-serve.cmd. ' +
        "Setup: tools/silero/README.md"
    : "Start it: systemctl --user start silero. Setup: sup/optional/voice/README.md";
}

// Синтез — около 0,1 с на фразу, но сервер однопоточный: запрос может ждать чужой.
const SYNTHESIZE_TIMEOUT_MS = 30_000;
const INFO_TIMEOUT_MS = 5_000;

function toNetworkError(err, baseUrl) {
  if (err?.name === "TimeoutError") {
    return new TtsError(TtsErrorCode.TTS_DOWN, `Silero didn't respond in time (${baseUrl})`);
  }
  if (err?.name === "AbortError") {
    return new TtsError(TtsErrorCode.ABORTED, "Request cancelled");
  }
  return new TtsError(TtsErrorCode.TTS_DOWN, `Silero isn't responding (${baseUrl})`);
}

function notSilero(baseUrl, detail = "") {
  return new TtsError(TtsErrorCode.BAD_RESPONSE, `The server at ${baseUrl} is not Silero${detail}`);
}

async function toHttpError(res, baseUrl) {
  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // тело не JSON — оставляем как есть
  }
  // свои 404 Silero отдаёт с JSON { error }, а без него такого пути на сервере нет
  if (res.status === 404 && !data?.error) return notSilero(baseUrl, " (HTTP 404)");
  // 404 с { error, available } бывает и на голос, и на темп, различаются они только текстом
  if (res.status === 404 && /голос не найден/i.test(data.error)) {
    return new TtsError(TtsErrorCode.VOICE_NOT_FOUND, `Silero: ${data.error}`);
  }
  const message = data?.error || text.trim() || res.statusText;
  return new TtsError(TtsErrorCode.BAD_RESPONSE, `Silero: HTTP ${res.status}: ${message}`);
}

async function request(baseUrl, path, { method = "GET", body, signal, timeoutMs }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw toNetworkError(err, baseUrl);
  }
  if (!res.ok) throw await toHttpError(res, baseUrl);
  return res;
}

async function readJson(res, baseUrl) {
  try {
    return await res.json();
  } catch (err) {
    throw err?.name === "SyntaxError" ? notSilero(baseUrl) : toNetworkError(err, baseUrl);
  }
}

// text — по-русски; voice — имя голоса, пусто — голос по умолчанию на сервере; rate — темп
// из rates сервера ("medium", "fast", "x-fast"…), пусто — по умолчанию на сервере.
// → ArrayBuffer с wav или null, если произносить нечего (в тексте нет слов).
export async function synthesize(baseUrl, { text, voice, rate }, { signal } = {}) {
  const body = { text };
  if (voice) body.voice = voice;
  if (rate) body.rate = rate;
  const res = await request(baseUrl, "/synthesize", {
    method: "POST",
    body,
    signal,
    timeoutMs: SYNTHESIZE_TIMEOUT_MS,
  });
  if (res.status === 204) return null;
  if (!res.headers.get("Content-Type")?.startsWith("audio/")) throw notSilero(baseUrl);
  try {
    return await res.arrayBuffer();
  } catch (err) {
    throw toNetworkError(err, baseUrl);
  }
}

// → { voices: [имя], defaultVoice, rates: [темп] }. rates пуст у старой версии сервера: она
// темп не меняет.
export async function getVoices(baseUrl, { signal } = {}) {
  const res = await request(baseUrl, "/voices", { signal, timeoutMs: INFO_TIMEOUT_MS });
  const data = await readJson(res, baseUrl);
  if (!Array.isArray(data?.voices)) throw notSilero(baseUrl);
  return {
    voices: data.voices.filter((v) => typeof v === "string"),
    defaultVoice: typeof data.default === "string" ? data.default : "",
    rates: Array.isArray(data.rates) ? data.rates.filter((r) => typeof r === "string") : [],
  };
}

// → { model, voiceCount, device }.
export async function getHealth(baseUrl, { signal } = {}) {
  const res = await request(baseUrl, "/health", { signal, timeoutMs: INFO_TIMEOUT_MS });
  const data = await readJson(res, baseUrl);
  if (typeof data?.model !== "string") throw notSilero(baseUrl);
  return {
    model: data.model,
    voiceCount: Number(data.voices) || 0,
    device: typeof data.device === "string" ? data.device : "",
  };
}

// Клиент HTTP API Ollama. Только fetch, без chrome.* — работает и в popup, и в service worker.

export const ErrorCode = Object.freeze({
  OLLAMA_DOWN: "OLLAMA_DOWN",
  FORBIDDEN_ORIGIN: "FORBIDDEN_ORIGIN",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  BAD_RESPONSE: "BAD_RESPONSE",
  ABORTED: "ABORTED",
  TEXT_TOO_LONG: "TEXT_TOO_LONG", // не от Ollama: текст длиннее допустимого, повтор не поможет
});

export class OllamaError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
    this.status = status; // HTTP-статус, если ошибка пришла от сервера
  }
}

export function abortedError() {
  return new OllamaError(ErrorCode.ABORTED, "Request cancelled");
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function toNetworkError(err, baseUrl) {
  if (err?.name === "TimeoutError") {
    return new OllamaError(ErrorCode.OLLAMA_DOWN, `Ollama didn't respond in time (${baseUrl})`);
  }
  if (err?.name === "AbortError") {
    return abortedError();
  }
  return new OllamaError(ErrorCode.OLLAMA_DOWN, `Can't connect to Ollama (${baseUrl})`);
}

async function toHttpError(res) {
  const text = await res.text().catch(() => "");
  let message = text.trim();
  try {
    message = JSON.parse(text).error || message;
  } catch {
    // тело не JSON — оставляем как есть
  }
  const status = res.status;
  if (status === 403) {
    return new OllamaError(
      ErrorCode.FORBIDDEN_ORIGIN,
      "Ollama rejected the extension's request (403): OLLAMA_ORIGINS is not set",
      { status },
    );
  }
  if (status === 404 && /not found/i.test(message)) {
    return new OllamaError(ErrorCode.MODEL_NOT_FOUND, message, { status });
  }
  return new OllamaError(ErrorCode.BAD_RESPONSE, `HTTP ${status}: ${message || res.statusText}`, {
    status,
  });
}

async function request(baseUrl, path, { method = "GET", body, signal, timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    });
  } catch (err) {
    throw toNetworkError(err, baseUrl);
  }
  if (!res.ok) throw await toHttpError(res);
  return res;
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    throw new OllamaError(ErrorCode.BAD_RESPONSE, "Ollama returned something other than JSON");
  }
}

export async function getVersion(baseUrl, opts = {}) {
  const data = await readJson(await request(baseUrl, "/api/version", { timeoutMs: 3000, ...opts }));
  return data.version ?? "";
}

export async function listModels(baseUrl, opts = {}) {
  const data = await readJson(await request(baseUrl, "/api/tags", { timeoutMs: 5000, ...opts }));
  return (data.models ?? [])
    .map((m) => ({
      name: m.name,
      size: m.size,
      parameterSize: m.details?.parameter_size ?? "",
      quantization: m.details?.quantization_level ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function showModel(baseUrl, model, opts = {}) {
  const res = await request(baseUrl, "/api/show", {
    timeoutMs: 10000,
    ...opts,
    method: "POST",
    body: { model },
  });
  const data = await readJson(res);
  return { capabilities: data.capabilities ?? [] };
}

// Загружает модель в память заранее, чтобы первый батч не ждал загрузки.
export async function warmUp(baseUrl, model, { keepAlive = "30m", ...opts } = {}) {
  const stall = new AbortController();
  let stallError = null;
  const watch = watchStall(baseUrl, (message) => {
    stallError = new OllamaError(ErrorCode.OLLAMA_DOWN, message);
    stall.abort();
  });
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  try {
    // Ждём и тело ответа: до него загрузка ещё может продолжаться.
    return await readJson(await request(baseUrl, "/api/generate", {
      ...opts,
      signal,
      method: "POST",
      body: { model, prompt: "", stream: false, keep_alive: keepAlive },
    }));
  } catch (err) {
    // readJson превращает оборванное чтение тела в BAD_RESPONSE; сохраняем причину отмены.
    if (opts.signal?.aborted) throw abortedError();
    if (stallError) throw stallError;
    throw err;
  } finally {
    watch.stop();
  }
}

// Фактически выделенное окно загруженной модели, а не её теоретический максимум из /api/show.
// null — модель выгружена или версия Ollama не сообщает длину контекста.
export async function modelContextLength(baseUrl, model, opts = {}) {
  const data = await readJson(await request(baseUrl, "/api/ps", { timeoutMs: 5000, ...opts }));
  const running = (data.models ?? []).find((m) =>
    [m.name, m.model].some((name) => name === model || name === `${model}:latest`),
  );
  const length = running?.context_length;
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

// Выгружает модель из памяти (VRAM и RAM). Если её ещё доделывают оборванные запросы, Ollama
// выгрузит её сразу после них.
export async function unloadModel(baseUrl, model, opts = {}) {
  await request(baseUrl, "/api/generate", {
    timeoutMs: 10000,
    ...opts,
    method: "POST",
    body: { model, prompt: "", keep_alive: 0 },
  });
}

// Ollama может зависнуть, не закрыв соединение, — запрос висел бы вечно и держал слот (а с ним
// и service worker, см. slots.js). Но до первого куска ответа молчание — норма: запрос ждёт
// очереди в Ollama (OLLAMA_NUM_PARALLEL, наши же запросы, другие клиенты), модель грузится в
// память, читается промпт — на медленном железе всё это минуты. Поэтому до первого куска только
// проверяем раз в MODEL_PROBE_MS, что Ollama отвечает; зависшую загрузку модели она оборвёт сама
// (OLLAMA_LOAD_TIMEOUT). Когда модель пишет ответ, куски идут постоянно: тогда отсчёт простоя
// сбрасывает каждый кусок. При warmUp проверяем доступность до конца загрузки, включая тело
// ответа: она тоже держит слот, но потоковых кусков у неё нет.
const MODEL_PROBE_MS = 30_000;
const MODEL_PROBE_TIMEOUT_MS = 10_000;
const CHAT_IDLE_MS = 180_000;

// Сторож запросов warmUp и chat: если Ollama не отвечает, зовёт onStall(message).
function watchStall(baseUrl, onStall) {
  const probing = new AbortController();
  let timer = null;
  const probe = async () => {
    const signal = withTimeout(probing.signal, MODEL_PROBE_TIMEOUT_MS);
    try {
      await getVersion(baseUrl, { timeoutMs: 0, signal });
    } catch (err) {
      // Тайм-аут может оборвать и тело /api/version, которое readJson считает BAD_RESPONSE.
      if ((err.code === ErrorCode.OLLAMA_DOWN || signal.aborted) && !probing.signal.aborted) {
        onStall(`Ollama isn't responding (${baseUrl})`);
        return;
      }
    }
    if (!probing.signal.aborted) timer = setTimeout(probe, MODEL_PROBE_MS);
  };
  timer = setTimeout(probe, MODEL_PROBE_MS);
  const stop = () => {
    probing.abort();
    clearTimeout(timer);
  };
  return {
    stop,
    // пришёл кусок ответа: модель взялась за запрос, дальше следим за простоем
    chunk() {
      stop();
      timer = setTimeout(
        () => onStall(`Ollama has been silent for over ${CHAT_IDLE_MS / 1000} s (${baseUrl})`),
        CHAT_IDLE_MS,
      );
    },
  };
}

// POST /api/chat со stream: true. Копит ответ целиком; стрим нужен, чтобы соединение не молчало.
// opts.onContent(content) — необязательный: получает накопленный ответ после каждого куска.
// opts.onThinking(thinking) — так же для рассуждения (message.thinking), если модель рассуждает.
export async function chat(baseUrl, body, opts = {}) {
  const stall = new AbortController();
  let stallError = null;
  const watch = watchStall(baseUrl, (message) => {
    stallError = new OllamaError(ErrorCode.OLLAMA_DOWN, message);
    stall.abort();
  });
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  let reader = null;
  let buffer = "";
  let content = "";
  let thinking = "";
  const toolCalls = [];
  let final = null;

  const handleLine = (line) => {
    if (!line.trim()) return;
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      throw new OllamaError(ErrorCode.BAD_RESPONSE, "Couldn't parse a line of the Ollama stream");
    }
    if (chunk.error) throw new OllamaError(ErrorCode.BAD_RESPONSE, chunk.error);
    const thought = chunk.message?.thinking ?? "";
    if (thought) {
      thinking += thought;
      opts.onThinking?.(thinking);
    }
    const delta = chunk.message?.content ?? "";
    if (delta) {
      content += delta;
      opts.onContent?.(content);
    }
    if (Array.isArray(chunk.message?.tool_calls)) {
      toolCalls.push(...chunk.message.tool_calls);
    }
    if (chunk.done) final = chunk;
  };

  try {
    const res = await request(baseUrl, "/api/chat", {
      ...opts,
      signal,
      method: "POST",
      body: { ...body, stream: true },
    });
    reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      watch.chunk();
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    handleLine(buffer);
  } catch (err) {
    // без cancel Ollama догенерирует ответ, который уже никому не нужен, а слот отдан другому
    reader?.cancel().catch(() => {});
    if (stallError && !opts.signal?.aborted) throw stallError;
    if (err instanceof OllamaError) throw err;
    throw toNetworkError(err, baseUrl);
  } finally {
    watch.stop();
  }

  if (!final) throw new OllamaError(ErrorCode.BAD_RESPONSE, "The Ollama stream ended before the response was complete");
  return {
    content,
    thinking,
    toolCalls,
    message: {
      role: "assistant",
      content,
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    promptEvalCount: Number.isSafeInteger(final.prompt_eval_count) && final.prompt_eval_count >= 0
      ? final.prompt_eval_count : null,
    evalCount: Number.isSafeInteger(final.eval_count) && final.eval_count >= 0
      ? final.eval_count : null,
    evalDuration: final.eval_duration ?? 0, // наносекунды
    doneReason: final.done_reason ?? "",
  };
}

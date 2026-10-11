// Разбор ответов модели. Всё, что возвращает null или считается «плохим», background
// обрабатывает сам: делит батч, переспрашивает по одному, помечает блок ошибкой.

// Модели с thinking иногда всё равно пишут рассуждение, даже при think: false.
function stripThinking(content) {
  return String(content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Ответ на батч → массив переводов, либо null, если формат не тот или число элементов не совпало.
export function parseBatch(content, expectedCount) {
  const text = stripThinking(content).trim();
  let data = tryJson(text);
  if (data === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    data = tryJson(text.slice(start, end + 1));
  }
  const list = data?.translations;
  if (!Array.isArray(list) || list.length !== expectedCount) return null;
  if (!list.every((t) => typeof t === "string")) return null;
  return list.map((t) => t.trim());
}

// Ответ на одиночный запрос без format — просто текст перевода.
export function parseSingle(content, original = "") {
  let text = stripThinking(content).trim();
  // «Перевод: …» или весь ответ в кавычках — частые вольности моделей
  text = text.replace(/^(translation|перевод)\s*:\s*/i, "");
  const quoted = /^(["«“])([\s\S]*)(["»”])$/.exec(text);
  if (quoted && !/["«»“”]/.test(quoted[2]) && !/^\s*["«“]/.test(original)) {
    text = quoted[2].trim();
  }
  return text;
}

const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

// Пустой перевод или длинный текст, который вернулся без изменений, — ошибка.
export function isBadTranslation(original, translation) {
  if (!translation.trim()) return true;
  return original.length >= 40 && normalize(original) === normalize(translation);
}

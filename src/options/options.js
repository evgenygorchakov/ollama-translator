import {
  BUILTIN_HOSTS,
  DEFAULTS,
  LIMITS,
  getSettings,
  normalizeUrl,
  resetSettings,
  setSettings,
} from "../lib/settings.js";
import { LANGUAGES } from "../lib/languages.js";
import { DEFAULT_BATCH_PROMPT } from "../lib/prompt.js";
import { ErrorCode, getVersion, listModels } from "../lib/ollama.js";
import { modelOptions } from "../lib/model-options.js";
import { ensureHostPermission, parseServerUrl } from "../lib/host-permission.js";

const $ = (id) => document.getElementById(id);
const NUMBER_KEYS = ["batchMaxItems", "batchMaxChars", "concurrency", "temperature", "numCtx"];

let settings;
let models = [];

// ---------- Форма ----------

function setupStatic() {
  for (const key of NUMBER_KEYS) {
    const { min, max, step } = LIMITS[key];
    Object.assign($(key), { min, max, step });
  }
  $("targetLang").replaceChildren(
    ...LANGUAGES.map((l) => new Option(`${l.name} (${l.label})`, l.code)),
  );
  $("systemPrompt").placeholder = DEFAULT_BATCH_PROMPT;
}

function renderModels(selected) {
  $("model").replaceChildren(...modelOptions(models, selected));
  $("model").value = selected;
}

function fill(s) {
  $("ollamaUrl").value = s.ollamaUrl;
  renderModels(s.model);
  $("targetLang").value = s.targetLang;
  for (const key of NUMBER_KEYS) $(key).value = s[key];
  $("systemPrompt").value = s.systemPrompt;
}

function readForm() {
  const values = {
    ollamaUrl: normalizeUrl($("ollamaUrl").value),
    model: $("model").value,
    targetLang: $("targetLang").value,
    systemPrompt: $("systemPrompt").value.trim(),
  };
  for (const key of NUMBER_KEYS) {
    const raw = $(key).value.trim();
    values[key] = raw === "" ? DEFAULTS[key] : Number(raw);
  }
  return values;
}

function setSaveStatus(text) {
  $("save-status").textContent = text;
}

// ---------- Ollama ----------

function setOllamaStatus(kind, text) {
  const el = $("ollama-status");
  el.dataset.kind = kind;
  el.textContent = text;
}

// → URL, если адрес годится и разрешение есть; иначе пишет ошибку в статус и → null.
// Вызывать прямо из обработчика клика (см. ensureHostPermission).
async function prepareUrl() {
  const url = parseServerUrl($("ollamaUrl").value);
  if (!url) {
    setOllamaStatus("error", "The address must look like http://host:11434");
    return null;
  }
  let granted = false;
  try {
    granted = await ensureHostPermission(url, BUILTIN_HOSTS);
  } catch (err) {
    console.error(err);
  }
  if (!granted) {
    setOllamaStatus("error", `No permission to access ${url.origin}`);
    return null;
  }
  return url;
}

async function checkOllama(baseUrl) {
  setOllamaStatus("checking", "Checking Ollama…");
  $("check").disabled = true;
  try {
    let version;
    [version, models] = await Promise.all([getVersion(baseUrl), listModels(baseUrl)]);
    renderModels($("model").value);
    if (models.length) setOllamaStatus("ok", `Ollama ${version} · models: ${models.length}`);
    else setOllamaStatus("warn", `Ollama ${version} is running, but has no models`);
  } catch (err) {
    console.error(err);
    models = [];
    renderModels($("model").value);
    const hint =
      err.code === ErrorCode.FORBIDDEN_ORIGIN
        ? " — set OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* and restart Ollama"
        : "";
    setOllamaStatus("error", err.message + hint);
  } finally {
    $("check").disabled = false;
  }
}

// ---------- События ----------

$("check").addEventListener("click", async () => {
  const url = await prepareUrl();
  if (url) await checkOllama(normalizeUrl(url.href));
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = await prepareUrl();
  if (!url) {
    setSaveStatus("Not saved: check the Ollama address");
    return;
  }
  // Пишем только поля, изменённые здесь: остальные могли сменить в popup, пока страница открыта.
  const patch = Object.fromEntries(
    Object.entries(readForm()).filter(([key, value]) => value !== settings[key]),
  );
  const urlChanged = "ollamaUrl" in patch;
  await setSettings(patch);
  settings = await getSettings();
  fill(settings); // показываем значения после проверки диапазонов
  setSaveStatus("Saved");
  if (urlChanged) await checkOllama(settings.ollamaUrl);
});

// Модель меняют и в popup. Если здесь её не трогали, показываем новую. Если выбрали другую,
// она остаётся в форме и запишется при сохранении.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.model || !settings) return;
  const model = changes.model.newValue ?? DEFAULTS.model;
  if ($("model").value === settings.model) renderModels(model);
  settings.model = model;
});

$("form").addEventListener("input", () => {
  setSaveStatus("Unsaved changes");
});

$("reset").addEventListener("click", async () => {
  await resetSettings();
  settings = await getSettings();
  fill(settings);
  setSaveStatus("Settings reset");
  await checkOllama(settings.ollamaUrl);
});

// ---------- Старт ----------

setupStatic();
settings = await getSettings();
fill(settings);
await checkOllama(settings.ollamaUrl);

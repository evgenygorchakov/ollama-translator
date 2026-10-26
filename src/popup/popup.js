import { getSettings, setSettings } from "../lib/settings.js";
import { ErrorCode, getVersion, listModels, showModel, warmUp } from "../lib/ollama.js";
import { modelOptions } from "../lib/model-options.js";
import { getPageState } from "../lib/tabs.js";
import { isStopped, markModelUsed } from "../lib/stop.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"),
  statusText: $("status-text"),
  hint: $("hint"),
  hintText: $("hint-text"),
  hintCode: $("hint-code"),
  model: $("model"),
  refresh: $("refresh"),
  options: $("options"),
  stop: $("stop"),
  translate: $("translate"),
  original: $("original"),
  progress: $("progress"),
  note: $("note"),
};

const POLL_MS = 500;
const IDLE = { busy: 0, queued: 0 };

let settings;
let version = "";
let models = [];
let tabId = null;
let pageState = null; // ответ content script'а; null — ещё не внедрён или страница недоступна
let activity = IDLE; // работа модели на всех вкладках и над выделенным, из background
let acting = false; // идёт переключение, «Продолжить» или «Стоп»: кнопки не нажимаются

const HINTS = {
  [ErrorCode.OLLAMA_DOWN]: {
    text: "Start Ollama (Windows: from the Start menu, Linux: systemctl) and press ⟳.",
  },
  [ErrorCode.FORBIDDEN_ORIGIN]: {
    text: "Ollama rejects requests from extensions. Set this environment variable and restart Ollama:",
    code: "OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*",
  },
  [ErrorCode.BAD_RESPONSE]: {
    text: "Unexpected response from Ollama. See the popup console for details.",
  },
};

function setStatus(kind, text, hint) {
  els.status.dataset.kind = kind;
  els.statusText.textContent = text;
  els.hint.hidden = !hint;
  els.hintText.textContent = hint?.text ?? "";
  els.hintCode.textContent = hint?.code ?? "";
  els.hintCode.hidden = !hint?.code;
  updateButtons();
}

// Перевод выключен — «Перевести страницу»; включён — «Показать оригинал»; на паузе ещё и
// «▶ Продолжить». «■ Стоп» — пока модель работает, на этой вкладке или на любой другой.
function updateButtons() {
  const active = Boolean(pageState?.active);
  const paused = active && Boolean(pageState.paused);
  els.translate.hidden = active && !paused;
  els.translate.textContent = paused ? "▶ Resume" : "Translate page";
  // вернуть оригинал можно всегда, переводить — только когда Ollama и модель в порядке
  els.translate.disabled = acting || els.status.dataset.kind !== "ok";
  els.original.hidden = !active;
  els.original.disabled = acting;
  els.stop.hidden = !activity.busy && !activity.queued;
  els.stop.disabled = acting;
}

function renderProgress() {
  const s = pageState;
  els.progress.hidden = !s?.active;
  if (!s?.active) return;
  // на паузе ожидавшие перевода фрагменты снова ждут прокрутки — считаем от всех на странице
  const parts = s.paused
    ? [`Stopped · translated ${s.done} of ${s.total}`]
    : [`Translated ${s.done} of ${s.requested}`];
  if (s.errors) parts.push(`errors: ${s.errors}`);
  if (!s.paused) parts.push(`on the page: ${s.total}`);
  els.progress.textContent = parts.join(" · ");
}

async function getActivity() {
  try {
    return (await chrome.runtime.sendMessage({ type: "getActivity" })) ?? IDLE;
  } catch {
    return IDLE; // service worker не ответил: расширение перезагружается
  }
}

async function refresh() {
  [pageState, activity] = await Promise.all([getPageState(tabId), getActivity()]);
  renderProgress();
  updateButtons();
}

// Прогресс перевода (остальное подтянется при прокрутке страницы) и работа модели — пока
// popup открыт.
async function poll() {
  await refresh();
  setTimeout(poll, POLL_MS);
}

function showNote(text) {
  els.note.hidden = !text;
  els.note.textContent = text ?? "";
}

function renderModels() {
  els.model.replaceChildren(...modelOptions(models, settings.model));
  els.model.value = settings.model;
  els.model.disabled = models.length === 0;
}

function updateModelStatus() {
  if (models.length === 0) {
    setStatus("warn", `Ollama ${version} is running, but has no models`, {
      text: "Pull a model, for example:",
      code: "ollama pull qwen3:8b",
    });
  } else if (!settings.model) {
    setStatus("warn", `Ollama ${version} · choose a model`);
  } else if (!models.some((m) => m.name === settings.model)) {
    setStatus("error", `Model ${settings.model} not found`, {
      text: "Choose another model or pull this one:",
      code: `ollama pull ${settings.model}`,
    });
  } else {
    setStatus("ok", `Ollama ${version} · OK`);
    warmUpUnlessStopped();
  }
}

// Грузим модель в память заранее, пока пользователь тянется к кнопке. После «Стоп» — нет:
// модель выгрузили намеренно, открытый popup не должен загружать её обратно.
async function warmUpUnlessStopped() {
  if (await isStopped()) return;
  markModelUsed(settings.ollamaUrl, settings.model); // «Стоп» выгрузит её, даже если модель сменят
  warmUp(settings.ollamaUrl, settings.model).catch((err) => console.warn("warm-up:", err));
}

async function check() {
  els.refresh.disabled = true;
  els.model.disabled = true;
  setStatus("checking", "Checking Ollama…");
  try {
    [version, models] = await Promise.all([
      getVersion(settings.ollamaUrl),
      listModels(settings.ollamaUrl),
    ]);
    // GET-запросы к хостам из host_permissions Chrome шлёт без Origin, и Ollama их пускает;
    // 403 из-за OLLAMA_ORIGINS проявляется только на POST — проверяем им.
    const probe = models.find((m) => m.name === settings.model) ?? models[0];
    if (probe) await showModel(settings.ollamaUrl, probe.name);
    renderModels();
    updateModelStatus();
  } catch (err) {
    console.error(err);
    models = [];
    els.model.replaceChildren();
    setStatus("error", err.message, HINTS[err.code]);
  } finally {
    els.refresh.disabled = false;
  }
}

els.model.addEventListener("change", async () => {
  settings.model = els.model.value;
  await setSettings({ model: settings.model });
  renderModels();
  updateModelStatus();
});

els.refresh.addEventListener("click", check);

// Пока действие идёт, кнопки выключены: иначе опрос включил бы их раньше времени, и второй
// клик переключил бы перевод обратно. failure — начало сообщения, если не получилось.
async function act(fn, failure) {
  acting = true;
  updateButtons();
  showNote("");
  try {
    await fn();
  } catch (err) {
    console.error(err);
    showNote(`${failure}: ${err.message}`);
  } finally {
    acting = false;
    await refresh();
  }
}

// ответ background вида { error }: ошибка — исключением
async function askBackground(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (res?.error) throw new Error(res.error);
  return res;
}

// Внедрение и переключение делает background — так же, как для хоткея и контекстного меню.
const togglePage = () =>
  act(() => askBackground({ type: "toggleTab", tabId }), "Couldn't translate this page");

// На паузе content script уже внедрён — просим его продолжить напрямую.
const resumePage = () =>
  act(() => chrome.tabs.sendMessage(tabId, { type: "resume" }), "Couldn't resume translation");

// Обрывает все запросы к модели на всех вкладках и выгружает её из памяти (background.js).
// Запросы обрываются всегда, ошибкой может закончиться только выгрузка.
const stopAll = () => act(() => askBackground({ type: "stopAll" }), "Model not unloaded");

els.translate.addEventListener("click", () => (pageState?.paused ? resumePage() : togglePage()));
els.original.addEventListener("click", togglePage);
els.stop.addEventListener("click", stopAll);
els.options.addEventListener("click", () => chrome.runtime.openOptionsPage());

settings = await getSettings();
[{ id: tabId }] = await chrome.tabs.query({ active: true, currentWindow: true });
poll();
await check();

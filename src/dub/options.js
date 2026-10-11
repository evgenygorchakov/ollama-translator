// Раздел «Озвучка видео» на странице настроек: адрес Silero и голос. Остальные настройки
// озвучки — в меню у кнопки «Перевести» в плеере (dub/content.js). options.js о разделе не
// знает: раздел сам себя заполняет, по submit общей формы сохраняет свои поля, а после
// «Сбросить настройки» (storage стирает options.js) показывает DUB_DEFAULTS. Статус и ошибки — в
// своём разделе.

import { normalizeUrl } from "../lib/settings.js";
import { ensureHostPermission, parseServerUrl } from "../lib/host-permission.js";
import { DUB_BUILTIN_HOSTS, DUB_DEFAULTS, getDubSettings, setDubSettings } from "./lib/settings.js";
import { TtsErrorCode, getHealth, getVoices, startHint, synthesize } from "./lib/tts.js";
import { wavDuration } from "./lib/wav.js";

const $ = (id) => document.getElementById(id);
const SAMPLE_TEXT = "Привет! Так будет звучать озвучка видео.";

// Голоса v5_5_ru. Если сервер назовёт другие, покажем просто имя.
const VOICE_LABELS = {
  aidar: "aidar — мужской",
  eugene: "eugene — мужской",
  baya: "baya — женский",
  kseniya: "kseniya — женский",
  xenia: "xenia — женский",
};

const number = (v, digits) => v.toLocaleString("ru-RU", { maximumFractionDigits: digits });

let settings;
let server = null; // { voices, defaultVoice, rates } — последний ответ Silero
let os = ""; // chrome.runtime.getPlatformInfo: "win", "linux", "mac"…
let player = null; // { audio, url } — «Прослушать»

// ---------- Форма ----------

function voiceLabel(name) {
  return VOICE_LABELS[name] ?? name;
}

// Пусто — голос по умолчанию на сервере. Выбранный голос, которого нет в списке сервера,
// остаётся в списке: пока его не сменили, он и сохранится.
function renderVoices(selected) {
  const voices = server?.voices ?? [];
  const fallback = server?.defaultVoice;
  const options = [
    new Option(fallback ? `По умолчанию сервера (${voiceLabel(fallback)})` : "По умолчанию сервера", ""),
    ...voices.map((v) => new Option(voiceLabel(v), v)),
  ];
  if (selected && !voices.includes(selected)) {
    options.push(new Option(server ? `${selected} (нет на сервере)` : selected, selected));
  }
  $("dubVoice").replaceChildren(...options);
  $("dubVoice").value = selected;
}

function fill(s) {
  $("dubTtsUrl").value = s.dubTtsUrl;
  renderVoices(s.dubVoice);
}

function readForm() {
  return {
    dubTtsUrl: normalizeUrl($("dubTtsUrl").value),
    dubVoice: $("dubVoice").value,
  };
}

function setStatus(id, kind, text) {
  const el = $(id);
  el.dataset.kind = kind;
  el.textContent = text;
}

// ---------- Silero ----------

function errorText(err) {
  return err.code === TtsErrorCode.TTS_DOWN ? `${err.message}. ${startHint(os)}` : err.message;
}

// → URL, если адрес годится и разрешение есть; иначе пишет ошибку в статус и → null.
// Вызывать прямо из обработчика клика (см. ensureHostPermission).
async function prepareUrl(prefix = "") {
  const url = parseServerUrl($("dubTtsUrl").value);
  if (!url) {
    setStatus("dub-status", "error", `${prefix}Адрес должен быть вида http://127.0.0.1:5011`);
    return null;
  }
  let granted = false;
  try {
    granted = await ensureHostPermission(url, DUB_BUILTIN_HOSTS);
  } catch (err) {
    console.error(err);
  }
  if (!granted) {
    setStatus("dub-status", "error", `${prefix}Нет разрешения на доступ к ${url.origin}`);
    return null;
  }
  return url;
}

async function checkSilero(baseUrl) {
  setStatus("dub-status", "checking", "Проверяю Silero…");
  $("dubCheck").disabled = true;
  try {
    const [health, voices] = await Promise.all([getHealth(baseUrl), getVoices(baseUrl)]);
    server = voices;
    renderVoices($("dubVoice").value);
    const summary = `Silero ${health.model} · голосов: ${voices.voices.length}`;
    if (voices.rates.length) setStatus("dub-status", "ok", summary);
    else setStatus("dub-status", "warn", `${summary} · старая версия server.py: темп речи не меняется`);
  } catch (err) {
    console.error(err);
    server = null;
    renderVoices($("dubVoice").value);
    setStatus("dub-status", "error", errorText(err));
  } finally {
    $("dubCheck").disabled = false;
  }
}

function stopPlayer() {
  if (!player) return;
  player.audio.pause();
  URL.revokeObjectURL(player.url);
  player = null;
}

async function play(wav) {
  stopPlayer();
  const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
  const audio = new Audio(url);
  player = { audio, url };
  audio.addEventListener("ended", () => player?.audio === audio && stopPlayer());
  await audio.play();
}

async function listen(baseUrl) {
  const voice = $("dubVoice").value;
  stopPlayer();
  setStatus("dub-listen-status", "checking", "Синтезирую фразу…");
  $("dubListen").disabled = true;
  try {
    const startedAt = performance.now();
    const wav = await synthesize(baseUrl, { text: SAMPLE_TEXT, voice });
    const took = (performance.now() - startedAt) / 1000;
    if (!wav) throw new Error("Silero не озвучил фразу: пустой ответ");
    const duration = wavDuration(wav);
    await play(wav);
    const name = voice || server?.defaultVoice || "по умолчанию";
    setStatus(
      "dub-listen-status",
      "ok",
      `Голос ${name}: ${number(duration, 1)} с речи, синтез за ${number(took, 2)} с`,
    );
  } catch (err) {
    console.error(err);
    setStatus("dub-listen-status", "error", errorText(err));
  } finally {
    $("dubListen").disabled = false;
  }
}

// ---------- События ----------

$("dubCheck").addEventListener("click", async () => {
  const url = await prepareUrl();
  if (url) await checkSilero(normalizeUrl(url.href));
});

$("dubListen").addEventListener("click", async () => {
  const url = await prepareUrl();
  if (url) await listen(normalizeUrl(url.href));
});

// Ту же форму сохраняет options.js — свои поля, а этот обработчик — поля озвучки.
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = await prepareUrl("Озвучка не сохранена. ");
  if (!url) return;
  const patch = Object.fromEntries(
    Object.entries(readForm()).filter(([key, value]) => value !== settings[key]),
  );
  try {
    await setDubSettings(patch);
    settings = await getDubSettings();
  } catch (err) {
    console.error(err);
    setStatus("dub-status", "error", `Озвучка не сохранена: ${err.message}`);
    return;
  }
  fill(settings); // показываем значения после проверки
  if ("dubTtsUrl" in patch) await checkSilero(settings.dubTtsUrl);
});

// storage стирает options.js, здесь только показываем умолчания
$("reset").addEventListener("click", async () => {
  settings = { ...DUB_DEFAULTS };
  fill(settings);
  stopPlayer();
  setStatus("dub-listen-status", "", "");
  await checkSilero(settings.dubTtsUrl);
});

// ---------- Старт ----------

let platform;
[settings, platform] = await Promise.all([getDubSettings(), chrome.runtime.getPlatformInfo()]);
os = platform.os;
fill(settings);
await checkSilero(settings.dubTtsUrl);

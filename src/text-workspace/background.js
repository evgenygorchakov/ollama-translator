// Независимый модуль. Скрипты регистрируются только после включения в настройках.
// Один порт — один запрос, история живёт в панели и не попадает в storage.
import { CONFIG, getWorkspaceSettings } from "./lib/settings.js";
import { buildRequest, readQuestion } from "./lib/prompt.js";
import { getSettings } from "../lib/settings.js";
import { ErrorCode, OllamaError, abortedError } from "../lib/ollama.js";
import { stripThinking } from "../lib/parse.js";
import { chatWithRetry, toOllamaError } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { onStop, registerQueue } from "../lib/stop.js";
import { onContextReset } from "../lib/context-reset.js";
import { keepAwake } from "../lib/keepalive.js";
import { getWebSettings } from "../lib/web-settings.js";
import { checkWebAccess, webChat } from "../lib/web.js";

const SCRIPT_ID = "ot-text-workspace";
const SCRIPTS = [
  "src/shared/keepalive-port.js",
  "src/shared/theme.js",
  "src/shared/shadow-host.js",
  "src/shared/clipboard.js",
  "src/shared/context-usage.js",
  "src/text-workspace/config.js",
  "src/text-workspace/style.js",
  "src/text-workspace/content.js",
];
const jobs = new Map();
const visibleAnswer = (text) => stripThinking(text).replace(/<think>[\s\S]*$/i, "").trim();

function stopJobs() {
  for (const job of jobs.values()) {
    job.controller.abort();
    job.queued = false;
    safePost(job.port, { type: "stopped" });
  }
}
onStop(stopJobs);
onContextReset(stopJobs);
registerQueue(() => [...jobs.values()].filter((job) => job.queued).length);

async function answer(job, msg) {
  const input = readQuestion(msg);
  const workspace = await getWorkspaceSettings();
  if (!workspace[CONFIG.enabledKey]) throw new Error("Text workspace is disabled in Settings.");
  const settings = await getSettings();
  const { summaryWebEnabled: web, summarySearxngUrl: searxngUrl } = await getWebSettings();
  const signal = job.controller.signal;
  if (signal.aborted) throw abortedError();
  job.queued = true;
  const slot = {
    signal,
    model: settings.model,
    ollamaUrl: settings.ollamaUrl,
  };
  let numCtx;
  let webShortened = false;
  const build = (ctx) => {
    const { body, omitted, historyTokens, historyBudget } = buildRequest({
      ...input, lang: settings.targetLang, web,
    }, { ...ctx, numCtx: numCtx ?? ctx.numCtx });
    safePost(job.port, {
      type: "context", context: { total: ctx.numCtx, usage: null },
      omitted, historyTokens, historyBudget, model: ctx.model,
    });
    return body;
  };
  const ask = (request, callbacks) => withPrioritySlot(slot, async (ctx) => {
    job.queued = false;
    try {
      if (numCtx && (!ctx.numCtx || ctx.numCtx < numCtx)) {
        throw new OllamaError(ErrorCode.BAD_RESPONSE,
          "Ollama's context length changed during web search. Send the question again to resize the text and history.");
      }
      return await chatWithRetry(request(ctx), ctx, callbacks);
    } finally {
      job.queued = !signal.aborted;
    }
  });
  let lastSent = 0;
  const onContent = (content) => {
    if (signal.aborted || Date.now() - lastSent < 100) return;
    lastSent = Date.now();
    safePost(job.port, { type: "partial", text: visibleAnswer(content) });
  };
  let result;
  if (web) {
    const prepared = await withPrioritySlot(slot, async (ctx) => {
      await checkWebAccess({ searxngUrl, numCtx: ctx.numCtx, ...slot });
      const { webBudget } = buildRequest({ ...input, lang: settings.targetLang, web }, ctx);
      return { numCtx: ctx.numCtx, webBudget };
    });
    numCtx = prepared.numCtx;
    // HTTP-поиск не занимает слот модели, но service worker должен дождаться его ответа.
    const letSleep = keepAwake();
    try {
      result = await webChat({
        build, ask, searxngUrl, numCtx, signal, onContent,
        messageBudget: prepared.webBudget,
        onProgress(progress) {
          lastSent = 0;
          if (!signal.aborted) safePost(job.port, { type: "progress", ...progress });
        },
        onTrim() { webShortened = true; },
      });
    } finally {
      letSleep();
    }
  } else {
    result = await ask(build, { onContent });
  }
  if (signal.aborted) throw abortedError();
  const text = visibleAnswer(result.content);
  if (!text) throw new Error("The model returned an empty answer. Try again.");
  return {
    text, context: result.context, cut: result.doneReason === "length",
    sources: result.sources ?? [], webLimited: result.webLimited ?? false, webShortened,
  };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONFIG.port) return;
  const job = { port, controller: new AbortController(), started: false, queued: false };
  jobs.set(port, job);
  onPortClosed(port, () => {
    jobs.delete(port);
    job.controller.abort();
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "ask" || job.started || job.controller.signal.aborted) return;
    job.started = true;
    answer(job, msg).then(
      (result) => {
        if (!job.controller.signal.aborted) safePost(port, { type: "result", ...result });
      },
      (error) => {
        if (job.controller.signal.aborted) return;
        const err = toOllamaError(error);
        if (err.code !== ErrorCode.ABORTED) {
          safePost(port, { type: "error", code: err.code, message: err.message });
        }
      },
    ).finally(() => { job.queued = false; });
  });
});

// Сериализация не даёт быстрому переключению оставить скрипты включёнными после выключения.
let syncTask = Promise.resolve();
function scheduleSync() {
  syncTask = syncTask.catch(() => {}).then(syncScripts);
  return syncTask;
}
const syncInBackground = () => {
  scheduleSync().catch((err) => console.warn("[ot] text workspace:", err.message));
};

async function syncScripts() {
  const settings = await getWorkspaceSettings();
  let enabled = settings[CONFIG.enabledKey];
  if (enabled && !(await chrome.permissions.contains({ origins: CONFIG.origins }))) {
    enabled = false;
    await chrome.storage.local.set({ [CONFIG.enabledKey]: false });
  }
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!enabled) {
    stopJobs();
    if (!registered.length) return;
  }
  if (enabled && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      matches: CONFIG.origins,
      js: SCRIPTS,
      allFrames: true,
      runAt: "document_idle",
      persistAcrossSessions: false,
    }]);
  } else if (!enabled && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
  // Применяем и к уже открытым вкладкам. Закрытые/служебные страницы пропускаем.
  const tabs = await chrome.tabs.query({ url: CONFIG.origins });
  await Promise.allSettled(tabs.map((tab) => chrome.scripting.executeScript(enabled ? {
    target: { tabId: tab.id, allFrames: true }, files: SCRIPTS,
  } : {
    target: { tabId: tab.id, allFrames: true },
    func: () => window.__ollamaTranslator?.textWorkspace?.dispose(),
  })));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && CONFIG.enabledKey in changes) syncInBackground();
});
chrome.permissions.onAdded.addListener(syncInBackground);
chrome.permissions.onRemoved.addListener(syncInBackground);
chrome.runtime.onInstalled.addListener(syncInBackground);
chrome.runtime.onStartup.addListener(syncInBackground);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "textWorkspaceSync" || sender.tab) return;
  scheduleSync().then(
    () => sendResponse({}),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});
syncInBackground();

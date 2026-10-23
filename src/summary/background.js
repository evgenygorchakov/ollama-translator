// Краткое содержание страницы, часть service worker: кнопка в popup (сообщение summarizeTab),
// пункт контекстного меню на странице, внедрение панели (panel.js) и порт "summary", по которому
// она просит краткое содержание. От перевода страницы, выделенного и озвучки не зависит.
//
// Один порт — один запрос. Панель → сюда: summarize { text, title, length }; ping.
// Отсюда → панели: source { used, total } — сколько символов текста ушло модели; partial { text }
// — ответ по мере генерации; result { text, cut } — готово, cut — ответ упёрся в num_ctx;
// error { code, message }; stopped — «Стоп».
// Панель закрыли или сменили длину — порт отключился — запрос к Ollama отменён.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { getSettings } from "../lib/settings.js";
import { chatWithRetry, toOllamaError } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { ensureMenu } from "../lib/menus.js";
import { onStop } from "../lib/stop.js";
import { SUMMARY_LENGTHS, buildSummaryRequest } from "./lib/prompt.js";
import { cutText, inputChars } from "./lib/chunks.js";

const PORT_NAME = "summary";
const PAGE_MENU_ID = "summarize-page";
const PANEL_SCRIPTS = [
  "src/shared/keepalive-port.js",
  "src/shared/shadow-host.js",
  "src/shared/clipboard.js",
  "src/summary/lib/format.js",
  "src/summary/extract.js",
  "src/summary/panel.js",
];
// partial — не на каждый токен, а не чаще раза в столько
const PARTIAL_MS = 150;

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu({
    id: PAGE_MENU_ID,
    title: "Краткое содержание страницы",
    contexts: ["page"],
  });
});

// Панель — в главном фрейме. panel.js внедряем, только если его там ещё нет или остался
// осиротевший экземпляр после перезагрузки расширения.
async function openPanel(tabId) {
  const target = { tabId };
  const tryOpen = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: () => {
        const panel = window.__ollamaTranslator?.summary;
        if (!panel?.alive?.()) return false;
        panel.open();
        return true;
      },
    });
    return injection?.result === true;
  };
  if (await tryOpen()) return;
  await chrome.scripting.executeScript({ target, files: PANEL_SCRIPTS });
  if (!(await tryOpen())) throw new Error("панель не запустилась");
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== PAGE_MENU_ID || !tab?.id) return;
  // chrome://, Chrome Web Store, встроенный просмотрщик PDF — туда скрипты не внедрить
  openPanel(tab.id).catch((err) => console.warn("[ot] не удалось показать краткое содержание:", err.message));
});

// открывать панель — только страницам расширения (popup), не content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "summarizeTab" || sender.tab) return;
  openPanel(msg.tabId).then(
    () => sendResponse({}),
    (err) => sendResponse({ error: err.message }),
  );
  return true;
});

// partial не чаще раза в PARTIAL_MS. push(content) — накопленный ответ, cancel() — больше не слать.
function partialSender(port) {
  let timer = 0;
  let latest = "";
  return {
    push(content) {
      latest = content;
      timer ||= setTimeout(() => {
        timer = 0;
        safePost(port, { type: "partial", text: latest });
      }, PARTIAL_MS);
    },
    cancel() {
      clearTimeout(timer);
      timer = 0;
    },
  };
}

// → { text, cut }
function summarize({ text, title, length }, signal, port) {
  // общий с переводом лимит запросов; встаём перед очередью перевода страниц
  return withPrioritySlot({ signal }, async (ctx) => {
    const { targetLang } = await getSettings();
    const used = cutText(text, inputChars(ctx.numCtx));
    safePost(port, { type: "source", used: used.length, total: text.length });
    const partial = partialSender(port);
    const body = buildSummaryRequest({ text: used, title, length, lang: targetLang }, ctx);
    try {
      const { content, doneReason } = await chatWithRetry(body, ctx, { onContent: partial.push });
      if (!content.trim()) throw new OllamaError(ErrorCode.BAD_RESPONSE, "модель вернула пустой ответ");
      return { text: content.trim(), cut: doneReason === "length" };
    } finally {
      partial.cancel();
    }
  });
}

// Открытые порты панелей: port → AbortController его запроса.
const sessions = new Map();

// «Стоп»: панель покажет «Остановлено» и «Повторить»; ошибку ABORTED она не получит.
onStop(() => {
  for (const [port, controller] of sessions) {
    safePost(port, { type: "stopped" });
    controller.abort();
  }
});

// Пока порт открыт, панель шлёт ping, чтобы service worker не уснул на долгом ответе.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controller = new AbortController();
  sessions.set(port, controller);
  onPortClosed(port, () => {
    sessions.delete(port);
    controller.abort();
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "summarize" || typeof msg.text !== "string") return;
    const request = {
      text: msg.text,
      title: typeof msg.title === "string" ? msg.title : "",
      length: SUMMARY_LENGTHS.includes(msg.length) ? msg.length : SUMMARY_LENGTHS[0],
    };
    summarize(request, controller.signal, port).then(
      (result) => safePost(port, { type: "result", ...result }),
      (e) => {
        const err = toOllamaError(e);
        if (err.code !== ErrorCode.ABORTED) {
          safePost(port, { type: "error", code: err.code, message: err.message });
        }
      },
    );
  });
});

// Перевод выделенного, часть service worker: пункт контекстного меню на выделении, внедрение
// всплывашки (bubble.js) и порт "translate-selection", по которому она просит перевод.
// От перевода страницы не зависит.

import { ErrorCode, OllamaError } from "../lib/ollama.js";
import { toOllamaError, translateOne } from "../lib/translate.js";
import { withPrioritySlot } from "../lib/priority.js";
import { onPortClosed, safePost } from "../lib/port.js";
import { ensureMenu } from "../lib/menus.js";
import { onStop } from "../lib/stop.js";

const MENU_ID = "translate-selection";
const PORT_NAME = "translate-selection";
const BUBBLE_SCRIPTS = ["src/shared/keepalive-port.js", "src/selection/bubble.js"];
// Длиннее модель переводит минутами, а в num_ctx может и не влезть. Лимит передаём всплывашке:
// она проверяет его до запроса и объясняет пользователю; здесь — на всякий случай.
const MAX_CHARS = 5000;

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu({
    id: MENU_ID,
    title: "Перевести выделенное",
    contexts: ["selection"],
  });
});

// Внедряем всплывашку в тот фрейм, где выделение. Во фрейм с другого сайта activeTab доступа
// не даёт — тогда показываем её в главном фрейме, с текстом из меню, без привязки к выделению.
// menuText — выделение, как его видит Chrome (без переносов строк); всплывашка возьмёт текст
// со страницы, если выделение в её фрейме, иначе этот.
// bubble.js внедряем, только если во фрейме его ещё нет или остался осиротевший экземпляр
// после перезагрузки расширения.
async function openBubble(tabId, frameId, menuText, inSelectionFrame) {
  const target = { tabId, frameIds: [frameId] };
  const tryOpen = async () => {
    const [injection] = await chrome.scripting.executeScript({
      target,
      func: (text, anchored, maxChars) => {
        const bubble = window.__ollamaTranslator?.selection;
        if (!bubble?.alive?.()) return false;
        bubble.open(text, anchored, maxChars);
        return true;
      },
      args: [menuText, inSelectionFrame, MAX_CHARS],
    });
    return injection?.result === true;
  };
  if (await tryOpen()) return;
  await chrome.scripting.executeScript({ target, files: BUBBLE_SCRIPTS });
  if (!(await tryOpen())) throw new Error("всплывашка не запустилась");
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  const frameId = info.frameId ?? 0;
  const text = info.selectionText ?? "";
  try {
    try {
      await openBubble(tab.id, frameId, text, true);
    } catch (err) {
      if (frameId === 0) throw err;
      await openBubble(tab.id, 0, text, false);
    }
  } catch (err) {
    // chrome://, Chrome Web Store, встроенный просмотрщик PDF — туда скрипты не внедрить
    console.warn("[ot] не удалось показать перевод выделенного:", err.message);
  }
});

async function translate(text, signal) {
  if (text.length > MAX_CHARS) {
    throw new OllamaError(ErrorCode.TEXT_TOO_LONG, `Текст длиннее ${MAX_CHARS} символов`);
  }
  // общий с переводом страницы лимит запросов; встаём перед её очередью
  const r = await withPrioritySlot({ signal }, (ctx) =>
    translateOne(text, ctx, { acceptUnchanged: true }),
  );
  if (r.error) throw new OllamaError(r.error.code, r.error.message);
  return r.text;
}

// Открытые порты всплывашек: port → AbortController его перевода.
const sessions = new Map();

// «Стоп»: всплывашка покажет «Перевод остановлен» и «Повторить»; ошибку ABORTED она не получит.
onStop(() => {
  for (const [port, controller] of sessions) {
    safePost(port, { type: "stopped" });
    controller.abort();
  }
});

// Один порт — один перевод. Всплывашку закрыли — порт отключился — запрос к Ollama отменён.
// Пока порт открыт, всплывашка шлёт ping, чтобы service worker не уснул на долгом ответе.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  const controller = new AbortController();
  sessions.set(port, controller);
  onPortClosed(port, () => {
    sessions.delete(port);
    controller.abort();
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type !== "translate" || typeof msg.text !== "string") return;
    translate(msg.text, controller.signal).then(
      (text) => safePost(port, { type: "result", text }),
      (e) => {
        const err = toOllamaError(e);
        if (err.code !== ErrorCode.ABORTED) {
          safePost(port, { type: "error", code: err.code, message: err.message });
        }
      },
    );
  });
});

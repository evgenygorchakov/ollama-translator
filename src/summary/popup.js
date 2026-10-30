// Кнопки «Краткое содержание», «В чём суть» и «Спросить» в popup. popup.js о них не знает: кнопки
// активны, как и «Перевести страницу», когда статус Ollama в порядке (его data-kind ставит
// popup.js), а панель на странице открывает summary/background.js. Ошибки — в своей заметке под
// кнопками.

const $ = (id) => document.getElementById(id);
// кнопка → режим панели: "" — последняя длина краткого содержания, "essence" — суть, "ask" —
// только вопросы
const buttons = new Map([
  [$("summary"), ""],
  [$("essence"), "essence"],
  [$("ask"), "ask"],
]);
const note = $("summary-note");
const status = $("status");

let opening = false;

function sync() {
  for (const button of buttons.keys()) {
    button.disabled = opening || status.dataset.kind !== "ok";
  }
}

new MutationObserver(sync).observe(status, { attributes: true, attributeFilter: ["data-kind"] });
sync();

async function open(mode) {
  opening = true;
  sync();
  note.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({ type: "summarizeTab", tabId: tab.id, mode });
    if (res?.error) throw new Error(res.error);
    window.close(); // ответ — в панели на странице
  } catch (err) {
    console.error(err);
    note.textContent = `Couldn't open the panel: ${err.message}`;
    note.hidden = false;
  } finally {
    opening = false;
    sync();
  }
}

for (const [button, mode] of buttons) {
  button.addEventListener("click", () => open(mode));
}

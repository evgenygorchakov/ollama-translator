// Кнопка «Краткое содержание» в popup. popup.js о ней не знает: кнопка активна, как и
// «Перевести страницу», когда статус Ollama в порядке (его data-kind ставит popup.js), а панель
// на странице открывает summary/background.js. Ошибки — в своей заметке под кнопкой.

const $ = (id) => document.getElementById(id);
const button = $("summary");
const note = $("summary-note");
const status = $("status");

let opening = false;

function sync() {
  button.disabled = opening || status.dataset.kind !== "ok";
}

new MutationObserver(sync).observe(status, { attributes: true, attributeFilter: ["data-kind"] });
sync();

button.addEventListener("click", async () => {
  opening = true;
  sync();
  note.hidden = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.runtime.sendMessage({ type: "summarizeTab", tabId: tab.id });
    if (res?.error) throw new Error(res.error);
    window.close(); // краткое содержание — в панели на странице
  } catch (err) {
    console.error(err);
    note.textContent = `Не удалось открыть краткое содержание: ${err.message}`;
    note.hidden = false;
  } finally {
    opening = false;
    sync();
  }
});

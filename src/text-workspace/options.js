// Единственная точка подключения настроек — script в options.html.
import { CONFIG, getWorkspaceSettings } from "./lib/settings.js";

const section = document.createElement("section");
section.id = "text-workspace-settings";
const heading = document.createElement("h2");
heading.textContent = "Text workspace · Experimental";
const description = document.createElement("p");
description.className = "help";
description.textContent = "Select text on a page, then hover over Ask to open a conversation about it. Each selection has its own temporary history, separate from translation and page questions.";

function checkbox(id, text) {
  const label = document.createElement("label");
  label.className = "field";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  label.append(input, ` ${text}`);
  return { input, label };
}
const enabled = checkbox(CONFIG.enabledKey, "Enable Text workspace");
const cursor = checkbox(CONFIG.cursorKey, "Use a Figma-style violet cursor");
const help = document.createElement("small");
help.className = "help";
help.textContent = "Applies immediately. Enabling asks for access to websites so the selection button can appear automatically. Uses the selected Ollama model and response language. No request is sent until you ask a question.";
const status = document.createElement("p");
status.className = "status";
status.setAttribute("role", "status");
section.append(heading, description, enabled.label, cursor.label, help, status);
document.querySelector("#form > section").after(section);

let saving = false;
let revision = 0;
async function fill() {
  const version = ++revision;
  const settings = await getWorkspaceSettings();
  if (version !== revision || saving) return;
  enabled.input.checked = settings[CONFIG.enabledKey];
  cursor.input.checked = settings[CONFIG.cursorKey];
  cursor.input.disabled = !enabled.input.checked;
}

enabled.input.addEventListener("change", async () => {
  const value = enabled.input.checked;
  saving = true;
  enabled.input.disabled = true;
  status.textContent = "Applying…";
  status.dataset.kind = "checking";
  try {
    // До первого await: запрос прав должен оставаться в действии пользователя.
    if (value && !(await chrome.permissions.request({ origins: CONFIG.origins }))) {
      throw new Error("Allow website access to enable Text workspace.");
    }
    await chrome.storage.local.set({ [CONFIG.enabledKey]: value });
    const result = await chrome.runtime.sendMessage({ type: "textWorkspaceSync" });
    if (result?.error) throw new Error(result.error);
    status.textContent = value ? "Text workspace is on. Select text on a web page to begin." : "Text workspace is off.";
    status.dataset.kind = "ok";
  } catch (err) {
    await chrome.storage.local.set({ [CONFIG.enabledKey]: false });
    status.textContent = err.message || "Could not enable Text workspace.";
    status.dataset.kind = "error";
  } finally {
    saving = false;
    enabled.input.disabled = false;
    await fill();
  }
});

cursor.input.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ [CONFIG.cursorKey]: cursor.input.checked });
    status.textContent = "Cursor preference saved.";
    status.dataset.kind = "ok";
  } catch {
    status.textContent = "Could not save the cursor preference.";
    status.dataset.kind = "error";
    await fill();
  }
});

// Эти поля сохраняются отдельно; общий обработчик формы не должен писать «Unsaved changes».
section.addEventListener("input", (event) => event.stopPropagation());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(CONFIG.enabledKey in changes || CONFIG.cursorKey in changes)) return;
  if (!saving) {
    status.textContent = "";
    void fill();
  }
});
await fill();

import "../config.js";

export const CONFIG = globalThis.__ollamaTranslator.textWorkspaceConfig;
export const DEFAULTS = Object.freeze({
  [CONFIG.enabledKey]: false,
  [CONFIG.cursorKey]: true,
});

export async function getWorkspaceSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    [CONFIG.enabledKey]: stored[CONFIG.enabledKey] === true,
    [CONFIG.cursorKey]: stored[CONFIG.cursorKey] !== false,
  };
}

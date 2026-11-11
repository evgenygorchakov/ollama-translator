import "../config.js";

export const CONFIG = globalThis.__ollamaTranslator.textWorkspaceConfig;
export const DEFAULTS = Object.freeze({
  [CONFIG.enabledKey]: false,
  [CONFIG.cursorKey]: true,
  [CONFIG.colorKey]: CONFIG.defaultColor,
});

export async function getWorkspaceSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    [CONFIG.enabledKey]: stored[CONFIG.enabledKey] === true,
    [CONFIG.cursorKey]: stored[CONFIG.cursorKey] !== false,
    [CONFIG.colorKey]: CONFIG.color(stored[CONFIG.colorKey]).id,
  };
}

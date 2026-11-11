// Общие константы background (импорт) и content scripts (обычный скрипт).
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  ns.textWorkspaceConfig = Object.freeze({
    port: "text-workspace",
    enabledKey: "textWorkspaceEnabled",
    cursorKey: "textWorkspaceCursor",
    maxText: 12_000,
    maxQuestion: 2_000,
    maxTurns: 24,
    maxHistoryChars: 64_000,
    origins: ["http://*/*", "https://*/*"],
  });
})();

// Общие константы background (импорт) и content scripts (обычный скрипт).
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  // Яркая заливка — для курсора и кнопок с тёмным текстом; ink — для акцентов на светлом фоне.
  const { colors, color } = ns.uiTheme;
  ns.textWorkspaceConfig = Object.freeze({
    port: "text-workspace",
    enabledKey: "textWorkspaceEnabled",
    cursorKey: "textWorkspaceCursor",
    colorKey: "textWorkspaceColor",
    defaultColor: colors[0].id,
    colors,
    color,
    maxText: 12_000,
    maxQuestion: 2_000,
    maxTurns: 24,
    maxHistoryChars: 64_000,
    origins: ["http://*/*", "https://*/*"],
  });
})();

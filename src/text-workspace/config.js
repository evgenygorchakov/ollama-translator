// Общие константы background (импорт) и content scripts (обычный скрипт).
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  // Яркая заливка — для курсора и кнопок с тёмным текстом; ink — для акцентов на светлом фоне.
  const colors = Object.freeze([
    { id: "orange", label: "Orange", fill: "#f76b4f", ink: "#a8321b" },
    { id: "amber", label: "Amber", fill: "#e8ac26", ink: "#805500" },
    { id: "green", label: "Green", fill: "#51b879", ink: "#216d3f" },
    { id: "teal", label: "Teal", fill: "#38b8ae", ink: "#176b65" },
    { id: "blue", label: "Blue", fill: "#71a5f8", ink: "#2458a8" },
    { id: "violet", label: "Violet", fill: "#b08af0", ink: "#6734a6" },
    { id: "rose", label: "Rose", fill: "#ed85ae", ink: "#9b2856" },
  ].map(Object.freeze));
  ns.textWorkspaceConfig = Object.freeze({
    port: "text-workspace",
    enabledKey: "textWorkspaceEnabled",
    cursorKey: "textWorkspaceCursor",
    colorKey: "textWorkspaceColor",
    defaultColor: colors[0].id,
    colors,
    color: (value) => colors.find(({ id }) => id === value) ?? colors[0],
    maxText: 12_000,
    maxQuestion: 2_000,
    maxTurns: 24,
    maxHistoryChars: 64_000,
    origins: ["http://*/*", "https://*/*"],
  });
})();

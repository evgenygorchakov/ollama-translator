// Общая тема extension pages и закрытых shadow roots. Без зависимостей от отдельных функций.
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  if (ns.uiTheme) return;

  const colors = Object.freeze([
    { id: "orange", label: "Orange", fill: "#f76b4f", ink: "#a8321b" },
    { id: "amber", label: "Amber", fill: "#e8ac26", ink: "#805500" },
    { id: "green", label: "Green", fill: "#51b879", ink: "#216d3f" },
    { id: "teal", label: "Teal", fill: "#38b8ae", ink: "#176b65" },
    { id: "blue", label: "Blue", fill: "#71a5f8", ink: "#2458a8" },
    { id: "violet", label: "Violet", fill: "#b08af0", ink: "#6734a6" },
    { id: "rose", label: "Rose", fill: "#ed85ae", ink: "#9b2856" },
  ].map(Object.freeze));
  const color = (value) => colors.find(({ id }) => id === value) ?? colors[0];
  const defaults = { textWorkspaceColor: colors[0].id, textWorkspaceEnabled: false, textWorkspaceCursor: true };
  const BASE = `
    :root, :host {
      --bg: #fff; --fg: #27272a; --muted: #54545b; --line: #dedee3;
      --surface: #f4f4f6; --accent: var(--accent-ink); --error: #c12f4b;
      --ok: #216d3f; --warn: #805500; --hint-bg: #fff6e3;
      --tint: color-mix(in srgb, var(--accent-fill) 12%, var(--bg));
      --button-fg: #231f20;
      --button-hover: color-mix(in srgb, var(--accent-fill) 88%, white);
      --border: var(--line); --btn-hover: var(--surface);
      --panel-shadow: 0 16px 48px #00000029, 0 2px 8px #00000014;
      --ui-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      :root, :host {
        --bg: #232326; --fg: #f7f7fa; --muted: #c4c4cc; --line: #444449;
        --surface: #2f2f33; --error: #ff94a5; --ok: #8bdaa8; --warn: #e8c276;
        --hint-bg: #363022;
        --accent: color-mix(in srgb, var(--accent-fill) 85%, white);
        --tint: color-mix(in srgb, var(--accent-fill) 16%, var(--bg));
        color-scheme: dark;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    input, meter { accent-color: var(--accent); }
    meter::-webkit-meter-bar { border: 0; border-radius: 3px; background: var(--line); }
    meter::-webkit-meter-optimum-value { background: var(--accent); }
    meter::-moz-meter-bar { background: var(--accent); }
    a { color: var(--accent); text-underline-offset: 3px; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
    @media (forced-colors: active) {
      button, input, select, textarea { border: 1px solid ButtonText; }
    }
  `;

  function cursor(fill) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <defs><filter id="shadow" x="0" y="0" width="32" height="32" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="1.5" stdDeviation="1.4" flood-color="#000" flood-opacity=".3"/>
      </filter></defs>
      <path d="M6 4.7 26.3 12.3Q28.4 13.1 26.3 13.9L18.6 16.7Q17.2 17.2 16.7 18.6L13.9 26.3Q13.1 28.4 12.3 26.3L4.7 6Q3.9 3.9 6 4.7Z"
        fill="${fill}" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" filter="url(#shadow)"/>
    </svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 5 5, auto`;
  }

  let sheet = null;
  let settings = { ...defaults };
  function render() {
    const selected = color(settings.textWorkspaceColor);
    // Временно один кастомный курсор для всех состояний, включая ссылки и ввод текста.
    const cursorStyle = settings.textWorkspaceEnabled === true && settings.textWorkspaceCursor !== false
      ? `@media (pointer: fine) { :root, :host, *, *::before, *::after { cursor: ${cursor(selected.fill)} !important; } }`
      : "";
    sheet.replaceSync(`${BASE}
      :root, :host { --accent-fill: ${selected.fill}; --accent-ink: ${selected.ink}; }
      ${cursorStyle}`);
  }

  function attach(root) {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      render();
      // Изменения во время первого чтения не должны потеряться вместе с остальными настройками.
      let initialChanges = {};
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !Object.keys(defaults).some((key) => key in changes)) return;
        for (const key of Object.keys(defaults)) {
          if (!(key in changes)) continue;
          settings[key] = changes[key].newValue ?? defaults[key];
          if (initialChanges) initialChanges[key] = settings[key];
        }
        render();
      });
      chrome.storage.local.get(defaults).then((stored) => {
        settings = { ...stored, ...initialChanges };
        initialChanges = null;
        render();
      }).catch(() => { /* После перезагрузки расширения остаётся тема по умолчанию. */ });
    }
    if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }

  ns.uiTheme = Object.freeze({ colors, color, cursor, attach });
})();

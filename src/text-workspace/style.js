(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  ns.textWorkspaceStyle = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .workspace {
      color: var(--fg); text-align: left;
      font: 13px/1.5 var(--ui-font);
      letter-spacing: normal; text-transform: none; direction: ltr;
    }
    button, textarea { font: inherit; }
    button {
      border: 0; margin: 0; cursor: pointer; color: inherit; background: none;
      border-radius: 6px; padding: 5px 8px; line-height: 1.4;
      transition: background 120ms, transform 120ms;
    }
    button:hover { background: var(--surface); }
    button:active { transform: scale(.96); }
    button:focus-visible, textarea:focus-visible, a:focus-visible {
      outline: 2px solid var(--accent); outline-offset: 3px;
    }
    button:disabled { opacity: .45; cursor: default; }
    .trigger {
      display: flex; align-items: center; gap: 7px; white-space: nowrap;
      padding: 8px 12px; border: 1px solid #ffffff40; border-radius: 9px;
      color: var(--button-fg); background: var(--accent-fill); font-weight: 600;
      box-shadow: 0 4px 14px color-mix(in srgb, var(--accent-fill) 25%, transparent), 0 1px 3px #0002;
      animation: appear 180ms cubic-bezier(.2,.8,.2,1) both;
    }
    .trigger:hover { background: var(--button-hover); }
    .spark { font-size: 18px; line-height: 1; }
    .panel {
      width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px);
      max-height: calc(100dvh - 24px); overflow: auto;
      background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: var(--panel-shadow);
      animation: appear 180ms cubic-bezier(.2,.8,.2,1) both;
    }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .mark { display: grid; place-items: center; width: 25px; height: 25px; border-radius: 7px; background: var(--tint); color: var(--accent); }
    .title { flex: 1; font-weight: 600; font-size: 12px; }
    .head button { color: var(--muted); font-size: 11px; }
    .head .close { font-size: 20px; line-height: 1; width: 28px; height: 28px; padding: 0; }
    .source { margin: 12px; padding: 9px 11px; background: var(--surface); border-left: 2px solid var(--accent); border-radius: 0 6px 6px 0; }
    .eyebrow { margin-bottom: 4px; color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase; }
    .quote {
      display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
      overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 12px;
    }
    .suggestions { display: flex; gap: 5px; flex-wrap: wrap; padding: 0 12px 12px; }
    .suggestions button { border: 1px solid var(--line); border-radius: 6px; font-size: 11px; }
    .thread { max-height: min(34vh, 280px); overflow: auto; overscroll-behavior: contain; padding: 0 12px; }
    .turn { padding: 2px 0 12px; }
    .question { margin: 0 0 10px 24px; padding: 8px 10px; border-radius: 9px 9px 3px 9px; background: var(--tint); white-space: pre-wrap; overflow-wrap: anywhere; }
    .answer { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .answer:empty::before { content: "Preparing an answer…"; color: var(--muted); }
    .turn[data-pending] .answer:empty::before { animation: pulse 1.4s ease-in-out infinite; }
    .answer-tools { display: flex; align-items: center; gap: 8px; margin-top: 5px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
    .answer-tools button { font-size: 11px; padding: 3px 5px; }
    .sources, .answer-notes { margin-top: 8px; font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
    .sources a { display: block; margin-top: 4px; color: var(--accent); }
    .answer-notes:empty { display: none; }
    .web-status { margin-bottom: 5px; color: var(--muted); font-size: 10px; }
    .notice { padding: 0 12px 10px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .notice:empty { display: none; }
    .notice[data-error] { color: var(--error); }
    .composer { margin: 0 12px 10px; padding: 8px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); transition: border-color 120ms, box-shadow 120ms; }
    .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--tint); }
    textarea {
      display: block; width: 100%; min-height: 46px; max-height: 120px; padding: 2px;
      resize: vertical; color: var(--fg); background: transparent; border: 0;
      outline: none !important; line-height: 1.5; cursor: text;
    }
    textarea::placeholder { color: var(--muted); opacity: 1; }
    .compose-tools { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 5px; }
    .hint { color: var(--muted); font-size: 10px; }
    .send { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; background: var(--accent-fill); color: var(--button-fg); padding: 0; font-size: 19px; }
    .send:hover { background: var(--button-hover); }
    .send[data-busy] { font-size: 11px; }
    .foot { border-top: 1px solid var(--line); padding: 8px 12px; color: var(--muted); font-size: 10px; }
    .context { overflow-wrap: anywhere; }
    .meter { height: 3px; margin-top: 6px; overflow: hidden; border-radius: 2px; background: var(--line); }
    .meter-fill { width: 0; height: 100%; background: var(--accent); transition: width 180ms; }
    .warning { margin-top: 5px; color: var(--accent); line-height: 1.5; }
    .warning:empty { display: none; }
    @keyframes appear { from { opacity: 0; transform: translateY(5px) scale(.97); } to { opacity: 1; transform: none; } }
    @keyframes pulse { 50% { opacity: .5; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before { animation: none !important; transition: none !important; }
    }
    @media (forced-colors: active) {
      .trigger, .panel, .composer, .send { border: 1px solid ButtonText; }
    }
  `;
})();

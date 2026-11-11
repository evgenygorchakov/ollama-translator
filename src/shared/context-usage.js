// Общая подпись для popup (импорт скрипта) и внедрённой панели (обычный content script).
(() => {
  const ns = (globalThis.__ollamaTranslator ??= {});
  const number = new Intl.NumberFormat("en-US");
  ns.contextUsage = ({ total, usage } = {}) => {
    const known = Number.isSafeInteger(total) && total > 0;
    const used = Number.isSafeInteger(usage?.used) && usage.used >= 0 ? usage.used : null;
    const limit = known ? number.format(total) : "unknown";
    const ratio = known && used !== null ? Math.min(1, used / total) : null;
    const percent = ratio === null ? "—" : number.format(Math.round(used / total * 1000) / 10);
    const title = [
      "Context length is managed in Ollama.",
      used !== null
        ? `Last completed request: ${number.format(usage.input)} input + ${number.format(usage.output)} generated tokens (including thinking).`
        : "Token usage is available after a request completes.",
      "Includes the prompt and history actually sent. Independent requests are not added together.",
      known && used > total ? "This request processed more tokens than the window can retain." : "",
    ].filter(Boolean).join(" ");
    return {
      text: `Context: ${used === null ? "—" : number.format(used)} / ${limit} tokens · ${percent}%`,
      title,
      ratio,
    };
  };

  // Состояние конкретного диалога хранится в панели, независимо от общего счётчика popup.
  ns.dialogueUsage = (state = {}) => {
    const view = ns.contextUsage(state);
    const { history, omitted, shortened, webShortened, status } = state;
    const warnings = [];
    if (omitted) warnings.push("Older messages were omitted from a request.");
    if (shortened) warnings.push("Earlier answers were shortened to fit a request.");
    if (webShortened) warnings.push("Web results or tool replies were shortened to fit.");
    const historyUsed = history?.nextEstimate ?? history?.usedEstimate;
    const historyFull = history && (history.budgetChars === 0 || historyUsed >= history.budgetEstimate * 0.8);
    if (historyFull) warnings.push("History space is nearly full; older messages may not fit the next request.");
    if (view.ratio >= 0.8) warnings.push("Context is nearly full.");
    if (warnings.length) warnings.push("Use Reset to clear the conversation.");
    let detail = {
      empty: "No requests in this conversation yet.",
      pending: "Preparing / generating · exact usage after the final response.",
      stopped: "Stopped · no completed final response for this attempt.",
      error: "Request failed · retry is available.",
      complete: state.usage ? "Last completed response · includes input, history and generated tokens." : "Ollama did not report token usage.",
    }[status] ?? "";
    if (history) {
      const label = history.nextEstimate !== undefined ? "History for next turn" : "History to send";
      detail += ` ${label}: ≈${number.format(historyUsed)} / ≈${number.format(history.budgetEstimate)} tokens` +
        ` (estimate${history.limitingStage === "search" ? "; page search" : history.web ? "; web search reserved" : ""}).`;
    }
    return {
      ...view,
      detail,
      warning: warnings.join(" "),
      level: omitted || shortened || webShortened || view.ratio >= 0.95 ? "high" : warnings.length ? "near" : "normal",
      title: view.title + " History budget is smaller: page text, prompts, the next question, response space" +
        " and web search reserve part of the window. History estimates use 3 characters per token;" +
        " the tokenizer and the next request can change the actual usage and available space." +
        " Omission and shortening warnings remain until Reset, including changes during page search or failed attempts.",
    };
  };
})();

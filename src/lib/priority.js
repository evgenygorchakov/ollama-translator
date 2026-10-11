// Срочный перевод — тот, что пользователь ждёт прямо сейчас (перевод выделенного): слот берётся
// раньше очереди перевода страниц, а та ему уступает (см. slots.js). Работает в service worker.

import { getSettings } from "./settings.js";
import { acquire, release } from "./slots.js";
import { markModelUsed } from "./stop.js";
import { createContext } from "./translate.js";

// Ждёт слот, создаёт контекст перевода и вызывает fn(ctx); слот отдаёт, когда fn закончит.
// prompts — см. createContext. При отмене signal — OllamaError ABORTED. → результат fn.
export async function withPrioritySlot({ signal, prompts }, fn) {
  let settings = await getSettings();
  const waited = await acquire(settings.concurrency, signal);
  try {
    // слот ждали, может, минутами — за это время в popup могли сменить модель или язык
    if (waited) settings = await getSettings();
    markModelUsed(settings.ollamaUrl, settings.model);
    // /api/show тоже запрос к Ollama — внутри слота
    const ctx = await createContext(settings, signal, prompts);
    return await fn(ctx);
  } finally {
    release();
  }
}

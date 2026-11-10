// Инструмент Ask freely: поиск через заданный пользователем SearXNG, без облачного API Ollama.
import { ErrorCode, OllamaError, abortedError } from "../../lib/ollama.js";
import { cutText, fitExcerpts, inputChars } from "./chunks.js";
import { searchWeb } from "./searxng.js";

const MAX_CALLS = 6;
const MAX_ROUNDS = 3;
const MAX_RESULTS = 3;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current information through SearXNG. Returns search excerpts and source IDs, not full page text. Use focused queries based on the user's question and context; use site:domain to narrow a search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query (up to 500 characters)" } },
        required: ["query"],
      },
    },
  },
];

function failure(message) {
  return new OllamaError(ErrorCode.BAD_RESPONSE, message);
}

export function publicWebUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    // Ссылки — только публичные источники; расширение не загружает страницы результатов.
    if (
      !host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost") ||
      /^(?:127|10|0)\./.test(host) || /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    ) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function argumentsOf(call) {
  try {
    const args = call?.function?.arguments;
    const value = typeof args === "string" ? JSON.parse(args) : args;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

// Метаданные вызовов сохраняем целиком. Текст результатов и рассуждений делит оставшийся
// бюджет: после нескольких раундов старые результаты не вытесняют вопрос и ответ.
function fitMessages(messages, budget) {
  const fixed = JSON.stringify(messages.map(({ content, thinking, ...rest }) => rest)).length;
  if (fixed > budget / 2) {
    throw failure("Web tool arguments filled the context. Try a more focused question or increase num_ctx in Settings.");
  }
  const strings = messages.flatMap((message) => [message.content ?? "", message.thinking ?? ""]);
  const fitted = fitExcerpts(strings, Math.max(0, budget - fixed));
  return messages.map((message, i) => ({
    ...message,
    content: fitted[2 * i],
    ...(message.thinking ? { thinking: fitted[2 * i + 1] } : {}),
  }));
}

// ask(build, callbacks) берёт слот только на запрос модели; HTTP-поиск слот не держит.
export async function webChat({ build, ask, searxngUrl, numCtx, signal, onProgress, onContent, onThinking }) {
  const sources = new Map();
  const messages = [];
  const cache = new Map();
  const budget = Math.floor(inputChars(numCtx) * 0.45);
  let calls = 0;

  function sourceText(url, title, content, limit = budget) {
    if (!sources.has(url)) {
      sources.set(url, { id: sources.size + 1, url, title: cutText(title || url, 200) });
    }
    const source = sources.get(url);
    const head = `[${source.id}] ${source.title}\nURL: ${url}\n`;
    return head + cutText(content, Math.max(0, limit - head.length));
  }

  async function execute(call) {
    const name = call.function.name;
    const args = argumentsOf(call);
    if (name !== "web_search") {
      return "Tool error: only web_search is available. Search again with a focused query if excerpts are insufficient; full page downloads are not supported.";
    }
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) {
      return "Tool error: query must be a nonempty string of at most 500 characters.";
    }
    const key = args.query.trim();
    onProgress({ step: "web-search", detail: key });
    if (cache.has(key)) return cache.get(key);
    const data = await searchWeb(searxngUrl, key, { signal });
    const results = [];
    const seen = new Set();
    for (const item of data.results) {
      const url = publicWebUrl(item?.url);
      if (!url || seen.has(url) || typeof item.content !== "string" || !item.content.trim()) continue;
      seen.add(url);
      results.push(sourceText(url, typeof item.title === "string" ? item.title : url, item.content,
        Math.floor(budget / MAX_RESULTS)));
      if (results.length >= MAX_RESULTS) break;
    }
    let result = results.join("\n\n") || "No readable search results. Try a different query or state that you could not verify the answer.";
    if (Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length) {
      result += "\n\nSome search engines did not respond. Search coverage may be incomplete.";
    }
    cache.set(key, result);
    return result;
  }

  for (let round = 0; ; round++) {
    if (signal.aborted) throw abortedError();
    const finished = round >= MAX_ROUNDS || calls >= MAX_CALLS;
    onProgress({ step: "final" });
    const result = await ask((ctx) => {
      const base = build(ctx);
      return {
        ...base,
        options: { ...base.options, num_predict: Math.min(2048, Math.floor(numCtx / 4)) },
        ...(!finished ? { tools: TOOLS } : {}),
        messages: [
          ...base.messages,
          ...fitMessages(messages, budget),
          ...(finished ? [{ role: "system", content: "The web tool budget is exhausted. Answer now using the evidence already obtained, cite source IDs, and clearly state any gaps. Do not request more tools." }] : []),
        ],
      };
    }, { onContent, onThinking });
    if (!result.toolCalls.length) {
      return {
        ...result,
        sources: [...sources.values()],
        webLimited: finished,
      };
    }
    if (result.doneReason === "length") {
      throw failure("The model ran out of context while requesting web tools. Increase num_ctx in Settings.");
    }
    if (finished || result.toolCalls.length > MAX_CALLS) {
      throw failure("The model exceeded the web search limit. Try a more focused question.");
    }
    if (result.toolCalls.some((call) =>
      typeof call?.function?.name !== "string" || call.function.name.length > 50 ||
      JSON.stringify(call).length > 4000,
    )) {
      throw failure("The model returned an invalid web tool call. Try again or choose another model.");
    }
    messages.push(result.message);
    for (const call of result.toolCalls) {
      if (signal.aborted) throw abortedError();
      const content = calls >= MAX_CALLS
        ? "Web tool limit reached. Answer with the evidence already obtained."
        : await execute(call);
      calls++;
      messages.push({ role: "tool", tool_name: call.function.name, content });
    }
  }
}

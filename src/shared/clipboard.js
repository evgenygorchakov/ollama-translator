// Копирование в буфер обмена: navigator.clipboard есть не везде (нет на http-страницах), тогда
// execCommand через временную textarea.
// Общий для перевода выделенного и краткого содержания; внедряется перед их скриптами.
(() => {
  const ns = (window.__ollamaTranslator ??= {});

  // container — куда на время положить textarea: внутрь своего shadow root, чтобы страница её не
  // видела. Запасной путь уводит фокус в textarea — вызывающий возвращает его сам.
  // → true, если скопировалось.
  ns.copyText = async (text, container) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // нет доступа к clipboard — ниже execCommand
    }
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;";
    container.append(area);
    area.focus();
    area.select();
    let ok;
    try {
      ok = document.execCommand("copy"); // false — страница или браузер не дали скопировать
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  };
})();

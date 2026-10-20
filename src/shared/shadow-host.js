// Свой элемент для интерфейса на странице: тег с нашим именем, стили — в закрытом shadow root,
// так что правила сайта вида div { … } до него не дотянутся. Но элемент с дефисом в имени не
// определён, а сайты на веб-компонентах прячут такие (:not(:defined)), — поэтому visibility и
// opacity хосту задаём сами. Текст внутрь — только через textContent (на YouTube innerHTML к тому
// же запрещён Trusted Types).
// Общий для перевода страницы, выделенного и озвучки; внедряется перед их скриптами.
(() => {
  const ns = (window.__ollamaTranslator ??= {});

  // hostCss — положение, слой и прочее для хоста, с !important. → { host, shadow }
  ns.shadowHost = (tag, hostCss, css) => {
    const host = document.createElement(tag);
    host.style.cssText = `${hostCss}visibility:visible!important;opacity:1!important;`;
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = css;
    shadow.append(style);
    return { host, shadow };
  };
})();

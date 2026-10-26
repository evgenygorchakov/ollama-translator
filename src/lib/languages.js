// Целевые языки: code — для атрибута lang, name — для промпта и списка в настройках
// (по-английски), label — самоназвание языка.

export const LANGUAGES = Object.freeze([
  { code: "ru", name: "Russian", label: "Русский" },
  { code: "uk", name: "Ukrainian", label: "Українська" },
  { code: "be", name: "Belarusian", label: "Беларуская" },
  { code: "kk", name: "Kazakh", label: "Қазақ тілі" },
  { code: "de", name: "German", label: "Deutsch" },
  { code: "fr", name: "French", label: "Français" },
  { code: "es", name: "Spanish", label: "Español" },
  { code: "it", name: "Italian", label: "Italiano" },
  { code: "pt", name: "Portuguese", label: "Português" },
  { code: "pl", name: "Polish", label: "Polski" },
  { code: "tr", name: "Turkish", label: "Türkçe" },
  { code: "zh", name: "Simplified Chinese", label: "简体中文" },
  { code: "ja", name: "Japanese", label: "日本語" },
  { code: "ko", name: "Korean", label: "한국어" },
]);

export function isKnownLanguage(code) {
  return LANGUAGES.some((l) => l.code === code);
}

export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

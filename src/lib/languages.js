// Целевые языки: code — для атрибута lang, name — для промпта (по-английски).

export const LANGUAGES = Object.freeze([
  { code: "ru", name: "Russian", label: "Русский" },
  { code: "uk", name: "Ukrainian", label: "Украинский" },
  { code: "be", name: "Belarusian", label: "Белорусский" },
  { code: "kk", name: "Kazakh", label: "Казахский" },
  { code: "de", name: "German", label: "Немецкий" },
  { code: "fr", name: "French", label: "Французский" },
  { code: "es", name: "Spanish", label: "Испанский" },
  { code: "it", name: "Italian", label: "Итальянский" },
  { code: "pt", name: "Portuguese", label: "Португальский" },
  { code: "pl", name: "Polish", label: "Польский" },
  { code: "tr", name: "Turkish", label: "Турецкий" },
  { code: "zh", name: "Simplified Chinese", label: "Китайский (упрощённый)" },
  { code: "ja", name: "Japanese", label: "Японский" },
  { code: "ko", name: "Korean", label: "Корейский" },
]);

export function isKnownLanguage(code) {
  return LANGUAGES.some((l) => l.code === code);
}

export function languageName(code) {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

// Промпты перевода субтитров для озвучки: формат ctx.prompts из lib/translate.js. Язык всегда
// русский — Silero говорит только по-русски, настройки targetLang и systemPrompt сюда не
// относятся. Промпт страниц не годится: он велит сохранять латиницу и цифры, а синтезатор их
// не прочтёт.

const SPEECH_RULES =
  "The translation will be read aloud by a speech synthesizer in place of the original voice, " +
  "so keep it short and natural, like live spoken Russian, and make it fit in about the same " +
  "time as the original; drop filler words (um, uh, you know, like), stutters and false starts. " +
  "Write everything the way it is pronounced: numbers, dates, times, units, currencies, " +
  "symbols and abbreviations in Russian words, in the correct grammatical case " +
  "(5% → пять процентов, $10 → десять долларов, 2024 → две тысячи двадцать четвёртый); names, " +
  "companies, brands and terms in Cyrillic, the way Russians say them (iPhone → айфон, " +
  "SpaceX → Спейс Икс, GPU → джи-пи-ю). Use only Cyrillic letters and punctuation: not a " +
  "single Latin letter or digit, no emoji, no notes or comments.";

export const DUB_PROMPTS = Object.freeze({
  batch:
    "You translate English video subtitles into Russian for a voice-over. The `items` array " +
    "holds consecutive subtitle phrases: use the neighbours as context, but translate each item " +
    "separately. If a sentence is split between items, split its translation at the same point, " +
    `as far as Russian word order allows. ${SPEECH_RULES} Return JSON {"translations": [...]} ` +
    "with exactly the same number of elements in the same order, one translation per item.",
  single:
    "You translate an English video subtitle phrase into Russian for a voice-over. " +
    `${SPEECH_RULES} Output only the translation, without quotes.`,
  singleViaBatch: false,
});

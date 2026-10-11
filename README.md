# Ollama Translator

Расширение для Chrome и Firefox: переводит страницы с английского на русский через локальную
Ollama и озвучивает видео YouTube по-русски через Silero.

## Запуск

1. **Ollama.** Установить с [ollama.com](https://ollama.com) и скачать модель, например
   `ollama pull gemma4`. Разрешить запросы расширений и перезапустить Ollama:
   - Windows: `setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"`, затем выйти из
     Ollama через трей и запустить снова;
   - Linux: `sudo systemctl edit ollama`, добавить
     `Environment="OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*"` в секцию `[Service]`,
     затем `sudo systemctl restart ollama`.
2. **Расширение.**
   - Chrome: `chrome://extensions` → «Режим разработчика» → «Загрузить распакованное» → папка
     проекта;
   - Firefox: `about:debugging` → «Этот Firefox» → «Загрузить временное дополнение» →
     `manifest.json`. Временное дополнение пропадает после перезапуска браузера.
3. **Модель.** Открыть popup расширения и выбрать модель.
4. **Озвучка** (нужна только для YouTube). Silero на `http://127.0.0.1:5011`:
   - Windows: по инструкции в [`tools/silero/README.md`](tools/silero/README.md), около 280 МБ;
   - Linux: systemd-сервис из `sup/optional/voice`.

Настройки хранятся в браузере и на другой компьютер не переносятся.

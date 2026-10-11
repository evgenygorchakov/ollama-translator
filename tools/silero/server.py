# Сервер синтеза речи Silero для озвучки видео. Копия sup/optional/voice/silero/server.py
# (там же он ставится на Linux как systemd-сервис). Файлы держим одинаковыми: правка в одном —
# переносим в другой. Расширение рассчитывает на этот API: POST /synthesize, GET /voices,
# GET /health.

import io
import os
import re
from xml.sax.saxutils import escape

import numpy as np
import soundfile as sf
import silero
from flask import Flask, Response, jsonify, request

MODEL = os.environ.get("SILERO_MODEL", "v5_5_ru")
LANGUAGE = os.environ.get("SILERO_LANGUAGE", "ru")
DEFAULT_VOICE = os.environ.get("SILERO_VOICE", "aidar")
DEFAULT_RATE = os.environ.get("SILERO_RATE", "medium")
DEVICE = os.environ.get("SILERO_DEVICE", "cpu")
SAMPLE_RATE = int(os.environ.get("SILERO_SAMPLE_RATE", "48000"))
PORT = int(os.environ.get("SILERO_PORT", "5011"))
CHUNK_LIMIT = int(os.environ.get("SILERO_CHUNK_LIMIT", "800"))
USE_ACCENTOR = os.environ.get("SILERO_ACCENTOR", "1").lower() not in ("0", "false", "no")

# Темпы речи из SSML-словаря модели; medium — это множитель 1.0, то есть синтез без обёртки.
RATES = ("x-slow", "slow", "medium", "fast", "x-fast")
NEUTRAL_RATE = "medium"

SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
SPEAKABLE = re.compile(r"\w", re.UNICODE)
PAUSE = np.zeros(int(SAMPLE_RATE * 0.15), dtype="float32")

print(f"[silero] загрузка {MODEL} на {DEVICE}…", flush=True)
model, _ = silero.silero_tts(language=LANGUAGE, speaker=MODEL, sample_rate=SAMPLE_RATE)
model.to(DEVICE)

# В SSML-ветке модель зовёт convert_to_orig без охраны `if self.ext_alph`, а у русского пакета
# ext_alph — None: любая латиница в тексте роняет синтез. Пустой словарь возвращает функции
# её ранний выход, поведение остаётся прежним.
for package in getattr(model, "packages", []):
    if getattr(package, "ext_alph", None) is None:
        package.ext_alph = {}

VOICES = sorted(getattr(model, "speakers", []))

print(f"[silero] готов: voices={len(VOICES)}, default={DEFAULT_VOICE}, rate={DEFAULT_RATE}, "
      f"language={LANGUAGE}, accentor={'on' if USE_ACCENTOR else 'off'}, {SAMPLE_RATE} Гц", flush=True)


def resolve_voice(name):
    name = name.strip()
    return name if name in VOICES else None


def resolve_rate(name):
    name = name.strip().lower()
    return name if name in RATES else None


def split_text(text):
    chunks = []
    current = ""
    for sentence in SENTENCE_END.split(text):
        if not sentence:
            continue
        if len(current) + len(sentence) + 1 <= CHUNK_LIMIT:
            current = f"{current} {sentence}".strip()
            continue
        if current:
            chunks.append(current)
        while len(sentence) > CHUNK_LIMIT:
            cut = sentence.rfind(" ", 0, CHUNK_LIMIT)
            cut = cut if cut > 0 else CHUNK_LIMIT
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        current = sentence
    if current:
        chunks.append(current)
    return [chunk for chunk in chunks if SPEAKABLE.search(chunk)]


def synthesize_chunk(text, voice, rate, stressed):
    source = ({"text": text} if rate == NEUTRAL_RATE
              else {"ssml_text": f'<speak><prosody rate="{rate}">{escape(text)}</prosody></speak>'})
    audio = model.apply_tts(**source, speaker=voice, sample_rate=SAMPLE_RATE,
                            put_accent=stressed, put_stress_homo=stressed,
                            put_yo=stressed, put_yo_homo=stressed)
    if hasattr(audio, "cpu"):
        audio = audio.cpu().numpy()
    return np.asarray(audio, dtype="float32").ravel()


app = Flask(__name__)


@app.post("/synthesize")
def synthesize():
    data = request.get_json(force=True, silent=True) or {}
    text = (data.get("text") or "").strip()
    if not text:
        return Response(status=204)

    requested = data.get("voice") or DEFAULT_VOICE
    voice = resolve_voice(requested)
    if voice is None:
        return jsonify(error=f"голос не найден: {requested}", available=VOICES), 404

    requested_rate = data.get("rate") or DEFAULT_RATE
    rate = resolve_rate(requested_rate)
    if rate is None:
        return jsonify(error=f"темп не найден: {requested_rate}", available=list(RATES)), 404

    chunks = split_text(text)
    if not chunks:
        return Response(status=204)

    stressed = USE_ACCENTOR and data.get("raw") is not True
    pieces = []
    for chunk in chunks:
        try:
            pieces.append(synthesize_chunk(chunk, voice, rate, stressed))
        except Exception as failure:
            print(f"[silero] пропущен фрагмент ({failure}): {chunk[:60]}", flush=True)
    if not pieces:
        return jsonify(error="синтез не удался"), 500

    audio = pieces[0]
    for piece in pieces[1:]:
        audio = np.concatenate((audio, PAUSE, piece))

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), mimetype="audio/wav")


@app.get("/voices")
def voices():
    return jsonify(voices=VOICES, default=DEFAULT_VOICE, rates=list(RATES), default_rate=DEFAULT_RATE)


@app.get("/health")
def health():
    return jsonify(model=MODEL, language=LANGUAGE, voices=len(VOICES), default_voice=DEFAULT_VOICE,
                   default_rate=DEFAULT_RATE, device=DEVICE, sample_rate=SAMPLE_RATE,
                   accentor=USE_ACCENTOR)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, threaded=False)

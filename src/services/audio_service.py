import io
import asyncio
import logging
from pathlib import Path
import speech_recognition as sr
from gtts import gTTS
from pydub import AudioSegment
import uuid


STATIC_DIR = Path(__file__).parent.parent.parent / "static" / "audios"
STATIC_DIR.mkdir(exist_ok=True, parents=True)

rec = sr.Recognizer()
rec.operation_timeout = 20
logger = logging.getLogger(__name__)


class SpeechRecognitionUnavailable(RuntimeError):
    """The transcription provider could not process the request."""

def _speech_to_text(audio_bytes: bytes) -> str:
    """
    Converte áudio em texto usando a API do Google Speech Recognition.
    """

    try:
        # The web client records PCM WAV, which needs no external codec.
        wav_io = io.BytesIO(audio_bytes)
        if not (audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE"):
            audio_segment = AudioSegment.from_file(wav_io)
            wav_io = io.BytesIO()
            audio_segment.export(wav_io, format="wav")
            wav_io.seek(0)

        # Manda o WAV para o STT
        with sr.AudioFile(wav_io) as source:
            audio_data = rec.record(source)

        # Device rates can exceed Google's supported range (e.g. 96/192 kHz).
        # Normalize the PCM itself so the FLAC payload and declared rate agree.
        audio_data = sr.AudioData(
            audio_data.get_raw_data(convert_rate=16000, convert_width=2),
            sample_rate=16000,
            sample_width=2,
        )
        text = rec.recognize_google(
            audio_data, language='pt-BR',
            endpoint='https://www.google.com/speech-api/v2/recognize',
        )
        return text

    except sr.UnknownValueError:
        return ""
    except (sr.RequestError, TimeoutError) as e:
        logger.warning("Falha no serviço de reconhecimento de voz: %s", e)
        raise SpeechRecognitionUnavailable() from e
    except Exception as e:
        print(f"Falha no reconhecimento de voz: {e}")
        return ""


async def speech_to_text(audio_bytes: bytes) -> str:
    return await asyncio.to_thread(_speech_to_text, audio_bytes)


def _text_to_speech(text: str) -> str:
    try:
        filename = f"{uuid.uuid4()}.mp3"
        filepath = STATIC_DIR / filename

        tts = gTTS(text=text, lang='pt', tld='com.br', timeout=(5, 10))
        tts.save(str(filepath))

        return f"/static/audios/{filename}"
    except Exception as e:
        print(f"Erro na conversão de texto para fala: {e}")
        return ""


async def text_to_speech(text: str, user_id: str = "default_user") -> str:
    return await asyncio.to_thread(_text_to_speech, text)

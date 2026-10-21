import io
import asyncio
import logging
import math
import os
import sys
import textwrap
import time
import wave
from array import array
from pathlib import Path
import speech_recognition as sr
import httpx
import riva.client
from riva.client.proto import riva_asr_pb2
from pydub import AudioSegment
from pydub.exceptions import CouldntDecodeError
import uuid

from src.core.config import settings


STATIC_DIR = Path(__file__).parent.parent.parent / "static" / "audios"
STATIC_DIR.mkdir(exist_ok=True, parents=True)

rec = sr.Recognizer()
logger = logging.getLogger("uvicorn.error")
TTS_SAMPLE_RATE_HZ = 22050
TTS_CHUNK_CHARS = 350


class SpeechRecognitionUnavailable(RuntimeError):
    """The transcription provider could not process the request."""


class InvalidSpeechAudio(ValueError):
    """The uploaded recording cannot be decoded or contains no usable signal."""


def _transcribe_whisper(audio_data: sr.AudioData) -> str:
    # Whisper expects ISO language codes (pt, en), not regional codes (pt-BR).
    language = settings.LANGUAGE.replace("_", "-").split("-")[0].lower()
    auth = riva.client.Auth(
        uri=settings.NVIDIA_STT_SERVER,
        use_ssl=True,
        metadata_args=[
            ["function-id", settings.NVIDIA_STT_FUNCTION_ID],
            ["authorization", f"Bearer {settings.NVIDIA_API_KEY}"],
        ],
    )
    try:
        service = riva.client.ASRService(auth)
        config = riva.client.RecognitionConfig(
            encoding=riva.client.AudioEncoding.LINEAR_PCM,
            sample_rate_hertz=audio_data.sample_rate,
            audio_channel_count=1,
            language_code=language,
            max_alternatives=1,
            enable_automatic_punctuation=True,
        )
        response = service.stub.Recognize(
            riva_asr_pb2.RecognizeRequest(config=config, audio=audio_data.frame_data),
            metadata=auth.get_auth_metadata(),
            timeout=settings.STT_TIMEOUT_SECONDS,
        )
        return " ".join(
            result.alternatives[0].transcript.strip()
            for result in response.results if result.alternatives
        ).strip()
    finally:
        auth.channel.close()


def _speech_to_text(audio_bytes: bytes) -> str:
    """Converte áudio em texto usando Whisper Large v3 hospedado pela NVIDIA."""

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

        # Normalize recordings to mono 16-bit PCM at 16 kHz for Whisper.
        audio_data = sr.AudioData(
            audio_data.get_raw_data(convert_rate=16000, convert_width=2),
            sample_rate=16000,
            sample_width=2,
        )
    except (ValueError, EOFError, wave.Error, CouldntDecodeError) as error:
        logger.warning("STT status=invalid_audio error_type=%s", type(error).__name__)
        raise InvalidSpeechAudio("Não foi possível ler a gravação. Grave novamente e tente enviar o áudio.") from error
    except Exception as error:
        # Missing codecs/converters and server failures are not unintelligible
        # speech. Do not silently turn them into a misleading 422 response.
        logger.exception("STT status=audio_processing_error")
        raise SpeechRecognitionUnavailable() from error

    samples = array('h', audio_data.frame_data)
    if sys.byteorder != 'little':
        samples.byteswap()
    duration = len(samples) / audio_data.sample_rate
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples)) if samples else 0
    peak = max((abs(sample) for sample in samples), default=0)
    rms_dbfs = 20 * math.log10(max(rms / 32768, 1e-6))
    peak_dbfs = 20 * math.log10(max(peak / 32768, 1e-6))
    logger.info(
        "STT input duration=%.2fs sample_rate=%d rms_dbfs=%.1f peak_dbfs=%.1f language=%s",
        duration, audio_data.sample_rate, rms_dbfs, peak_dbfs, settings.LANGUAGE,
    )
    if not samples:
        raise InvalidSpeechAudio("A gravação não contém áudio. Verifique o microfone e grave novamente.")
    if rms_dbfs < -50:
        logger.warning("STT input_level=very_low; check selected microphone, mute and input volume")

    try:
        text = _transcribe_whisper(audio_data)
    except Exception as error:
        # gRPC errors may include credentials or private provider details.
        logger.warning("STT status=provider_error error_type=%s", type(error).__name__)
        raise SpeechRecognitionUnavailable() from error

    if not text:
        logger.warning("STT status=unrecognized; provider returned no transcript")
        if peak == 0:
            raise InvalidSpeechAudio(
                "O microfone enviou apenas silêncio. Verifique se ele está silenciado e se o navegador está usando o microfone correto."
            )
        return ""
    logger.info("STT status=recognized")
    return text


async def speech_to_text(audio_bytes: bytes) -> str:
    return await asyncio.to_thread(_speech_to_text, audio_bytes)


def _text_to_speech(text: str) -> str:
    temporary = None
    try:
        # Keep each utterance below Magpie's standard-mode duration limit.
        # Join PCM into one WAV so the browser still plays one complete reply.
        chunks = textwrap.wrap(" ".join(text.split()), width=TTS_CHUNK_CHARS, break_on_hyphens=False)
        if not chunks:
            return ""
        deadline = time.monotonic() + settings.TTS_TIMEOUT_SECONDS
        output = io.BytesIO()
        with wave.open(output, "wb") as wav, httpx.Client(
            headers={"Authorization": f"Bearer {settings.NVIDIA_API_KEY}"},
        ) as client:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(TTS_SAMPLE_RATE_HZ)
            for chunk in chunks:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("TTS deadline exceeded")
                response = client.post(
                    f"{settings.NVIDIA_TTS_BASE_URL.rstrip('/')}/v1/audio/synthesize",
                    files={key: (None, value) for key, value in {
                        "text": chunk,
                        "language": settings.TTS_LANGUAGE,
                        "voice": settings.TTS_VOICE,
                        "encoding": "LINEAR_PCM",
                        "sample_rate_hz": str(TTS_SAMPLE_RATE_HZ),
                    }.items()},
                    timeout=remaining,
                )
                response.raise_for_status()
                with wave.open(io.BytesIO(response.content), "rb") as audio:
                    if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, TTS_SAMPLE_RATE_HZ, "NONE"):
                        raise ValueError("Unexpected TTS audio format")
                    frames = audio.readframes(audio.getnframes())
                    if not frames or len(frames) != audio.getnframes() * 2:
                        raise ValueError("Empty or truncated TTS audio")
                    wav.writeframes(frames)
                if time.monotonic() >= deadline:
                    raise TimeoutError("TTS deadline exceeded")

        filename = f"{uuid.uuid4()}.wav"
        filepath = STATIC_DIR / filename
        temporary = STATIC_DIR / f".{filename}.tmp"
        temporary.write_bytes(output.getvalue())
        os.replace(temporary, filepath)
        return f"/static/audios/{filename}"
    except Exception as e:
        # Do not log API keys, spoken text, or provider response bodies.
        status = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
        logger.warning("TTS status=failed error_type=%s http_status=%s", type(e).__name__, status)
        return ""
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                logger.warning("TTS status=temporary_cleanup_failed")


async def text_to_speech(text: str, user_id: str = "default_user") -> str:
    return await asyncio.to_thread(_text_to_speech, text)

from fastapi import APIRouter, File, UploadFile, HTTPException, Form
import logging
from time import perf_counter

from src.models.schemas import ChatTextRequest, ChatResponse, LogoutRequest, SpeechRequest
from src.services.llm_service import llm_service_instance
from src.services.audio_service import text_to_speech, speech_to_text, SpeechRecognitionUnavailable

router = APIRouter()
logger = logging.getLogger("uvicorn.error")


async def timed_stage(stage, operation):
    started = perf_counter()
    try:
        return await operation
    finally:
        logger.info("Chat stage=%s duration=%.2fs", stage, perf_counter() - started)


@router.get("/health")
async def health_check():
    return {"status": "online"}


@router.post("/chat/text", response_model=ChatResponse)
async def chat_with_text(request: ChatTextRequest):
    """
    Recebe uma mensagem de texto, processa via RAG/LLM,
    e retorna texto, emoção e um link de áudio TTS.
    """
    try:
        text_reply, emotion = await timed_stage("llm", llm_service_instance.process_text(request.message, request.user_id))

        audio_url = await timed_stage("tts", text_to_speech(text_reply)) if request.generate_audio else ""

        return ChatResponse(
            text_reply=text_reply,
            emotion=emotion,
            audio_url=audio_url
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail="Não foi possível gerar a resposta.") from e


@router.post("/chat/voice", response_model=ChatResponse)
async def chat_with_voice(user_id: str = Form("default_user"), audio_file: UploadFile = File(...), generate_audio: bool = Form(True)):
    """
    Recebe um arquivo de áudio, transcreve, processa via RAG/LLM,
    e retorna a resposta.
    """
    try:
        # A minute of mono PCM is under 12 MB even at 96 kHz.
        audio_bytes = await audio_file.read(12 * 1024 * 1024 + 1)
        if len(audio_bytes) > 12 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="A gravação é muito longa.")
        if not audio_bytes:
            raise HTTPException(status_code=422, detail="A gravação está vazia.")
        transcribed_text = await timed_stage("stt", speech_to_text(audio_bytes))

        if not transcribed_text:
            raise HTTPException(status_code=422, detail="Não consegui entender o áudio. Fale mais perto do microfone e tente novamente.")

        try:
            text_reply, emotion = await timed_stage("llm", llm_service_instance.process_text(transcribed_text, user_id))
            audio_url = await timed_stage("tts", text_to_speech(text_reply)) if generate_audio else ""
        except Exception as e:
            # Preserve successful transcription even when answer generation fails.
            raise HTTPException(status_code=502, detail={
                "message": "Não foi possível gerar a resposta.",
                "transcribed_text": transcribed_text,
            }) from e

        return ChatResponse(
            text_reply=text_reply,
            emotion=emotion,
            audio_url=audio_url,
            transcribed_text=transcribed_text
        )
    except HTTPException:
        raise
    except SpeechRecognitionUnavailable as e:
        raise HTTPException(status_code=502, detail="O serviço de transcrição está indisponível. Tente novamente em instantes.") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail="Não foi possível processar o áudio.") from e


@router.post("/chat/speech")
async def generate_speech(request: SpeechRequest):
    """Generate optional audio after the client has already displayed the answer."""
    audio_url = await timed_stage("tts", text_to_speech(request.text))
    if not audio_url:
        raise HTTPException(status_code=502, detail="Não foi possível gerar o áudio.")
    return {"audio_url": audio_url}


@router.post("/chat/logout")
async def logout(request: LogoutRequest):
    """
    Limpa o histórico do usuário e encerra a sessão.
    """
    llm_service_instance.clear_session(request.user_id)
    return {"status": "success", "message": "Histórico do usuário apagado."}

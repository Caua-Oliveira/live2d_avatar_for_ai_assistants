from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Response
import asyncio
import logging
from time import perf_counter

from src.models.schemas import ChatTextRequest, ChatResponse, LogoutRequest, SpeechRequest
from src.services.llm_service import llm_service_instance
from src.services.audio_service import text_to_speech, speech_to_text, SpeechRecognitionUnavailable, InvalidSpeechAudio
from src.services.appearance_service import AppearancePreset, load_appearance, save_appearance

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


@router.get("/avatar/appearance", response_model=AppearancePreset)
async def get_avatar_appearance(response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return await asyncio.to_thread(load_appearance)
    except (OSError, ValueError) as error:
        logger.exception("Could not load the shared avatar appearance")
        raise HTTPException(status_code=503, detail="Não foi possível carregar o visual padrão.") from error


@router.put("/avatar/appearance", response_model=AppearancePreset)
async def put_avatar_appearance(preset: AppearancePreset, response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        return await asyncio.to_thread(save_appearance, preset)
    except OSError as error:
        logger.exception("Could not save the shared avatar appearance")
        raise HTTPException(status_code=503, detail="Não foi possível salvar o visual padrão.") from error


@router.post("/chat/text", response_model=ChatResponse)
async def chat_with_text(request: ChatTextRequest):
    """
    Recebe uma mensagem de texto, processa via RAG/LLM,
    e retorna texto, emoção e um link de áudio TTS.
    """
    try:
        reply = await timed_stage("llm", llm_service_instance.process_text(request.message, request.user_id))

        audio_url = await timed_stage("tts", text_to_speech(reply.text_tts)) if request.generate_audio else ""

        return ChatResponse(
            text_ui=reply.text_ui,
            text_tts=reply.text_tts,
            emotion=reply.emotion,
            audio_url=audio_url,
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
            reply = await timed_stage("llm", llm_service_instance.process_text(transcribed_text, user_id))
            audio_url = await timed_stage("tts", text_to_speech(reply.text_tts)) if generate_audio else ""
        except Exception as e:
            # Preserve successful transcription even when answer generation fails.
            raise HTTPException(status_code=502, detail={
                "message": "Não foi possível gerar a resposta.",
                "transcribed_text": transcribed_text,
            }) from e

        return ChatResponse(
            text_ui=reply.text_ui,
            text_tts=reply.text_tts,
            emotion=reply.emotion,
            audio_url=audio_url,
            transcribed_text=transcribed_text,
        )
    except HTTPException:
        raise
    except InvalidSpeechAudio as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except SpeechRecognitionUnavailable as e:
        raise HTTPException(status_code=502, detail="O serviço de transcrição está indisponível. Tente novamente em instantes.") from e
    except Exception as e:
        raise HTTPException(status_code=502, detail="Não foi possível processar o áudio.") from e


@router.post("/chat/speech")
async def generate_speech(request: SpeechRequest):
    """Synthesize the complete answer as one audio clip."""
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

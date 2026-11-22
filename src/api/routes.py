import asyncio
import logging

from fastapi import APIRouter, HTTPException, Response, WebSocket

from src.services.appearance_service import (
    AppearancePreset,
    load_appearance,
    save_appearance,
)
from src.services.gemini_live_service import public_config, serve_live

router = APIRouter()
logger = logging.getLogger("uvicorn.error")


@router.get("/chat/live/config")
async def get_live_config():
    return public_config()


@router.websocket("/chat/live")
async def chat_live(websocket: WebSocket):
    await serve_live(websocket)


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

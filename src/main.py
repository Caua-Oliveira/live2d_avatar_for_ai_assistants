from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from src.api.routes import health_check as api_health_check
from src.api.routes import router as api_router
from src.core.config import settings

LOCAL_DEV_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

app = FastAPI(
    title="IA Universitária - Jorgina",
    description="API para o sistema de assistência universitária ao vivo com Live2D",
    version="1.0.0",
)

configured_origins = settings.allowed_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins,
    allow_origin_regex=None if configured_origins else LOCAL_DEV_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "PUT", "OPTIONS"],
    allow_headers=["Content-Type"],
)

app.include_router(api_router, prefix="/api")
app.add_api_route("/health", api_health_check, methods=["GET"], include_in_schema=False)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend" / "dist"


@app.get("/")
async def root():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    return {
        "status": "online",
        "message": "Jorgina está ouvindo.",
        "model": settings.GEMINI_LIVE_MODEL,
    }


@app.get("/changemodel", include_in_schema=False)
async def appearance_editor():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.is_file():
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="Frontend build not found.")


# Montado após /api e as rotas SPA para que essas rotas mantenham seus próprios handlers.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from src.api.routes import router as api_router, health_check as api_health_check
from src.core.config import settings

app = FastAPI(
    title="IA Universitária - Jorgina",
    description="API para o sistema de assistência universitária com Live2D",
    version="1.0.0"
)

# CORS Setup
# TODO: Restringir o acesso apenas para domínios confiáveis
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent.parent / "static"
STATIC_DIR.mkdir(exist_ok=True, parents=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


app.include_router(api_router, prefix="/api")
app.add_api_route("/health", api_health_check, methods=["GET"], include_in_schema=False)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend" / "dist"

@app.get("/")
async def health_check():
    if (FRONTEND_DIR / "index.html").is_file():
        return FileResponse(FRONTEND_DIR / "index.html")
    return {
        "status": "online",
        "message": "Jorgina está ouvindo.",
        "model": settings.MODEL_NAME
    }


# Serve the production interface when it has been built with `npm run build`.
# Register after /api and /static so those routes keep their own handlers.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

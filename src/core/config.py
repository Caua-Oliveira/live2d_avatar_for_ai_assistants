from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    NVIDIA_API_KEY: str
    NVIDIA_BASE_URL: str = "https://integrate.api.nvidia.com/v1"

    MODEL_NAME: str = "nvidia/nemotron-3-ultra-550b-a55b"
    LLM_TIMEOUT_SECONDS: float = Field(default=60.0, gt=0)
    NVIDIA_STT_SERVER: str = "grpc.nvcf.nvidia.com:443"
    NVIDIA_STT_FUNCTION_ID: str = "b702f636-f60c-4a3d-a6f4-f3568c13bd7d"
    STT_TIMEOUT_SECONDS: float = Field(default=30.0, gt=0)
    NVIDIA_TTS_BASE_URL: str = "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com"
    TTS_LANGUAGE: str = "pt-BR"
    TTS_VOICE: str = "Magpie-Multilingual.PT-BR.Isabela"
    TTS_TIMEOUT_SECONDS: float = Field(default=25.0, gt=0)
    LANGUAGE: str = "pt-BR"

    class Config:
        env_file = ".env"
        env_file_encoding = 'utf-8'
        extra = "ignore"

settings = Settings()

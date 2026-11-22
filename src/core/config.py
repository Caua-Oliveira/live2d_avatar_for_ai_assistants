from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    GEMINI_LIVE_REPAIR_TIMEOUT_SECONDS: float = Field(
        default=60.0,
        gt=0,
        validation_alias=AliasChoices("GEMINI_LIVE_REPAIR_TIMEOUT_SECONDS", "LLM_TIMEOUT_SECONDS"),
    )

    GEMINI_API_KEY: str = Field(default="", repr=False)
    GEMINI_API_KEY_FILE: str = ""
    GEMINI_LIVE_ENABLED: bool = True
    GEMINI_LIVE_MODEL: str = "gemini-3.8-live"
    GEMINI_LIVE_VOICE: str = "Aoede"
    GEMINI_LIVE_LANGUAGE_CODE: str = "pt-BR"
    GEMINI_LIVE_TEMPERATURE: float | None = Field(default=0.4, ge=0.0, le=2.0)
    GEMINI_LIVE_AFFECTIVE_DIALOG: bool | None = False
    GEMINI_LIVE_MAX_SECONDS: float = Field(default=900, gt=0, le=3600)
    GEMINI_LIVE_CONNECT_TIMEOUT_SECONDS: float = Field(default=20, gt=0)
    GEMINI_LIVE_ALLOWED_ORIGINS: str = ""

    @field_validator("GEMINI_LIVE_TEMPERATURE", "GEMINI_LIVE_AFFECTIVE_DIALOG", mode="before")
    @classmethod
    def empty_string_to_none(cls, value):
        if isinstance(value, str) and not value.strip():
            return None
        return value

    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.GEMINI_LIVE_ALLOWED_ORIGINS.split(",") if origin.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()

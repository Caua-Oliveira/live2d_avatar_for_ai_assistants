from pydantic import BaseModel, Field
from typing import Literal, Optional


class AssistantReply(BaseModel):
    text_ui: str = Field(min_length=1, max_length=8000)
    text_tts: str = Field(min_length=1, max_length=8000)
    emotion: Literal["happy", "sad", "neutral"] = "neutral"


class ChatTextRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    user_id: str = Field(default="default_user", max_length=128)
    generate_audio: bool = True


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)


class ChatResponse(BaseModel):
    text_ui: str
    text_tts: str
    emotion: Literal["happy", "sad", "neutral"]
    audio_url: Optional[str] = None
    transcribed_text: Optional[str] = None


class LogoutRequest(BaseModel):
    user_id: str

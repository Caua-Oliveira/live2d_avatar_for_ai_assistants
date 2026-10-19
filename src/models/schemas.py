from pydantic import BaseModel, Field
from typing import Optional

class ChatTextRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    user_id: str = Field(default="default_user", max_length=128)
    generate_audio: bool = True


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=8000)

class ChatResponse(BaseModel):
    text_reply: str
    emotion: str
    audio_url: Optional[str] = None
    transcribed_text: Optional[str] = None

class LogoutRequest(BaseModel):
    user_id: str

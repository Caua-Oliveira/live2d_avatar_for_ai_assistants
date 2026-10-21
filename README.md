# Jorgina · Assistente universitária

A Portuguese, avatar-first interface for the university assistant. The MO.v2.7 Live2D model is rendered with Pixi/Cubism; text and voice questions use the FastAPI RAG/LLM endpoints.

## Run locally

Create an API key at [NVIDIA Build](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b) and set `NVIDIA_API_KEY` in the root `.env` (see `.env.example`). Replies use `nvidia/nemotron-3-ultra-550b-a55b` through NVIDIA's OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`; optionally override `MODEL_NAME` or `NVIDIA_BASE_URL`. Your existing NVIDIA key can be reused; remove or update any old `MODEL_NAME` override when switching models. Install the Python dependencies into your environment with `uv pip install -r pyproject.toml`, then start the API from the repository root:

```sh
python -m uvicorn src.main:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```sh
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` and `/static` to port 8000. A different API origin can be configured with `VITE_API_BASE_URL` (see `frontend/.env.example`).

## Production

Run `npm run build` inside `frontend`, then start/restart FastAPI. FastAPI serves the built interface at `/`, the API at `/api`, and generated speech at `/static/audios`. Use HTTPS outside localhost for microphone and camera access.

## Interaction

- **Text:** Enter sends; Shift + Enter inserts a line break. Suggested topics send real questions to the API.
- **Voice:** Click “Pode falar”, allow the microphone, then click “Enviar áudio”. Recordings stop after 60 seconds. Cancel discards the recording. Mono PCM WAV is sent to `/api/chat/voice`; the returned transcript replaces the voice placeholder. WAV recordings do not need FFmpeg (legacy non-WAV uploads still do).
- **AI-chosen expression:** The AI returns `text_ui` (written answer), `text_tts` (the same answer prepared for speech, with numbers and abbreviations spelled out), and one `emotion`: `happy`, `sad`, or `neutral`, chosen to suit the answer. Chat responses expose these as `text_ui`, `text_tts`, and `emotion`. The frontend displays `text_ui` and sends `text_tts` to speech synthesis. It applies the facial expression while speaking; natural blinking, camera gaze, physics and amplitude-driven lip sync remain automatic. Replies contain no animation parameters, hand gestures, timelines or scripted pauses. The conversation uses a closer portrait framing; the appearance editor retains a full-body view. See [the rig and expression mapping](frontend/mo-avatar-parameters.md).
- **Eye contact:** Enable “Ativar contato visual”. MediaPipe detects the closest face at up to 10 fps; gaze smoothly returns to center when no face is visible. Camera frames stay on-device. The first activation downloads the pinned MediaPipe WASM runtime and face detector from jsDelivr/Google; allow these hosts in deployment network policies.
- **Playback:** Toggle voice, stop speaking, or replay/copy individual responses. Blocked autoplay leaves the text and replay button available.
- **Sessions:** Each page load/new conversation uses a distinct anonymous ID. New conversation cancels in-flight UI work and requests removal of the previous backend history. The chat is kept in memory, not persisted in browser storage.
- **Shared avatar default:** “Salvar como padrão” in `/changemodel` writes `data/avatar-appearance.json` on the backend, not browser storage. Every browser/device using that backend loads the same appearance. Existing conversations refresh it on focus/visibility and their 30-second health checks. Unsaved editor changes remain previews. Preserve this file on writable persistent storage across deployments; restrict the editor and `PUT /api/avatar/appearance` to trusted operators, as the project currently has no authentication.

Microphone audio is sent to the API and NVIDIA-hosted [OpenAI Whisper Large v3](https://build.nvidia.com/openai/whisper-large-v3) for transcription; replies use Nemotron 3 Ultra and hosted [Magpie TTS Multilingual](https://build.nvidia.com/nvidia/magpie-tts-multilingual) via NVIDIA. STT reuses `NVIDIA_API_KEY` through the Riva Python client (`nvidia-riva-client`), with TLS gRPC to `NVIDIA_STT_SERVER=grpc.nvcf.nvidia.com:443` and `NVIDIA_STT_FUNCTION_ID=b702f636-f60c-4a3d-a6f4-f3568c13bd7d`. Allow outbound HTTP/2 gRPC on port 443. `STT_TIMEOUT_SECONDS` defaults to 30 seconds, with no provider fallback or automatic retries. Audio is normalized locally to mono 16-bit PCM at 16 kHz. No local GPU or Riva server is required.

TTS also reuses `NVIDIA_API_KEY`, with Brazilian Portuguese (`TTS_LANGUAGE=pt-BR`) and the female `TTS_VOICE=Magpie-Multilingual.PT-BR.Isabela` by default. `NVIDIA_TTS_BASE_URL` selects the dedicated speech endpoint (separate from the LLM's `NVIDIA_BASE_URL`); `TTS_TIMEOUT_SECONDS` defaults to 25 seconds. The hosted model supports Portuguese, unlike the older downloadable Riva IPA model. Outbound HTTPS to the configured endpoint is required; no local GPU, gRPC server, or FFmpeg is needed for synthesis. Available voices can be queried at `<NVIDIA_TTS_BASE_URL>/v1/audio/list_voices` with the same bearer key; set a matching language/voice pair when changing languages. The connection indicator checks API availability, not model/provider health. Current retrieval uses `data/context.json` through the existing location and coordination tools: the model requests only the slice it needs, so the full dataset is never attached to a question.

### Response latency

The interface requests text/transcripts with `generate_audio=false`, then calls `/api/chat/speech` with only the complete answer's `text_tts` if voice is enabled. The endpoint returns one mono 16-bit PCM WAV at 22.05 kHz via `audio_url`; it does not process animation plans. Long answers are split at word boundaries into at most 350-character provider requests and their PCM frames are joined into one clip. These requests share the TTS time budget, and any failure discards the entire clip rather than playing a truncated answer. Provider chunk boundaries can affect prosody, but playback has no inter-file gaps. TTS failures retain the existing text-only/502 behavior with no fallback to another provider.

The answer stays pending until playback starts, so the full text appears together with the voice and the chosen expression. Muting voice displays text with the chosen expression immediately and skips/cancels pending speech generation; “Ouvir resposta” generates it on demand and replays the same clip and expression. Stop, a new question/conversation, and hiding the tab cancel playback. Blocked autoplay or speech failure falls back to text.

Answers that need `get_locais`/`get_coordenacao` still require a second provider round trip, so tool-based questions are slower than small talk. Replace the JSON-backed tools with indexed database queries when the real dataset arrives.

`LLM_TIMEOUT_SECONDS` (default `60`) caps the entire LLM turn, including tool round trips. Provider requests are not automatically retried, so a stalled request does not silently double the wait. A successful model-list request confirms endpoint access, not inference availability; if generation times out, try the same model in NVIDIA Build to check whether its hosted inference is responding. Local `GET /v1/models` requests are not supported by this application's API and are unrelated to its outbound NVIDIA requests.

Uvicorn logs `Chat stage=stt|llm|tts duration=…s` so you can identify slow transcription, model generation, or speech synthesis without logging question contents. `/health` and `/api/health` both return the same availability check; periodic health requests are independent of chat. Audio `206 Partial Content` and `304 Not Modified` responses are normal browser range/cache requests.

For microphone failures, `STT input duration=… rms_dbfs=… peak_dbfs=… language=…` reports recording length and volume, never the audio or transcript. Near `-120 dBFS` is digital silence; consistently very low levels suggest a muted/wrong microphone or low input volume. `STT status=unrecognized` means the provider returned no transcript (422); processing/provider failures are reported separately (502). Recognition uses `LANGUAGE` from `.env` (`pt-BR` by default; use `en-US` for English), converted to Whisper's language codes (`pt`, `en`). Use `multi` for automatic language detection. Restart the backend after changing it.

## Checks

```sh
cd frontend
npm run build
node --test tests/*.test.js
```

From the repository root, with the Python environment active, run `python -m unittest discover -s tests -v` for API, speech provider, appearance, and native WAV decoding checks. These tests mock provider calls and use no API credits. Keep `shared/avatar-appearance-controls.json` with the backend deployment; both Python and the frontend use this appearance contract.

Hardware permissions, face tracking, and audible lip sync should also be checked with a real camera/microphone on the target kiosk/browser. Layout supports mobile and desktop, keyboard navigation, screen-reader announcements, and reduced motion.

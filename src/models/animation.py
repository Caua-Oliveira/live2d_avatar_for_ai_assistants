"""Limites compartilhados do modelo e contrato de animação relativa ao áudio por resposta."""
import json
import logging
from itertools import pairwise
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

CATALOG = json.loads((Path(__file__).resolve().parents[2] / "shared" /
                      "avatar-parameter-catalog.json").read_text(encoding="utf-8"))
MODEL = CATALOG["model"]
PARAMETERS = CATALOG["parameters"]
PARAMETER_METADATA = json.loads((Path(__file__).resolve().parents[2] / "shared" /
                                 "avatar-parameter-details.json").read_text(encoding="utf-8"))
if (PARAMETER_METADATA["model"] != MODEL or PARAMETER_METADATA["moc_sha256"] != CATALOG["moc_sha256"]
        or set(PARAMETER_METADATA["parameters"]) != set(PARAMETERS)):
    raise ValueError("Regenerate avatar parameter details for the current compiled catalog.")
MAX_KEYFRAMES = 16
MAX_SEGMENTS = 8
logger = logging.getLogger("uvicorn.error")


class Keyframe(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    at: float = Field(ge=0, le=1, allow_inf_nan=False)
    value: float = Field(allow_inf_nan=False)


class ParameterTrack(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    mode: Literal["set", "add", "multiply"]
    duration: float | None = Field(default=None, ge=0.4, le=4, allow_inf_nan=False)
    keyframes: list[Keyframe] = Field(min_length=1, max_length=MAX_KEYFRAMES)

    @model_validator(mode="after")
    def validate_track(self):
        if self.id not in PARAMETERS:
            raise ValueError("Unknown model parameter")
        times = [frame.at for frame in self.keyframes]
        if any(b <= a for a, b in pairwise(times)):
            raise ValueError("Keyframe positions must be strictly increasing")
        control = PARAMETERS[self.id]
        low, high = control["min"], control["max"]
        if self.mode == "add":
            low, high = -(high - low), high - low
        elif self.mode == "multiply":
            low, high = 0, 2
        for frame in self.keyframes:
            frame.value = max(low, min(high, frame.value))
            if control["type"] == "choice" and self.mode == "set" and not frame.value.is_integer():
                raise ValueError("Discrete style selectors require integer set values")
        return self


class AnimationSegment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    text: str = Field(min_length=1, max_length=8000)
    tracks: list[ParameterTrack] = Field(default_factory=list, max_length=len(PARAMETERS))

    @model_validator(mode="after")
    def validate_text(self):
        if not self.text.strip():
            raise ValueError("A spoken segment cannot be blank")
        return self


class AvatarAnimation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    model: Literal["MO.v2.7"] = "MO.v2.7"
    tracks: list[ParameterTrack] = Field(default_factory=list, max_length=len(PARAMETERS))
    segments: list[AnimationSegment] = Field(default_factory=list, max_length=MAX_SEGMENTS)


def _tracks(items, strict):
    if not isinstance(items, list) or len(items) > len(PARAMETERS):
        if strict:
            raise ValueError("animation.tracks must be a bounded array of parameter tracks")
        return []
    tracks, seen = [], set()
    for item in items:
        try:
            track = ParameterTrack.model_validate(item)
            if track.id in seen:
                raise ValueError("Duplicate parameter track")
        except (ValidationError, ValueError) as error:
            if strict:
                raise ValueError(f"Invalid animation track: {error}") from error
            logger.warning("Avatar animation: discarded invalid/duplicate track")
            continue
        seen.add(track.id)
        tracks.append(track)
    return tracks


def normalize_animation(raw, *, strict=False, spoken_text=None) -> AvatarAnimation:
    """A geração pelo LLM usa validação estrita para que uma animação inválida dispare reparo."""
    if not isinstance(raw, dict) or raw.get("model") != MODEL:
        if strict:
            raise ValueError("animation with model MO.v2.7 is required")
        logger.warning("Avatar animation missing or incompatible; using automatic behavior")
        return AvatarAnimation()
    tracks = _tracks(raw.get("tracks", []), strict)
    segments = []
    raw_segments = raw.get("segments", [])
    if not isinstance(raw_segments, list) or len(raw_segments) > MAX_SEGMENTS:
        if strict:
            raise ValueError("animation.segments must have at most eight spoken phrases")
        raw_segments = []
    for item in raw_segments:
        try:
            segment = AnimationSegment(text=item["text"], tracks=_tracks(item["tracks"], strict))
        except (ValidationError, ValueError, KeyError, TypeError) as error:
            if strict:
                raise ValueError("Each animation segment needs text and valid tracks") from error
            continue
        segments.append(segment)
    if segments and spoken_text is not None:
        if " ".join(" ".join(s.text.split()) for s in segments) != " ".join(spoken_text.split()):
            raise ValueError("Joining animation.segments[].text must reproduce text_tts exactly")
    if strict and not tracks and not any(s.tracks for s in segments):
        raise ValueError("A visible parameter performance is required; an empty score only plays idle")
    return AvatarAnimation(tracks=tracks, segments=segments)


PARAMETER_HINTS = {
    "Param56": "Eye SIZE: -1 small, +1 large; saved appearance is neutral",
    "Param155": "Eye WIDTH: -1 narrow, +1 wide; saved appearance is neutral",
    "Param36": "Left PUPIL STYLE (discrete): happy example 7, sad example 0",
    "Param38": "Right PUPIL STYLE (discrete): happy example 7, sad example 0",
    "Param55": "Left EYE SHINE STYLE (discrete): happy example 3",
    "Param178": "Right EYE SHINE STYLE (discrete): happy example 3",
    "Param74": "BLUSH STYLE (discrete): happy example 6",
    "Param69": "Eyebrow ROTATION: sad example +1; saved appearance is neutral",
    "Param81": "Eyebrow POSITION: sad example -1; saved appearance is neutral",
    "ParamBrowLY": "Left eyebrow HEIGHT: -1 down, +1 raised",
    "ParamBrowRY": "Right eyebrow HEIGHT: -1 down, +1 raised",
    "ParamBrowLForm": "Left eyebrow SHAPE, not height",
    "ParamBrowRForm": "Right eyebrow SHAPE, not height",
    "ParamAngleX": "Head turn LEFT/RIGHT, degrees",
    "ParamAngleY": "Head look UP/DOWN, degrees",
    "ParamAngleZ": "Head TILT sideways, degrees",
    "ParamMouthForm": "Mouth expression: -1 frown, +1 smile",
    "ParamEyeLSmile": "Left smiling eye, 0 off to 1 full",
    "ParamEyeRSmile": "Right smiling eye, 0 off to 1 full",
    "Param190": "Left auxiliary smiling eye output",
    "Param191": "Right auxiliary smiling eye output",
    "ParamControllerON": "Hand style PREVIEW switch, not a verified waving animation",
}

PARAMETER_HINTS.update({
    "ParamEyeBallX": "Horizontal gaze: -1 left, +1 right; combine with head turn for directions",
    "ParamEyeBallY": "Vertical gaze: -1 down, +1 up",
    "ParamEyeLOpen": "Left eyelid openness: 0 closed, 1 open; multiply retains automatic blink",
    "ParamEyeROpen": "Right eyelid openness: 0 closed, 1 open; multiply retains automatic blink",
    "Param47": "Auxiliary eyebrow shape (not eyebrow height)",
    "Param48": "Large-eye control; compiled neutral 0.5, range 0 to 1",
    "ParamBodyAngleX": "Body X angle, normally physics-driven; explicit set overrides, add preserves secondary motion",
    "ParamBodyAngleY": "Body Y angle, normally physics-driven; explicit set overrides, add preserves secondary motion",
    "ParamBodyAngleZ": "Body Z angle, normally physics-driven; explicit set overrides, add preserves secondary motion",
    "ParamBreath": "Breathing input; do not substitute breath for a facial expression",
    "Param250": "Question-mark expression graphic (问号): confusion/curiosity; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param251": "Sweat expression graphic (流汗): embarrassment/unease; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param252": "Anger expression graphic (生气): frustration/anger; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param254": "Ellipsis expression graphic (。。。): hesitation; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param255": "Heart expression graphic (爱心): affection/joy; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param256": "Speechless expression graphic (无语): disbelief/dismay; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param258": "Star expression graphic (星星): excitement; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
    "Param259": "Ghost-flame expression graphic (鬼火); not verified tears/gloom; range 0..1, target set 1, default 0; visibility prerequisites uncalibrated",
})

# Traduções literais dos rótulos CDI auditados, sem afirmar comportamento visual dos extremos.
PARAMETER_LABEL_TRANSLATIONS = {
    "Param61": "Left hand", "Param63": "Left hand rotation", "Param98": "Left hand deformation", "Param99": "Left hand deformation 2",
    "Param62": "Right hand", "Param64": "Right hand rotation", "Param104": "Right hand deformation 1", "Param105": "Right hand deformation 2",
    "Param229": "Raised hand", "Param228": "Raised arm", "Param230": "Raised wrist",
    "Param215": "Singing shoulder", "Param121": "Singing arm", "Param176": "Singing wrist",
    "Param213": "Drawing hand X", "Param214": "Drawing hand Y", "Param216": "Pen pressed",
    "Param122": "Crooked mouth", "Param123": "Mouth width", "Param124": "Chin tuck", "Param125": "Jaw protrusion", "Param126": "Puffed mouth",
    "Param250": "Question-mark expression graphic", "Param251": "Sweat expression graphic", "Param252": "Anger expression graphic",
    "Param254": "Ellipsis expression graphic", "Param255": "Heart expression graphic", "Param256": "Speechless expression graphic",
    "Param258": "Star expression graphic", "Param259": "Ghost-flame expression graphic",
    "Param260": "Expression physics", "Param17": "Left angry-eye effect", "Param18": "Right angry-eye effect",
    "Param30": "Left eyelid", "Param31": "Right eyelid",
}


def parameter_details(ids=None) -> dict:
    """Metadados originais do autor combinados ao uso verificado no projeto; nunca inventar nomes de estilos."""
    selected = list(PARAMETERS) if ids is None or ids == [] else ids
    if (not isinstance(selected, list) or len(selected) > len(PARAMETERS)
            or any(not isinstance(pid, str) or pid not in PARAMETERS for pid in selected)):
        raise ValueError("Use somente IDs do catálogo MO.v2.7; ids=[] retorna todos.")
    details = {}
    for pid in dict.fromkeys(selected):
        info = PARAMETERS[pid]
        metadata = PARAMETER_METADATA["parameters"][pid]
        notes = []
        heading = any(char in info["name"] for char in ("█", "▂"))
        if heading:
            notes.append("Decorative display heading, not an expressive motion.")
        if info["type"] == "choice":
            notes.append("Discrete style index: use integer set values; hold instead of sweeping through styles. Individual style meanings are not documented unless noted.")
        if info["physicsOutput"]:
            notes.append("Physics output: set takes ownership; add overlays the physical result. Keep the saved look unless a related part is present.")
        if info["appearance"]:
            notes.append("Appearance control: animate facial features temporarily; preserve outfit/hair/accessories unless requested. Playback never saves this value.")
        if pid == "ParamMouthOpenY":
            notes.append("Reserved for audio RMS lip sync in Live mode; documented and discoverable but not authored by the Live animation tool.")
        if pid not in PARAMETER_HINTS and not heading:
            notes.append("Meaning comes from the maker's original label only; visual effect, axis sign and visual selector prerequisites are not independently calibrated. Do not invent them. Physics wiring is provided separately.")
        if pid in PARAMETER_LABEL_TRANSLATIONS:
            notes.append("Description is a literal CDI-label translation; endpoints, selector prerequisites and visibility are uncalibrated. Body/hands may be outside portrait framing.")
        details[pid] = {
            **info,
            "description": PARAMETER_HINTS.get(pid, PARAMETER_LABEL_TRANSLATIONS.get(pid, info["name"])),
            "documentation_status": "project_documented" if pid in PARAMETER_HINTS else "maker_label_translation" if pid in PARAMETER_LABEL_TRANSLATIONS else "maker_label_only",
            "group": metadata["group"],
            "source": {"file": PARAMETER_METADATA["sources"][0], "line": metadata["cdi_source_line"]},
            "physics_sources": metadata["physics_sources"],
            "physics_targets": metadata["physics_targets"],
            "drives_physics_settings": metadata["drives_physics_settings"],
            "written_by_physics_settings": metadata["written_by_physics_settings"],
            "heading": heading,
            "notes": notes,
        }
    return {"model": MODEL, "parameter_count": len(PARAMETERS), "parameters": details}


def catalog_instruction() -> str:
    rows = []
    for pid, info in parameter_details()["parameters"].items():
        tags = [tag for tag, enabled in (("appearance", info["appearance"]),
                                        ("physics-output", info["physicsOutput"]),
                                        ("heading", info["heading"])) if enabled]
        rows.append([pid, info["name"], info["min"], info["max"], info["default"],
                     info["type"], ",".join(tags), info["group"]["name"],
                     PARAMETER_HINTS.get(pid, PARAMETER_LABEL_TRANSLATIONS.get(pid, "maker-label-only"))])
    return ("\nCATÁLOGO COMPLETO DO MODELO MO.v2.7: " + str(len(PARAMETERS)) + " parâmetros. "
            "Cada linha contém [id, nome original do autor, mínimo, máximo, padrão compilado, "
            "tipo range/choice, características, grupo original, uso documentado ou tradução literal do nome]. "
            "Todos os IDs reais estão disponíveis; o nome original descreve a função segundo o autor. "
            "maker-label-only significa que não há verificação visual adicional: não invente efeitos "
            "ou significados dos índices. heading é título decorativo, sem atuação visível. "
            "Parâmetros de roupa/cabelo/acessórios dependem da peça selecionada; não são gestos faciais. "
            "Padrão compilado NÃO é o visual neutro salvo recebido na cena.\n" +
            json.dumps(rows, ensure_ascii=False, separators=(",", ":")))

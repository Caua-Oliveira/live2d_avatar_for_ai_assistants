"""One disk-backed appearance for every client of this server."""
import json
import math
import os
from pathlib import Path
import tempfile
import threading
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ROOT = Path(__file__).resolve().parents[2]
PRESET_PATH = ROOT / "data" / "avatar-appearance.json"
CONTROLS = json.loads((ROOT / "shared" / "avatar-appearance-controls.json").read_text(encoding="utf-8"))["parameters"]
WRITE_LOCK = threading.Lock()


class AppearancePreset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1] = 1
    model: Literal["MO.v2.7"] = "MO.v2.7"
    parameters: dict[str, float] = Field(default_factory=dict, validate_default=True)

    @field_validator("parameters", mode="before")
    @classmethod
    def normalize_parameters(cls, parameters):
        if not isinstance(parameters, dict) or parameters.keys() - CONTROLS.keys():
            raise ValueError("Only supported appearance parameters can be saved.")
        result = {}
        for parameter, control in CONTROLS.items():
            value = parameters.get(parameter, control["default"])
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("Appearance values must be numbers.")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError("Appearance values must be finite.")
            value = max(control["min"], min(control["max"], value))
            result[parameter] = math.floor(value + .5) if control["type"] == "choice" else value
        return result


def load_appearance() -> AppearancePreset:
    try:
        content = PRESET_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return AppearancePreset()
    # No process-local cache: changes are visible across workers and restarts.
    return AppearancePreset.model_validate_json(content)


def save_appearance(preset: AppearancePreset) -> AppearancePreset:
    with WRITE_LOCK:
        PRESET_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            # Replace only after the whole JSON has reached disk. Readers see
            # either the old preset or the new one, never a half-written file.
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=PRESET_PATH.parent,
                                             prefix=".avatar-appearance-", suffix=".tmp", delete=False) as output:
                temporary = Path(output.name)
                output.write(preset.model_dump_json(indent=2) + "\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, PRESET_PATH)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return preset

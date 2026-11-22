import json
from pathlib import Path

# JSON usado como prova de conceito; em produção os dados viriam de um banco de dados.
DATA_PATH = Path(__file__).parent.parent.parent / "data" / "context.json"


def _get_json_data() -> dict:
    try:
        with open(DATA_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"Error on getting json data: {e}")
        raise RuntimeError("Database not found.")


def get_locais() -> dict:
    """
    Obtém informações de locais da faculdade
    """
    data = _get_json_data()
    return data.get("locais", {})


def get_coordenacao() -> dict:
    """
    Obtém informações sobre a coordenação, coordenadores e horários de atendimento.
    """
    data = _get_json_data()
    return data.get("coordenacao", {})


AVAILABLE_TOOLS = {
    "get_locais": get_locais,
    "get_coordenacao": get_coordenacao,
}
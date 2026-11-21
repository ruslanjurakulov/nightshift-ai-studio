"""Schema-constrained JSON from Gemini — the roadmap #50 spike.

Every Gemini call in this project that wants structured data does the same
fragile thing: it asks for JSON *in the prompt*, then strips ``` fences and
regex-extracts a ``{...}`` blob out of free-form text (see the near-identical
``_extract_json`` in script_engine, research_engine, fact_checker, …). That
works until the model wraps the object in prose, truncates it, or emits two
objects — then the regex grabs the wrong span and the parse throws.

The google-genai SDK offers a first-class alternative: set
``response_mime_type="application/json"`` and a ``response_schema`` on the
request, and the model is *constrained* to emit exactly that shape. The SDK
then hands the parsed object back on ``response.parsed`` — no fences, no regex.

This module is the shared, dependency-light seam for trying that:

  * ``json_config`` builds the JSON-mode ``GenerateContentConfig`` (carrying an
    optional system instruction), tolerating an environment where the genai
    types aren't importable by returning ``None`` — the caller then falls back
    to its existing free-text path, so importing this module never breaks.
  * ``parse_structured`` reads ``response.parsed`` first and only drops to the
    same fence-strip / regex extraction the modules already use when the SDK
    gave back no parsed object. It never *silently* returns nothing: an
    unparseable response still raises ``ValueError``, exactly like today.

Deciding whether ``response_schema`` earns a project-wide rollout — and whether
a full LLM-provider interface is worth building on top — is the point of the
spike. Wiring is opt-in behind ``config.GEMINI_STRUCTURED_OUTPUT`` (default
off), so nothing here changes a live run until that flag is set.
"""

import json
import re
from typing import Any, Optional

JSON_MIME_TYPE = "application/json"


def json_config(
    schema: Optional[Any] = None,
    *,
    system_instruction: Optional[str] = None,
) -> Optional[Any]:
    """Build a JSON-mode ``GenerateContentConfig``.

    ``schema`` is anything the SDK accepts as ``response_schema`` — a
    ``genai.types.Schema``, a plain OpenAPI-subset ``dict``, or a pydantic
    model. ``None`` asks for JSON MIME type without constraining the shape,
    which still stops the model wrapping the object in prose.

    Returns ``None`` when the genai types can't be imported, so a caller can
    treat that as "structured mode unavailable, use the text path" rather than
    crashing on import — the same defensive stance research_engine already
    takes for its system-instruction config.
    """
    try:
        from google.genai import types as genai_types
    except ImportError:  # pragma: no cover - defensive only
        return None

    kwargs: dict[str, Any] = {"response_mime_type": JSON_MIME_TYPE}
    if schema is not None:
        kwargs["response_schema"] = schema
    if system_instruction:
        kwargs["system_instruction"] = system_instruction
    return genai_types.GenerateContentConfig(**kwargs)


def _extract_json(text: str) -> Any:
    """Strip markdown fences and pull the JSON value out of free-form text.

    Mirrors the ``_extract_json`` duplicated across the Gemini-calling modules
    so the fallback path behaves identically to what those modules do today.
    """
    stripped = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
    stripped = re.sub(r"\s*```$", "", stripped.strip(), flags=re.MULTILINE)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        # An object or an array, whichever appears first — matched non-greedily
        # from the first opening bracket to the last matching close.
        match = re.search(r"\{[\s\S]*\}|\[[\s\S]*\]", stripped)
        if match:
            return json.loads(match.group())
        raise ValueError("Gemini did not return valid JSON") from None


def parse_structured(response: Any) -> Any:
    """Return the JSON value from a Gemini response.

    Prefers ``response.parsed`` — the object the SDK builds when the request
    carried a ``response_schema``. Falls back to extracting JSON from
    ``response.text`` when ``.parsed`` is absent or ``None`` (a call made
    without a schema, or an older SDK), so this one function serves both the
    structured and the legacy free-text paths.

    A pydantic model on ``.parsed`` is converted to a plain dict via
    ``model_dump`` so callers always get JSON-native containers. Raises
    ``ValueError`` when neither path yields parseable JSON — the failure is
    never swallowed.
    """
    parsed = getattr(response, "parsed", None)
    if parsed is not None:
        model_dump = getattr(parsed, "model_dump", None)
        if callable(model_dump):
            return model_dump()
        return parsed

    text = getattr(response, "text", None)
    if not text or not str(text).strip():
        raise ValueError("Gemini response carried neither parsed JSON nor text")
    return _extract_json(str(text))

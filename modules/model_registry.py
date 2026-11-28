"""The model registry: what each generative model can do, read from one file.

``schemas/model_registry.json`` is the reviewed source of truth for a model's
static facts — capabilities, inputs, resolutions, durations, which adapter
talks to it, the vendor model string, where its API is documented and how
well, how it is priced (a ``credit_prices`` unit), the plan entitlement it
needs, vendor terms that gate it, and its limits. The Python worker reads it
here; ``tools/probe_models.py --sync`` copies the static facts into the
database so SQL can price and validate server-side (docs/CREATIVE_OS_PLAN.md §3.2).

What the file deliberately does NOT hold is whether a model is available.
That is ``model_registry.availability`` + ``verified_at`` in the database
(migration 0035), which refuses ``beta``/``ga`` until a real probe call has
succeeded with the owner's key. A model is never "available" because someone
typed it into a JSON file (CLAUDE.md #5).

The file is validated against ``schemas/model_registry.schema.json`` itself,
by the small evaluator below (the worker image ships no jsonschema package),
and then by the cross-field rules a schema cannot express.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import unquote

from modules.capabilities import ADAPTERS
from modules.capabilities.base import (
    CAPTIONS,
    DESCRIBE,
    MUSIC,
    DUB,
    ERASE,
    EXPAND,
    EXPAND_ASPECTS,
    FILE_INPUT,
    I2V,
    IMAGE_INPUT,
    QUALITY_CAPABILITIES,
    MEDIA_INPUT,
    VIDEO_VARIANT_CAPABILITIES,
    OUTPUT_OF,
    PICTURE_OPS,
    PROMPT_OPTIONAL,
    REGISTRY_ONLY_CAPABILITIES,
    RELIGHT,
    RELIGHT_LOOKS,
    UPSCALE,
    VIDEO_CHARACTER_SWAP,
    VIDEO_EDIT,
    VIDEO_INPUT,
    VIDEO_MUSIC,
    VIDEO_OPS,
    VIDEO_REFRAME,
    VIDEO_REMOVE_BG,
    VIDEO_UPSCALE,
    TTS,
    CapabilityRequest,
)

SCHEMAS = Path(__file__).resolve().parent.parent / "schemas"
REGISTRY_PATH = SCHEMAS / "model_registry.json"
SCHEMA_PATH = SCHEMAS / "model_registry.schema.json"

#: ``credit_prices.unit`` must match this (migration 0020's CHECK).
CREDIT_UNIT_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
#: A terms gate keeps a model unsellable in SQL until the owner clears it.
TERMS_GATES = ("written_consent_required", "terms_review_required", "plan_required:scale")


class RegistryError(ValueError):
    pass


# ── a JSON Schema evaluator for the keywords our schema uses ────────────────
#: Keywords the evaluator understands. A schema that uses any other keyword is
#: rejected outright, so an edit cannot silently add a rule nobody enforces.
SUPPORTED_KEYWORDS = frozenset({
    "$schema", "$id", "$ref", "$defs", "title", "description",
    "type", "enum", "const", "required", "properties", "additionalProperties", "propertyNames",
    "minProperties", "items", "minItems", "maxItems", "uniqueItems",
    "pattern", "minLength", "maxLength", "minimum", "maximum",
})


def unsupported_keywords(schema: Any, path: str = "#") -> List[str]:
    out: List[str] = []
    if isinstance(schema, Mapping):
        for k, v in schema.items():
            if k not in SUPPORTED_KEYWORDS:
                out.append(f"{path}/{k}")
            if k in ("properties", "$defs"):
                for name, sub in (v or {}).items():
                    out.extend(unsupported_keywords(sub, f"{path}/{k}/{name}"))
            elif k in ("items", "additionalProperties", "propertyNames") and isinstance(v, Mapping):
                out.extend(unsupported_keywords(v, f"{path}/{k}"))
    return out


def _type_ok(value: Any, t: str) -> bool:
    if t == "null":
        return value is None
    if t == "boolean":
        return isinstance(value, bool)
    if t == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "string":
        return isinstance(value, str)
    if t == "array":
        return isinstance(value, list)
    if t == "object":
        return isinstance(value, dict)
    return False


def _resolve(root: Mapping, ref: str) -> Mapping:
    if not ref.startswith("#/"):
        raise RegistryError(f"only local $ref is supported: {ref}")
    node: Any = root
    for part in ref[2:].split("/"):
        node = node[part]
    return node


def schema_errors(value: Any, schema: Mapping, root: Optional[Mapping] = None, at: str = "$") -> List[str]:
    """Every way ``value`` breaks ``schema`` (draft 2020-12 semantics for the
    supported keywords: a type-specific keyword applies only to that type)."""
    root = root if root is not None else schema
    if "$ref" in schema:
        return schema_errors(value, _resolve(root, schema["$ref"]), root, at)
    errs: List[str] = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, t) for t in types):
            return [f"{at}: expected {'/'.join(types)}"]
    if "enum" in schema and value not in schema["enum"]:
        errs.append(f"{at}: {value!r} is not one of {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        errs.append(f"{at}: must be {schema['const']!r}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errs.append(f"{at}: {value!r} does not match {schema['pattern']}")
        if len(value) < schema.get("minLength", 0):
            errs.append(f"{at}: shorter than {schema['minLength']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errs.append(f"{at}: longer than {schema['maxLength']}")
    if _type_ok(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            errs.append(f"{at}: below {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errs.append(f"{at}: above {schema['maximum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errs.append(f"{at}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errs.append(f"{at}: more than {schema['maxItems']} items")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errs.append(f"{at}: items are not unique")
        if isinstance(schema.get("items"), Mapping):
            for i, item in enumerate(value):
                errs.extend(schema_errors(item, schema["items"], root, f"{at}[{i}]"))
    if isinstance(value, dict):
        for k in schema.get("required", []):
            if k not in value:
                errs.append(f"{at}: missing {k}")
        if len(value) < schema.get("minProperties", 0):
            errs.append(f"{at}: fewer than {schema['minProperties']} properties")
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for k, v in value.items():
            if isinstance(schema.get("propertyNames"), Mapping):
                errs.extend(schema_errors(k, schema["propertyNames"], root, f"{at}.<{k}>"))
            if k in props:
                errs.extend(schema_errors(v, props[k], root, f"{at}.{k}"))
            elif extra is False:
                errs.append(f"{at}: unknown field {k}")
            elif isinstance(extra, Mapping):
                errs.extend(schema_errors(v, extra, root, f"{at}.{k}"))
    return errs


@lru_cache(maxsize=1)
def load_schema() -> Mapping:
    return json.loads(SCHEMA_PATH.read_text())


# ── entries ─────────────────────────────────────────────────────────────────
#: Price variants that name the soundtrack (0070). Keys: ``silent`` / ``audio``,
#: or ``<resolution>_silent`` / ``<resolution>_audio`` for resolution_audio.
AUDIO_VARIANTS = ("audio", "resolution_audio")
AUDIO_STATES = ("silent", "audio")


def credit_unit_for(model_id: str, unit: str, variant: Optional[str] = None) -> str:
    """The ``credit_prices`` unit a model is sold by: ``model_<id>_<unit>``,
    plus ``_<variant>`` for a priced variant (a resolution / image size)."""
    base = "model_" + re.sub(r"[^a-z0-9]", "_", model_id.lower()) + "_" + unit
    return base if variant is None else base + "_" + re.sub(r"[^a-z0-9]", "_", variant.lower())


def prompt_units(text: str) -> int:
    """Prompt length in UTF-16 code units — what the strictest vendor
    (Runway) counts, and never fewer than Python's code points."""
    return len((text or "").encode("utf-16-le")) // 2


@dataclass(frozen=True)
class ModelEntry:
    id: str
    display_name: str
    provider: str
    adapter: str
    vendor_model: str
    vendor_model_by_capability: Mapping[str, str]
    capabilities: Tuple[str, ...]
    output: str
    image_refs_max: int
    aspect_ratios: Tuple[str, ...]
    aspect_ratios_by_capability: Mapping[str, Tuple[str, ...]]
    image_sizes: Tuple[str, ...]
    #: Render qualities the model bills by (t2i / edit; 0060), cheapest first;
    #: empty = the model has no tiers and takes no ``quality``.
    qualities: Tuple[str, ...]
    resolutions: Tuple[str, ...]
    #: The resolution a video job runs at when it names none (0070): the
    #: quote prices it and the worker sends it, never the vendor's own
    #: default. None = the model's price does not depend on the resolution.
    default_resolution: Optional[str]
    durations_s: Tuple[int, ...]
    #: Upscale factors the model is sold for (empty unless it lists upscale).
    upscale_factors: Tuple[int, ...]
    #: Languages a dub is made in (empty unless it lists dub; 0050).
    languages: Tuple[str, ...]
    #: Output resolutions a video upscale is sold at (empty unless it lists
    #: video_upscale; 0052). The vendor takes a target, not a factor.
    upscale_targets: Tuple[str, ...]
    #: The model can end an i2v clip on a chosen picture (0052).
    end_frame: bool
    #: The lights a relight is sold for (0099); empty unless it lists relight.
    relight_looks: Tuple[str, ...]
    #: The longest source a file tool takes, in seconds (limits.max_source_seconds).
    max_source_seconds: Optional[int]
    audio_out: bool
    is_async: bool
    api_documented_url: str
    doc_source: str
    credit_unit: str
    entitlement: Optional[str]
    terms_gate: Optional[str]
    api_exposure: str
    max_prompt_chars: int
    max_concurrent_per_org: int
    #: The adapter puts negative_prompt in the vendor's request (registry ``takes_negative_prompt``, default false). A model that does
    #: not is refused one, by the quote (0218) and here: never charged for and silently dropped (CLAUDE.md #4).
    takes_negative_prompt: bool
    #: The adapter's own negative prompt limit, in characters (``limits.max_negative_prompt_chars``; Krea: 1024). None = none of its own.
    max_negative_prompt_chars: Optional[int]
    quality_tier: int
    speed_tier: int
    raw: Mapping

    @property
    def variants_by(self) -> Optional[str]:
        return (self.raw["pricing"].get("variants") or {}).get("by")

    @property
    def priced_by_audio(self) -> bool:
        """The soundtrack is priced apart (0070): the worker pins it off unless the job asks."""
        return self.variants_by in AUDIO_VARIANTS

    @property
    def shutdown_on(self) -> Optional[date]:
        """The date the vendor announced it may shut the vendor model down
        (``shutdown.on``), or None when none is announced. Not a measurement
        that the model works before it nor that it is dead after it."""
        s = self.raw.get("shutdown")
        return date.fromisoformat(s["on"]) if s else None

    def shut_down(self, on: Optional[date] = None) -> bool:
        """True from the announced shutdown date on (UTC, like the database's
        ``(now() at time zone 'utc')::date``, whatever the session's TimeZone): the model is no longer offered or quoted
        (migration 0125). An entry with no announced date is never shut down
        here; that means "none announced", not "safe"."""
        d = self.shutdown_on
        return d is not None and d <= (on or datetime.now(timezone.utc).date())

    @property
    def registry_only(self) -> bool:
        """The entry lists a capability the database does not know yet (``REGISTRY_ONLY_CAPABILITIES``): it exists in the file
        and nowhere else. It is not synced, not probed and has no row a price or a job could hang on."""
        return bool(REGISTRY_ONLY_CAPABILITIES & set(self.capabilities))

    def vendor_model_for(self, capability: str) -> str:
        return self.vendor_model_by_capability.get(capability) or self.vendor_model

    def aspects_for(self, capability: str) -> Tuple[str, ...]:
        return tuple(self.aspect_ratios_by_capability.get(capability) or self.aspect_ratios)

    def problems(self, request: CapabilityRequest) -> List[str]:
        """Capability detection: why this model cannot serve ``request``. Pure.
        An empty list in the registry means the model takes no such setting,
        so a request that sets it is refused rather than silently ignored."""
        out: List[str] = []
        cap = request.capability
        if cap not in self.capabilities:
            out.append(f"{self.id} does not support {cap}")
        if cap not in PROMPT_OPTIONAL and not (request.prompt or "").strip():
            out.append("prompt is empty")
        if prompt_units(request.prompt) > self.max_prompt_chars:
            out.append(f"prompt is longer than {self.max_prompt_chars} characters")
        # The worker's backstop for 0218's quote check: a job created before it (or by a path that skipped the quote) still never
        # reaches an adapter that would drop its negative prompt.
        if (request.negative_prompt or "").strip() and not self.takes_negative_prompt:
            out.append(f"{self.id} does not take a negative prompt; remove it or choose a model that does")
        aspects = self.aspects_for(cap)
        if request.aspect_ratio and request.aspect_ratio not in aspects:
            out.append(f"aspect ratio {request.aspect_ratio} is not offered for {cap} by {self.id}")
        if request.resolution and request.resolution not in self.resolutions:
            out.append(f"resolution {request.resolution} is not offered by {self.id}")
        if request.image_size and request.image_size not in self.image_sizes:
            out.append(f"image size {request.image_size} is not offered by {self.id}")
        if request.quality is not None:
            if cap not in QUALITY_CAPABILITIES:
                out.append(f"a quality does not apply to {cap}")
            elif request.quality not in self.qualities:
                out.append(f"quality {request.quality} is not offered by {self.id}")
        if request.duration_s is not None and request.duration_s not in self.durations_s:
            out.append(f"duration {request.duration_s}s is not offered by {self.id}")
        if request.audio and not self.audio_out:
            out.append(f"{self.id} does not generate audio")
        if cap in IMAGE_INPUT and not request.input_images:
            out.append(f"{cap} needs an input image")
        if cap == UPSCALE and request.scale not in self.upscale_factors:
            out.append(f"{self.id} does not offer a {request.scale}x upscale")
        if cap != UPSCALE and request.scale is not None:
            out.append(f"an upscale factor does not apply to {cap}")
        if len(request.input_images) > self.image_refs_max:
            out.append(f"{self.id} takes at most {self.image_refs_max} input image(s)")
        if cap in MEDIA_INPUT and not request.input_media:
            out.append(f"{cap} needs a recording")
        if cap in VIDEO_INPUT and not request.input_media:
            out.append(f"{cap} needs a video")
        if cap not in FILE_INPUT and request.input_media:
            out.append(f"a recording does not apply to {cap}")
        if request.end_image and (cap != I2V or not self.end_frame):
            out.append(f"{self.id} cannot end a clip on a chosen frame")
        if cap == VIDEO_UPSCALE and request.upscale_target not in self.upscale_targets:
            out.append(f"{self.id} does not upscale a video to {request.upscale_target or '(no target)'}")
        if cap != VIDEO_UPSCALE and request.upscale_target is not None:
            out.append(f"an upscale target does not apply to {cap}")
        if cap == DUB and request.target_language not in self.languages:
            out.append(f"{self.id} does not dub into {request.target_language or '(no language)'}")
        if cap != DUB and request.target_language is not None:
            out.append(f"a target language does not apply to {cap}")
        if cap != DESCRIBE and request.output_language is not None:
            out.append(f"an output language does not apply to {cap}")
        # Captions (0072) sell a spoken language only when the model was proven for it.
        if cap == CAPTIONS and request.spoken_language is not None and request.spoken_language not in self.languages:
            out.append(f"{self.id} does not transcribe {request.spoken_language}")
        if cap != CAPTIONS and request.spoken_language is not None:
            out.append(f"a spoken language does not apply to {cap}")
        # The picture ops (0099) are sold only for the shapes and lights the model was proven for.
        if cap in (EXPAND, VIDEO_REFRAME) and not request.aspect_ratio:
            out.append(f"{cap} needs the shape to change the {'video' if cap == VIDEO_REFRAME else 'picture'} to")
        if cap in (RELIGHT, ERASE) and request.aspect_ratio:
            out.append(f"{cap} keeps the picture's own shape: an aspect ratio does not apply")
        # The video ops (0100): the edit is asked by its words; the others keep or name the shape.
        if cap in (VIDEO_EDIT, VIDEO_REMOVE_BG) and request.aspect_ratio:
            out.append(f"{cap} keeps the video's own shape: an aspect ratio does not apply")
        if cap == RELIGHT and request.look is not None and request.look not in self.relight_looks:
            out.append(f"{self.id} does not relight with the {request.look} look")
        if cap != RELIGHT and request.look is not None:
            out.append(f"a look does not apply to {cap}")
        return out

    def probe_request(self, *, voice_id: Optional[str] = None,
                      generated_image: Optional[str] = None,
                      generated_speech: Optional[str] = None,
                      generated_end_image: Optional[str] = None,
                      generated_video: Optional[str] = None) -> CapabilityRequest:
        """The cheapest real request this model is probed with (registry ``probe``).

        A voice tool's probe (``input_audio: "speech"``) starts from a short
        clip of the probe's ``prompt`` spoken by TTS (tools/probe_models.py
        makes it): the prompt is the words of that clip, not part of the
        request — and a dub needs no voice (its speakers keep their own).
        A video upscale's probe (``input_video``) starts from a short test
        pattern ffmpeg draws; an end-frame probe (``end_frame``) ends on a
        second drawn picture, so what is sold is what was proven (0052)."""
        p = self.raw["probe"]
        images: Sequence[str] = ()
        media: Sequence[str] = ()
        if p.get("input_image") == "generated":
            images = (generated_image or "<generated>",)
        speech = p.get("input_audio") == "speech"
        if speech:
            media = (generated_speech or "<speech>.mp3",)
        if p.get("input_video") == "generated":
            media = (generated_video or "<video>.mp4",)
        end = (generated_end_image or "<generated end>") if p.get("end_frame") == "generated" else None
        cap = p["capability"]
        # A description takes no words of ours either: the picture is the input.
        # An expand is asked by its shape, and a relight by its look when the
        # probe names one (the database sends exactly one of look / prompt).
        # A video edit and a character swap are asked by their words; the other video tools take none.
        # A picture upscale takes none either: Ideogram's (Topaz Standard V2, the one wired) refuses a prompt.
        wordless = (speech or (cap in VIDEO_INPUT and cap not in (VIDEO_EDIT, VIDEO_CHARACTER_SWAP)) or cap == DESCRIBE or cap == EXPAND
                    or cap == UPSCALE or (cap == RELIGHT and p.get("look")))
        return CapabilityRequest(capability=cap, prompt="" if wordless else p["prompt"],
                                 look=p.get("look"),
                                 aspect_ratio=p.get("aspect_ratio"), resolution=p.get("resolution"),
                                 image_size=p.get("image_size"), quality=p.get("quality"),
                                 duration_s=p.get("duration_s"),
                                 voice_id=None if cap in (DUB, CAPTIONS) else voice_id, input_images=tuple(images),
                                 scale=p.get("factor"), input_media=tuple(media),
                                 target_language=p.get("target_language"), end_image=end,
                                 upscale_target=p.get("upscale_target"))


def _entry(m: Mapping) -> ModelEntry:
    return ModelEntry(
        id=m["id"], display_name=m["display_name"], provider=m["provider"], adapter=m["adapter"],
        vendor_model=m["vendor_model"], vendor_model_by_capability=dict(m.get("vendor_model_by_capability") or {}),
        capabilities=tuple(m["capabilities"]), output=m["output"],
        image_refs_max=int(m["inputs"]["image_refs_max"]), aspect_ratios=tuple(m["aspect_ratios"]),
        aspect_ratios_by_capability={k: tuple(v) for k, v in (m.get("aspect_ratios_by_capability") or {}).items()},
        image_sizes=tuple(m.get("image_sizes") or ()),
        qualities=tuple(m.get("qualities") or ()),
        resolutions=tuple(m["resolutions"]), default_resolution=m.get("default_resolution"),
        durations_s=tuple(m["durations_s"]),
        upscale_factors=tuple(m.get("upscale_factors") or ()),
        languages=tuple(m.get("languages") or ()),
        upscale_targets=tuple(m.get("upscale_targets") or ()),
        end_frame=bool(m.get("end_frame")),
        relight_looks=tuple(m.get("relight_looks") or ()),
        max_source_seconds=m["limits"].get("max_source_seconds"),
        audio_out=bool(m["audio_out"]), is_async=bool(m["async"]),
        api_documented_url=m["api_documented"]["url"], doc_source=m["api_documented"]["source"],
        credit_unit=m["credit_unit"], entitlement=m["entitlement"], terms_gate=m["terms_gate"],
        api_exposure=m["api_exposure"], max_prompt_chars=int(m["limits"]["max_prompt_chars"]),
        max_concurrent_per_org=int(m["limits"]["max_concurrent_per_org"]),
        takes_negative_prompt=m.get("takes_negative_prompt") is True,
        max_negative_prompt_chars=m["limits"].get("max_negative_prompt_chars"),
        quality_tier=int(m["quality_tier"]), speed_tier=int(m["speed_tier"]), raw=m,
    )


def _err(mid: str, msg: str) -> str:
    return f"{mid or '?'}: {msg}"


_BYTEDANCE_RE = re.compile(r"seedance|seedream")


def is_bytedance(m: Mapping) -> bool:
    """A ByteDance / BytePlus model, however it is named: the same test as migration 0219's oauth_creative_bytedance (the id, the
    provider, the adapter, the vendor's own model id)."""
    return bool(_BYTEDANCE_RE.search(str(m.get("id") or "").lower())
                or str(m.get("provider") or "").lower() in ("bytedance", "byteplus")
                or re.match(r"(video\.seedance|image\.seedream)", str(m.get("adapter") or "").lower())
                or _BYTEDANCE_RE.search(str(m.get("vendor_model") or "").lower()))


def _cross_errors(models: Sequence[Mapping]) -> List[str]:
    """Rules a JSON Schema cannot say: uniqueness, adapters that exist and can
    serve the listed capabilities, prices with a source, units that 0020
    accepts, and a probe the entry itself would accept."""
    errors: List[str] = []
    seen_ids, seen_units = set(), set()
    for m in models:
        mid = m["id"]
        caps = list(m["capabilities"])
        if mid in seen_ids:
            errors.append(_err(mid, "duplicate id"))
        seen_ids.add(mid)
        if any(OUTPUT_OF[c] != m["output"] for c in caps):
            errors.append(_err(mid, "a capability does not produce this output"))
        cls = ADAPTERS.get(m["adapter"])
        if cls is None:
            errors.append(_err(mid, f"adapter {m['adapter']!r} does not exist"))
        elif any(c not in cls.capabilities for c in caps):
            errors.append(_err(mid, f"adapter {m['adapter']} cannot serve {caps}"))
        for key in ("vendor_model_by_capability", "aspect_ratios_by_capability"):
            if any(c not in caps for c in (m.get(key) or {})):
                errors.append(_err(mid, f"{key} names a capability the model does not list"))
        if any(a not in m["aspect_ratios"] for v in (m.get("aspect_ratios_by_capability") or {}).values() for a in v):
            errors.append(_err(mid, "aspect_ratios_by_capability must narrow aspect_ratios"))
        # inputs.prompt_required is what the Studio reads to ask for words before a press: it may only name the model's own
        # capabilities, and it must name every one its adapter refuses without words (a job with none used to fail after
        # the press with a vague "settings were not accepted").
        words = list(m["inputs"].get("prompt_required") or [])
        if any(c not in caps for c in words):
            errors.append(_err(mid, "inputs.prompt_required names a capability the model does not list"))
        if cls is not None:
            needed = [c for c in caps if c in getattr(cls, "prompt_required_capabilities", ())]
            if any(c not in words for c in needed):
                errors.append(_err(mid, f"adapter {m['adapter']} needs words for {needed}: list them in inputs.prompt_required"))
        # inputs.ref_capabilities is the adapter's reference_capabilities as the database sees them: film_price (0235) refuses a key
        # frame with references unless it lists t2i, because the adapter refuses references on any other capability at submit, after
        # the film's hold (a priced film that cannot be made). Stated on every image model, and never other than the adapter's.
        refs_on = m["inputs"].get("ref_capabilities")
        if cls is not None and (m["output"] == "image" or refs_on is not None):
            want = [c for c in getattr(cls, "reference_capabilities", ()) if c in caps]
            if refs_on is None:
                errors.append(_err(mid, f"inputs.ref_capabilities is required on an image model: {want} (adapter {m['adapter']})"))
            elif sorted(refs_on) != sorted(want):
                errors.append(_err(mid, f"inputs.ref_capabilities must be {want}, what adapter {m['adapter']} sends references on"))
        if any(c in IMAGE_INPUT for c in caps) and m["inputs"]["image_refs_max"] < 1:
            errors.append(_err(mid, "a capability that takes an image needs image_refs_max >= 1"))
        if (UPSCALE in caps) != bool(m.get("upscale_factors")):
            # 0046 sells an upscale only at a factor the model lists.
            errors.append(_err(mid, "upscale_factors is required with upscale and only with it"))
        if (RELIGHT in caps) != bool(m.get("relight_looks")):
            # 0099 sells a relight by name only in a light the model lists.
            errors.append(_err(mid, "relight_looks is required with relight and only with it"))
        if any(k not in RELIGHT_LOOKS for k in (m.get("relight_looks") or ())):
            errors.append(_err(mid, "relight_looks must be lights the database accepts"))
        expand_shapes = (m.get("aspect_ratios_by_capability") or {}).get(EXPAND)
        if (EXPAND in caps) != bool(expand_shapes):
            # 0099 sells an expand only to a shape the model lists for it.
            errors.append(_err(mid, "aspect_ratios_by_capability.expand is required with expand and only with it"))
        if any(a not in EXPAND_ASPECTS for a in (expand_shapes or ())):
            errors.append(_err(mid, "expand shapes must be shapes the database accepts"))
        if any(c in PICTURE_OPS for c in caps) and any(c not in PICTURE_OPS for c in caps):
            errors.append(_err(mid, "a picture-op model lists only picture ops"))
        if any(c in PICTURE_OPS for c in caps) and m["api_exposure"] != "web_only":
            errors.append(_err(mid, "picture ops are a web tool until the API documents them: api_exposure must be web_only"))
        if (DUB in caps or CAPTIONS in caps or TTS in caps) != bool(m.get("languages")):
            # 0050 sells a dub only into a language the model lists; 0072
            # sells captions only in a spoken language it lists. A voice model
            # lists what it speaks so a film's quote can refuse an Uzbek film
            # read by a model that does not speak Uzbek before the hold (0214),
            # and so the Brain proposes only a voice that speaks the film's
            # language. A voice model without the list would read as "unknown"
            # there, never as "speaks", so the entry may not omit it.
            errors.append(_err(mid, "languages is required with dub, captions or tts and only with them"))
        if (VIDEO_UPSCALE in caps) != bool(m.get("upscale_targets")):
            # 0052 sells a video upscale only at a target the model lists.
            errors.append(_err(mid, "upscale_targets is required with video_upscale and only with it"))
        if VIDEO_UPSCALE in caps and not m["limits"].get("max_source_seconds"):
            # 0052 prices the source's seconds: a model without a documented
            # longest input would be sold a length the vendor refuses.
            errors.append(_err(mid, "video_upscale needs limits.max_source_seconds"))
        if any(c in VIDEO_OPS for c in caps) and not m["limits"].get("max_source_seconds"):
            # 0100 prices the source's seconds the same way.
            errors.append(_err(mid, "a video op needs limits.max_source_seconds"))
        reframe_shapes = (m.get("aspect_ratios_by_capability") or {}).get(VIDEO_REFRAME)
        if (VIDEO_REFRAME in caps) != bool(reframe_shapes):
            # 0100 sells a reframe only to a shape the model lists for it.
            errors.append(_err(mid, "aspect_ratios_by_capability.video_reframe is required with video_reframe and only with it"))
        if any(a not in EXPAND_ASPECTS for a in (reframe_shapes or ())):
            errors.append(_err(mid, "reframe shapes must be shapes the database accepts"))
        if any(c in VIDEO_OPS for c in caps) and m["api_exposure"] != "web_only":
            errors.append(_err(mid, "video ops are a web tool until the API documents them: api_exposure must be web_only"))
        if CAPTIONS in caps and m["api_exposure"] != "web_only":
            # The transcript is read from caption_tracks by a signed-in member's
            # session only (0072): an API key that bought captions could never
            # fetch the result, so the registry never offers them to the API.
            errors.append(_err(mid, "captions are a web tool: api_exposure must be web_only"))
        if any(c in VIDEO_INPUT for c in caps) and any(c not in VIDEO_INPUT for c in caps):
            errors.append(_err(mid, "a video tool model lists only video tools"))
        if VIDEO_MUSIC in caps and not m["limits"].get("max_source_seconds"):
            # The vendor bills the video's seconds: without a documented longest input a length it refuses would be sold.
            errors.append(_err(mid, "video_music needs limits.max_source_seconds"))
        if m["pricing"]["unit"] == "request" and not set(caps) <= {MUSIC, DESCRIBE}:
            # BR-0228-01/02: 0228 quotes a per-request MUSIC model for one request, and every other capability by its own quantity
            # (a region edit by its regions, a video op by its source's seconds). A per-request price on any other capability would
            # be multiplied by that quantity, or by none: refused here until a migration says how such a model is quoted.
            errors.append(_err(mid, "pricing.unit request is for music and describe models only"))
        if REGISTRY_ONLY_CAPABILITIES & set(caps):
            # The database's capability lists (0100) do not hold these. The entry is left out of the sync, so it must be
            # dark by its own fields too, and must not carry a capability the sync would then silently drop with it.
            if any(c not in REGISTRY_ONLY_CAPABILITIES for c in caps):
                errors.append(_err(mid, "a capability the database does not know yet is never listed beside one it knows"))
            if not m["terms_gate"] or m["api_exposure"] != "web_only" or m["pricing"]["confirmed"]:
                errors.append(_err(mid, "a registry-only entry stays dark: terms_gate set, api_exposure web_only, price unconfirmed"))
        swap = m.get("character_swap")
        if (VIDEO_CHARACTER_SWAP in caps) != bool(swap):
            # 0137 quotes the input's seconds against these limits, and the worker refuses an input outside them before it pays.
            errors.append(_err(mid, "character_swap is required with video_character_swap and only with it"))
        elif swap:
            lo, hi = swap["input_seconds"]
            if not lo <= hi or hi > (m["limits"].get("max_source_seconds") or 0):
                errors.append(_err(mid, "character_swap.input_seconds must be a range within limits.max_source_seconds"))
            if swap["reference_images_max"] != m["inputs"]["image_refs_max"]:
                errors.append(_err(mid, "character_swap.reference_images_max must equal inputs.image_refs_max"))
            if sorted(((m["pricing"].get("variants") or {}).get("prices") or {})) != sorted(m["resolutions"]) or not m["resolutions"]:
                # Each resolution the person can pick is shown its own price (0137 character_swap_models): none may be missing.
                errors.append(_err(mid, "a character swap is priced per resolution: one price for each listed resolution"))
            if swap["real_people"] == "own_generated_clip_only" and m["provider"] != "bytedance":
                errors.append(_err(mid, "own_generated_clip_only is BytePlus's 30-day rule"))
        if cls is not None and (m.get("takes_negative_prompt") is True) != bool(getattr(cls, "TAKES_NEGATIVE_PROMPT", False)):
            # 0218 sells a negative prompt only to a model that says it takes one: the file must say exactly what the adapter sends
            # (true on an adapter that drops it is a paid setting never used; false on one that sends it refuses what works).
            errors.append(_err(mid, f"takes_negative_prompt must be {bool(getattr(cls, 'TAKES_NEGATIVE_PROMPT', False))} "
                                    f"for adapter {m['adapter']}"))
        neg_max = m["limits"].get("max_negative_prompt_chars")
        if neg_max is not None and m.get("takes_negative_prompt") is not True:
            errors.append(_err(mid, "limits.max_negative_prompt_chars is for a model that takes a negative prompt"))
        if cls is not None and m.get("takes_negative_prompt") is True and neg_max != getattr(cls, "MAX_NEGATIVE_CHARS", None):
            # The quote (0218) refuses past this number; the adapter refuses past its own. They must be one number.
            errors.append(_err(mid, f"limits.max_negative_prompt_chars must be the adapter's own limit "
                                    f"({getattr(cls, 'MAX_NEGATIVE_CHARS', None)})"))
        if m.get("end_frame"):
            if I2V not in caps:
                errors.append(_err(mid, "end_frame is for a model that animates a picture (i2v)"))
            elif cls is not None and I2V not in cls.end_frame_capabilities:
                # The adapter would drop the picture: the clip would not end where asked.
                errors.append(_err(mid, f"adapter {m['adapter']} does not send an end frame"))
        if m["probe"].get("end_frame") and not m.get("end_frame"):
            errors.append(_err(mid, "only a model with end_frame is probed with one"))
        if (m["probe"].get("input_video") == "generated") != (m["probe"]["capability"] in VIDEO_INPUT):
            errors.append(_err(mid, "a video tool is probed from a drawn video (probe.input_video), and only a video tool"))
        probe_speech = m["probe"].get("input_audio") == "speech"
        if probe_speech != (m["probe"]["capability"] in MEDIA_INPUT):
            errors.append(_err(mid, "a voice tool is probed from speech (probe.input_audio), and only a voice tool"))
        if any(c in MEDIA_INPUT for c in caps) and any(c not in MEDIA_INPUT for c in caps):
            # One recording per job is the whole input; a model that also
            # makes things from words would be probed for only one of them.
            errors.append(_err(mid, "a voice tool model lists only voice tools"))
        if m.get("image_sizes") and m["output"] != "image":
            errors.append(_err(mid, "image_sizes is for image models"))
        if m.get("qualities"):
            if m["output"] != "image" or not QUALITY_CAPABILITIES & set(caps):
                errors.append(_err(mid, "qualities is for image models that make or edit pictures"))
            elif cls is not None and not QUALITY_CAPABILITIES & set(caps) & set(cls.quality_capabilities):
                # The adapter would drop it: the vendor would bill its own default under another tier's price.
                errors.append(_err(mid, f"adapter {m['adapter']} does not send a quality"))
        for key in ("on", "as_of"):
            # The pattern only checks the shape; migration 0125 casts `on` to a date, and a
            # 2026-13-45 there would be a date nobody can compare.
            try:
                date.fromisoformat((m.get("shutdown") or {}).get(key, "2000-01-01"))
            except ValueError:
                errors.append(_err(mid, f"shutdown.{key} is not a calendar date"))
        pricing = m["pricing"]
        variants = pricing.get("variants")
        # A variant table of nothing but nulls states no price (0060 lists the
        # tiers an OpenAI image model is sold by before any is pinned).
        stated = variants and any(v is not None for v in variants["prices"].values())
        if (pricing["provider_usd_per_unit"] is not None or stated) \
                and not (pricing["source_url"] and pricing["as_of"]):
            # A price without where and when it came from is a guess (CLAUDE.md #5).
            errors.append(_err(mid, "a provider price needs source_url and as_of"))
        for i, change in enumerate(pricing.get("changes") or ()):
            # The patterns only check the shape. tests/test_dated_vendor_prices.py compares effective_at with the moment written in
            # the documented credit_price_schedule row (0224), so an impossible date would be a change nobody can schedule.
            try:
                datetime.strptime(change["effective_at"], "%Y-%m-%dT%H:%M:%SZ")
                date.fromisoformat(change["as_of"])
            except ValueError:
                errors.append(_err(mid, f"pricing.changes[{i}] has a date that is not on the calendar"))
            if all(r["from"] == r["to"] for r in change["rates"].values()):
                errors.append(_err(mid, f"pricing.changes[{i}] changes no rate"))
            if any(r["from"] <= 0 or r["to"] <= 0 for r in change["rates"].values()):
                # A ratio to/from is what the schedule's rate is scaled by: a rate from or to nothing has no ratio to scale by.
                errors.append(_err(mid, f"pricing.changes[{i}] needs every rate above 0, before and after"))
        units = [m["credit_unit"]]
        if m["credit_unit"] != credit_unit_for(mid, pricing["unit"]):
            errors.append(_err(mid, f"credit_unit must be {credit_unit_for(mid, pricing['unit'])}"))
        by = (variants or {}).get("by")
        res_default = m.get("default_resolution")
        if res_default is not None and (by not in ("resolution", "resolution_audio") or res_default not in m["resolutions"]):
            errors.append(_err(mid, "default_resolution must be a listed resolution of a model priced by resolution"))
        video_caps = VIDEO_VARIANT_CAPABILITIES & set(caps)
        if by in ("resolution", "resolution_audio", "audio") and (res_default is not None or by != "resolution"):
            # 0070: a price that depends on the resolution or the soundtrack is only
            # true if the adapter sends what was priced (never the vendor's default).
            if m["output"] != "video" or not video_caps:
                errors.append(_err(mid, f"price variants by {by} are for video models"))
            elif cls is not None:
                if by in AUDIO_VARIANTS and not (video_caps & set(cls.audio_capabilities)):
                    errors.append(_err(mid, f"adapter {m['adapter']} does not send an audio flag"))
                if res_default is not None and not (video_caps & set(cls.resolution_capabilities)):
                    errors.append(_err(mid, f"adapter {m['adapter']} does not always send a resolution"))
            if by in AUDIO_VARIANTS and not m["audio_out"]:
                errors.append(_err(mid, "audio price variants need audio_out"))
            if by == "resolution_audio" and res_default is None:
                errors.append(_err(mid, "resolution_audio prices need default_resolution"))
        if variants:
            allowed = {"resolution": m["resolutions"], "image_size": m.get("image_sizes") or [],
                       "upscale_target": m.get("upscale_targets") or [],
                       "quality": m.get("qualities") or [],
                       "audio": list(AUDIO_STATES),
                       "resolution_audio": [f"{r}_{a}" for r in m["resolutions"] for a in AUDIO_STATES]}[variants["by"]]
            if any(k not in allowed for k in variants["prices"]):
                errors.append(_err(mid, f"price variants must be listed {variants['by']}s"))
            units += [credit_unit_for(mid, pricing["unit"], k) for k in variants["prices"]]
        for u in units:
            if not CREDIT_UNIT_RE.fullmatch(u):
                errors.append(_err(mid, f"credit unit {u} is not a valid credit_prices unit"))
            if u in seen_units:
                errors.append(_err(mid, f"credit unit {u} collides with another model"))
            seen_units.add(u)
        if m.get("blocked_countries") and m["api_exposure"] != "web_only":
            # The country is read from the visitor's address (docs/GEO_BLOCK.md). The API and MCP sell to a server, whose
            # address says nothing about the person behind it, so a model sold by country is never offered there.
            errors.append(_err(mid, "blocked_countries needs api_exposure web_only"))
        allowed_in = m.get("available_countries")
        if m.get("blocked_countries") and not m.get("terms_gate") and not allowed_in:
            # Since 0208 the database refuses by country on every path (creative_jobs_geo_gate, one trigger on the table every
            # create writes, with the signed geo claim), and since 0230 it reads the vendor's own allow-list. A deny-list alone still
            # lets a code on neither list through (EU, ZZ: BR-S6-04), so 0238 lets a row with blocked_countries go on sale only when
            # it also carries available_countries; the file holds the same line. Without one, a terms_gate keeps it hidden (0035).
            errors.append(_err(mid, "blocked_countries needs available_countries (or a terms_gate) before the database lets it on sale (0238)"))
        if allowed_in and not m.get("blocked_countries"):
            # 0230 reads an allow-list only on a row with blocked_countries (0208's trigger skips any other): alone it gates nothing.
            errors.append(_err(mid, "available_countries needs blocked_countries"))
        if allowed_in and set(allowed_in) & set(m.get("blocked_countries") or []):
            errors.append(_err(mid, "available_countries and blocked_countries share a code"))
        if m["provider"] == "google" and m.get("blocked_countries") and not allowed_in:
            # BR-S6-03: Google's terms are an allow-list. Its complement alone lets a code on neither list (EU, a typo) through, and
            # 0230 refuses every job on a Google row with no allow-list: the file must carry it, or the model can never run.
            errors.append(_err(mid, "a google model with blocked_countries needs available_countries (Google's own list)"))
        if "mcp_oauth_exposure" in m and m["mcp_oauth_exposure"] is not True and m["mcp_oauth_exposure"] is not False:
            errors.append(_err(mid, "mcp_oauth_exposure is true or false"))
        if m.get("mcp_oauth_exposure") is True:
            # A connected assistant's request has no visitor address to check a country against, and a rights acknowledgement is the
            # person's own act in the Studio (0174); migration 0191 refuses both for an assistant, so the file must not promise them.
            if m.get("blocked_countries"):
                errors.append(_err(mid, "mcp_oauth_exposure cannot be combined with blocked_countries"))
            if m.get("requires_acknowledgement"):
                errors.append(_err(mid, "mcp_oauth_exposure cannot be combined with requires_acknowledgement"))
            if CAPTIONS in caps:
                errors.append(_err(mid, "captions are a web tool: mcp_oauth_exposure cannot be true"))
            # The vendor's permission for our connector is api_exposure web_mcp (0188), or any; web_only means the vendor did not
            # give it, and 0191's gate (sellable_models 'mcp') would refuse the model anyway: the file must not promise it.
            if m["api_exposure"] not in ("web_mcp", "any"):
                errors.append(_err(mid, "mcp_oauth_exposure needs api_exposure web_mcp (or any): web_only is the vendor's no"))
        if is_bytedance(m) and (m["api_exposure"] != "web_only" or m.get("mcp_oauth_exposure") is True):
            # BytePlus's service terms §4.2.3 forbid re-integrating its video API into an AI content-creation tool
            # (docs/FILM_STUDIO.md "Models"): never the public API, never a connected assistant. Migration 0219 refuses every
            # ByteDance model to every assistant in the database too; the file must not promise otherwise.
            errors.append(_err(mid, "a ByteDance model is web_only and never mcp_oauth_exposure (BytePlus terms §4.2.3)"))
        ent = m["entitlement"]
        if ent and ent.split(":")[0] != f"models_{m['output']}":
            errors.append(_err(mid, "entitlement category must match the output"))
        probe = m["probe"]
        if probe["capability"] not in caps:
            errors.append(_err(mid, "probe.capability must be one of the model's capabilities"))
        elif cls is not None:
            entry = _entry(m)
            req = entry.probe_request(voice_id="A" * 20, generated_image="https://probe.invalid/x.png",
                                      generated_speech="probe_speech.mp3",
                                      generated_end_image="https://probe.invalid/end.png",
                                      generated_video="probe_video.mp4")
            # A placeholder vendor model is how a gated entry with no vendor assigned ships (the
            # adapter refuses it at run time); it is not a fault of the probe request.
            problems = [p for p in cls(env={}).problems(req, entry)
                        if "https URL" not in p and "placeholder vendor model" not in p]
            if problems:
                errors.append(_err(mid, "probe request is not servable: " + "; ".join(problems)))
    return errors


def validate(doc: Any, schema: Optional[Mapping] = None) -> List[str]:
    """Every problem with a registry document: schema first, then cross-field."""
    schema = schema if schema is not None else load_schema()
    bad = unsupported_keywords(schema)
    if bad:
        return [f"schema uses keywords the evaluator does not enforce: {', '.join(bad)}"]
    errors = schema_errors(doc, schema)
    if errors:
        return errors
    return _cross_errors(doc["models"])


def load(path: Optional[Path] = None) -> Dict[str, ModelEntry]:
    """Parse and validate the registry. Raises :class:`RegistryError` listing
    every problem — a half-valid registry is not loaded."""
    doc = json.loads(Path(path or REGISTRY_PATH).read_text())
    problems = validate(doc)
    if problems:
        raise RegistryError("model registry is invalid:\n  " + "\n  ".join(problems))
    return {m["id"]: _entry(m) for m in doc["models"]}


@lru_cache(maxsize=1)
def registry() -> Dict[str, ModelEntry]:
    return load()


def normalise_text(text: str) -> str:
    """``text`` as a vendor's server would read an id out of it: percent-decoded (repeatedly), NFKC-normalised, with zero-width and other
    invisible format characters removed, lower-cased. A deprecated id must not dodge a guard by being %-encoded, written in full-width
    letters or split by an invisible character."""
    s = str(text or "")
    for _ in range(3):
        decoded = unquote(s)
        if decoded == s:
            break
        s = decoded
    s = unicodedata.normalize("NFKC", s)
    return "".join(ch for ch in s if unicodedata.category(ch) != "Cf").lower()


def names_id(text: str, vendor_model: str) -> bool:
    """``vendor_model`` appears in ``text`` as a WHOLE id, however it is spelled around (other case, a ``models/`` prefix, a
    ``:predictLongRunning`` or ``?x=1`` suffix, a path, a trailing dot or hyphen). A longer id that merely starts or ends with it
    (``-001``) is a different id and does not match."""
    vm = re.escape(vendor_model.lower())
    return bool(re.search(r"(?<![a-z0-9])(?<![a-z0-9][.-])" + vm + r"(?![a-z0-9])(?![.-][a-z0-9])", normalise_text(text)))


def entries_named_in(text: str) -> List[ModelEntry]:
    """Every registry entry whose vendor model ``names_id`` finds in ``text``. Used so a deprecated id cannot dodge a guard by how it is
    written."""
    return [e for e in registry().values() if names_id(text, e.vendor_model)]


def get(model_id: str) -> Optional[ModelEntry]:
    return registry().get(model_id)


def models(capability: Optional[str] = None) -> List[ModelEntry]:
    return [m for m in registry().values() if capability is None or capability in m.capabilities]


#: Columns of ``model_registry`` the file owns; everything else is ``spec``.
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")


def sync_rows(entries: Sequence[ModelEntry]) -> List[dict]:
    """The rows ``sync_model_registry`` (migration 0035) upserts: static facts
    only — never availability or verification, which the database owns. A
    registry-only entry (``ModelEntry.registry_only``) is not among them."""
    rows = []
    for e in entries:
        if e.registry_only:
            # One row with a capability outside 0100's check would fail the whole call (and with it every other model's
            # sync). The entry stays in the file until a migration teaches the database its capability.
            continue
        spec = {k: v for k, v in e.raw.items() if k not in _COLUMNS}
        # Always stated, never left to "absent means false": migration 0218 reads it, and a spec that says it is one a reader can trust.
        spec["takes_negative_prompt"] = e.takes_negative_prompt
        rows.append({"id": e.id, "display_name": e.display_name, "provider": e.provider,
                     "adapter": e.adapter, "capabilities": list(e.capabilities),
                     "credit_unit": e.credit_unit, "entitlement": e.entitlement, "spec": spec})
    return rows

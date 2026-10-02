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
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from modules.capabilities import ADAPTERS
from modules.capabilities.base import (
    CAPTIONS,
    DESCRIBE,
    DUB,
    FILE_INPUT,
    I2V,
    IMAGE_INPUT,
    QUALITY_CAPABILITIES,
    MEDIA_INPUT,
    VIDEO_VARIANT_CAPABILITIES,
    OUTPUT_OF,
    PROMPT_OPTIONAL,
    UPSCALE,
    VIDEO_INPUT,
    VIDEO_UPSCALE,
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
        return CapabilityRequest(capability=cap, prompt="" if speech or cap in VIDEO_INPUT or cap == DESCRIBE
                                 else p["prompt"],
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
        max_source_seconds=m["limits"].get("max_source_seconds"),
        audio_out=bool(m["audio_out"]), is_async=bool(m["async"]),
        api_documented_url=m["api_documented"]["url"], doc_source=m["api_documented"]["source"],
        credit_unit=m["credit_unit"], entitlement=m["entitlement"], terms_gate=m["terms_gate"],
        api_exposure=m["api_exposure"], max_prompt_chars=int(m["limits"]["max_prompt_chars"]),
        max_concurrent_per_org=int(m["limits"]["max_concurrent_per_org"]),
        quality_tier=int(m["quality_tier"]), speed_tier=int(m["speed_tier"]), raw=m,
    )


def _err(mid: str, msg: str) -> str:
    return f"{mid or '?'}: {msg}"


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
        if any(c in IMAGE_INPUT for c in caps) and m["inputs"]["image_refs_max"] < 1:
            errors.append(_err(mid, "a capability that takes an image needs image_refs_max >= 1"))
        if (UPSCALE in caps) != bool(m.get("upscale_factors")):
            # 0046 sells an upscale only at a factor the model lists.
            errors.append(_err(mid, "upscale_factors is required with upscale and only with it"))
        if (DUB in caps or CAPTIONS in caps) != bool(m.get("languages")):
            # 0050 sells a dub only into a language the model lists; 0072
            # sells captions only in a spoken language it lists.
            errors.append(_err(mid, "languages is required with dub or captions and only with them"))
        if (VIDEO_UPSCALE in caps) != bool(m.get("upscale_targets")):
            # 0052 sells a video upscale only at a target the model lists.
            errors.append(_err(mid, "upscale_targets is required with video_upscale and only with it"))
        if VIDEO_UPSCALE in caps and not m["limits"].get("max_source_seconds"):
            # 0052 prices the source's seconds: a model without a documented
            # longest input would be sold a length the vendor refuses.
            errors.append(_err(mid, "video_upscale needs limits.max_source_seconds"))
        if CAPTIONS in caps and m["api_exposure"] != "web_only":
            # The transcript is read from caption_tracks by a signed-in member's
            # session only (0072): an API key that bought captions could never
            # fetch the result, so the registry never offers them to the API.
            errors.append(_err(mid, "captions are a web tool: api_exposure must be web_only"))
        if any(c in VIDEO_INPUT for c in caps) and any(c not in VIDEO_INPUT for c in caps):
            errors.append(_err(mid, "a video tool model lists only video tools"))
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
        pricing = m["pricing"]
        variants = pricing.get("variants")
        # A variant table of nothing but nulls states no price (0060 lists the
        # tiers an OpenAI image model is sold by before any is pinned).
        stated = variants and any(v is not None for v in variants["prices"].values())
        if (pricing["provider_usd_per_unit"] is not None or stated) \
                and not (pricing["source_url"] and pricing["as_of"]):
            # A price without where and when it came from is a guess (CLAUDE.md #5).
            errors.append(_err(mid, "a provider price needs source_url and as_of"))
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
            problems = [p for p in cls(env={}).problems(req, entry) if "https URL" not in p]
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


def get(model_id: str) -> Optional[ModelEntry]:
    return registry().get(model_id)


def models(capability: Optional[str] = None) -> List[ModelEntry]:
    return [m for m in registry().values() if capability is None or capability in m.capabilities]


#: Columns of ``model_registry`` the file owns; everything else is ``spec``.
_COLUMNS = ("id", "display_name", "provider", "adapter", "capabilities", "credit_unit", "entitlement")


def sync_rows(entries: Sequence[ModelEntry]) -> List[dict]:
    """The rows ``sync_model_registry`` (migration 0035) upserts: static facts
    only — never availability or verification, which the database owns."""
    rows = []
    for e in entries:
        spec = {k: v for k, v in e.raw.items() if k not in _COLUMNS}
        rows.append({"id": e.id, "display_name": e.display_name, "provider": e.provider,
                     "adapter": e.adapter, "capabilities": list(e.capabilities),
                     "credit_unit": e.credit_unit, "entitlement": e.entitlement, "spec": spec})
    return rows

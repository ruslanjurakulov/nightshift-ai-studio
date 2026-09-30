"""Image adapters: OpenAI GPT Image, Gemini image, FLUX.2, Ideogram 3 and 4.

Imagen is not here: Google shut Imagen down on the Gemini API (2026-08-17);
it is still sold on Vertex AI, which needs its own adapter (OAuth, another host).

Each calls the vendor's documented endpoint (the source is in the model's
``api_documented`` entry in ``schemas/model_registry.json``). Keys come from the
worker's env and ride in headers only — never the URL, never a log line.
Nothing here is shown to users until ``tools/probe_models.py`` has made a real
call with the owner's key (migration 0035 refuses ``beta``/``ga`` otherwise).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

from modules.capabilities.base import (
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_POLICY,
    E_UNAVAILABLE,
    EDIT,
    FAILED,
    PENDING,
    SUCCEEDED,
    T2I,
    AdapterError,
    CapabilityRequest,
    HttpAdapter,
    Output,
    PollResult,
    ProviderTask,
    b64_output,
    dig,
    host_is,
    image_b64,
    image_mime,
)

#: Pixel sizes for vendors that take width/height (multiples of 16, ~1 MP).
_PIXELS = {"1:1": (1024, 1024), "16:9": (1344, 768), "9:16": (768, 1344),
           "4:3": (1152, 864), "3:4": (864, 1152), "3:2": (1216, 816), "2:3": (816, 1216)}


_END_USER = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class OpenAIImageAdapter(HttpAdapter):
    """``POST /v1/images/generations`` (text → image) and ``POST
    /v1/images/edits`` (multipart ``image[]`` + prompt → image), as
    openai-python sends them. GPT Image models answer in base64. The GPT
    Image 2 family accepts any ``WxH`` with both sides multiples of 16, so each
    aspect ratio maps to a size near 1.3 MP instead of three fixed squares."""

    key = "image.openai"
    key_env = ("OPENAI_API_KEY",)
    base_url_env = "OPENAI_BASE_URL"
    default_base_url = "https://api.openai.com/v1"
    capabilities = (T2I, EDIT)
    timeout = 180
    SIZES = {"1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536",
             "16:9": "1536x864", "9:16": "864x1536", "4:3": "1344x1008", "3:4": "1008x1344"}

    def _common(self, request: CapabilityRequest, vendor_model: str) -> dict:
        body = {"model": vendor_model, "prompt": request.prompt.strip(), "n": 1,
                "size": self.SIZES.get(request.aspect_ratio or "1:1", "1024x1024")}
        if request.end_user and _END_USER.fullmatch(request.end_user):
            body["user"] = request.end_user          # OpenAI's safety identifier
        return body

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        body = self._common(request, vendor_model)
        if request.capability == EDIT:
            files = [("image[]", (Path(p).name, Path(p).read_bytes(), image_mime(p)))
                     for p in request.input_images]
            data = self._call("POST", f"{self.base_url}/images/edits", what="edit",
                              data={k: str(v) for k, v in body.items()}, files=files)
        else:
            data = self.post(f"{self.base_url}/images/generations", body, what="generate")
        first = dig(data, "data", 0) or {}
        if first.get("b64_json"):
            out = b64_output(first["b64_json"], "image/png")
        elif first.get("url"):
            out = Output(mime="image/png", url=str(first["url"]))
        else:
            raise AdapterError(E_BAD_RESPONSE, "no image in the response")
        return ProviderTask(self.key, vendor_model, None, outputs=[out])


class _GoogleAdapter(HttpAdapter):
    key_env = ("GEMINI_API_KEY",)
    base_url_env = "GEMINI_BASE_URL"
    default_base_url = "https://generativelanguage.googleapis.com/v1beta"

    def auth_headers(self) -> Dict[str, str]:
        # Google takes the key in its own header; never in the query string.
        return {"x-goog-api-key": self.api_key()}


class GeminiImageAdapter(_GoogleAdapter):
    """``POST /v1beta/models/{model}:generateContent`` with
    ``responseModalities: ["IMAGE"]`` and ``imageConfig.aspectRatio``.
    Reference images ride as inline parts, which is how the same call edits."""

    key = "image.gemini"
    capabilities = (T2I, EDIT)
    timeout = 120

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        parts: List[dict] = [{"text": request.prompt.strip()}]
        for path in request.input_images:
            parts.append({"inlineData": {"mimeType": image_mime(path), "data": image_b64(path)}})
        image_config = {"aspectRatio": request.aspect_ratio or "1:1"}
        if request.image_size:
            image_config["imageSize"] = request.image_size      # 512 / 1K / 2K / 4K: priced per size
        body = {"contents": [{"parts": parts}],
                "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": image_config}}
        data = self.post(f"{self.base_url}/models/{vendor_model}:generateContent", body, what="generate")
        for cand in data.get("candidates") or []:
            for part in dig(cand, "content", "parts") or []:
                inline = (part or {}).get("inlineData") or (part or {}).get("inline_data")
                if isinstance(inline, dict) and inline.get("data"):
                    out = b64_output(inline["data"], inline.get("mimeType") or "image/png")
                    return ProviderTask(self.key, vendor_model, None, outputs=[out])
        reason = dig(data, "promptFeedback", "blockReason") or dig(data, "candidates", 0, "finishReason")
        if reason and str(reason).upper() not in ("STOP", ""):
            raise AdapterError(E_POLICY, f"no image: {self.message(reason)}")
        raise AdapterError(E_BAD_RESPONSE, "no image in the response")


class FluxAdapter(HttpAdapter):
    """Black Forest Labs: ``POST https://api.bfl.ai/v1/{model}`` (header
    ``x-key``) → ``polling_url``; poll until ``Ready``; ``result.sample`` is a
    URL that expires in minutes, so ``fetch`` runs straight after."""

    key = "image.bfl"
    key_env = ("BFL_API_KEY",)
    base_url_env = "BFL_BASE_URL"
    default_base_url = "https://api.bfl.ai/v1"
    capabilities = (T2I,)
    _FAILED = {"Error", "Failed", "Content Moderated", "Request Moderated", "Task not found"}

    def auth_headers(self) -> Dict[str, str]:
        return {"x-key": self.api_key(), "accept": "application/json"}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        w, h = _PIXELS.get(request.aspect_ratio or "1:1", _PIXELS["1:1"])
        data = self.post(f"{self.base_url}/{vendor_model}",
                         {"prompt": request.prompt.strip(), "width": w, "height": h})
        poll = data.get("polling_url")
        if not poll:
            raise AdapterError(E_BAD_RESPONSE, "no polling_url in the response")
        if not host_is(poll, "bfl.ai"):
            raise AdapterError(E_BAD_RESPONSE, "polling_url is not a bfl.ai URL")
        # The polling URL is the task id: it names the regional cluster that holds the job.
        return ProviderTask(self.key, vendor_model, str(poll))

    def poll(self, task: ProviderTask) -> PollResult:
        self.require_key()
        url = str(task.task_id or "")
        if not host_is(url, "bfl.ai"):
            # The task id comes back from a job row; the key must never follow
            # it to a host that is not Black Forest Labs'.
            raise AdapterError(E_NOT_FOUND, "task id is not a bfl.ai polling URL")
        data = self.get(url)
        status = str(data.get("status") or "")
        if status == "Ready":
            sample = dig(data, "result", "sample")
            if not sample:
                raise AdapterError(E_BAD_RESPONSE, "Ready without result.sample")
            return PollResult(SUCCEEDED, [Output(mime="image/jpeg", url=str(sample))])
        if status in self._FAILED:
            code = E_POLICY if "Moderated" in status else (
                E_NOT_FOUND if status == "Task not found" else E_UNAVAILABLE)
            return PollResult(FAILED, error=AdapterError(code, f"job ended with status {status!r}"))
        return PollResult(PENDING)


class IdeogramAdapter(HttpAdapter):
    """``POST https://api.ideogram.ai/v1/ideogram-v3/generate`` — multipart form,
    header ``Api-Key``; ``data[0].url``."""

    key = "image.ideogram"
    key_env = ("IDEOGRAM_API_KEY",)
    base_url_env = "IDEOGRAM_BASE_URL"
    default_base_url = "https://api.ideogram.ai"
    capabilities = (T2I,)
    timeout = 120

    def auth_headers(self) -> Dict[str, str]:
        return {"Api-Key": self.api_key()}

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        # vendor_model is Ideogram 3's rendering speed (TURBO / BALANCED / QUALITY).
        form = {"prompt": (None, request.prompt.strip()),
                "aspect_ratio": (None, (request.aspect_ratio or "1:1").replace(":", "x")),
                "rendering_speed": (None, vendor_model)}
        data = self._call("POST", f"{self.base_url}/v1/ideogram-v3/generate", files=form,
                          what="generate")
        first = dig(data, "data", 0) or {}
        if first.get("is_image_safe") is False:
            raise AdapterError(E_POLICY, "the vendor marked the image unsafe")
        if not first.get("url"):
            raise AdapterError(E_BAD_RESPONSE, "no image in the response")
        return ProviderTask(self.key, vendor_model, None,
                            outputs=[Output("image/png", url=str(first["url"]))])


class IdeogramV4Adapter(IdeogramAdapter):
    """Ideogram 4.0: ``POST https://api.ideogram.ai/v1/ideogram-v4/generate``
    with ``text_prompt`` and ``rendering_speed``. Only those two fields are
    confirmed (search extract of developer.ideogram.ai; the page itself was
    unreachable), so no aspect ratio or resolution is sent and the registry
    offers none. Hidden until a probe succeeds."""

    key = "image.ideogram_v4"

    def problems(self, request: CapabilityRequest, entry) -> List[str]:
        out = super().problems(request, entry)
        if request.aspect_ratio:
            out.append("Ideogram 4.0 aspect ratios are not wired yet")
        return out

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        self.require_key()
        form = {"text_prompt": (None, request.prompt.strip()),
                "rendering_speed": (None, vendor_model)}
        data = self._call("POST", f"{self.base_url}/v1/ideogram-v4/generate", files=form,
                          what="generate")
        first = dig(data, "data", 0) or {}
        if first.get("is_image_safe") is False:
            raise AdapterError(E_POLICY, "the vendor marked the image unsafe")
        if not first.get("url"):
            raise AdapterError(E_BAD_RESPONSE, "no image in the response")
        return ProviderTask(self.key, vendor_model, None,
                            outputs=[Output("image/png", url=str(first["url"]))])


ADAPTERS = (OpenAIImageAdapter, GeminiImageAdapter, FluxAdapter, IdeogramAdapter,
            IdeogramV4Adapter)

__all__ = [a.__name__ for a in ADAPTERS] + ["ADAPTERS"]

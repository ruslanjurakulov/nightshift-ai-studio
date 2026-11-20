"""``describe`` on Claude and on GPT: read one library picture and write a generation prompt for it.

The same capability, rules and output as ``image.gemini_describe`` (modules/capabilities/image.py): the same system instruction,
the picture is a local file the worker copied from the media library (an https URL is refused, so a job can never make the worker
fetch an address someone typed), the answer is cleaned (modules/describe_text.py) and handed back as one ``text/plain`` output.
Only the vendor call differs. Neither adapter falls back to another vendor or model when its own call fails (CLAUDE.md rule 4):
the job fails with the closed code the creative worker already maps to a sentence.

* ``image.anthropic_describe``: ``POST https://api.anthropic.com/v1/messages`` with ``x-api-key`` and ``anthropic-version:
  2026-10-21``; the picture is an ``image`` content block (``source.type: base64``); the answer is the ``text`` blocks of
  ``content`` (thinking blocks skipped); ``stop_reason: refusal`` is a policy refusal. Errors: 401 authentication_error, 402
  billing_error, 429 rate_limit_error, 529 overloaded_error (platform.claude.com/docs api/messages and api/errors, read 2026-11-20).
* ``image.openai_describe``: ``POST https://api.openai.com/v1/responses`` with ``instructions`` and an ``input`` message holding
  ``input_image`` (a base64 data URL) and ``input_text``; the answer is the ``output_text`` parts of ``output[]`` messages; a
  ``refusal`` part is a policy refusal. A 429 is a spent balance only when ``error.code`` (or ``type``) is ``insufficient_quota``
  (developers.openai.com guides/text, guides/images-vision, guides/error-codes, read 2026-11-20).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_BAD_RESPONSE,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    AdapterError,
    CapabilityRequest,
    Output,
    ProviderTask,
    image_b64,
    image_mime,
    is_url,
)
from modules.capabilities.image import _END_USER, DESCRIBE_SYSTEM, GeminiDescribeAdapter
from modules.describe_text import clean_description


def _error_field(text: str, name: str) -> Optional[str]:
    try:
        err = json.loads(text or "").get("error")
    except (ValueError, AttributeError):
        return None
    val = err.get(name) if isinstance(err, dict) else None
    return val if isinstance(val, str) else None


def _unscoped_key(text: str) -> bool:
    """Anthropic's 400 for an organization-level key used without a workspace ("This API key is not scoped to a workspace,
    so this request must include ...")."""
    return "not scoped to a workspace" in (_error_field(text, "message") or text or "").lower()


#: What the operator reads on a job or probe that failed for that reason.
UNSCOPED_KEY_REMEDY = "the Anthropic key is not scoped to a workspace: create a workspace-scoped API key and set ANTHROPIC_API_KEY"


class _LlmDescribe(GeminiDescribeAdapter):
    """Shares GeminiDescribeAdapter's checks (``problems``: no prompt, one JPEG/PNG/WebP library file of at most 15 MB, a language
    from the closed list) and its ``ask``; only the call is the subclass's."""

    base_url_env = ""
    timeout = 90
    #: Room for the reasoning these models spend before the answer; the kept text is still cut to the describe limit.
    MAX_OUTPUT_TOKENS = 8192

    def _picture(self, request: CapabilityRequest) -> str:
        self.require_key()
        if len(request.input_images) != 1 or is_url(str(request.input_images[0])):
            # Never a URL: the worker hands over the library copy it made.
            raise AdapterError(E_BAD_REQUEST, "a description reads one picture file from the library")
        return str(request.input_images[0])

    def _done(self, vendor_model: str, texts: List[str]) -> ProviderTask:
        text = clean_description(" ".join(texts))
        if not text:
            raise AdapterError(E_BAD_RESPONSE, "no usable description in the response")
        return ProviderTask(self.key, vendor_model, None, outputs=[Output(mime="text/plain", data=text.encode("utf-8"))])


class AnthropicDescribeAdapter(_LlmDescribe):
    key = "image.anthropic_describe"
    key_env = ("ANTHROPIC_API_KEY",)
    default_base_url = "https://api.anthropic.com/v1"
    #: A 3xx would carry x-api-key to wherever it points.
    follow_redirects = False
    VERSION = "2026-10-21"

    def auth_headers(self) -> Dict[str, str]:
        return {"x-api-key": self.api_key(), "anthropic-version": self.VERSION, "content-type": "application/json"}

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        kind = _error_field(text, "type")
        if status == 400 and _unscoped_key(text):
            # The key is fine but belongs to no workspace (the first probe, 2026-11-20): the fix is the operator's (a
            # workspace-scoped key), never the person's request, so it is `auth`, not `bad_request`.
            return E_AUTH
        if status == 402 or kind == "billing_error":
            return E_QUOTA
        if kind == "rate_limit_error":
            return E_RATE_LIMITED
        return None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        path = self._picture(request)
        body = {
            "model": vendor_model,
            "max_tokens": self.MAX_OUTPUT_TOKENS,
            "system": DESCRIBE_SYSTEM,
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": image_mime(path), "data": image_b64(path)}},
                {"type": "text", "text": self.ask(request.output_language)},
            ]}],
        }
        if request.end_user and _END_USER.fullmatch(request.end_user):
            body["metadata"] = {"user_id": request.end_user}   # opaque id only, never an email
        try:
            data = self.post(f"{self.base_url}/messages", body, what="describe")
        except AdapterError as e:
            if e.code == E_AUTH and _unscoped_key(e.message):
                raise AdapterError(E_AUTH, UNSCOPED_KEY_REMEDY, http_status=400, not_accepted=True) from None
            raise
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "describe: not a JSON object")
        if data.get("stop_reason") == "refusal":
            raise AdapterError(E_POLICY, "no description: the model declined")
        if data.get("stop_reason") == "max_tokens":
            # Cut off mid-sentence (thinking counts against max_tokens): half a prompt is not a description, and is never charged.
            raise AdapterError(E_BAD_RESPONSE, "the description was cut off before it ended")
        texts = [b["text"] for b in data.get("content") or []
                 if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
        return self._done(vendor_model, texts)


class OpenAIDescribeAdapter(_LlmDescribe):
    key = "image.openai_describe"
    key_env = ("OPENAI_API_KEY",)
    default_base_url = "https://api.openai.com/v1"
    follow_redirects = False

    def auth_headers(self) -> Dict[str, str]:
        # Stated here, not inherited: the Gemini parent sends x-goog-api-key, which would hand this key to the wrong header.
        return {"Authorization": f"Bearer {self.api_key()}"}

    def vendor_error_code(self, status: int, text: str) -> Optional[str]:
        if status == 429:
            quota = "insufficient_quota" in (_error_field(text, "code"), _error_field(text, "type"))
            return E_QUOTA if quota else E_RATE_LIMITED
        return None

    def submit(self, request: CapabilityRequest, vendor_model: str) -> ProviderTask:
        path = self._picture(request)
        body = {
            "model": vendor_model,
            "instructions": DESCRIBE_SYSTEM,
            "max_output_tokens": self.MAX_OUTPUT_TOKENS,
            # The Responses API keeps responses by default; a customer's picture has no reason to stay at the vendor.
            "store": False,
            "input": [{"role": "user", "content": [
                {"type": "input_image", "image_url": f"data:{image_mime(path)};base64,{image_b64(path)}"},
                {"type": "input_text", "text": self.ask(request.output_language)},
            ]}],
        }
        if request.end_user and _END_USER.fullmatch(request.end_user):
            body["safety_identifier"] = request.end_user
        data = self.post(f"{self.base_url}/responses", body, what="describe")
        if not isinstance(data, dict):
            raise AdapterError(E_BAD_RESPONSE, "describe: not a JSON object")
        if data.get("status") == "incomplete":
            # incomplete_details.reason max_output_tokens (or content_filter): never a finished description.
            reason = (data.get("incomplete_details") or {}).get("reason") if isinstance(data.get("incomplete_details"), dict) else None
            if reason == "content_filter":
                raise AdapterError(E_POLICY, "no description: the vendor's filter stopped it")
            raise AdapterError(E_BAD_RESPONSE, "the description was cut off before it ended")
        texts: List[str] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "refusal":
                    raise AdapterError(E_POLICY, "no description: the model declined")
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    texts.append(part["text"])
        return self._done(vendor_model, texts)


ADAPTERS = (AnthropicDescribeAdapter, OpenAIDescribeAdapter)

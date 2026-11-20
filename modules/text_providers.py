"""Text providers for the Studio's planner: Claude (Anthropic Messages API) and GPT (OpenAI Responses API).

The series planner takes an injected ``generate(prompt, stage=...)`` (modules/series_planner.plan_series), so a provider is one
function that sends ONE request and returns the model's text. This module builds that function for a provider the caller names.

Rules it keeps (CLAUDE.md):
* **No silent fallback (rule 4).** The provider is chosen explicitly by the caller. When it fails, ``generate`` raises
  ``TextProviderError`` with a closed code; nothing here ever tries another provider or another model.
* **Fail early, and name the remedy (rule 6).** A missing key is ``llm_not_configured`` before any request; a bad key
  (``llm_auth``) and a spent balance (``llm_quota``) are told apart even where the vendor answers both with the same status
  (OpenAI's 429 carries ``error.code == "insufficient_quota"``; Anthropic answers 402 ``billing_error``).
* **No secret in a log or an error (rule 1).** The key rides in a header only. Vendor text that reaches an error message goes
  through ``scrub`` with the key's value, and is cut short.

Calls are raw REST with ``requests``, like every adapter in modules/capabilities: one dependency for the worker, one place that
handles keys. Sources (read 2026-11-20): platform.claude.com/docs (Messages API, models overview, api/errors, api/versioning);
developers.openai.com/api/docs (guides/text, guides/error-codes, models/all).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable, Mapping, Optional

import logging

from modules.capabilities.base import env_secrets, scrub

logger = logging.getLogger(__name__)

#: The providers a caller may name. ``gemini`` is the planner's existing path (series_planner.gemini_generate) and is listed so a
#: caller can validate one closed set; this module builds only the two below.
PROVIDERS = ("gemini", "anthropic", "openai")

#: Model ids from the vendors' own model pages (2026-11-20). Changing one needs a new probe before the UI offers it.
#: Sonnet: the cost/quality point the owner chose for plans (2026-11-20).
ANTHROPIC_MODEL = "claude-sonnet-5-5"
OPENAI_MODEL = "gpt-6-luna"     # "Our most efficient model for focused, high-volume tasks" (models/all)

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2026-10-21"
OPENAI_URL = "https://api.openai.com/v1/responses"

#: A plan is a few hundred words of JSON; the cap leaves room for the model's own reasoning before the answer.
MAX_OUTPUT_TOKENS = 16000
TIMEOUT_S = 120

# The closed error codes, each with the fix a person can act on.
E_NOT_CONFIGURED = "llm_not_configured"
E_AUTH = "llm_auth"
E_QUOTA = "llm_quota"
E_RATE_LIMITED = "llm_rate_limited"
E_UNAVAILABLE = "llm_unavailable"
E_REFUSED = "llm_refused"
E_BAD_REQUEST = "llm_bad_request"
E_BAD_RESPONSE = "llm_bad_response"

REMEDIES = {
    E_NOT_CONFIGURED: "the provider's API key is not set on the worker: add it (Model keys page -> GitHub secret) and redeploy",
    E_AUTH: "the provider rejected the API key: replace the key",
    E_QUOTA: "the provider account has no credit or hit its spend limit: top it up or raise the limit",
    E_RATE_LIMITED: "the provider is rate limiting this account: try again in a few minutes",
    E_UNAVAILABLE: "the provider did not answer (outage, overload or timeout): try again later",
    E_REFUSED: "the model declined this request: rephrase the topic",
    E_BAD_REQUEST: "the provider refused the request as malformed (model id or parameters): a code fix is needed",
    E_BAD_RESPONSE: "the provider answered without text: try again; if it repeats, a code fix is needed",
}

_KEY_ENV = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}
_MAX_VENDOR_TEXT = 200


class TextProviderError(Exception):
    """One failed call. ``code`` is from the closed list above; ``remedy`` is what a person does about it."""

    def __init__(self, code: str, provider: str, detail: str = ""):
        self.code = code
        self.provider = provider
        self.remedy = REMEDIES[code]
        super().__init__(f"{provider}: {code}: {self.remedy}" + (f" ({detail})" if detail else ""))


@dataclass
class TextResult:
    text: str
    provider: str
    model: str
    usage: dict = field(default_factory=dict)   # the vendor's own usage object, recorded as given (never estimated)


def key_env(provider: str) -> str:
    return _KEY_ENV[provider]


def _vendor_text(resp, secret: str, env: Mapping[str, str]) -> str:
    try:
        body = resp.json()
        err = body.get("error") if isinstance(body, dict) else None
        msg = err.get("message") if isinstance(err, dict) else None
    except ValueError:
        msg = None
    return scrub(str(msg or ""), [secret, *env_secrets(env)])[:_MAX_VENDOR_TEXT]


def _error_field(resp, name: str) -> Optional[str]:
    try:
        body = resp.json()
    except ValueError:
        return None
    err = body.get("error") if isinstance(body, dict) else None
    val = err.get(name) if isinstance(err, dict) else None
    return val if isinstance(val, str) else None


def classify(provider: str, resp) -> str:
    """The closed code for a non-2xx answer. Pure, so a test pins every branch."""
    status = resp.status_code
    if status in (401, 403):
        return E_AUTH
    if provider == "anthropic":
        if status == 402 or _error_field(resp, "type") == "billing_error":
            return E_QUOTA
        if status == 429:
            return E_RATE_LIMITED
        if status in (500, 504, 529) or status >= 500:
            return E_UNAVAILABLE
        return E_BAD_REQUEST
    # OpenAI: one 429 status for "rate limit reached" and for "credit balance exhausted"; error.code tells them apart, and
    # error.type "can still be insufficient_quota" (guides/error-codes), so both are read.
    if status == 429:
        if "insufficient_quota" in (_error_field(resp, "code"), _error_field(resp, "type")):
            return E_QUOTA
        return E_RATE_LIMITED
    if status >= 500:
        return E_UNAVAILABLE
    return E_BAD_REQUEST


def _anthropic_request(prompt: str, model: str, system: Optional[str], safety_id: Optional[str]) -> dict:
    body = {"model": model, "max_tokens": MAX_OUTPUT_TOKENS, "messages": [{"role": "user", "content": prompt}]}
    if system:
        body["system"] = system
    if safety_id:
        body["metadata"] = {"user_id": safety_id}     # opaque id only ("Do not include any identifying information")
    return body


def _anthropic_text(data: Mapping) -> str:
    if data.get("stop_reason") == "refusal":
        raise TextProviderError(E_REFUSED, "anthropic")
    if data.get("stop_reason") == "max_tokens":
        raise TextProviderError(E_BAD_RESPONSE, "anthropic", "cut off at max_tokens")
    # thinking blocks (adaptive by default on Sonnet 5.5) are skipped; only text blocks are the answer
    texts = [b.get("text") for b in data.get("content") or [] if isinstance(b, dict) and b.get("type") == "text"]
    return "".join(t for t in texts if isinstance(t, str))


def _openai_request(prompt: str, model: str, system: Optional[str], safety_id: Optional[str]) -> dict:
    body = {"model": model, "input": prompt, "max_output_tokens": MAX_OUTPUT_TOKENS, "store": False}
    if system:
        body["instructions"] = system
    if safety_id:
        body["safety_identifier"] = safety_id
    return body


def _openai_text(data: Mapping) -> str:
    if data.get("status") == "incomplete":
        raise TextProviderError(E_BAD_RESPONSE, "openai", "the answer is incomplete")
    texts = []
    for item in data.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "refusal":
                raise TextProviderError(E_REFUSED, "openai")
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                texts.append(part["text"])
    return "".join(texts)


def call(provider: str, prompt: str, *, system: Optional[str] = None, safety_id: Optional[str] = None,
         env: Optional[Mapping[str, str]] = None, session=None, model: Optional[str] = None) -> TextResult:
    """ONE request to ``provider``; the text, or ``TextProviderError``. Never retried here and never another provider."""
    if provider not in _KEY_ENV:
        raise ValueError(f"unknown text provider {provider!r}")
    env = os.environ if env is None else env
    key = (env.get(_KEY_ENV[provider]) or "").strip()
    if not key:
        raise TextProviderError(E_NOT_CONFIGURED, provider, f"{_KEY_ENV[provider]} is not set")
    if session is None:
        import requests  # noqa: PLC0415 - only a live call needs it
        session = requests.Session()
    import requests as _rq  # noqa: PLC0415

    if provider == "anthropic":
        model = model or ANTHROPIC_MODEL
        url, body = ANTHROPIC_URL, _anthropic_request(prompt, model, system, safety_id)
        headers = {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json"}
    else:
        model = model or OPENAI_MODEL
        url, body = OPENAI_URL, _openai_request(prompt, model, system, safety_id)
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        resp = session.post(url, json=body, headers=headers, timeout=TIMEOUT_S, allow_redirects=False)
    except (_rq.Timeout, _rq.ConnectionError) as exc:
        raise TextProviderError(E_UNAVAILABLE, provider, type(exc).__name__) from None
    except (_rq.RequestException, UnicodeError) as exc:
        # Only the class: an InvalidHeader's text holds the header value, i.e. the whole key (a two-line paste; BR-LLM-002).
        raise TextProviderError(E_BAD_REQUEST, provider, type(exc).__name__) from None
    if not 200 <= resp.status_code < 300:
        raise TextProviderError(classify(provider, resp), provider,
                                f"HTTP {resp.status_code} {_vendor_text(resp, key, env)}".strip())
    try:
        data = resp.json()
    except ValueError:
        raise TextProviderError(E_BAD_RESPONSE, provider, "not JSON") from None
    if not isinstance(data, dict):
        raise TextProviderError(E_BAD_RESPONSE, provider, "not a JSON object")
    text = _anthropic_text(data) if provider == "anthropic" else _openai_text(data)
    if not text.strip():
        raise TextProviderError(E_BAD_RESPONSE, provider, "no text in the answer")
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    return TextResult(text=text, provider=provider, model=str(data.get("model") or model), usage=dict(usage))


def generate_for(provider: str, *, env: Optional[Mapping[str, str]] = None, session=None,
                 on_usage: Optional[Callable[[TextResult], None]] = None) -> Callable:
    """The planner's ``generate(prompt, stage=...)`` for ``provider`` (anthropic or openai). ``on_usage`` receives each result,
    so the caller records the vendor's own token counts; a recorder that fails never changes the answer."""
    if provider not in _KEY_ENV:
        raise ValueError(f"unknown text provider {provider!r}")

    def generate(prompt: str, *, stage: str = "") -> str:
        result = call(provider, prompt, env=env, session=session)
        if on_usage is not None:
            try:
                on_usage(result)
            except Exception as exc:  # noqa: BLE001 - a ledger gap must not change the answer, but it must be seen
                logger.warning("text provider %s: the usage record failed (%s)", provider, type(exc).__name__)
        return result.text
    return generate

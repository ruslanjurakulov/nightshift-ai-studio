"""Shared Gemini client — retries transient API failures.

The Gemini API fails in three distinct ways that matter here:
  503 UNAVAILABLE      — model overloaded, clears in seconds. Always retry.
  429 RESOURCE_EXHAUSTED with a per-minute quota — clears in ~a minute. Retry.
  429 RESOURCE_EXHAUSTED with a per-day quota — does not clear today. Give up
                         immediately rather than burning minutes on doomed waits,
                         and say so once, as GeminiDailyQuotaError (not the SDK's
                         raw 429, which reached the log as a traceback).
"""

import logging
import random
import re
import time

from google import genai
from google.genai import errors as genai_errors

from config import GEMINI_API_KEY, GEMINI_MAX_RETRIES, GEMINI_RETRY_MAX_DELAY
from modules import gemini_stages
from modules.gemini_stages import GeminiDailyQuotaError

logger = logging.getLogger(__name__)

# Overloaded model, rate limit, and transient gateway faults.
RETRYABLE_CODES = {429, 500, 502, 503, 504}


def make_client() -> genai.Client:
    return genai.Client(api_key=GEMINI_API_KEY)


def _error_details(exc: Exception) -> list:
    """Return the error's `details` list, tolerating either shape the SDK uses."""
    details = getattr(exc, "details", None)
    if isinstance(details, list):
        return details
    # Some SDK versions hand back the whole response body instead.
    if isinstance(details, dict):
        return details.get("error", {}).get("details", []) or []
    return []


def _is_daily_quota(exc: Exception) -> bool:
    """True when the 429 is a per-day quota, which no amount of waiting fixes."""
    for item in _error_details(exc):
        if not isinstance(item, dict):
            continue
        if not str(item.get("@type", "")).endswith("QuotaFailure"):
            continue
        for violation in item.get("violations", []) or []:
            if "PerDay" in str(violation.get("quotaId", "")):
                return True
    return False


def _server_delay(exc: Exception) -> float | None:
    """Google's own suggested wait, e.g. retryDelay: '41s'."""
    for item in _error_details(exc):
        if not isinstance(item, dict):
            continue
        if not str(item.get("@type", "")).endswith("RetryInfo"):
            continue
        match = re.fullmatch(r"([\d.]+)s", str(item.get("retryDelay", "")).strip())
        if match:
            return float(match.group(1))
    return None


def _backoff(exc: Exception, attempt: int) -> float:
    """Seconds to wait before attempt N — server's hint if given, else exponential."""
    delay = _server_delay(exc)
    if delay is None:
        delay = 2 ** attempt + random.uniform(0, 1)
    return min(delay, GEMINI_RETRY_MAX_DELAY)


def _quota_model(exc: Exception, requested: str) -> str:
    """The model Google says ran out (its quota dimensions), else the one this request named."""
    for item in _error_details(exc):
        if not isinstance(item, dict):
            continue
        for violation in item.get("violations", []) or []:
            dims = violation.get("quotaDimensions") if isinstance(violation, dict) else None
            model = dims.get("model") if isinstance(dims, dict) else None
            if isinstance(model, str) and gemini_stages.MODEL_ID_RE.fullmatch(model):
                return model
    return requested


def generate_with_retry(client: genai.Client, model: str, contents, config=None):
    """client.models.generate_content, retried on transient failures.

    ``model`` is normally ``gemini_stages.model_for(stage)``: the id of the model that stage uses, which
    also tells the request counter the stage. Every real attempt is counted, retries included."""
    last_exc = None
    stage = gemini_stages.stage_of(model)
    model_id = str(model)

    for attempt in range(GEMINI_MAX_RETRIES):
        gemini_stages.note_request(stage, model_id)
        try:
            return client.models.generate_content(
                model=model_id,
                contents=contents,
                config=config,
            )
        except genai_errors.APIError as exc:
            last_exc = exc
            code = getattr(exc, "code", None)

            if code not in RETRYABLE_CODES:
                raise

            if code == 429 and _is_daily_quota(exc):
                spent = _quota_model(exc, model_id)
                gemini_stages.note_daily_quota(stage, spent)
                quota = GeminiDailyQuotaError(spent, _server_delay(exc), stage)
                logger.error("%s", quota)
                raise quota from exc

            if attempt == GEMINI_MAX_RETRIES - 1:
                break

            wait = _backoff(exc, attempt)
            logger.warning(
                "Gemini %s — %.1fs kutib qayta urinaman (%d/%d)",
                code, wait, attempt + 1, GEMINI_MAX_RETRIES,
            )
            time.sleep(wait)

    logger.error("Gemini %d urinishdan keyin ham javob bermadi.", GEMINI_MAX_RETRIES)
    raise last_exc

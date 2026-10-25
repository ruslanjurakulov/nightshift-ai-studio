"""BytePlus ModelArk (international): the error vocabulary shared by the
Seedance 2.x video and the Seedream image adapters.

Source: docs.byteplus.com/en/docs/ModelArk/error-codes (read 2026-10-24). The
HTTP status alone is not enough — 429 is a rate limit (``RateLimitExceeded*``,
``ServerOverloaded``) and also an exhausted quota (``QuotaExceeded``,
``SetLimitExceeded``), 403 is a rejected key (``AccessDenied``) and also an
overdue bill (``AccountOverdueError``) — and each pair needs the opposite
remedy (CLAUDE.md #6). An unknown code maps to None, so the caller falls back
to the HTTP status and never to "success".
"""

from __future__ import annotations

from typing import Optional

from modules.capabilities.base import (
    E_AUTH,
    E_BAD_REQUEST,
    E_NOT_FOUND,
    E_POLICY,
    E_QUOTA,
    E_RATE_LIMITED,
    E_UNAVAILABLE,
)

#: Hosts a ModelArk result (video clip) is downloaded from. The docs say the
#: video URL is "valid for 24 hours" but do not name its host; the TOS storage
#: that serves ModelArk lives under these two vendor domains. A host outside
#: them is refused, so a wrong guess fails closed (the probe reports
#: ``bad_response``) instead of fetching from somewhere unchecked.
RESULT_HOSTS = ("volces.com", "bytepluses.com")

#: Exact codes first (the sharper ones), then prefixes, then substrings.
_EXACT = {
    "OperationDenied.ServiceNotOpen": E_NOT_FOUND,   # the model is not activated in the console
    "ModelNotOpen": E_NOT_FOUND,
    "OperationDenied.ServiceOverdue": E_QUOTA,       # bill overdue: top up
    "AccountOverdueError": E_QUOTA,
    "QuotaExceeded": E_QUOTA,
    "SetLimitExceeded": E_QUOTA,                     # the account's own "safe experience" cap
}
_PREFIX = (
    ("AuthenticationError", E_AUTH),
    ("AccessDenied", E_AUTH),
    ("OperationDenied", E_AUTH),
    ("RateLimitExceeded", E_RATE_LIMITED),
    ("ModelAccount", E_RATE_LIMITED),                # Rpm / Tpm / Ipm limits of the account-model pair
    ("APIAccount", E_RATE_LIMITED),
    ("AccountRateLimit", E_RATE_LIMITED),
    ("ServerOverloaded", E_RATE_LIMITED),
    ("RequestBurstTooFast", E_RATE_LIMITED),
    ("InflightBatchsizeExceeded", E_RATE_LIMITED),   # concurrency: wait, same task
    ("InvalidEndpointOrModel", E_NOT_FOUND),
    ("NotFound", E_NOT_FOUND),
    ("InvalidParameter", E_BAD_REQUEST),             # incl. TaskTypeConstraint / TaskTypeMismatch
    ("InternalServiceError", E_UNAVAILABLE),
)


def map_code(code) -> Optional[str]:
    """The adapter error code for a ModelArk ``error.code``, or None."""
    c = str(code or "")
    if not c:
        return None
    if c in _EXACT:
        return _EXACT[c]
    # Input/Output<Kind>SensitiveContentDetected(.PolicyViolation|.PrivacyInformation|.DeepFake):
    # the vendor refused the content, whatever the kind.
    if "SensitiveContentDetected" in c:
        return E_POLICY
    for prefix, mapped in _PREFIX:
        if c.startswith(prefix):
            return mapped
    return None

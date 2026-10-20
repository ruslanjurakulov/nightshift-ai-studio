"""Is this channel's YouTube token still alive? Asked BEFORE the run spends anything.

Why this exists
---------------
A YouTube refresh token can die at any time: revoked in the Google account, or expired after
7 days because the OAuth app is still in "Testing". Until now that was found at the very end of
a run, when the upload called ``creds.refresh()`` and raised ``invalid_grant`` after the script,
the voice, the stills and the render were already paid for (audit H2). The scheduled doctor
proves only the default channel's token, and only every six hours.

What it does
------------
One POST to Google's OAuth token endpoint with the channel's own refresh token, in memory,
nothing saved. That call costs no YouTube Data API quota (it is not a Data API method at all),
uploads nothing and changes nothing on the channel. It answers one of:

* ``live``    Google issued an access token.
* ``dead``    Google says the refresh token (or the OAuth client behind it) is refused:
              ``invalid_grant`` / ``invalid_client`` / ``unauthorized_client``, or the token
              file cannot be used at all (a missing field). The upload WILL fail, so the run
              stops before it spends.
* ``unknown`` Google did not give a verdict: a network error, a timeout, HTTP 429 / 5xx, a body
              this code cannot read. It is retried once; if it is still unknown the run goes on.
              An unknown is not a no, and a network blip must not stall a day's video: if the
              token really is dead the upload fails exactly as it did before, and the doctor and
              the held record say so.
* ``absent``  No token file for the channel. Nothing is asked of Google; the credential preflight
              already reports that as "publish token not ready".

Token handling
--------------
The token is resolved exactly as the uploader resolves it (``materialize_token`` then
``token_path``): an operator channel's from its ``CHRONOS_YT_TOKEN_<REF>`` secret, the legacy
default channel's from ``youtube_token.json``, a customer channel's from the file the worker
wrote from its Vault connection. The request goes to Google's fixed token URL, never to the
``token_uri`` inside the file, so a token file cannot choose where the client secret is sent.
Nothing the file or Google's reply contains is kept, logged or put in an event: the verdict is a
status and a word from a closed list.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

logger = logging.getLogger(__name__)

#: Fixed on purpose: never the ``token_uri`` inside a token file or a secret.
TOKEN_URL = "https://oauth2.googleapis.com/token"
TIMEOUT_SECONDS = 10
#: One retry for an unknown verdict, then the run goes on.
RETRY_DELAY_SECONDS = 2.0

LIVE = "live"
DEAD = "dead"
UNKNOWN = "unknown"
ABSENT = "absent"

#: The reasons Google gives that mean this token will not work until a person fixes it.
DEAD_CODES = frozenset({"invalid_grant", "invalid_client", "unauthorized_client"})
#: Our own word for a token file that cannot be used at all.
MALFORMED = "malformed"
#: The closed list of words a verdict's ``reason`` may be.
REASONS = tuple(sorted(DEAD_CODES)) + (MALFORMED, "network", "http_error", "no_answer")

_SAFE_WORD = re.compile(r"[a-z_]{1,40}")

Post = Callable[[str, dict], Tuple[Optional[int], object]]


@dataclass(frozen=True)
class TokenVerdict:
    """The outcome of one liveness check: a status and a word from :data:`REASONS`. Nothing else."""

    status: str
    reason: str = ""
    attempts: int = 0

    @property
    def dead(self) -> bool:
        return self.status == DEAD


def _post_to_google(url: str, data: dict) -> Tuple[Optional[int], object]:
    """The only network call. Errors become ``(None, None)``: a requests error quotes its URL."""
    import requests  # noqa: PLC0415 - keep the import light for callers that never ask

    try:
        r = requests.post(url, data=data, timeout=TIMEOUT_SECONDS, allow_redirects=False)
    except Exception:
        return None, None
    try:
        body = r.json()
    except ValueError:
        body = None
    return r.status_code, body


def verdict_from_response(status: Optional[int], body: object) -> TokenVerdict:
    """Read Google's answer to a refresh request. Pure; shared by the run preflight and the doctor."""
    if status is None:
        return TokenVerdict(UNKNOWN, "network")
    error = ""
    if isinstance(body, dict) and isinstance(body.get("error"), str) and _SAFE_WORD.fullmatch(body["error"]):
        error = body["error"]
    if status == 200 and isinstance(body, dict) and body.get("access_token"):
        return TokenVerdict(LIVE)
    if error in DEAD_CODES:
        return TokenVerdict(DEAD, error)
    if status == 200:
        return TokenVerdict(UNKNOWN, "no_answer")
    return TokenVerdict(UNKNOWN, "http_error")


def _read_token(channel) -> Tuple[Optional[dict], Optional[str]]:
    """(token document, None), or (None, ABSENT / MALFORMED)."""
    from modules import channel_credentials as cc  # noqa: PLC0415

    cc.materialize_token(channel)            # the same secret-to-file step the uploader takes
    path = cc.token_path(channel)
    if not path.exists():
        return None, ABSENT
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None, MALFORMED
    if not isinstance(doc, dict) or not all(str(doc.get(k) or "").strip()
                                            for k in ("refresh_token", "client_id", "client_secret")):
        return None, MALFORMED
    return doc, None


def check_channel_token(channel, *, post: Optional[Post] = None,
                        sleep: Callable[[float], None] = time.sleep) -> TokenVerdict:
    """Ask Google whether ``channel``'s token still refreshes. Never raises; never logs a value.

    ``post`` is the HTTP seam for tests. An unknown verdict is asked once more after a short wait."""
    post = post or _post_to_google
    try:
        doc, problem = _read_token(channel)
    except Exception as e:  # noqa: BLE001 - a check that cannot run is an unknown, not a stop
        logger.warning("YouTube token check could not read the token (%s)", type(e).__name__)
        return TokenVerdict(UNKNOWN, "no_answer")
    if doc is None:
        return TokenVerdict(ABSENT) if problem == ABSENT else TokenVerdict(DEAD, MALFORMED)
    form = {"client_id": str(doc["client_id"]), "client_secret": str(doc["client_secret"]),
            "refresh_token": str(doc["refresh_token"]), "grant_type": "refresh_token"}
    verdict = TokenVerdict(UNKNOWN, "no_answer")
    for attempt in (1, 2):
        try:
            status, body = post(TOKEN_URL, form)
        except Exception:  # noqa: BLE001
            status, body = None, None
        verdict = verdict_from_response(status, body)
        verdict = TokenVerdict(verdict.status, verdict.reason, attempt)
        if verdict.status != UNKNOWN:
            return verdict
        if attempt == 1:
            sleep(RETRY_DELAY_SECONDS)
    return verdict

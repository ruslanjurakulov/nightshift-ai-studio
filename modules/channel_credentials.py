"""Per-channel publishing credentials — resolution, never storage.

The rule this module exists to enforce
--------------------------------------
A YouTube OAuth **refresh token is a long-lived key to someone's channel**. It
must never reach the browser, never land in a ``NEXT_PUBLIC_*`` variable, never
be written into a database column the Command Center can read, and never appear
in a log line or an event's metadata.

So the split is:

* **The secret** lives where secrets already live for this project: a GitHub
  Actions secret, materialized into a token file on the runner for the life of
  one job (exactly what ``.github/workflows/daily_video.yml`` already does for
  the single channel). It is only ever read server-side, by this module.
* **The reference and the status** — which env var holds it, which YouTube
  channel it targets, whether it currently works, when it was last verified —
  are non-secret, and those are what get mirrored to Supabase and rendered in
  the Command Center.

``ChannelContext.credential`` (``CredentialRef``) carries only the reference.
This module turns a reference into a usable token *inside the process that
publishes*, and produces a redacted status object for everyone else.

Env var naming
--------------
For a channel whose ``credential.ref`` is ``extinct-world`` (or, when the ref is
blank, whose id is ``extinct-world``), the token JSON is read from::

    CHRONOS_YT_TOKEN_EXTINCT_WORLD

The one exception is the legacy default channel with a blank ref: it keeps
reading ``config.YOUTUBE_TOKEN_FILE`` / the existing ``YOUTUBE_TOKEN_JSON``
secret, so nothing about today's production channel changes.
"""

from __future__ import annotations

import json
import logging
import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

import config as cfg
from modules.channels import ChannelContext

logger = logging.getLogger(__name__)

ENV_PREFIX = "CHRONOS_YT_TOKEN_"

# Connection statuses. These are the only credential facts that ever leave the
# server: no token, no client secret, no scopes-with-values.
CONNECTED = "connected"
NOT_CONNECTED = "not_connected"
EXPIRED = "expired"
ERROR = "error"


@dataclass(frozen=True)
class CredentialStatus:
    """A channel's publishing-credential health, with nothing secret in it.

    Safe to log, safe to mirror to Supabase, safe to render in the browser.
    `detail` is a human-readable reason for a non-connected state and is built
    only from our own strings — never from token contents.
    """

    channel_id: str
    provider: str
    status: str
    youtube_channel_id: str = ""
    expires_at: Optional[str] = None
    last_verified_at: Optional[str] = None
    detail: str = ""

    @property
    def is_connected(self) -> bool:
        return self.status == CONNECTED

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "provider": self.provider,
            "status": self.status,
            "youtube_channel_id": self.youtube_channel_id,
            "expires_at": self.expires_at,
            "last_verified_at": self.last_verified_at,
            "detail": self.detail,
        }


def credential_key(channel: ChannelContext) -> str:
    """The name this channel's token secret and token file are derived from.

    The operator's own channels may name a reference (``credential.ref``): that
    is how one GitHub secret serves a channel whose id differs from it. Every
    other channel's key is its own id, whatever its row says. ``credential_ref``
    is written through the Command Center; a customer organization's row must
    never choose which secret the shared worker reads (BR-G-002), so for those
    channels the reference is ignored here and, in ``tools/queue_worker``,
    nothing is read from the environment at all: their token is their Vault
    connection.
    """
    if channel.is_operators:
        return channel.credential.ref or str(channel.channel_id)
    return str(channel.channel_id)


def secret_name_for(key: str) -> str:
    """The secret / env var name a token key is stored under: non-alphanumerics
    collapse to ``_``, ``_`` is trimmed, upper case. supabase 0086's
    ``channel_secret_name`` is the same function in SQL, and
    tests/security/test_sec_breach_channel_config.py pins the two against each
    other over a corpus: two ids that normalise to one name are one secret, so
    ``create_channel`` refuses the second (BR-L-080)."""
    return ENV_PREFIX + re.sub(r"[^A-Z0-9]+", "_", key.upper()).strip("_")


def env_var_name(channel: ChannelContext) -> str:
    """The env var expected to hold this channel's token JSON. Only the
    operator's own channels have one: a customer channel's token is its Vault
    connection, never the environment (BR-G-002, BR-L-080)."""
    return secret_name_for(credential_key(channel))


def customer_token_filename(channel_id: str) -> str:
    """The token file of a channel that is not the operator's. A name no
    operator reference can produce (``youtube_token_<ref>.json`` always has a
    letter or digit after the underscore), so a customer's file is never an
    operator's."""
    return "youtube_token__" + re.sub(r"[^a-zA-Z0-9_-]+", "-", str(channel_id)) + ".json"


#: What both workflows actually write the default channel's token to. See
#: LEGACY_TOKEN_NAME's use in token_path() for why this constant has to exist.
LEGACY_TOKEN_NAME = "youtube_token.json"


def legacy_token_path() -> Path:
    """The single-channel token path, with the unsuffixed fallback.

    Split out of token_path() because the callers that pass no channel at all —
    ``AnalyticsClient(channel=None)`` and friends, which is how
    ``tools/run_intelligence_poll.py`` constructs its first poller — used
    ``cfg.YOUTUBE_TOKEN_FILE`` directly and so never reached the fallback. The
    result was that the poll looked for the suffixed name, missed the file the
    workflow had actually written, and reported "no usable token" while the
    token sat right there.

    One function, so there is one answer to "where is the default channel's
    token" no matter which door the caller came through.
    """
    primary = Path(cfg.YOUTUBE_TOKEN_FILE)
    if primary.exists():
        return primary
    fallback = Path(cfg.BASE_DIR) / LEGACY_TOKEN_NAME
    return fallback if fallback.exists() else primary


def token_path(channel: ChannelContext) -> Path:
    """Where this channel's token file lives on disk.

    The legacy default channel (blank ref) keeps the existing path so an
    already-working deployment keeps working with no migration.

    The unsuffixed fallback
    -----------------------
    ``config.YOUTUBE_TOKEN_FILE`` is ``youtube_token_<YOUTUBE_CHANNEL_ID>.json``
    when that env var is set and ``youtube_token.json`` when it is not — but
    both workflows restore the ``YOUTUBE_TOKEN_JSON`` secret to the *unsuffixed*
    name while also exporting ``YOUTUBE_CHANNEL_ID``. So on CI the token was
    written to one name and looked for under another, the file was never found,
    and the run died in ``require_interactive_consent_possible`` — "no browser
    on a CI runner" — as if no token had been provided at all.

    Falling back here fixes every consumer at once (uploader, analytics client,
    comment fetcher all resolve through this function) and fixes the same trap
    locally, where a token minted before ``YOUTUBE_CHANNEL_ID`` was known is
    also left under the plain name.

    The fallback can only ever *find* a token, never shadow one: it is consulted
    only when the suffixed file does not exist, and when neither exists the
    suffixed path is still returned so a fresh token is written where this
    deployment expects it.
    """
    # Only the operator's own `default` channel has the legacy token file: a customer
    # channel that somehow carries the id `default` (BR-L-110) gets its own namespace.
    if channel.is_default and channel.is_operators and not channel.credential.ref:
        return legacy_token_path()
    if not channel.is_operators:
        return cfg.BASE_DIR / customer_token_filename(str(channel.channel_id))
    key = credential_key(channel)
    # No leading underscore: "youtube_token__<id>.json" is the customer namespace.
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "-", key).lstrip("_")
    return cfg.BASE_DIR / f"youtube_token_{safe}.json"


def materialize_token(channel: ChannelContext) -> Optional[Path]:
    """Write this channel's token from its env var to its token file, if the
    env var is set and the file isn't already there. Returns the path when a
    usable token file exists afterwards, else None.

    The file is created 0600 where the platform supports it. Nothing about the
    token's *contents* is ever logged — only the path and the channel id.
    """
    path = token_path(channel)
    if not channel.is_operators:
        # Never the environment (BR-L-080): the runner holds the operator's
        # tokens there, and a customer's channel id can normalise to the name of
        # one. A customer's token reaches the run only as the file the worker
        # (or tools/restore_channel_token.py) wrote from its Vault connection.
        return path if path.exists() else None
    raw = os.getenv(env_var_name(channel), "").strip()
    if raw:
        try:
            # Parse before writing: an empty or truncated secret should fail
            # here, loudly and without a token ever being half-written.
            json.loads(raw)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(raw, encoding="utf-8")
            try:
                path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            except OSError:
                pass  # Windows / restricted FS — the write itself still stands.
            logger.info("Channel %s: token materialized at %s", channel.channel_id, path.name)
        except Exception as e:
            # Deliberately does not include `raw` or the exception's payload
            # beyond its type — a JSON error can echo the document it failed on.
            logger.warning(
                "Channel %s: %s is set but is not valid token JSON (%s) — ignoring it",
                channel.channel_id, env_var_name(channel), type(e).__name__,
            )
    return path if path.exists() else None


def credential_status(channel: ChannelContext, *, now: Optional[datetime] = None) -> CredentialStatus:
    """Inspect this channel's credential and report its health.

    Reads the token file to check expiry — reads, never echoes. A missing file
    is NOT an error, it is `not_connected`: a channel that has not been
    connected yet is a normal state, not a failure.
    """
    now = now or datetime.now(timezone.utc)
    ref = channel.credential
    base = dict(
        channel_id=str(channel.channel_id),
        provider=ref.provider or "youtube",
        youtube_channel_id=ref.youtube_channel_id,
    )
    path = token_path(channel)
    if not path.exists():
        return CredentialStatus(
            **base,
            status=NOT_CONNECTED,
            detail=("No token for this channel. Connect YouTube from the Command Center's Channels page."
                    if not channel.is_operators else
                    f"No token for this channel. Set {env_var_name(channel)} "
                    "(see docs/MULTI_CHANNEL.md) or connect it with tools/connect_channel.py."),
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return CredentialStatus(
            **base, status=ERROR, detail=f"Token file is unreadable ({type(e).__name__})."
        )

    expiry = data.get("expiry")
    has_refresh = bool(data.get("refresh_token"))
    expires_at = str(expiry) if expiry else None
    parsed = _parse_iso(expiry) if expiry else None

    if parsed is not None and parsed <= now:
        # An expired access token with a refresh token is normal and
        # self-healing — google-auth refreshes it on the next upload. Without
        # one, the channel genuinely needs reconnecting.
        if has_refresh:
            return CredentialStatus(
                **base, status=CONNECTED, expires_at=expires_at,
                last_verified_at=_file_mtime_iso(path),
                detail="Access token expired; will refresh on next use.",
            )
        return CredentialStatus(
            **base, status=EXPIRED, expires_at=expires_at,
            last_verified_at=_file_mtime_iso(path),
            detail="Token expired and has no refresh token — reconnect this channel.",
        )

    return CredentialStatus(
        **base, status=CONNECTED, expires_at=expires_at,
        last_verified_at=_file_mtime_iso(path),
    )


def token_diagnosis(token_file: Optional[Path], required_scopes: Iterable[str] = ()) -> str:
    """Why this token file cannot be used, in one non-secret sentence.

    "No usable token" has at least four distinct causes, and they need four
    different fixes: the secret was never set, the secret arrived truncated, the
    consent screen granted fewer scopes than the code needs, or Google returned
    no refresh token because the account had already authorised this client.
    Reporting them as one message costs a debugging round-trip every time, so
    this names which one it is.

    Only *facts about* the token are described — which scopes are missing, which
    fields are absent. No token, refresh token, client id or client secret value
    is ever included, so the result is safe to log and safe to put in an
    exception that reaches CI output.
    """
    if token_file is None:
        return "no token file was resolved"
    path = Path(token_file)
    if not path.exists():
        return (
            f"no token file at {path.name} — the YOUTUBE_TOKEN_JSON secret is "
            "probably unset, so the workflow wrote nothing"
        )
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        return (
            f"{path.name} is not valid JSON ({type(e).__name__}) — the secret was "
            "likely pasted incomplete"
        )
    if not isinstance(data, dict):
        return f"{path.name} does not contain a token object"

    missing_fields = [f for f in ("refresh_token", "client_id", "client_secret") if not data.get(f)]
    if missing_fields:
        return (
            f"{path.name} is missing {', '.join(missing_fields)}. A token with no "
            "refresh_token cannot be renewed: revoke Nightshift at "
            "myaccount.google.com/permissions and connect the channel again"
        )

    granted = set(data.get("scopes") or [])
    lacking = [scope for scope in required_scopes if scope not in granted]
    if lacking:
        return (
            f"{path.name} was granted {len(granted)} scope(s) but is missing: "
            f"{', '.join(lacking)}. Re-run tools/connect_channel.py and accept every "
            "permission on Google's consent screen"
        )
    return (
        f"{path.name} looks complete (all required scopes, refresh token present) — "
        "if this still fails, the stored secret and this file differ"
    )


def require_interactive_consent_possible(
    channel_label: str = "",
    token_file: Optional[Path] = None,
    required_scopes: Iterable[str] = (),
) -> None:
    """Raise before starting an OAuth flow that cannot possibly succeed here.

    ``InstalledAppFlow.run_local_server()`` opens a browser and waits for a
    human. On a CI runner there is no browser and no human, so the flow either
    hangs until the job's timeout or dies with a confusing socket error. Failing
    fast with the actual remedy is strictly better than either.

    `token_file` and `required_scopes` are optional so existing callers keep
    working, but passing them turns "no usable token" into the specific reason —
    see token_diagnosis.
    """
    if not os.getenv("CI"):
        return
    raise RuntimeError(
        f"{channel_label}No usable YouTube token, and interactive consent is "
        "impossible on a CI runner (no browser).\n"
        f"Reason: {token_diagnosis(token_file, required_scopes)}.\n"
        "Run tools/connect_channel.py on a trusted machine, then store the "
        "resulting token as this channel's GitHub Actions secret — see "
        "docs/MULTI_CHANNEL.md."
    )


def client_secret_problem(path: Optional[Path] = None) -> Optional[str]:
    """Why this client-secret file is unusable, or None when it is fine.

    Existence is not enough. The workflows write the secret with
    ``echo '<secret>' > client_secret.json``, so when the secret is unset the
    file exists and contains one empty line — and every auth path here used to
    check only ``Path(...).exists()``, hand that file to
    ``InstalledAppFlow.from_client_secrets_file()``, and surface a bare
    ``JSONDecodeError: Expecting value: line 2 column 1``. That is the error
    every scheduled poll has actually been failing with, and it names neither
    the file nor the fix.
    """
    target = Path(path) if path is not None else Path(cfg.YOUTUBE_CLIENT_SECRET)
    if not target.exists():
        return (
            f"client_secret.json not found at {target}. Download it from Google "
            "Cloud Console -> APIs & Services -> Credentials, or set the "
            "YOUTUBE_CLIENT_SECRET_JSON secret."
        )
    try:
        raw = target.read_text(encoding="utf-8").strip()
    except OSError as e:
        return f"client_secret.json at {target} could not be read ({type(e).__name__})."
    if not raw:
        return (
            f"client_secret.json at {target} is empty — the YOUTUBE_CLIENT_SECRET_JSON "
            "secret is unset or blank, so the workflow wrote nothing into it."
        )
    try:
        data = json.loads(raw)
    except ValueError:
        return f"client_secret.json at {target} is not valid JSON."
    # Google writes the credentials under exactly one of these two keys.
    if not isinstance(data, dict) or not ({"installed", "web"} & set(data)):
        return (
            f"client_secret.json at {target} has no 'installed' or 'web' section — "
            "it does not look like an OAuth client file."
        )
    return None


def _parse_iso(value) -> Optional[datetime]:
    try:
        text = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _file_mtime_iso(path: Path) -> Optional[str]:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return None

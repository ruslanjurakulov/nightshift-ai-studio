"""Customer channels' YouTube tokens from Supabase Vault — resolution only.

Migration 0022 lets a customer organization's admin connect their own channel
from the Command Center: the refresh token is encrypted in Supabase Vault and
only the service role can read it back (``read_channel_token``). This module is
the runner's side of that: it asks for the token at run time and turns it into
the authorized-user JSON the uploader already loads — in memory, never logged.

Fallback order, per channel
---------------------------
1. The legacy default channel never consults Vault. Its token stays the
   ``YOUTUBE_TOKEN_JSON`` GitHub secret, exactly as before.
2. An ACTIVE Vault connection wins. A customer who connected (or reconnected)
   their channel expects that connection to be the one used.
3. Otherwise the channel's own ``CHRONOS_YT_TOKEN_<REF>`` env var / GitHub
   secret, as before 0022 — so nothing changes for a channel nobody connected
   through Vault, or for a deployment that has not applied 0022.
4. Otherwise no token: publishing and analytics are skipped for the run, as
   they are today for a channel with no secret. Never another channel's token.

A Vault lookup that FAILS (network, HTTP 5xx) is not "no token": when there is
no env fallback it raises, so a run stops before it spends anything instead of
rendering a video it then cannot upload. When there is a fallback, it is used
and the log says so.

What never leaves this module: the refresh token, the OAuth client secret, and
anything derived from them. Exceptions and log lines carry our own words, an
HTTP status and an exception type name — never a response body, which could
echo the token.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Optional, Tuple

logger = logging.getLogger(__name__)

TOKEN_URI = "https://oauth2.googleapis.com/token"

SOURCE_VAULT = "vault"
SOURCE_ENV = "env"
SOURCE_NONE = "none"

#: The Command Center's OAuth client (the one that mints Vault tokens). The
#: runner needs the same pair to refresh them: a refresh token only works with
#: the client that minted it.
CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID"
CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET"
CLIENT_FILE_ENV = "YOUTUBE_CLIENT_SECRET_JSON"


class ChannelTokenError(RuntimeError):
    """A channel's Vault token could not be used. The message is ours and
    names the remedy; it never contains a token, a secret or a response body."""


@dataclass(frozen=True)
class VaultToken:
    """One row of ``read_channel_token``. ``repr`` hides the token."""

    refresh_token: str = field(repr=False)
    scopes: Tuple[str, ...] = ()
    oauth_client_id: str = ""
    youtube_channel_id: str = ""


@dataclass(frozen=True)
class ResolvedToken:
    """Which token a run gets. ``token_json`` is the authorized-user document
    (``Credentials.from_authorized_user_info``); ``repr`` hides it."""

    source: str
    token_json: str = field(default="", repr=False)

    @property
    def found(self) -> bool:
        return bool(self.token_json)


class VaultTokenClient:
    """``read_channel_token`` over PostgREST with the service key."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 15.0, session=None):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._timeout = timeout
        self._http = session

    @property
    def configured(self) -> bool:
        return bool(self.url and self._key)

    def _session(self):
        if self._http is None:
            import requests  # noqa: PLC0415 — keep imports light for callers that never ask

            self._http = requests.Session()
        return self._http

    def read(self, channel_id: str) -> Optional[VaultToken]:
        """The channel's active token, or None when it has none (never
        connected, revoked, or 0022 not applied). Raises ChannelTokenError when
        the lookup itself failed."""
        if not self.configured:
            return None
        try:
            r = self._session().post(
                f"{self.url}/rest/v1/rpc/read_channel_token",
                json={"p_channel_id": str(channel_id)},
                headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                         "Content-Type": "application/json"},
                timeout=self._timeout,
            )
        except Exception as e:  # network, TLS, timeout — the type only
            raise ChannelTokenError(f"Vault token lookup failed ({type(e).__name__})") from None
        status = getattr(r, "status_code", 0)
        if status == 404:
            # PostgREST's "function not found": 0022 is not applied here, which
            # means no channel can have a Vault token. Not an error.
            logger.info("channel %s: read_channel_token is not available (migration 0022 "
                        "not applied) — using the channel's GitHub secret, as before", channel_id)
            return None
        if status >= 300:
            raise ChannelTokenError(f"Vault token lookup failed: HTTP {status}")
        try:
            rows = r.json() or []
        except Exception:
            raise ChannelTokenError("Vault token lookup returned an unreadable answer") from None
        if isinstance(rows, dict):
            rows = [rows]
        if not rows:
            return None
        row = rows[0] if isinstance(rows[0], dict) else {}
        token = str(row.get("refresh_token") or "").strip()
        if not token:
            return None
        return VaultToken(
            refresh_token=token,
            scopes=tuple(str(s) for s in (row.get("scopes") or []) if s),
            oauth_client_id=str(row.get("oauth_client_id") or ""),
            youtube_channel_id=str(row.get("youtube_channel_id") or ""),
        )


def _clients_from_env(env: Mapping[str, str]) -> list:
    """Every OAuth client this runner knows, as (client_id, client_secret)."""
    found = []
    cid = (env.get(CLIENT_ID_ENV) or "").strip()
    csec = (env.get(CLIENT_SECRET_ENV) or "").strip()
    if cid and csec:
        found.append((cid, csec))
    raw = (env.get(CLIENT_FILE_ENV) or "").strip()
    if raw:
        try:
            doc = json.loads(raw)
        except ValueError:
            doc = None
        if isinstance(doc, dict):
            for section in ("web", "installed"):
                sec = doc.get(section)
                if isinstance(sec, dict) and sec.get("client_id") and sec.get("client_secret"):
                    found.append((str(sec["client_id"]), str(sec["client_secret"])))
    return found


def oauth_client_for(token: VaultToken, env: Mapping[str, str]) -> Tuple[str, str]:
    """The OAuth client to refresh ``token`` with.

    A refresh token only works with the client that minted it, so when the
    token names its client that exact client is required — picking "some
    client" would fail later, inside an upload, with ``unauthorized_client``.
    """
    clients = _clients_from_env(env)
    if token.oauth_client_id:
        for cid, csec in clients:
            if cid == token.oauth_client_id:
                return cid, csec
        raise ChannelTokenError(
            "this channel's Vault token was minted by the Command Center's OAuth client, "
            f"which this runner does not have: set {CLIENT_ID_ENV} and {CLIENT_SECRET_ENV} "
            "to the same values the Command Center uses")
    if clients:
        return clients[0]
    raise ChannelTokenError(
        f"no OAuth client configured to refresh a Vault token: set {CLIENT_ID_ENV} and "
        f"{CLIENT_SECRET_ENV} (the Command Center's OAuth client)")


def build_token_json(token: VaultToken, client_id: str, client_secret: str) -> str:
    """The authorized-user document the uploader loads.

    Vault holds only the refresh token, so there is no access token. The
    expiry is set in the past on purpose: every consumer (uploader, analytics
    client, comment fetcher) refreshes only when ``creds.expired`` — with no
    expiry a token-less credential reads as neither valid nor expired, and the
    consumer falls through to the interactive consent flow, which on a runner
    is a hard failure."""
    return json.dumps({
        "token": None,
        "refresh_token": token.refresh_token,
        "token_uri": TOKEN_URI,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": list(token.scopes),
        "expiry": "1970-01-01T00:00:00Z",
    })


def resolve_channel_token(
    channel_id: str,
    env_name: str,
    env: Mapping[str, str],
    *,
    client: Optional[VaultTokenClient] = None,
    is_default: bool = False,
    expected_youtube_channel_id: str = "",
) -> ResolvedToken:
    """This channel's token, by the fallback order in the module docstring."""
    env_token = (env.get(env_name) or "").strip() if env_name else ""

    if not is_default and client is not None:
        try:
            vault = client.read(channel_id)
        except ChannelTokenError as e:
            if env_token:
                logger.warning("channel %s: %s — using %s instead", channel_id, e, env_name)
                return ResolvedToken(SOURCE_ENV, env_token)
            raise
        if vault is not None:
            if (expected_youtube_channel_id and vault.youtube_channel_id
                    and vault.youtube_channel_id != expected_youtube_channel_id):
                # 0022 refuses this at connect time for a verified channel; a
                # channel verified AFTER it was connected can still disagree.
                raise ChannelTokenError(
                    "this channel's Vault token was granted for a different YouTube channel "
                    "than the one it is verified against — reconnect it from the Command Center")
            cid, csec = oauth_client_for(vault, env)
            logger.info("channel %s: using its Vault token (connected from the Command Center)",
                        channel_id)
            return ResolvedToken(SOURCE_VAULT, build_token_json(vault, cid, csec))

    if env_token:
        return ResolvedToken(SOURCE_ENV, env_token)
    return ResolvedToken(SOURCE_NONE)


def secret_strings(resolved: ResolvedToken) -> list:
    """Every string inside the resolved token worth masking in output: the
    whole document and each field long enough to be a secret."""
    if not resolved.token_json:
        return []
    out = {resolved.token_json}
    try:
        doc = json.loads(resolved.token_json)
    except ValueError:
        doc = None
    if isinstance(doc, dict):
        for key in ("refresh_token", "client_secret", "token"):
            v = doc.get(key)
            if isinstance(v, str) and len(v) >= 8:
                out.add(v)
    return sorted(out, key=len, reverse=True)


def write_private(path: Path, text: str) -> Path:
    """Write ``text`` to ``path`` created 0600 from the first byte — never a
    moment where the file exists with the umask's wider permissions."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)  # O_CREAT's mode does not apply to an existing file
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path

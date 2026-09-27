"""Instagram / TikTok tokens from Supabase Vault — the worker's side of 0028.

Migration 0028 lets an organization's editor connect an Instagram professional
account or a TikTok account from the Command Center. The tokens are encrypted
in Supabase Vault; only the service role can read them (``read_social_token``)
or store a refreshed pair (``rotate_social_token``). This module is the only
place in the pipeline that touches them, and it keeps them in memory only.

Refresh rules (official docs):

* Instagram API with Instagram Login — the stored token is a LONG-LIVED user
  token (60 days). It can be refreshed once it is at least 24 hours old and
  not yet expired; the refreshed token is valid for another 60 days.
  ``GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token``
  https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
* TikTok — the access token lasts 24 hours, the refresh token 365 days; a
  refresh may return a NEW refresh token, which then replaces the old one.
  ``POST https://open.tiktokapis.com/v2/oauth/token/`` (grant_type=refresh_token,
  client_key, client_secret, refresh_token)
  https://developers.tiktok.com/doc/oauth-user-access-token-management

What never leaves this module: a token, the TikTok client secret, or a response
body (which could echo either). Exceptions and log lines carry our own words,
an account id, an HTTP status and an exception type name.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Mapping, Optional

logger = logging.getLogger(__name__)

IG_REFRESH_URL = "https://graph.instagram.com/refresh_access_token"
TT_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"

TIKTOK_CLIENT_KEY_ENV = "TIKTOK_CLIENT_KEY"
TIKTOK_CLIENT_SECRET_ENV = "TIKTOK_CLIENT_SECRET"

#: Refresh an Instagram token when it has less than this left.
IG_REFRESH_WINDOW = timedelta(days=10)
#: Instagram refuses to refresh a token younger than this.
IG_MIN_AGE = timedelta(hours=24)
#: Refresh a TikTok access token when it has less than this left.
TT_REFRESH_WINDOW = timedelta(minutes=10)


class SocialTokenError(RuntimeError):
    """A social account's token could not be used. The message is ours; it
    never contains a token, a secret or a response body."""


@dataclass(frozen=True)
class SocialToken:
    """One row of ``read_social_token``. ``repr`` hides both tokens."""

    account_id: str
    org_id: str
    platform: str
    external_id: str
    access_token: str = field(repr=False, default="")
    refresh_token: str = field(repr=False, default="")
    access_expires_at: Optional[datetime] = None
    refresh_expires_at: Optional[datetime] = None
    connected_at: Optional[datetime] = None


def _parse_ts(v) -> Optional[datetime]:
    if not v:
        return None
    try:
        s = str(v).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


class SocialTokenClient:
    """The 0028 service-role RPCs over PostgREST."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 15.0, session=None):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self._timeout = timeout
        self._http = session

    @classmethod
    def from_env(cls, env: Optional[Mapping[str, str]] = None, session=None) -> "SocialTokenClient":
        env = os.environ if env is None else env
        return cls(env.get("SUPABASE_URL", ""), env.get("SUPABASE_SERVICE_KEY", ""), session=session)

    @property
    def configured(self) -> bool:
        return bool(self.url and self._key)

    def _session(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _rpc(self, name: str, payload: dict):
        try:
            r = self._session().post(
                f"{self.url}/rest/v1/rpc/{name}",
                json=payload,
                headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                         "Content-Type": "application/json"},
                timeout=self._timeout,
            )
        except Exception as e:  # network, TLS, timeout — the type only
            raise SocialTokenError(f"{name} failed ({type(e).__name__})") from None
        status = getattr(r, "status_code", 0)
        if status >= 300:
            raise SocialTokenError(f"{name} failed: HTTP {status}")
        try:
            return r.json()
        except Exception:
            return None

    def read(self, account_id: str) -> Optional[SocialToken]:
        """The account's active tokens, or None (never connected, revoked)."""
        if not self.configured:
            raise SocialTokenError("SUPABASE_URL / SUPABASE_SERVICE_KEY are not set on this worker")
        rows = self._rpc("read_social_token", {"p_account_id": str(account_id)}) or []
        if isinstance(rows, dict):
            rows = [rows]
        if not rows or not isinstance(rows[0], dict):
            return None
        row = rows[0]
        access = str(row.get("access_token") or "").strip()
        if not access:
            return None
        return SocialToken(
            account_id=str(row.get("account_id") or account_id),
            org_id=str(row.get("org_id") or ""),
            platform=str(row.get("platform") or ""),
            external_id=str(row.get("external_id") or ""),
            access_token=access,
            refresh_token=str(row.get("refresh_token") or "").strip(),
            access_expires_at=_parse_ts(row.get("access_expires_at")),
            refresh_expires_at=_parse_ts(row.get("refresh_expires_at")),
            connected_at=_parse_ts(row.get("connected_at")),
        )

    def rotate(self, tok: SocialToken) -> None:
        self._rpc("rotate_social_token", {
            "p_account_id": tok.account_id,
            "p_access_token": tok.access_token,
            "p_refresh_token": tok.refresh_token or None,
            "p_access_expires_at": tok.access_expires_at.isoformat() if tok.access_expires_at else None,
            "p_refresh_expires_at": tok.refresh_expires_at.isoformat() if tok.refresh_expires_at else None,
        })

    def set_status(self, account_id: str, status: str) -> None:
        try:
            self._rpc("set_social_account_status", {"p_account_id": str(account_id), "p_status": status})
        except SocialTokenError as e:  # best effort: the caller is already failing
            logger.warning("account %s: could not mark %s (%s)", account_id, status, e)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _needs_instagram_refresh(tok: SocialToken, now: datetime) -> bool:
    if tok.access_expires_at is None:
        return False  # unknown expiry: use it; a 190 error will say otherwise
    if tok.access_expires_at <= now:
        return False  # expired: cannot be refreshed
    if tok.access_expires_at - now > IG_REFRESH_WINDOW:
        return False
    return tok.connected_at is None or now - tok.connected_at >= IG_MIN_AGE


def _needs_tiktok_refresh(tok: SocialToken, now: datetime) -> bool:
    return tok.access_expires_at is None or tok.access_expires_at - now <= TT_REFRESH_WINDOW


def ensure_fresh(tok: SocialToken, client: SocialTokenClient, *, http=None,
                 env: Optional[Mapping[str, str]] = None, now: Optional[datetime] = None) -> SocialToken:
    """Return a usable token for ``tok``'s account, refreshing (and storing the
    refreshed pair through ``rotate_social_token``) when it is close to expiry.

    Raises SocialTokenError — after marking the account 'expired' — when the
    token cannot be used any more; the Command Center then asks to reconnect.
    """
    env = os.environ if env is None else env
    now = now or _now()
    http = http or client._session()

    if tok.platform == "instagram":
        if tok.access_expires_at is not None and tok.access_expires_at <= now:
            client.set_status(tok.account_id, "expired")
            raise SocialTokenError(f"instagram account {tok.account_id}: token expired; reconnect it")
        if not _needs_instagram_refresh(tok, now):
            return tok
        try:
            r = http.get(IG_REFRESH_URL, params={"grant_type": "ig_refresh_token",
                                                 "access_token": tok.access_token}, timeout=20)
        except Exception as e:
            logger.warning("instagram account %s: refresh failed (%s); using the current token",
                           tok.account_id, type(e).__name__)
            return tok
        status = getattr(r, "status_code", 0)
        if status >= 300:
            logger.warning("instagram account %s: refresh refused (HTTP %s); using the current token",
                           tok.account_id, status)
            return tok
        body = r.json() or {}
        new = str(body.get("access_token") or "").strip()
        if not new:
            return tok
        expires = body.get("expires_in")
        fresh = replace(tok, access_token=new,
                        access_expires_at=now + timedelta(seconds=int(expires)) if isinstance(expires, (int, float)) else None)
        client.rotate(fresh)
        return fresh

    if tok.platform == "tiktok":
        if not _needs_tiktok_refresh(tok, now):
            return tok
        if not tok.refresh_token or (tok.refresh_expires_at is not None and tok.refresh_expires_at <= now):
            client.set_status(tok.account_id, "expired")
            raise SocialTokenError(f"tiktok account {tok.account_id}: refresh token expired; reconnect it")
        key = (env.get(TIKTOK_CLIENT_KEY_ENV) or "").strip()
        secret = (env.get(TIKTOK_CLIENT_SECRET_ENV) or "").strip()
        if not key or not secret:
            raise SocialTokenError(
                f"set {TIKTOK_CLIENT_KEY_ENV} and {TIKTOK_CLIENT_SECRET_ENV} on the worker (the same "
                "values the Command Center uses) to refresh TikTok tokens")
        try:
            r = http.post(TT_TOKEN_URL, data={
                "client_key": key, "client_secret": secret,
                "grant_type": "refresh_token", "refresh_token": tok.refresh_token,
            }, headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=20)
        except Exception as e:
            raise SocialTokenError(f"tiktok account {tok.account_id}: refresh failed ({type(e).__name__})") from None
        status = getattr(r, "status_code", 0)
        try:
            body = r.json() or {}
        except Exception:
            body = {}
        if status >= 300 or body.get("error") or not body.get("access_token"):
            if 400 <= status < 500 or body.get("error"):
                client.set_status(tok.account_id, "expired")
            raise SocialTokenError(f"tiktok account {tok.account_id}: refresh refused (HTTP {status}); reconnect it")
        exp = body.get("expires_in")
        rexp = body.get("refresh_expires_in")
        fresh = replace(
            tok,
            access_token=str(body["access_token"]),
            refresh_token=str(body.get("refresh_token") or tok.refresh_token),
            access_expires_at=now + timedelta(seconds=int(exp)) if isinstance(exp, (int, float)) else None,
            refresh_expires_at=(now + timedelta(seconds=int(rexp)) if isinstance(rexp, (int, float))
                                else tok.refresh_expires_at),
        )
        client.rotate(fresh)
        return fresh

    raise SocialTokenError(f"account {tok.account_id}: unknown platform")

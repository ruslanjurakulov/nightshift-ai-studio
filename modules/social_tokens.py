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
* X (API v2, OAuth 2.0 with PKCE) — the access token lasts two hours; with the ``offline.access`` scope a refresh token is
  issued. ``POST https://api.x.com/2/oauth2/token`` form-encoded ``grant_type=refresh_token``, ``refresh_token`` and, for a
  public client, ``client_id`` (a confidential client sends ``Authorization: Basic`` instead). The page does NOT say whether
  the refresh token rotates, so a new one is stored when X sends it and the old one kept when it does not.
  https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
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

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Mapping, Optional

logger = logging.getLogger(__name__)

IG_REFRESH_URL = "https://graph.instagram.com/refresh_access_token"
TT_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/"
X_TOKEN_URL = "https://api.x.com/2/oauth2/token"

TIKTOK_CLIENT_KEY_ENV = "TIKTOK_CLIENT_KEY"
TIKTOK_CLIENT_SECRET_ENV = "TIKTOK_CLIENT_SECRET"
X_CLIENT_ID_ENV = "X_CLIENT_ID"
X_CLIENT_SECRET_ENV = "X_CLIENT_SECRET"

#: Refresh an Instagram token when it has less than this left.
IG_REFRESH_WINDOW = timedelta(days=10)
#: Instagram refuses to refresh a token younger than this.
IG_MIN_AGE = timedelta(hours=24)
#: Refresh a TikTok access token when it has less than this left.
TT_REFRESH_WINDOW = timedelta(minutes=10)
#: Refresh an X access token (two hours) when it has less than this left.
X_REFRESH_WINDOW = timedelta(minutes=10)


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


#: The most a token-endpoint answer is read for (it holds two tokens and a few words).
MAX_TOKEN_ANSWER = 64 * 1024


#: A token-endpoint answer must arrive within this, once its headers are in.
TOKEN_READ_SECONDS = 20.0
#: ... and its headers within this (a wall-clock watchdog, see ``guarded_call``).
TOKEN_HEADER_SECONDS = 30.0


class CallTimedOut(Exception):
    """``guarded_call`` gave up waiting for a response."""


def guarded_call(fn, seconds: float):
    """``fn()`` with a WALL-CLOCK limit on getting its response. ``requests`` timeouts are per socket operation, so a server
    that sends its headers one byte at a time keeps a call alive for ever; this waits at most ``seconds`` and raises
    ``CallTimedOut`` (the call keeps running on a daemon thread until its own timeouts end it, and a response that arrives
    after the wait is closed, never used). Exceptions of ``fn`` are re-raised."""
    box: dict = {}
    done, abandoned = threading.Event(), threading.Event()

    def close(resp) -> None:
        try:
            resp.close()
        except Exception:
            pass

    def run() -> None:
        try:
            box["r"] = fn()
        except BaseException as e:  # noqa: BLE001 - handed to the caller
            box["e"] = e
        finally:
            done.set()
            if abandoned.is_set() and "r" in box:
                close(box["r"])

    threading.Thread(target=run, daemon=True).start()
    if not done.wait(max(float(seconds), 0.0)):
        abandoned.set()
        if done.is_set() and "r" in box:      # it finished while we were deciding
            close(box["r"])
        raise CallTimedOut()
    if "e" in box:
        raise box["e"]
    return box["r"]


def _content_encoding(r) -> str:
    """The answer's ``Content-Encoding`` word when it is anything but identity ("unknown" for an odd value), else ""."""
    coding = str((getattr(r, "headers", None) or {}).get("Content-Encoding") or "").strip().lower()
    if not coding or coding == "identity":
        return ""
    return coding if len(coding) <= 20 and all(c.isalnum() or c == "-" for c in coding) else "unknown"


def _bounded_json(r, *, clock=time.monotonic, seconds: float = TOKEN_READ_SECONDS) -> dict:
    """The JSON object of a token-endpoint answer, read through ``MAX_TOKEN_ANSWER`` bytes and a wall-clock limit (what has
    ARRIVED is read, so a body that drips one byte at a time is cut at the limit); ``{}`` when it is not one."""
    deadline = clock() + seconds
    try:
        stream = getattr(r, "iter_content", None)
        read1 = getattr(getattr(r, "raw", None), "read1", None)
        if callable(read1):
            buf = bytearray()
            while True:
                chunk = read1(8192)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > MAX_TOKEN_ANSWER or clock() > deadline:
                    return {}
            body = json.loads(bytes(buf).decode("utf-8")) if buf else {}
        elif stream is None:
            body = r.json()
        else:
            buf = bytearray()
            for chunk in stream(chunk_size=512):
                buf += chunk
                if len(buf) > MAX_TOKEN_ANSWER or clock() > deadline:
                    return {}
            body = json.loads(bytes(buf).decode("utf-8")) if buf else {}
    except Exception:
        return {}
    finally:
        try:
            r.close()
        except Exception:
            pass
    return body if isinstance(body, dict) else {}


def _lifetime_seconds(v) -> Optional[int]:
    """A token lifetime in whole seconds when it is a finite positive number of at most ten years, else None (NaN, infinity,
    1e30 and booleans are not lifetimes)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        return int(v) if 0 < v <= 10 * 365 * 86400 else None      # NaN fails both comparisons
    except (OverflowError, ValueError):
        return None


def _ensure_fresh_x(tok: SocialToken, client: SocialTokenClient, http, env: Mapping[str, str], now: datetime) -> SocialToken:
    if tok.access_expires_at is not None and tok.access_expires_at - now > X_REFRESH_WINDOW:
        return tok
    if not tok.refresh_token:
        client.set_status(tok.account_id, "expired")
        raise SocialTokenError(f"x account {tok.account_id}: no refresh token; reconnect it")
    cid = (env.get(X_CLIENT_ID_ENV) or "").strip()
    secret = (env.get(X_CLIENT_SECRET_ENV) or "").strip()
    if not cid:
        raise SocialTokenError(f"set {X_CLIENT_ID_ENV} (and {X_CLIENT_SECRET_ENV} for a confidential app) on the worker to "
                               "refresh X tokens")
    # identity: the answer is read as sent (read1, no decoder), so a compressed one is not what we asked for.
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": "identity"}
    data = {"grant_type": "refresh_token", "refresh_token": tok.refresh_token}
    if secret:
        import base64  # noqa: PLC0415

        headers["Authorization"] = "Basic " + base64.b64encode(f"{cid}:{secret}".encode("utf-8")).decode("ascii")
    else:
        data["client_id"] = cid
    try:
        r = guarded_call(lambda: http.post(X_TOKEN_URL, data=data, headers=headers, timeout=20, allow_redirects=False,
                                           stream=True), TOKEN_HEADER_SECONDS)
    except CallTimedOut:
        raise SocialTokenError(f"x account {tok.account_id}: refresh got no answer within {int(TOKEN_HEADER_SECONDS)}s") from None
    except Exception as e:  # the type only: the message of a request error can carry the URL and the form
        raise SocialTokenError(f"x account {tok.account_id}: refresh failed ({type(e).__name__})") from None
    status = getattr(r, "status_code", 0)
    coding = _content_encoding(r)
    if coding:
        # Fail closed, as the publishers do: not decoded, not read -- and NOT "expired": nothing says the token is bad.
        try:
            r.close()
        except Exception:
            pass
        raise SocialTokenError(f"x account {tok.account_id}: the refresh answer (HTTP {status}) has Content-Encoding {coding} "
                               "and is not decoded; try again")
    body = _bounded_json(r)
    new = str(body.get("access_token") or "").strip()
    if status >= 300 or not new:
        # Only the token endpoint's own refusal of the credentials marks the account expired. An unreadable 2xx, a 5xx and a
        # 429 say nothing about the token: it stays usable and the next attempt tries again.
        if status in (400, 401, 403):
            client.set_status(tok.account_id, "expired")
            raise SocialTokenError(f"x account {tok.account_id}: refresh refused (HTTP {status}); reconnect it")
        raise SocialTokenError(f"x account {tok.account_id}: the refresh did not give a usable answer (HTTP {status}); "
                               "try again")
    seconds = _lifetime_seconds(body.get("expires_in"))
    # Whatever X sent for the lifetime, the rotated pair is stored: a refresh token X has just replaced is lost if this raises.
    fresh = replace(tok, access_token=new,
                    refresh_token=str(body.get("refresh_token") or tok.refresh_token).strip(),
                    access_expires_at=now + timedelta(seconds=seconds) if seconds is not None else None)
    client.rotate(fresh)
    return fresh


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

    if tok.platform == "facebook":
        # A Page access token made from a long-lived user token "does not have an expiration date" (Meta, "Long-lived
        # access tokens"): there is nothing to refresh. It can still be invalidated (password change, role removed),
        # which the publish call reports as error 190. A stored expiry that has passed is believed.
        if tok.access_expires_at is not None and tok.access_expires_at <= now:
            client.set_status(tok.account_id, "expired")
            raise SocialTokenError(f"facebook account {tok.account_id}: token expired; reconnect it")
        return tok
    if tok.platform == "x":
        return _ensure_fresh_x(tok, client, http, env, now)

    raise SocialTokenError(f"account {tok.account_id}: unknown platform")

"""Customer e-mails: "your video is ready" and the weekly summary (migration 0103).

This module is the pure half plus the transports. It never reads the database
(tools/email_worker.py does, through the 0103 functions) and it never decides
WHO gets mail or WHETHER: that is the database's job (preferences, the ledger).
What it does:

* render a mail from one item the database handed over, in the language it is
  GIVEN (an argument, never a global; the words are modules/email_copy.py, keyed
  by language code, English for a code it has no block for);
* build the links: the video or library, "make another", the signed-out
  unsubscribe link and the one-click header, all absolute under the app's own
  origin;
* send through a transport that is OFF unless the owner has configured it.

THE TRANSPORT IS CONFIGURED BY ENVIRONMENT NAMES ONLY, never a value in the
repository, and the feature stays OFF until they are all set:

    NIGHTSHIFT_EMAIL_TRANSPORT   "resend" (the real one) or "fake" (local runs: the
                                 mail is written to a folder and nothing leaves the
                                 machine). Unset or anything else: OFF.
    RESEND_API_KEY               secret, only for "resend" (the operator alert mail
                                 already uses this name).
    NIGHTSHIFT_EMAIL_FROM        the sender, e.g. 'Nightshift <hello@your-domain>'.
    APP_ORIGIN                   https://your-domain, the origin every link is built on
                                 (the web app already uses this name).
    NIGHTSHIFT_EMAIL_FAKE_DIR    optional, where "fake" writes (default output/email-fake).

Nothing here logs an address, a token, a body or a secret: errors are a machine
code and an HTTP status.
"""

from __future__ import annotations

import html
import json
import logging
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import quote, urlencode, urlsplit

from modules.email_copy import COPY, copy_for

logger = logging.getLogger(__name__)

_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_TOKEN = re.compile(r"^[0-9a-f]{64}$")
_CODE = re.compile(r"^[a-z]{2,3}$")


# ── messages ────────────────────────────────────────────────────────────────

@dataclass
class Message:
    to: str
    subject: str
    text: str
    html: str
    headers: Dict[str, str] = field(default_factory=dict)


class TransportError(Exception):
    """A send that did not happen. ``permanent`` means retrying cannot help
    (the provider refused the address or the request); ``code`` is a machine
    word, never provider text."""

    def __init__(self, code: str, permanent: bool = False):
        super().__init__(code)
        self.code = code
        self.permanent = permanent


# ── small helpers ───────────────────────────────────────────────────────────

def clean_line(value: Any, limit: int = 80) -> str:
    """One printable line: control characters (and so header injection) removed."""
    text = re.sub(r"[\x00-\x1f\x7f  ]+", " ", str(value or "")).strip()
    return text[:limit]


def safe_origin(origin: Optional[str]) -> Optional[str]:
    """The app origin, or None when it is not https (or http on localhost)."""
    try:
        parts = urlsplit((origin or "").strip())
    except ValueError:
        return None
    if not parts.netloc:
        return None
    # https everywhere a mail can be read; plain http only for a machine's own address (local runs).
    local = (parts.hostname or "") in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        return None
    return f"{parts.scheme}://{parts.netloc}"


def https_url(value: Any) -> Optional[str]:
    """A public image address, https only (an avatar in an e-mail must not be http)."""
    if not isinstance(value, str) or len(value) > 500 or re.search(r"[\s\"'<>]", value):
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    return value if parts.scheme == "https" and parts.netloc else None


def number_text(value: Any, decimal: str = ".") -> Optional[str]:
    """A measured number for display: up to two decimals, no trailing zeros, in the
    language's decimal separator. None for anything that is not a finite number: an
    unknown is left out, never printed as 0."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        d = Decimal(str(value))
    except InvalidOperation:
        return None
    if not d.is_finite():
        return None
    text = format(d.quantize(Decimal("0.01")), "f").rstrip("0").rstrip(".")
    return text.replace(".", decimal)


def count_text(value: Any) -> Optional[str]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value or value < 0:
        return None
    return str(int(value))


# ── links ───────────────────────────────────────────────────────────────────

def _section_path(item: Mapping[str, Any]) -> str:
    """Where "open" goes. A held video opens on its own page, in its own channel;
    anything else opens the library (a finished export lives there)."""
    data = item.get("data") if isinstance(item.get("data"), dict) else {}
    channel = (item.get("channel") or {}).get("id") if isinstance(item.get("channel"), dict) else None
    video = data.get("video_id")
    if item.get("kind") == "video_ready" and isinstance(channel, str) and isinstance(video, str) \
            and _SAFE_ID.match(channel) and _SAFE_ID.match(video):
        return f"/{quote(channel, safe='')}/videos/{quote(video, safe='')}"
    return "/library"


def _make_another_path(item: Mapping[str, Any]) -> str:
    channel = (item.get("channel") or {}).get("id") if isinstance(item.get("channel"), dict) else None
    if isinstance(channel, str) and _SAFE_ID.match(channel):
        return f"/{quote(channel, safe='')}/create"
    return "/create"


def unsubscribe_links(origin: str, token: str, scope: str, language: str) -> Dict[str, str]:
    """The page a person lands on (confirm button, no login) and the URL a mail
    program POSTs to for one-click unsubscribe (RFC 8058)."""
    if not _TOKEN.match(token or "") or scope not in ("ready", "weekly"):
        raise ValueError("bad unsubscribe link input")
    lang = language if _CODE.match(language or "") else "en"
    page = f"{origin}/unsubscribe?" + urlencode({"t": token, "s": scope, "l": lang})
    post = f"{origin}/api/email/unsubscribe?" + urlencode({"t": token, "s": scope})
    return {"page": page, "post": post}


def _headers(post_url: str) -> Dict[str, str]:
    return {"List-Unsubscribe": f"<{post_url}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}


# ── rendering ───────────────────────────────────────────────────────────────

_STYLE_BODY = "margin:0;padding:24px 12px;background:#f4f4f6;font-family:Arial,Helvetica,sans-serif;color:#17171c;"
_STYLE_CARD = "max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;padding:28px 24px;"
_STYLE_BTN = ("display:inline-block;padding:12px 22px;border-radius:999px;background:#17171c;color:#ffffff;"
              "text-decoration:none;font-weight:700;font-size:15px;margin:0 8px 8px 0;")
_STYLE_BTN2 = ("display:inline-block;padding:11px 21px;border-radius:999px;border:1px solid #17171c;color:#17171c;"
               "text-decoration:none;font-weight:700;font-size:15px;margin:0 8px 8px 0;")


def _channel_block(channel: Optional[Mapping[str, Any]], label: str) -> tuple[str, str]:
    """(html, text) for the channel the mail is about: avatar (or its first
    letter) and its name. Empty when there is no channel to name."""
    if not isinstance(channel, dict):
        return "", ""
    name = clean_line(channel.get("name"), 60)
    if not name:
        return "", ""
    avatar = https_url(channel.get("avatar"))
    letter = html.escape(next(iter(name), "").upper())
    mark = (
        f'<img src="{html.escape(avatar, quote=True)}" width="40" height="40" alt="" '
        'style="width:40px;height:40px;border-radius:8px;object-fit:cover;display:block;">'
        if avatar else
        f'<div style="width:40px;height:40px;border-radius:8px;background:#e7e2d3;color:#6b5a1e;'
        f'font-weight:700;font-size:18px;line-height:40px;text-align:center;">{letter}</div>'
    )
    block = (
        '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;"><tr>'
        f'<td style="padding-right:12px;vertical-align:middle;">{mark}</td>'
        f'<td style="vertical-align:middle;"><div style="font-size:12px;color:#6b6b76;">{html.escape(label)}</div>'
        f'<div style="font-size:16px;font-weight:700;">{html.escape(name)}</div></td></tr></table>'
    )
    return block, f"{label}: {name}"


def _page(lang_code: str, c: Mapping[str, str], title: str, inner_html: str, footer_html: str) -> str:
    direction = c.get("dir", "ltr") if c.get("dir") in ("ltr", "rtl") else "ltr"
    return (
        f'<!doctype html><html lang="{html.escape(lang_code, quote=True)}" dir="{direction}"><head>'
        '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{html.escape(title)}</title></head>"
        f'<body style="{_STYLE_BODY}"><div style="{_STYLE_CARD}">{inner_html}</div>'
        f'<div style="max-width:520px;margin:14px auto 0;font-size:12px;color:#6b6b76;line-height:1.5;">{footer_html}</div>'
        "</body></html>"
    )


def render_ready(item: Mapping[str, Any], *, language: str, origin: str) -> Message:
    """The "your video is ready" mail for one item from email_claim_ready.

    ``language`` is the recipient's language code, passed in by the caller."""
    origin = safe_origin(origin) or ""
    if not origin:
        raise ValueError("an absolute app origin is required to build links")
    c = copy_for(language)
    code = language if language in COPY else "en"
    video = item.get("kind") == "video_ready"
    channel = item.get("channel") if isinstance(item.get("channel"), dict) else None
    channel_name = clean_line(channel.get("name"), 60) if channel else ""
    if video:
        subject = c["subject_video"].format(channel=channel_name) if channel_name else c["subject_video_plain"]
        title, body = c["title_video"], c["body_video"]
    else:
        subject, title, body = c["subject_export"], c["title_export"], c["body_export"]
    open_url = origin + _section_path(item)
    another_url = origin + _make_another_path(item)
    links = unsubscribe_links(origin, str(item.get("token") or ""), "ready", code)
    manage_url = origin + "/organization"
    block_html, block_text = _channel_block(channel, c["channel_label"])

    inner = (
        f"{block_html}"
        f'<h1 style="font-size:22px;line-height:1.25;margin:0 0 10px 0;">{html.escape(title)}</h1>'
        f'<p style="font-size:15px;line-height:1.5;margin:0 0 22px 0;">{html.escape(body)}</p>'
        f'<a href="{html.escape(open_url, quote=True)}" style="{_STYLE_BTN}">{html.escape(c["cta_open"])}</a>'
        f'<a href="{html.escape(another_url, quote=True)}" style="{_STYLE_BTN2}">{html.escape(c["cta_another"])}</a>'
    )
    footer = (
        f'{html.escape(c["reason_ready"])}<br>'
        f'<a href="{html.escape(links["page"], quote=True)}" style="color:#6b6b76;">{html.escape(c["unsub_ready"])}</a> · '
        f'<a href="{html.escape(manage_url, quote=True)}" style="color:#6b6b76;">{html.escape(c["manage"])}</a>'
    )
    text_parts = [title, ""]
    if block_text:
        text_parts += [block_text, ""]
    text_parts += [body, "", f"{c['cta_open']}: {open_url}", f"{c['cta_another']}: {another_url}", "",
                   "--", c["reason_ready"], f"{c['unsub_ready']}: {links['page']}", f"{c['manage']}: {manage_url}"]
    return Message(
        to=str(item["email"]), subject=clean_line(subject, 120), text="\n".join(text_parts),
        html=_page(code, c, title, inner, footer), headers=_headers(links["post"]),
    )


def render_weekly(item: Mapping[str, Any], *, language: str, origin: str) -> Message:
    """The weekly summary for one item from email_claim_weekly. Only numbers the
    database measured are shown; a zero or an unknown is left out, and credits
    appear only when the account's balance was known."""
    origin = safe_origin(origin) or ""
    if not origin:
        raise ValueError("an absolute app origin is required to build links")
    c = copy_for(language)
    code = language if language in COPY else "en"
    d = item.get("digest") if isinstance(item.get("digest"), dict) else {}
    decimal = c.get("decimal", ".")
    days = count_text(d.get("days")) or "7"

    lines: List[str] = []
    for key, copy_key in (("videos_made", "made_videos"), ("exports_made", "made_exports"),
                          ("generations_made", "made_generations"), ("waiting_videos", "waiting_videos"),
                          ("waiting_storyboards", "waiting_storyboards")):
        n = count_text(d.get(key))
        if n is not None and int(n) > 0:
            lines.append(c[copy_key].format(n=n))
    credits = number_text(d.get("credits_available"), decimal)
    if credits is not None:
        lines.append(c["credits_left"].format(n=credits))

    channels_html: List[str] = []
    channels_text: List[str] = []
    for ch in (d.get("channels") if isinstance(d.get("channels"), list) else [])[:8]:
        if not isinstance(ch, dict):
            continue
        made = count_text(ch.get("made")) or "0"
        waiting = str(int(count_text(ch.get("waiting_videos")) or 0) + int(count_text(ch.get("waiting_storyboards")) or 0))
        block, _ = _channel_block(ch, c["channel_label"])
        name = clean_line(ch.get("name"), 60)
        if not name:
            continue
        line = c["channel_line"].format(channel=name, made=made, waiting=waiting)
        channels_html.append(f'{block.replace("margin:0 0 18px 0;", "margin:0 0 6px 0;")}'
                             f'<p style="font-size:14px;margin:0 0 14px 0;">{html.escape(line)}</p>')
        channels_text.append(line)

    open_url = origin + "/home"
    new_url = origin + "/create"
    links = unsubscribe_links(origin, str(item.get("token") or ""), "weekly", code)
    manage_url = origin + "/organization"
    title = c["title_weekly"].format(days=days)
    list_html = "".join(f'<li style="margin:0 0 6px 0;">{html.escape(x)}</li>' for x in lines)
    inner = (
        f'<h1 style="font-size:22px;line-height:1.25;margin:0 0 10px 0;">{html.escape(title)}</h1>'
        f'<p style="font-size:15px;line-height:1.5;margin:0 0 14px 0;">{html.escape(c["intro_weekly"])}</p>'
        f'<ul style="font-size:15px;line-height:1.5;margin:0 0 18px 0;padding-left:20px;">{list_html}</ul>'
        f'{"".join(channels_html)}'
        f'<div style="margin-top:8px;"><a href="{html.escape(open_url, quote=True)}" style="{_STYLE_BTN}">{html.escape(c["cta_weekly_open"])}</a>'
        f'<a href="{html.escape(new_url, quote=True)}" style="{_STYLE_BTN2}">{html.escape(c["cta_weekly_new"])}</a></div>'
    )
    footer = (
        f'{html.escape(c["reason_weekly"])}<br>'
        f'<a href="{html.escape(links["page"], quote=True)}" style="color:#6b6b76;">{html.escape(c["unsub_weekly"])}</a> · '
        f'<a href="{html.escape(manage_url, quote=True)}" style="color:#6b6b76;">{html.escape(c["manage"])}</a>'
    )
    text = "\n".join([title, "", c["intro_weekly"], "", *[f"- {x}" for x in lines], "", *channels_text, "",
                      f"{c['cta_weekly_open']}: {open_url}", f"{c['cta_weekly_new']}: {new_url}", "",
                      "--", c["reason_weekly"], f"{c['unsub_weekly']}: {links['page']}", f"{c['manage']}: {manage_url}"])
    return Message(to=str(item["email"]), subject=clean_line(c["subject_weekly"], 120), text=text,
                   html=_page(code, c, title, inner, footer), headers=_headers(links["post"]))


# ── transports ──────────────────────────────────────────────────────────────

class FakeTransport:
    """Sends nothing. Keeps every message in ``sent`` and, when given a folder,
    writes each as a .json file there (for looking at a render by eye)."""

    name = "fake"

    def __init__(self, directory: Optional[Path] = None):
        self.sent: List[Message] = []
        self.directory = directory

    def send(self, message: Message) -> None:
        self.sent.append(message)
        if self.directory is not None:
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / f"{len(self.sent):04d}.json"
            path.write_text(json.dumps({"subject": message.subject, "text": message.text, "html": message.html,
                                        "headers": message.headers}, ensure_ascii=False, indent=2), encoding="utf-8")


class ResendTransport:
    """The real transport: the same HTTP API the operator alert mail already uses.
    Constructed only when the owner has set the environment names; tests inject a
    session and never reach the network."""

    name = "resend"
    URL = "https://api.resend.com/emails"

    def __init__(self, api_key: str, sender: str, session: Any = None, timeout: float = 15.0):
        self._key = api_key
        self._from = sender
        self._session = session
        self._timeout = timeout

    def _http(self):
        if self._session is None:
            import requests  # noqa: PLC0415

            self._session = requests.Session()
        return self._session

    def send(self, message: Message) -> None:
        payload = {"from": self._from, "to": [message.to], "subject": message.subject,
                   "html": message.html, "text": message.text, "headers": message.headers}
        try:
            r = self._http().post(self.URL, json=payload, timeout=self._timeout,
                                  headers={"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        except Exception as e:  # noqa: BLE001 — only the type is kept: the text can quote the request
            raise TransportError("network_" + type(e).__name__.lower()[:20]) from None
        status = int(getattr(r, "status_code", 0) or 0)
        if 200 <= status < 300:
            return
        # 429 and 5xx are the provider's trouble and pass; any other refusal (a bad
        # address, a rejected sender) will not change on retry.
        raise TransportError(f"http_{status}", permanent=not (status == 429 or status >= 500))


def transport_from_env(env: Mapping[str, str]) -> Optional[Any]:
    """The transport the owner configured, or None: the feature is OFF."""
    kind = (env.get("NIGHTSHIFT_EMAIL_TRANSPORT") or "").strip().lower()
    if not safe_origin(env.get("APP_ORIGIN")):
        return None
    if kind == "fake":
        folder = (env.get("NIGHTSHIFT_EMAIL_FAKE_DIR") or "output/email-fake").strip()
        return FakeTransport(Path(folder))
    if kind == "resend":
        key = (env.get("RESEND_API_KEY") or "").strip()
        sender = clean_line(env.get("NIGHTSHIFT_EMAIL_FROM"), 200)
        if key and sender:
            return ResendTransport(key, sender)
    return None


def describe_off(env: Mapping[str, str]) -> str:
    """Which names are missing, for the log: names only, never a value."""
    missing = []
    kind = (env.get("NIGHTSHIFT_EMAIL_TRANSPORT") or "").strip().lower()
    if kind not in ("fake", "resend"):
        missing.append("NIGHTSHIFT_EMAIL_TRANSPORT")
    if not safe_origin(env.get("APP_ORIGIN")):
        missing.append("APP_ORIGIN")
    if kind == "resend":
        if not (env.get("RESEND_API_KEY") or "").strip():
            missing.append("RESEND_API_KEY")
        if not (env.get("NIGHTSHIFT_EMAIL_FROM") or "").strip():
            missing.append("NIGHTSHIFT_EMAIL_FROM")
    return ", ".join(missing)


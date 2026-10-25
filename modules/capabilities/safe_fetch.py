"""Hardened result handling for first-party adapters (the maker's own API).

``HttpAdapter.fetch`` was written for vendors whose result link is trusted
once the vendor said so. The first-party adapters added after it cannot take
that on faith: the link comes out of a JSON body we do not control, the file
is large, and a half-written file must never look like a finished one. This
mixin is the stricter path, with the same shape as the one the presenter
(modules/avatar_fal.py) already uses for fal.ai; that module is tied to its
own error type and vendor, so the minimal pattern is copied here rather than
imported:

* **https only, on the maker's own hosts.** ``result_hosts`` is an allow-list
  of domains (a host matches itself or a subdomain, never a look-alike); the
  port must be one of ``result_ports``; no credentials in the URL; printable
  ASCII only, and the host urllib3 will connect to must be the host that was
  checked (a backslash is what makes two URL parsers disagree about it).
* **No key, no redirect.** The download carries no header of ours, and a 3xx
  is refused, not followed: a redirect would take the request anywhere. The one
  exception is opt-in per adapter (``download_headers``): Google's file URI cannot
  be fetched without its key, so that adapter returns the key header for the exact
  host its API is on and nothing for any other; the refused redirect is what keeps
  the key from travelling further.
* **A byte cap** checked against ``Content-Length`` first and then while
  streaming, so a hostile or broken server cannot fill the disk.
* **Atomic write.** Bytes go to ``<name>.part`` and ``os.replace`` publishes
  them only when the stream ended and the file looks like what the vendor
  promised (its first bytes), so a crash or a truncated stream leaves no
  file a later step could mistake for a result.

The lost-answer rule lives here too (``submit_json``): a submit whose answer
never arrived, or arrived unreadable, may still have started a billable task,
so it is reported as such and never as a refusal.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import List, Optional, Sequence
from urllib.parse import urlsplit

import requests

from modules.capabilities.base import (
    E_BAD_RESPONSE,
    E_NOT_FOUND,
    E_UNAVAILABLE,
    AdapterError,
    PollResult,
)

#: Printable ASCII, no space, no backslash: the characters on which two URL
#: parsers disagree about the host.
_SAFE_URL = re.compile(r"[\x21-\x5b\x5d-\x7e]+")
_HOSTNAME = re.compile(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*")

_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4"}

#: Starts the message of a submit failure that does not prove the vendor took
#: nothing (it comes FIRST: AdapterError keeps only the first 500 characters).
UNCONFIRMED = "UNCONFIRMED SPEND: the vendor may have accepted this and be billing it; check its usage page before rerunning"


#: Starts the message of any failure AFTER the vendor finished the work: the clip or image
#: may exist and be billed even though we could not store it.
AFTER_COMPLETION = "SPEND MAY HAVE OCCURRED: the generation may have completed and been billed; the result was not downloaded"


def after_completion(e: AdapterError) -> AdapterError:
    """``e`` with the post-completion spend note in front (code, status and retryability kept)."""
    if e.message.startswith(AFTER_COMPLETION):
        return e
    return AdapterError(e.code, f"{AFTER_COMPLETION}. {e.message}", http_status=e.http_status,
                        not_accepted=False)


def _urllib3_host(url: str) -> Optional[str]:
    """The host urllib3 (what ``requests`` connects with) reads from ``url``."""
    from urllib3.util import parse_url

    try:
        host = parse_url(url).host
    except Exception:  # LocationParseError and friends: not a URL we can vouch for
        return None
    return host.lower() if host else None


def checked_result_url(url, hosts: Sequence[str], ports: Sequence[Optional[int]] = (None, 443)) -> str:
    """``url`` when it is an https address on one of ``hosts`` (or a subdomain),
    else an ``AdapterError`` (bad_response). Nothing is requested before this."""
    host, port, userinfo, scheme = "", None, True, ""
    if isinstance(url, str) and _SAFE_URL.fullmatch(url):
        try:
            parts = urlsplit(url)
            host = (parts.hostname or "").lower()
            port = parts.port
            userinfo = bool(parts.username or parts.password)
            scheme = parts.scheme
            # The host the HTTP library will really connect to must be the one just read.
            if not _HOSTNAME.fullmatch(host) or _urllib3_host(url) != host:
                host = ""
        except ValueError:
            host, userinfo = "", True
    ok = bool(host) and any(host == h or host.endswith("." + h) for h in hosts)
    if not (ok and scheme == "https" and port in ports and not userinfo):
        raise AdapterError(E_BAD_RESPONSE,
                           f"the result link is not an https address on the vendor's own hosts "
                           f"({(host or 'unparsable')!r}); it was not downloaded")
    return url


def _download_code(status: int) -> str:
    """The code for a refused DOWNLOAD. A result link is a signed URL: its 401/403/404/410 means the
    link expired or is gone, never that our API key is wrong (the key is not sent to it), so it must
    not read as ``auth``. Overload and server errors are worth another try with the same task."""
    if status in (408, 425, 429) or status >= 500:
        return E_UNAVAILABLE
    return E_NOT_FOUND


def _looks_like(mime: str, head: bytes) -> bool:
    """The first bytes of a file agree with the type the vendor promised."""
    if mime == "video/mp4":
        return b"ftyp" in head[:12]
    if mime == "image/png":
        return head.startswith(b"\x89PNG")
    if mime == "image/jpeg":
        return head.startswith(b"\xff\xd8")
    if mime == "image/webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return True


def sniff_image_mime(data: bytes) -> Optional[str]:
    """The image type the bytes themselves say they are, or None. Used for an
    inline (base64) image: the file is stored under the type it IS, not the type
    the vendor's JSON claimed."""
    head = data[:16]
    for mime in ("image/png", "image/jpeg", "image/webp"):
        if _looks_like(mime, head):
            return mime
    return None


class SafeResultMixin:
    """Put FIRST in an adapter's bases so it replaces ``fetch`` / ``_download``."""

    #: Domains the result may live on. Empty = nothing is downloaded.
    result_hosts: Sequence[str] = ()
    result_ports: Sequence[Optional[int]] = (None, 443)
    #: A video clip / a decoded inline image may not be larger than this.
    max_result_bytes = 512 * 1024 * 1024
    max_inline_bytes = 64 * 1024 * 1024

    def download_headers(self, url: str) -> Optional[dict]:
        """The headers a result download carries. ``None`` (this default, and every adapter that does not
        override it) = none at all: a first-party result link is a signed URL and the key is not its
        credential. An adapter whose link needs the key returns it here only for the one host that is its
        own API; ``url`` has already passed the allow-list, and no redirect is ever followed."""
        return None

    # -- results -----------------------------------------------------------------
    def checked_outputs(self, result: PollResult) -> PollResult:
        """``result`` if every URL output passes the allow-list, else raises."""
        try:
            for item in result.outputs:
                if item.url:
                    checked_result_url(item.url, self.result_hosts, self.result_ports)
        except AdapterError as e:
            raise after_completion(e) from None
        return result

    def fetch(self, result: PollResult, out_dir, stem: str = "output") -> List[Path]:
        """Store every output. Any failure here comes AFTER the vendor finished (and may have billed),
        so it carries the ``AFTER_COMPLETION`` note; the task is still the vendor's, so the caller
        may fetch again while the link lives."""
        try:
            return self._fetch(result, out_dir, stem)
        except AdapterError as e:
            raise after_completion(e) from None

    def _fetch(self, result: PollResult, out_dir, stem: str) -> List[Path]:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        paths: List[Path] = []
        for i, item in enumerate(result.outputs):
            dest = out_dir / f"{stem}_{i}{_EXT.get(item.mime, '.bin')}"
            if item.data is not None:
                if not item.data:
                    raise AdapterError(E_BAD_RESPONSE, "output is empty")
                if len(item.data) > self.max_inline_bytes:
                    raise AdapterError(E_BAD_RESPONSE,
                                       f"output is over the {self.max_inline_bytes} byte limit; not stored")
                if not _looks_like(item.mime, item.data[:16]):
                    raise AdapterError(E_BAD_RESPONSE, f"output is not a {item.mime} file")
                self._publish(dest, item.data)
            elif item.url:
                self._download(checked_result_url(item.url, self.result_hosts, self.result_ports), dest,
                               mime=item.mime)
            else:
                raise AdapterError(E_BAD_RESPONSE, "output has neither data nor url")
            paths.append(dest)
        return paths

    @staticmethod
    def _publish(dest: Path, data: bytes) -> None:
        part = dest.with_name(dest.name + ".part")
        try:
            part.write_bytes(data)
            os.replace(part, dest)
        finally:
            part.unlink(missing_ok=True)

    def _download(self, url: str, dest: Path, headers=None, _hops: int = 0, *, mime: str = "") -> None:
        """Stream ``url`` to ``dest`` (no redirect followed, capped, written atomically; no key
        sent unless the adapter's ``download_headers`` returns one for this very host). ``headers``
        is accepted for the base signature and never sent: a first-party result link is a signed
        URL, the key is not its credential."""
        part = dest.with_name(dest.name + ".part")
        try:
            extra = self.download_headers(url)
            with self.session.get(url, stream=True, timeout=max(self.timeout, 120), allow_redirects=False,
                                  **({"headers": extra} if extra else {})) as resp:
                status = getattr(resp, "status_code", 200)
                if status in (301, 302, 303, 307, 308):
                    raise AdapterError(E_BAD_RESPONSE, "download: the host redirected; redirects are never followed")
                if status >= 300:
                    raise AdapterError(_download_code(status), f"download: HTTP {status}", http_status=status)
                try:
                    declared = int((getattr(resp, "headers", None) or {}).get("Content-Length") or 0)
                except (TypeError, ValueError):
                    declared = 0
                if declared > self.max_result_bytes:
                    raise AdapterError(E_BAD_RESPONSE, f"download: the file is {declared} bytes, over the "
                                                       f"{self.max_result_bytes} byte limit; not downloaded")
                size, head = 0, b""
                with open(part, "wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 16):
                        if not chunk:
                            continue
                        size += len(chunk)
                        if size > self.max_result_bytes:
                            raise AdapterError(E_BAD_RESPONSE, f"download: the file is over the "
                                                               f"{self.max_result_bytes} byte limit; stopped")
                        if len(head) < 16:
                            head = (head + chunk)[:16]
                        fh.write(chunk)
            if size <= 0:
                raise AdapterError(E_BAD_RESPONSE, "download: the file is empty")
            if mime and not _looks_like(mime, head):
                raise AdapterError(E_BAD_RESPONSE, f"download: the file is not a {mime} file")
            os.replace(part, dest)
        except requests.RequestException as e:
            raise AdapterError(E_UNAVAILABLE, f"download: {type(e).__name__}") from None
        finally:
            part.unlink(missing_ok=True)

    # -- submit --------------------------------------------------------------------
    def submit_json(self, url: str, body: dict, *, what: str = "submit") -> dict:
        """POST ``body``. A failure that does not PROVE the vendor refused it
        (a read timeout, a dropped connection, any 5xx, an unreadable 2xx) is
        re-raised with ``UNCONFIRMED`` in front and ``not_accepted`` False: the
        task may exist and bill, and the worker must neither retry it nor move
        it. A proven refusal (no key, no connection, 401/402/403/404/429) and
        the vendor's own 4xx about the request pass through unchanged."""
        try:
            return self.post(url, body, what=what)
        except AdapterError as e:
            if e.not_accepted or e.code not in (E_UNAVAILABLE, E_BAD_RESPONSE):
                raise
            raise AdapterError(e.code, f"{UNCONFIRMED}. {e.message}", http_status=e.http_status) from None


def unconfirmed(message: str) -> AdapterError:
    """A 2xx the adapter could not use: the vendor may have started the task."""
    return AdapterError(E_BAD_RESPONSE, f"{UNCONFIRMED}. {message}")

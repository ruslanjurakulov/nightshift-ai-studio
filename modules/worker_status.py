"""A worker's own status, reported to Supabase — migration 0045.

A container that exits with a remedy message leaves it in logs only the
server can read (they stay there on purpose: the Actions output is public).
:class:`WorkerStatusReporter` sends the state ('starting', 'running' as a
heartbeat, 'failed' with the remedy, 'stopped') to ``report_worker_status``
(service role), so Command Center can show it to the operator and the media
library can tell a customer that checking is paused.

Rules this module keeps:

* Reporting never raises and never stalls the worker: every call is wrapped,
  the HTTP timeout is short, and the heartbeat runs on its own daemon thread
  (a ticket's transcode may take hours; the heartbeat must not wait for it).
* ``detail`` goes through the caller's scrubber (the pipeline worker's secret
  scrubber) BEFORE it is cut to 300 characters, so a cut can never leave half
  a secret behind. Callers pass messages that name variables, never values.
* A failed report is logged as an exception type and an HTTP status — never
  the exception text, which for ``requests`` quotes the Supabase URL.
* 404 means migration 0045 is not applied: said once, not every 30 s.
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Callable, Optional

from modules.log_redaction import describe_http_error

logger = logging.getLogger(__name__)

DETAIL_MAX = 300
VERSION_MAX = 100
HEARTBEAT_SECONDS = 30.0
REPORT_TIMEOUT_SECONDS = 5.0

_WHITESPACE = re.compile(r"\s+")


def clean_detail(detail: Optional[str], scrub: Optional[Callable[[str], str]] = None) -> Optional[str]:
    """Scrubbed, single-line, at most 300 characters; None when there is nothing to say."""
    if not detail:
        return None
    text = str(detail)
    if scrub is not None:
        try:
            text = scrub(text)
        except Exception:
            return "detail withheld: the scrubber failed"
    text = _WHITESPACE.sub(" ", text).strip()
    return text[:DETAIL_MAX] or None


class WorkerStatusReporter:
    def __init__(self, url: str, service_key: str, *, worker_id: str, kind: str,
                 version: Optional[str] = None, scrub: Optional[Callable[[str], str]] = None,
                 session=None, timeout: float = REPORT_TIMEOUT_SECONDS,
                 interval: float = HEARTBEAT_SECONDS):
        self.url = (url or "").rstrip("/")
        self._key = service_key or ""
        self.worker_id = worker_id
        self.kind = kind
        self.version = (version or "").strip()[:VERSION_MAX] or None
        self._scrub = scrub
        self._http = session
        self._timeout = timeout
        self._interval = interval
        self._closed = False
        self._warned: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def _session(self):
        if self._http is None:
            import requests  # noqa: PLC0415

            self._http = requests.Session()
        return self._http

    def _warn_once(self, what: str) -> None:
        if self._warned != what:
            self._warned = what
            logger.warning("worker status not reported (%s)", what)

    def report(self, state: str, detail: Optional[str] = None) -> bool:
        """Send one status. True when the database took it. Never raises."""
        try:
            payload = {"p_worker_id": self.worker_id, "p_kind": self.kind, "p_state": state,
                       "p_detail": clean_detail(detail, self._scrub), "p_version": self.version}
            with self._lock:
                r = self._session().post(
                    f"{self.url}/rest/v1/rpc/report_worker_status", json=payload,
                    headers={"apikey": self._key, "Authorization": f"Bearer {self._key}",
                             "Content-Type": "application/json"},
                    timeout=self._timeout)
            if r.status_code == 404:
                self._warn_once("HTTP 404: apply migration 0045_worker_status.sql")
                return False
            if r.status_code >= 300:
                self._warn_once(f"HTTP {r.status_code}")
                return False
            self._warned = None
            return True
        except Exception as e:
            self._warn_once(describe_http_error(e))
            return False

    # ── heartbeat ────────────────────────────────────────────────────────────

    def start_heartbeat(self) -> None:
        """'running' now, then every ``interval`` seconds, on a daemon thread
        (also while the worker is idle or busy with one long ticket)."""
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._beat, name="worker-status-heartbeat", daemon=True)
        self._thread.start()

    def _beat(self) -> None:
        while not self._stop.is_set():
            if not self._closed:
                self.report("running")
            self._stop.wait(self._interval)

    def close(self, state: str = "stopped", detail: Optional[str] = None) -> bool:
        """Stop the heartbeat, then send the final status. Idempotent."""
        if self._closed:
            return False
        self._closed = True
        self._stop.set()
        t = self._thread
        if t is not None and t is not threading.current_thread():
            t.join(timeout=self._timeout + 1)
        return self.report(state, detail)


__all__ = ["DETAIL_MAX", "HEARTBEAT_SECONDS", "WorkerStatusReporter", "clean_detail"]

#!/usr/bin/env python3
"""Pipeline worker: claim ``render_jobs`` rows and run them, one at a time.

    python tools/queue_worker.py            # loop forever (the Docker CMD)
    python tools/queue_worker.py --once     # claim at most one job, then exit

The alternative execution backend to ``.github/workflows/daily_video.yml``
(roadmap phase B, ``docs/WORKER_VPS.md``). GitHub Actions stays the default; a
job reaches this worker only when the Command Center's server runs with
``NIGHTSHIFT_RUN_BACKEND=queue`` or an operator inserts a row by hand.

What it runs is the workflow's run step, not a variant of it:

* the channel is resolved by ``tools/list_channels.resolve_only`` — the
  workflow's ``--only`` — so an unknown or never-verified channel is refused
  here exactly as there, before anything is spent;
* argv and the derived env come from ``modules/run_request`` (privacy defaults
  to private; the publish gate, auto-publish and approvals are main.py's own
  and are not touched, skipped or overridden by anything in this file);
* credentials are handed over the way the workflow hands them: the default
  channel's token as ``youtube_token.json``, any other channel's as ONLY its
  own ``CHRONOS_YT_TOKEN_<REF>`` env var — every other channel's token is
  removed from the child's environment, so a run cannot upload to an account
  it was not started for — and ``client_secret.json`` only when set. The files
  are deleted after every job, as on a self-hosted runner.

Secrets are never printed. The worker's own log lines name facts ("token set"),
never values or lengths; the pipeline's output is streamed through the same
scrubber that cleans the stored error, standing in for Actions' secret masking.

Durability:

* a heartbeat thread refreshes ``heartbeat_at``; a worker that dies (OOM, VPS
  reboot) leaves a stale heartbeat, and ``claim_render_job`` re-queues the job
  (bounded by ``max_attempts``);
* when such a re-queued job comes back and ``output/`` still holds that run's
  checkpoint, it is run with ``--resume --topic <that run>`` so the stages it
  already paid for are reused, not bought again (:func:`resume_target`);
* SIGTERM (``docker stop``) stops claiming and lets the running job finish for
  up to ``WORKER_STOP_GRACE_SECONDS``; after that, or on a second signal, the
  run is terminated and the job released back to the queue.

Credits (migration 0020, ``modules/credits.py``): a job whose channel belongs
to an organization other than the operator's own is paid for by the hold its
``credit_ref`` names. The worker claims that hold before the run spends
anything and settles it when the run ends — the metered cost from this
machine's cost ledger on success (never above the hold, and the whole hold when
anything was unpriced), a full release on failure. With
``NIGHTSHIFT_CREDITS_ENFORCE`` on, such a job without an open hold is failed
without running: rows can be inserted from a browser, so the button is not the
only way in.
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Tuple

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import credits as credit_rules  # noqa: E402
from modules import run_request  # noqa: E402

logger = logging.getLogger("queue_worker")

#: Stored error text ceiling (the 0017 CHECK allows 2000).
MAX_ERROR_CHARS = 2000
#: Lines of run output kept for the error tail.
TAIL_LINES = 60
DEFAULT_HEARTBEAT_SECONDS = 30
DEFAULT_POLL_SECONDS = 15
DEFAULT_STALE_MINUTES = 10
# A video job takes minutes to tens of minutes; the workflow's own timeout is
# 60. Pair this with `docker run --stop-timeout 3600` (docs/WORKER_VPS.md).
DEFAULT_GRACE_SECONDS = 3300
#: After SIGTERM to the run's process group, how long before SIGKILL.
KILL_AFTER_SECONDS = 30

# ── secret scrubbing ────────────────────────────────────────────────────────

_SECRET_NAME = re.compile(
    r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIAL|AUTH|WEBHOOK|PRIVATE|_JSON$|^SUPABASE_URL$|DSN)",
    re.IGNORECASE,
)
_PATTERNS = (
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),  # JWT
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\b1//[A-Za-z0-9_-]{20,}"),  # Google refresh token
    re.compile(r"\bya29\.[A-Za-z0-9._-]{20,}"),  # Google access token
)
REDACTED = "[redacted]"
_MIN_SECRET_LEN = 8


def _json_leaves(value) -> Iterable[str]:
    if isinstance(value, dict):
        for v in value.values():
            yield from _json_leaves(v)
    elif isinstance(value, list):
        for v in value:
            yield from _json_leaves(v)
    elif isinstance(value, str):
        yield value


def secret_values(env: Mapping[str, str]) -> List[str]:
    """Every value in ``env`` that must never appear in a log or an error:
    values of secret-named vars and, for JSON-valued ones (a token document),
    each string inside them too — a traceback can echo one field of a token
    without the rest. Longest first, so a value containing another is replaced
    whole."""
    found = set()
    for name, value in env.items():
        if not value or not _SECRET_NAME.search(name):
            continue
        value = str(value)
        if len(value.strip()) >= _MIN_SECRET_LEN:
            found.add(value.strip())
        try:
            parsed = json.loads(value)
        except (ValueError, TypeError):
            continue
        for leaf in _json_leaves(parsed):
            if len(leaf) >= _MIN_SECRET_LEN:
                found.add(leaf)
    return sorted(found, key=len, reverse=True)


def scrub(text: str, secrets: Iterable[str]) -> str:
    """``text`` with every secret value and every token-shaped string replaced."""
    if not text:
        return ""
    for s in secrets:
        if s and s in text:
            text = text.replace(s, REDACTED)
    for pat in _PATTERNS:
        text = pat.sub(REDACTED, text)
    return text


def format_error(header: str, tail: Iterable[str], secrets: Iterable[str],
                 limit: int = MAX_ERROR_CHARS) -> str:
    """``header`` plus as much of the END of the run output as fits in
    ``limit`` — the end is where the reason is. Scrubbed before truncation, so
    a cut can never leave half a secret behind."""
    secrets = list(secrets)
    header = scrub(header, secrets)
    body = scrub("\n".join(tail), secrets)
    if not body:
        return header[:limit]
    room = limit - len(header) - 1
    if room <= 0:
        return header[:limit]
    if len(body) > room:
        body = "…" + body[-(room - 1):]
    return f"{header}\n{body}"


# ── the queue (PostgREST, service key) ──────────────────────────────────────

class QueueClient:
    """``render_jobs`` over Supabase's REST API with the service key.

    Every write is filtered on ``worker_id = me AND status = running``, so a
    worker can only ever change a job it currently holds: once a job has been
    re-queued (stale heartbeat) or cancelled by an operator, this worker's late
    writes match nothing. Failures are logged with the HTTP status only."""

    def __init__(self, url: str, service_key: str, *, timeout: float = 15.0, session=None):
        import requests  # noqa: PLC0415 — keep --help and the tests import-light

        self.url = url.rstrip("/")
        self._key = service_key
        self._timeout = timeout
        self._http = session or requests.Session()

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"apikey": self._key, "Authorization": f"Bearer {self._key}",
             "Content-Type": "application/json"}
        if extra:
            h.update(extra)
        return h

    def claim(self, worker_id: str, stale_minutes: int) -> Optional[dict]:
        try:
            r = self._http.post(
                f"{self.url}/rest/v1/rpc/claim_render_job",
                json={"p_worker": worker_id, "p_stale_after": f"{int(stale_minutes)} minutes"},
                headers=self._headers(), timeout=self._timeout,
            )
        except Exception as e:
            logger.warning("claim failed (%s)", type(e).__name__)
            return None
        if r.status_code >= 300:
            logger.warning("claim failed: HTTP %s — is migration 0017 applied?", r.status_code)
            return None
        rows = r.json() or []
        if isinstance(rows, dict):
            rows = [rows]
        return rows[0] if rows else None

    def _patch_mine(self, job_id: int, worker_id: str, values: dict) -> Optional[bool]:
        """True = updated, False = the job is no longer ours, None = unknown."""
        try:
            r = self._http.patch(
                f"{self.url}/rest/v1/render_jobs",
                params={"id": f"eq.{int(job_id)}", "worker_id": f"eq.{worker_id}",
                        "status": "eq.running", "select": "id"},
                json=values,
                headers=self._headers({"Prefer": "return=representation"}),
                timeout=self._timeout,
            )
        except Exception as e:
            logger.warning("job %s: update failed (%s)", job_id, type(e).__name__)
            return None
        if r.status_code >= 300:
            logger.warning("job %s: update failed: HTTP %s", job_id, r.status_code)
            return None
        return bool(r.json())

    def heartbeat(self, job_id: int, worker_id: str) -> Optional[bool]:
        return self._patch_mine(job_id, worker_id, {"heartbeat_at": _now()})

    def finish(self, job_id: int, worker_id: str, status: str, error: Optional[str]) -> Optional[bool]:
        return self._patch_mine(job_id, worker_id, {
            "status": status, "finished_at": _now(), "heartbeat_at": _now(), "error": error,
        })

    def release(self, job_id: int, worker_id: str, *, status: str, attempts: int,
                error: Optional[str]) -> Optional[bool]:
        values = {"status": status, "attempts": attempts, "error": error, "worker_id": None}
        if status == "failed":
            values["finished_at"] = _now()
        return self._patch_mine(job_id, worker_id, values)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── resume a re-queued run ─────────────────────────────────────────────────

def _slugify(text: str) -> str:
    # main.slugify, repeated so the worker never imports main (and its models).
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:50]


def _parse_ts(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def resume_target(job: Mapping, params: Mapping, output_dir: Path) -> Optional[str]:
    """The topic of THIS job's unfinished run, when the job is a re-queue and
    that run's checkpoint is still on the worker's disk; else None.

    Why: a job re-queued after a crash or a shutdown would otherwise start a
    brand-new video and pay for the topic, research and script (and whatever
    else it had reached) a second time. The workflow's own answer to that is
    ``--resume``; the worker's output/ persists, so it can use it without an
    operator.

    Only when it is safe to say the checkpoint is this job's:

    * the job ran before (``attempts > 1`` on this claim — a job released before
      its run started gets its attempt back, so it does not count);
    * a 'daily' job that did not already choose ``resume`` itself;
    * the checkpoint is unfinished, recorded for this channel, created after the
      job was queued (one running job per channel makes that unambiguous), has
      a topic, and — when the job named a topic — is that topic's run;
    * its saved script is still on disk (otherwise main.py would run fresh
      anyway).

    The topic is passed along with ``--resume`` on purpose: output/ is shared by
    every channel, and a bare ``--resume`` picks the newest unfinished run of
    ANY channel. Never raises; any doubt means a fresh run, as before.
    """
    try:
        if int(job.get("attempts") or 0) <= 1:
            return None
        if job.get("kind") != "daily" or params.get("resume") or params.get("repair_scenes"):
            return None
        queued_at = _parse_ts(job.get("created_at"))
        if queued_at is None or not Path(output_dir).is_dir():
            return None
        from modules import run_checkpoint  # noqa: PLC0415 — imports config

        wanted_slug = _slugify(params["topic"]) if params.get("topic") else None
        best = None
        for child in Path(output_dir).iterdir():
            if not child.is_dir() or (wanted_slug and child.name != wanted_slug):
                continue
            cp = run_checkpoint.load(child.name, root=Path(output_dir))
            if cp is None or cp.completed or str(cp.channel_id) != str(job.get("channel_id")):
                continue
            created = _parse_ts(cp.created_at)
            if created is None or created < queued_at:
                continue
            if not cp.topic or _slugify(cp.topic) != cp.slug:
                continue
            if not cp.can_resume_stage(run_checkpoint.STAGE_SCRIPT):
                continue
            if best is None or (cp.updated_at or "") > (best.updated_at or ""):
                best = cp
        return best.topic if best is not None else None
    except Exception as e:  # pragma: no cover - defensive
        logger.warning("resume check failed (%s) — running fresh", type(e).__name__)
        return None


# ── credentials ─────────────────────────────────────────────────────────────

TOKEN_PREFIX = "CHRONOS_YT_TOKEN_"
#: Consumed by the worker itself and never passed to the run: the workflow
#: writes these to files in a separate step and does not export them.
_WORKER_ONLY = ("YOUTUBE_TOKEN_JSON", "YOUTUBE_CLIENT_SECRET_JSON")


def _write_private(path: Path, text: str) -> None:
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


def prepare_credentials(channel_row: Mapping, env: Mapping[str, str], repo_dir: Path) -> Dict[str, str]:
    """The run's env with exactly this channel's credentials, and the credential
    files written where main.py looks for them. Mirrors the workflow's
    "Restore YouTube token (default channel / this channel)" and "Restore
    YouTube client secret" steps. Logs facts only, never a value or a size."""
    child = {k: v for k, v in env.items()
             if not k.startswith(TOKEN_PREFIX) and k not in _WORKER_ONLY}
    cid = channel_row.get("channel_id")
    if channel_row.get("is_default"):
        raw = env.get("YOUTUBE_TOKEN_JSON", "")
        if raw.strip():
            _write_private(Path(repo_dir) / "youtube_token.json", raw)
            logger.info("channel %s: YOUTUBE_TOKEN_JSON is set — wrote youtube_token.json", cid)
        else:
            logger.info("channel %s: YOUTUBE_TOKEN_JSON is not set — publishing and analytics "
                        "will be skipped", cid)
    else:
        name = str(channel_row.get("token_secret") or "")
        if name.startswith(TOKEN_PREFIX) and env.get(name, "").strip():
            child[name] = env[name]
            logger.info("channel %s: %s is set — this channel publishes to its own account", cid, name)
        else:
            # Deliberately no fallback to the default channel's token: that
            # would upload this channel's video to somebody else's account.
            logger.info("channel %s: %s is not set — publishing and analytics will be skipped",
                        cid, name or "its token")
    secret = env.get("YOUTUBE_CLIENT_SECRET_JSON", "")
    if secret.strip():
        _write_private(Path(repo_dir) / "client_secret.json", secret)
    else:
        logger.info("YOUTUBE_CLIENT_SECRET_JSON is not set — YouTube API calls will be skipped")
    return child


def remove_credential_files(repo_dir: Path) -> None:
    """What the workflow's self-hosted cleanup step removes, after every job."""
    for p in list(Path(repo_dir).glob("youtube_token*.json")) + [Path(repo_dir) / "client_secret.json"]:
        try:
            p.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("could not remove %s (%s)", p.name, type(e).__name__)


# ── the worker ─────────────────────────────────────────────────────────────

def _default_resolve_channel(channel_id: str) -> dict:
    from tools.list_channels import resolve_only  # noqa: PLC0415

    return resolve_only(channel_id)


class Worker:
    def __init__(
        self,
        client,
        *,
        worker_id: str,
        env: Optional[Mapping[str, str]] = None,
        repo_dir: Path = REPO_DIR,
        output_dir: Optional[Path] = None,
        python: str = sys.executable,
        main_script: str = "main.py",
        prelude: Optional[List[List[str]]] = None,
        resolve_channel: Callable[[str], dict] = _default_resolve_channel,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
        heartbeat_seconds: float = DEFAULT_HEARTBEAT_SECONDS,
        grace_seconds: float = DEFAULT_GRACE_SECONDS,
        stale_minutes: int = DEFAULT_STALE_MINUTES,
        kill_after_seconds: float = KILL_AFTER_SECONDS,
        out=None,
        credits=None,
        ledger_reader: Optional[Callable[[str, str], list]] = None,
    ):
        self.client = client
        self.worker_id = worker_id
        self.env = dict(os.environ if env is None else env)
        self.repo_dir = Path(repo_dir)
        self.output_dir = Path(output_dir) if output_dir is not None else self.repo_dir / "output"
        self.python = python
        self.main_script = main_script
        # The workflow's "Generate audio assets" step, before every run.
        self.prelude = prelude if prelude is not None else [[python, "tools/generate_assets.py"]]
        self.resolve_channel = resolve_channel
        self.poll_seconds = poll_seconds
        self.heartbeat_seconds = heartbeat_seconds
        self.grace_seconds = grace_seconds
        self.stale_minutes = stale_minutes
        self.kill_after_seconds = kill_after_seconds
        self.out = out or sys.stdout
        self.stop_requested = threading.Event()
        self.force_stop = threading.Event()
        self._stop_at: Optional[float] = None
        self._secrets = secret_values(self.env)
        # The service-key credits client (None = credits not wired, e.g. tests
        # of the plain queue) and where a finished run's ledger is read from.
        self.credits = credits
        self.ledger_reader = ledger_reader or credit_rules.local_run_entries
        self.credits_enforced = credit_rules.enforcement_enabled(self.env)
        self._last_sweep: Optional[float] = None

    # -- signals ----------------------------------------------------------

    def request_stop(self, signum: int = signal.SIGTERM, _frame=None) -> None:
        if self.stop_requested.is_set():
            logger.warning("second stop signal — terminating the current run now")
            self.force_stop.set()
            return
        self._stop_at = time.monotonic()
        self.stop_requested.set()
        logger.info("stop requested (signal %s): no new jobs; the current run may finish "
                    "within %ss", signum, int(self.grace_seconds))

    def install_signal_handlers(self) -> None:
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)

    def _must_interrupt(self) -> bool:
        if self.force_stop.is_set():
            return True
        return (self.stop_requested.is_set() and self._stop_at is not None
                and time.monotonic() - self._stop_at >= self.grace_seconds)

    # -- loop -------------------------------------------------------------

    def run_forever(self, *, once: bool = False) -> int:
        while not self.stop_requested.is_set():
            self._sweep_credit_holds()
            job = self.client.claim(self.worker_id, self.stale_minutes)
            if job is None:
                if once:
                    logger.info("no queued job")
                    return 0
                self.stop_requested.wait(self.poll_seconds)
                continue
            self.process(job)
            if once:
                return 0
        logger.info("worker stopped")
        return 0

    def process(self, job: Mapping) -> str:
        """Run one claimed job to an end state. Returns what happened:
        succeeded | failed | released | lost."""
        job_id = job["id"]
        channel_id = str(job.get("channel_id") or "")
        logger.info("job %s: claimed (channel %s, kind %s, attempt %s/%s)", job_id, channel_id,
                    job.get("kind"), job.get("attempts"), job.get("max_attempts"))

        if self.stop_requested.is_set():
            return self._release(job, started=False, why="worker stopping before the run started")

        try:
            argv, run_env, clean = run_request.plan_run(channel_id, str(job.get("kind") or ""),
                                                        job.get("params"), self.env)
        except run_request.InvalidRunRequest as e:
            return self._finish(job, "failed", f"invalid job (nothing was run): {e}")

        try:
            channel_row = self.resolve_channel(channel_id)
        except (KeyError, ValueError) as e:
            return self._finish(job, "failed", f"channel refused (nothing was run): {e}")
        except Exception as e:
            return self._finish(job, "failed", f"channel registry unavailable ({type(e).__name__})")

        topic = resume_target(job, clean, self.output_dir)
        if topic:
            clean = dict(clean, resume=True, topic=topic)
            argv = run_request.build_main_args(channel_id, clean)
            logger.info("job %s: re-queued run — resuming its unfinished run from output/", job_id)

        # The run's credits, claimed before anything is spent. The ledger is
        # read back from this machine's clock, so the window starts on it too.
        run_started = _now()
        try:
            hold = self._open_credit_hold(job, channel_id, clean)
        except credit_rules.CreditRefused as e:
            return self._finish(job, "failed", f"credits: {e} (nothing was run)")

        outcome = self._execute(job, argv, run_env, channel_row)
        if hold is not None and outcome in ("succeeded", "failed"):
            note = credit_rules.settle_hold(self.credits, hold, succeeded=outcome == "succeeded",
                                            channel_id=channel_id, since=run_started,
                                            ledger=self.ledger_reader)
            if note:
                logger.info("job %s: %s", job_id, note)
        # "released" (re-queued) keeps its hold for the next attempt; "lost"
        # belongs to whoever took the job. A job failed on its last attempt by
        # the stale sweep is released by expire_credit_reservations.
        return outcome

    def _open_credit_hold(self, job: Mapping, channel_id: str, clean: Mapping):
        if self.credits is None:
            if self.credits_enforced:
                raise credit_rules.CreditRefused("credits are enforced but this worker has no "
                                                 "credits client")
            return None
        return credit_rules.open_hold(self.credits, job_ref=job.get("credit_ref"),
                                      channel_id=channel_id, duration_s=clean.get("duration"),
                                      enforce=self.credits_enforced)

    def _sweep_credit_holds(self, every_seconds: float = 600.0) -> None:
        """Return holds that can no longer settle (expire_credit_reservations).
        Best-effort, at most every ten minutes."""
        if self.credits is None:
            return
        if self._last_sweep is not None and time.monotonic() - self._last_sweep < every_seconds:
            return
        self._last_sweep = time.monotonic()
        try:
            n = self.credits.expire()
            if n:
                logger.info("credits: released %d stale reservation(s)", int(n))
        except credit_rules.CreditsUnavailable as e:
            logger.info("credits: expiry sweep skipped (%s)", e)

    def _execute(self, job: Mapping, argv: List[str], run_env: Mapping[str, str],
                 channel_row: Mapping) -> str:
        job_id = job["id"]
        lost = threading.Event()
        done = threading.Event()
        hb = threading.Thread(target=self._heartbeat_loop, args=(job_id, lost, done), daemon=True)
        hb.start()
        try:
            child_env = prepare_credentials(channel_row, run_env, self.repo_dir)
            for cmd in self.prelude:
                rc, tail, how = self._run(cmd, child_env, lost)
                if how != "exited":
                    return self._interrupted(job, how)
                if rc != 0:
                    return self._finish(job, "failed",
                                        format_error(f"{Path(cmd[-1]).name} exited with code {rc}",
                                                     tail, self._secrets))
            rc, tail, how = self._run([self.python, self.main_script, *argv], child_env, lost)
            if how != "exited":
                return self._interrupted(job, how)
            if rc == 0:
                return self._finish(job, "succeeded", None)
            return self._finish(job, "failed",
                                format_error(f"main.py exited with code {rc}", tail, self._secrets))
        finally:
            done.set()
            hb.join(timeout=5)
            remove_credential_files(self.repo_dir)

    # -- pieces -----------------------------------------------------------

    def _heartbeat_loop(self, job_id, lost: threading.Event, done: threading.Event) -> None:
        while not done.wait(self.heartbeat_seconds):
            ours = self.client.heartbeat(job_id, self.worker_id)
            if ours is False:
                logger.warning("job %s: no longer held by this worker (cancelled or re-queued) "
                               "— stopping its run", job_id)
                lost.set()
                return

    def _run(self, cmd: List[str], env: Mapping[str, str],
             lost: threading.Event) -> Tuple[Optional[int], List[str], str]:
        """Run ``cmd`` in its own process group, streaming scrubbed output.
        Returns (exit code, output tail, how) where how is exited | lost | stopped."""
        tail: collections.deque = collections.deque(maxlen=TAIL_LINES)
        proc = subprocess.Popen(
            cmd, cwd=str(self.repo_dir), env=dict(env),
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            start_new_session=True,
        )

        def pump():
            assert proc.stdout is not None
            for line in proc.stdout:
                line = scrub(line.rstrip("\n"), self._secrets)
                tail.append(line)
                try:
                    self.out.write(line + "\n")
                    self.out.flush()
                except Exception:
                    pass

        reader = threading.Thread(target=pump, daemon=True)
        reader.start()
        how = "exited"
        while True:
            try:
                rc = proc.wait(timeout=0.5)
                break
            except subprocess.TimeoutExpired:
                pass
            if lost.is_set():
                how = "lost"
            elif self._must_interrupt():
                how = "stopped"
            else:
                continue
            self._terminate(proc)
            rc = proc.returncode
            break
        reader.join(timeout=5)
        return rc, list(tail), how

    def _terminate(self, proc: subprocess.Popen) -> None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=self.kill_after_seconds)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()

    def _interrupted(self, job: Mapping, how: str) -> str:
        if how == "lost":
            # Not ours any more: whoever cancelled or re-queued it owns its state.
            return "lost"
        return self._release(job, started=True,
                             why="worker shut down mid-run (SIGTERM); re-queued")

    def _release(self, job: Mapping, *, started: bool, why: str) -> str:
        attempts = int(job.get("attempts") or 1)
        max_attempts = int(job.get("max_attempts") or 3)
        if not started:
            # Nothing ran: the attempt is given back, and a later claim of this
            # job is not mistaken for a re-queue that has a run to resume.
            attempts = max(0, attempts - 1)
            status = "queued"
        else:
            status = "failed" if attempts >= max_attempts else "queued"
            if status == "failed":
                why = f"worker shut down mid-run on the last of {max_attempts} attempts"
        self._with_retries(lambda: self.client.release(job["id"], self.worker_id, status=status,
                                                       attempts=attempts, error=why))
        logger.info("job %s: released (%s): %s", job["id"], status, why)
        return "released"

    def _finish(self, job: Mapping, status: str, error: Optional[str]) -> str:
        if error:
            error = format_error(error, [], self._secrets)
        self._with_retries(lambda: self.client.finish(job["id"], self.worker_id, status, error))
        logger.info("job %s: %s%s", job["id"], status, f" — {error.splitlines()[0]}" if error else "")
        return status

    @staticmethod
    def _with_retries(fn, tries: int = 3, delay: float = 2.0):
        for i in range(tries):
            result = fn()
            if result is not None:
                return result
            if i + 1 < tries:
                time.sleep(delay * (i + 1))
        return None


# ── entry point ────────────────────────────────────────────────────────────

def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Claim and run render_jobs (docs/WORKER_VPS.md)")
    parser.add_argument("--once", action="store_true", help="Claim at most one job, run it, and exit")
    parser.add_argument("--worker-id", default=os.environ.get("NIGHTSHIFT_WORKER_ID")
                        or f"{socket.gethostname()}-{os.getpid()}")
    parser.add_argument("--poll-seconds", type=float,
                        default=_int_env("WORKER_POLL_SECONDS", DEFAULT_POLL_SECONDS))
    parser.add_argument("--stale-minutes", type=int,
                        default=_int_env("WORKER_STALE_MINUTES", DEFAULT_STALE_MINUTES),
                        help="Re-queue a running job whose heartbeat is older than this")
    parser.add_argument("--grace-seconds", type=float,
                        default=_int_env("WORKER_STOP_GRACE_SECONDS", DEFAULT_GRACE_SECONDS),
                        help="On SIGTERM, how long the current run may keep going")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s queue_worker %(levelname)s %(message)s")

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file "
                     "(docs/WORKER_VPS.md) — the queue lives in Supabase.")
        return 2

    worker = Worker(QueueClient(url, key), worker_id=args.worker_id,
                    poll_seconds=args.poll_seconds, stale_minutes=args.stale_minutes,
                    grace_seconds=args.grace_seconds,
                    credits=credit_rules.CreditsRest(url, key))
    worker.install_signal_handlers()
    logger.info("worker %s started (poll %ss, stale after %s min, stop grace %ss, credits %s)",
                args.worker_id, args.poll_seconds, args.stale_minutes, int(args.grace_seconds),
                "enforced" if worker.credits_enforced else "not enforced")
    return worker.run_forever(once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())

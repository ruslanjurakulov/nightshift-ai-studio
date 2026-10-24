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
  are deleted after every job, as on a self-hosted runner. A customer channel
  connected from the Command Center (migration 0022) has its token read from
  Supabase Vault at run time (``modules/channel_tokens.py``) and handed over
  under that same name, in memory; it is added to the scrubber for the run.

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

Cross-posting (migration 0029, ``modules/social_publish.py``): between render
jobs the worker claims at most one ``publish_requests`` row — a finished video
someone asked to post to a connected Instagram / TikTok account or to another
of the organization's YouTube channels (uploaded PRIVATE) — and carries it out
after checking the publish gate and approvals again. Nothing is charged for
it. Instagram / TikTok tokens come from Supabase Vault (0028); a YouTube
channel's token is resolved exactly as for a render run of that channel
(``channel_token``), in memory. None is ever printed.

Publish when approved (migration 0116, ``modules/visibility_publish.py``): between render jobs the worker also claims at most
one ``video_visibility_requests`` row (queued when a person approved one exact cut of an uploaded, private video on a channel
whose administrators switched "publish when approved" on) and makes that video public with ``videos.update`` on the channel's own
token (``youtube_publish_credentials``), in memory. It asks the database again before and immediately before the write
(``video_publish_refusal`` with the cut hash recorded at approval, the channel's switch, the expiry), keeps to the day's quota
ledger, reads the privacy BACK from YouTube, and records only what YouTube reports: ``applied`` when it is public, ``refused`` with a
closed word when it is not. The step is OFF unless ``NIGHTSHIFT_VISIBILITY_PUBLISH=on`` (it is the only code in this repository that
changes an existing video's privacy; a channel's own switch, default off, is the second lock).

Paid downloads (migration 0030, ``modules/paid_downloads.py``): between render
jobs the worker also keeps ``download_masters`` in step with the masters under
``output/``, prepares at most one queued 720p / 1080p download into
``NIGHTSHIFT_DOWNLOADS_DIR`` (the Command Center streams it from the same
volume), and deletes expired files. A failed download is refunded by the
database. Off when ``NIGHTSHIFT_DOWNLOADS_DIR`` is unset.

Repurposing (migration 0080, ``modules/repurpose.py``): between render jobs the
worker also claims at most one ``repurpose_requests`` row — up to five vertical
clips a person picked from one finished master and priced — and cuts them from
the MASTER file under ``output/`` (never the 480p review copy: a source below
720 pixels is refused). Each made clip becomes its own held, private videos row;
the database captures credits only for the clips that were made and releases the
rest. It needs no render slot and no provider call, and nothing is uploaded.

Comment inbox (migration 0081, ``modules/comment_replies.py``): between render
jobs the worker also keeps each connected channel's recent comments in step
(one channel per interval), writes a drafted reply for a comment a person
asked a draft for and paid for, and posts a reply ONLY after a person approved
that exact text (``comments.insert`` through the channel's own token, once;
a quota refusal is recorded as ``quota_exceeded``). Nothing replies on its own.
The step is OFF unless ``NIGHTSHIFT_COMMENT_INBOX=on`` (it spends YouTube quota and
classifier calls for every connected channel, within the inbox's daily quota ceiling).

Credits (migration 0020, ``modules/credits.py``): a job whose channel belongs
to an organization other than the operator's own is paid for by the hold its
``credit_ref`` names (or, from the public API, its ``api_hold_ref``). The
worker claims that hold before the run spends anything and settles it when the
run ends — the metered cost from this machine's cost ledger on success (never
above the hold, and the whole hold when anything was unpriced), a full release
on failure. Such a job without an open hold, or without the length it was
priced for (``params.duration``, frozen when it was queued — migration 0041),
is failed without running, whatever ``NIGHTSHIFT_CREDITS_ENFORCE`` says: rows
can be inserted from a browser, so the button is not the only way in, and the
run uses that frozen length, never the channel's target as it is by then.

The settlement is retried (3 tries, backing off) and happens BEFORE the job row
is finished; one that still cannot reach the credits API is kept in
``output/.pending_settlements.json`` — the DECISION (capture with this amount,
or release), replayed as is by the loop, never recomputed from the ledger. A
single worker process owns that file. A video run is
charged only when main.py reports a rendered video that is still on disk
(``NIGHTSHIFT_RUN_RESULT_FILE``): an exit 0 with nothing made, and the spend-
ceiling stop (exit 78), release the hold, and a paid job that exits 0 without
one is failed. A run still going after ``WORKER_JOB_TIMEOUT_SECONDS`` (default
3300, minimum 300) is terminated and the job fails with its hold RELEASED, even
if the render had finished: the customer is not charged for a run that did not
end.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Mapping, Optional, Tuple

REPO_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_DIR))

from modules import channel_credentials, channel_tokens  # noqa: E402
from modules import comment_replies  # noqa: E402
from modules import credits as credit_rules  # noqa: E402
from modules import log_redaction  # noqa: E402
from modules.budget import BUDGET_STOP_EXIT  # noqa: E402
from modules.gemini_stages import GEMINI_QUOTA_EXIT  # noqa: E402
from modules.publish_gate import HELD_BEFORE_RENDER_EXIT  # noqa: E402
from modules import run_request  # noqa: E402
from modules import social_publish  # noqa: E402
from modules import visibility_publish  # noqa: E402
from modules import paid_downloads  # noqa: E402
from modules import render_error  # noqa: E402
from modules import repurpose  # noqa: E402
from modules.storyboard_review import PAUSED_EXIT as STORYBOARD_PAUSED_EXIT  # noqa: E402
from modules.voice_gate import VOICE_GATE_EXIT, VOICE_GATE_UNAVAILABLE_EXIT  # noqa: E402

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
#: Wall-clock limit of one job's run (WORKER_JOB_TIMEOUT_SECONDS): the Actions
#: workflow's 60 minutes less a margin. The heartbeat thread keeps a job "alive"
#: whatever its child does, so without this a hung ffmpeg / Whisper / provider
#: socket holds the only worker, and the channel's slot, until the host reboots.
DEFAULT_JOB_TIMEOUT_SECONDS = 3300
#: A limit below this would kill ordinary runs (Whisper alone takes minutes):
#: the command line warns and uses the default instead.
MIN_JOB_TIMEOUT_SECONDS = 300
#: Settlements that could not reach the credits API, kept under output/ (a
#: volume) and retried by the loop until they go through.
PENDING_SETTLEMENTS_FILE = ".pending_settlements.json"
PENDING_RETRY_SECONDS = 60.0
#: Past this a pending settlement is dropped with an error: the reservation is
#: long gone (expired at 24 h) and retrying forever helps nobody.
PENDING_GIVE_UP_HOURS = 72
#: A run's result file (.run_result_<job>.json, repo dir) is kept while its queue row is unconfirmed; one
#: this old belongs to a job that is long over (the stale sweep re-queues within minutes), and is swept at
#: start-up. At most RESULT_SWEEP_MAX files a start, so a directory full of them cannot stall the worker.
RESULT_FILE_MAX_AGE_DAYS = 3
RESULT_SWEEP_MAX = 200
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


def _cost_mirror(url: str, key: str, resolve_channel: Callable[[str], Mapping] = None) -> Callable[[str], object]:
    """The worker's after-job send of history/chronos.db's video_costs to
    Supabase (SupabaseSync.mirror_costs: idempotent, never raises). A channel's
    USD is sent only when it is one of the operator's own (``is_operators``);
    a channel that does not exist counts as a customer's, and one that cannot be looked up right now is skipped until it can."""
    resolve = resolve_channel or _default_resolve_channel

    def mirror(since_iso: str):
        from modules.state_store import StateStore  # noqa: PLC0415 — only the real worker needs it
        from modules.supabase_sync import SupabaseSync  # noqa: PLC0415

        known: Dict[str, bool] = {}

        def is_operator(channel_id: str) -> bool:
            if channel_id not in known:
                try:
                    known[channel_id] = resolve(channel_id).get("is_operators") is True
                except (KeyError, ValueError):
                    known[channel_id] = False      # no such confirmed channel: not the operator's
                # any other failure (registry down) propagates: the mirror skips the
                # channel's rows this time instead of sending them without USD for good
            return known[channel_id]

        with StateStore() as store:
            return SupabaseSync(url, key).mirror_costs(store, since_iso=since_iso, is_operator=is_operator)

    return mirror


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def regeneration_summary(result: Mapping) -> Optional[dict]:
    """What a regeneration's row keeps of its result: ids, codes and counts
    (the 0076 CHECK caps it at 8 KB). Never a path, a prompt or an error tail."""
    if not isinstance(result, Mapping) or not result:
        return None
    ids = lambda v: [str(x)[:64] for x in v][:16] if isinstance(v, list) else []  # noqa: E731
    take = result.get("previous_take") if isinstance(result.get("previous_take"), Mapping) else {}
    qc = result.get("qc") if isinstance(result.get("qc"), Mapping) else {}
    out = {
        "source_kind": str(result.get("source_kind") or "")[:16] or None,
        "explicit_stock": result.get("explicit_stock") is True,
        "previous_asset_ids": ids(result.get("previous_asset_ids")),
        "new_asset_ids": ids(result.get("new_asset_ids")),
        "previous_take_kept": bool(take.get("project") or take.get("video")),
        "qc_blocks": ids(qc.get("blocks")) if "blocks" in qc else None,
        "gate": "not_evaluated",
        "published": False,
    }
    return out


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

        from modules import run_slug  # noqa: PLC0415

        channel = str(job.get("channel_id"))
        # A run's directory is keyed by its channel (modules/run_slug.py,
        # BR-G-007); a run begun before the key is named by the topic alone.
        wanted_slugs = (set(run_slug.candidates(params["topic"], channel))
                        if params.get("topic") else None)
        best = None
        for child in Path(output_dir).iterdir():
            if not child.is_dir() or (wanted_slugs is not None and child.name not in wanted_slugs):
                continue
            cp = run_checkpoint.load(child.name, root=Path(output_dir))
            if cp is None or cp.completed or str(cp.channel_id) != channel:
                continue
            created = _parse_ts(cp.created_at)
            if created is None or created < queued_at:
                continue
            if not cp.topic or cp.slug not in run_slug.candidates(cp.topic, channel):
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
#: writes these to files in a separate step and does not export them. The
#: Command Center's OAuth client pair is only needed to build a Vault token's
#: document (modules/channel_tokens.py), which carries it to the run.
_WORKER_ONLY = ("YOUTUBE_TOKEN_JSON", "YOUTUBE_CLIENT_SECRET_JSON",
                channel_tokens.CLIENT_ID_ENV, channel_tokens.CLIENT_SECRET_ENV)


def _write_private(path: Path, text: str) -> None:
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


def channel_token(channel_row: Mapping, env: Mapping[str, str],
                  token_client: Optional["channel_tokens.VaultTokenClient"] = None,
                  *, expected_youtube_channel_id: str = "") -> "channel_tokens.ResolvedToken":
    """This channel's YouTube token, in memory — the one rule a render run
    (prepare_credentials) and a "Publish to platforms" YouTube upload
    (youtube_publish_credentials) share. The operator's own channels: the ACTIVE
    Vault connection its owner made with the Command Center's button (migration
    0115), else its own secret: YOUTUBE_TOKEN_JSON for the default channel,
    CHRONOS_YT_TOKEN_<REF> for any other. A channel of any other organization:
    its ACTIVE Vault connection only, never the environment (BR-G-002)
    (modules/channel_tokens.py). The Vault key is always the row's own channel
    id. Never another channel's token. Raises ChannelTokenError when the Vault
    lookup failed with nothing to fall back to."""
    expected = expected_youtube_channel_id or str(channel_row.get("youtube_channel_id") or "")
    if channel_row.get("is_default"):
        # `is_default` is set only for the operator's own `default` channel (tools/list_channels._row), so its
        # secret is the environment's to give and its Vault key is that id, whatever else the row says.
        return channel_tokens.resolve_channel_token(
            "default", "YOUTUBE_TOKEN_JSON", env, client=token_client,
            expected_youtube_channel_id=expected, allow_env=True)
    name = str(channel_row.get("token_secret") or "")
    if not name.startswith(TOKEN_PREFIX):
        name = ""
    # The environment is the operator's own channels' place for a token. A row
    # without the flag is treated as someone else's: the safe direction.
    return channel_tokens.resolve_channel_token(
        str(channel_row.get("channel_id") or ""), name, env, client=token_client,
        expected_youtube_channel_id=expected,
        allow_env=channel_row.get("is_operators") is True)


def youtube_publish_credentials(channel_id: str, env: Mapping[str, str],
                                token_client: Optional["channel_tokens.VaultTokenClient"] = None,
                                registry=None) -> tuple:
    """(token_json, ChannelContext) for uploading a finished video to
    ``channel_id`` from "Publish to platforms" (modules/social_publish.py).

    Resolved exactly as a render run of that channel resolves it: the channel
    must exist and be confirmed against YouTube (``resolve_only`` — KeyError /
    ValueError otherwise), and its token comes from :func:`channel_token`.
    token_json is "" when the channel has no token on this worker. Nothing is
    written to disk and nothing is logged but facts."""
    from modules.channels import ChannelRegistry  # noqa: PLC0415
    from tools.list_channels import resolve_only  # noqa: PLC0415

    reg = registry or ChannelRegistry()
    row = resolve_only(channel_id, registry=reg)
    ctx = reg.get(channel_id)
    resolved = channel_token(row, env, token_client,
                             expected_youtube_channel_id=ctx.credential.youtube_channel_id)
    return resolved.token_json, ctx


def prepare_credentials(channel_row: Mapping, env: Mapping[str, str], repo_dir: Path,
                        token_client: Optional["channel_tokens.VaultTokenClient"] = None) -> Dict[str, str]:
    """The run's env with exactly this channel's credentials, and the credential
    files written where main.py looks for them. Mirrors the workflow's
    "Restore YouTube token (default channel / this channel / from Vault)" and
    "Restore YouTube client secret" steps. Logs facts only, never a value or a
    size.

    A non-default channel's token comes from modules/channel_tokens: its
    ACTIVE Vault connection (migration 0022) when it has one, else — for the
    operator's own channels only — its own CHRONOS_YT_TOKEN_<REF> secret, as
    before (BR-G-002: another organization's channel never reads the
    environment). An operator channel's token reaches the run in memory, under
    its own env var name only (the run writes it to a 0600 file); another
    organization's reaches it as the 0600 token file itself, and
    remove_credential_files deletes either after the job. Raises
    ChannelTokenError when the Vault lookup failed and there is nothing to fall
    back to, so the job fails before the run spends anything."""
    child = {k: v for k, v in env.items()
             if not k.startswith(TOKEN_PREFIX) and k not in _WORKER_ONLY}
    cid = channel_row.get("channel_id")
    resolved = channel_token(channel_row, env, token_client)
    if channel_row.get("is_default"):
        if resolved.found:
            _write_private(Path(repo_dir) / "youtube_token.json", resolved.token_json)
            logger.info("channel %s: its %s is set — wrote youtube_token.json", cid,
                        "Vault connection" if resolved.source == channel_tokens.SOURCE_VAULT else "YOUTUBE_TOKEN_JSON")
        else:
            logger.info("channel %s: no Vault connection and YOUTUBE_TOKEN_JSON is not set — publishing "
                        "and analytics will be skipped", cid)
    elif channel_row.get("is_operators") is not True:
        # Another organization's channel: its Vault token is handed over as the
        # file its uploader reads (modules/channel_credentials.token_path), never
        # as an environment variable the run could read under a name of the
        # row's choosing or that collides with an operator's (BR-L-080). The
        # file is removed after the job (remove_credential_files).
        if resolved.found:
            _write_private(Path(repo_dir) / channel_credentials.customer_token_filename(str(cid)),
                           resolved.token_json)
            logger.info("channel %s: its Vault connection is active — this channel publishes "
                        "to its own account", cid)
        else:
            logger.info("channel %s: no Vault connection is active — publishing and analytics "
                        "will be skipped", cid)
    else:
        name = str(channel_row.get("token_secret") or "")
        if not name.startswith(TOKEN_PREFIX):
            name = ""
        if resolved.found and name:
            child[name] = resolved.token_json
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
        job_timeout_seconds: float = DEFAULT_JOB_TIMEOUT_SECONDS,
        stale_minutes: int = DEFAULT_STALE_MINUTES,
        kill_after_seconds: float = KILL_AFTER_SECONDS,
        out=None,
        credits=None,
        ledger_reader: Optional[Callable[[str, str], list]] = None,
        token_client=None,
        publisher=None,
        downloads=None,
        repurposer=None,
        comments=None,
        visibility=None,
        cost_mirror: Optional[Callable[[str], object]] = None,
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
        self.job_timeout_seconds = job_timeout_seconds if job_timeout_seconds and job_timeout_seconds > 0 \
            else DEFAULT_JOB_TIMEOUT_SECONDS
        self.stale_minutes = stale_minutes
        self.kill_after_seconds = kill_after_seconds
        self.out = out or sys.stdout
        self.stop_requested = threading.Event()
        self.force_stop = threading.Event()
        self._stop_at: Optional[float] = None
        self._base_secrets = secret_values(self.env)
        self._secrets = self._base_secrets
        # Did the last _finish fail to reach the queue (no answer after its retries)? Then the row is
        # still "running", the stale sweep will re-queue it, and the run's result file is the only
        # proof the next attempt has that a video was made and its credits already taken.
        self._row_unconfirmed = False
        # Reads a customer channel's Vault token (migration 0022) with the
        # service key; None = only the env/GitHub-secret path, as before.
        self.token_client = token_client
        # Cross-posting to Instagram / TikTok (migration 0029,
        # modules/social_publish.py): handled between render jobs. None = off.
        self.publisher = publisher
        # Paid 720p / 1080p downloads (migration 0030): between render jobs.
        self.downloads = downloads
        # Multi-clip repurposing (migration 0080): between render jobs.
        self.repurposer = repurposer
        # The comment inbox (migration 0081): fetch, draft (when asked and
        # paid for) and post (only what a person approved), between render
        # jobs. None = off.
        self.comments = comments
        # Publish when approved (migration 0116): makes an approved video public on a channel that switched it on, between
        # render jobs. None = off (the default: NIGHTSHIFT_VISIBILITY_PUBLISH).
        self.visibility = visibility
        # The service-key credits client and where a finished run's ledger is
        # read from. None = the worker cannot tell who pays for a job, so it
        # runs none (migration 0041: no unpaid fallback).
        self.credits = credits
        self.ledger_reader = ledger_reader or credit_rules.local_run_entries
        # Called with an ISO time after every job: sends this machine's cost
        # ledger (history/chronos.db) to Supabase video_costs, where the Billing
        # page reads it. None = not mirrored. Must never fail a job.
        self.cost_mirror = cost_mirror
        self._last_sweep: Optional[float] = None
        self._last_pending_retry: Optional[float] = None

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

    def _sweep_old_result_files(self) -> int:
        """Delete result files older than RESULT_FILE_MAX_AGE_DAYS from the repo dir. Plain files named
        exactly ``.run_result_<id>.json`` only (never a symlink, never a directory); never raises."""
        removed = 0
        try:
            cutoff = time.time() - RESULT_FILE_MAX_AGE_DAYS * 86400
            for path in sorted(Path(self.repo_dir).glob(".run_result_*.json")):
                if removed >= RESULT_SWEEP_MAX:
                    break
                try:
                    if path.is_symlink() or not path.is_file() or path.stat().st_mtime >= cutoff:
                        continue
                    path.unlink()
                    removed += 1
                except OSError:
                    continue
        except OSError as e:
            logger.warning("result file sweep skipped (%s)", type(e).__name__)
        if removed:
            logger.info("removed %d result file(s) older than %d days", removed, RESULT_FILE_MAX_AGE_DAYS)
        return removed

    def run_forever(self, *, once: bool = False) -> int:
        self._sweep_old_result_files()
        while not self.stop_requested.is_set():
            self._sweep_credit_holds()
            self._retry_pending_settlements()
            published = self._publish_one()
            published = self._download_one() or published
            published = self._repurpose_one() or published
            published = self._comments_one() or published
            published = self._visibility_one() or published
            job = self.client.claim(self.worker_id, self.stale_minutes)
            if job is None:
                if once:
                    logger.info("no queued job")
                    return 0
                if not published:
                    self.stop_requested.wait(self.poll_seconds)
                continue
            self.process(job)
            if once:
                return 0
        logger.info("worker stopped")
        return 0

    def _publish_one(self) -> bool:
        """At most one publish request between render jobs; never raises."""
        if self.publisher is None:
            return False
        try:
            return bool(self.publisher.run_once())
        except Exception as e:
            logger.warning("publish request handling failed (%s)", type(e).__name__)
            return False

    def _visibility_one(self) -> bool:
        """At most one publish-when-approved request between render jobs; never raises."""
        if self.visibility is None:
            return False
        try:
            return bool(self.visibility.run_once())
        except Exception as e:
            logger.warning("visibility request handling failed (%s)", type(e).__name__)
            return False

    def _comments_one(self) -> bool:
        """One round of the comment inbox between render jobs; never raises."""
        if self.comments is None:
            return False
        try:
            return bool(self.comments.run_once())
        except Exception as e:
            logger.warning("comment inbox handling failed (%s)", type(e).__name__)
            return False

    def _download_one(self) -> bool:
        """At most one download request between render jobs; never raises."""
        if self.downloads is None:
            return False
        try:
            return bool(self.downloads.run_once())
        except Exception as e:
            logger.warning("download request handling failed (%s)", type(e).__name__)
            return False

    def _repurpose_one(self) -> bool:
        """At most one repurpose request between render jobs; never raises."""
        if self.repurposer is None:
            return False
        try:
            return bool(self.repurposer.run_once())
        except Exception as e:
            logger.warning("repurpose request handling failed (%s)", type(e).__name__)
            return False

    def process(self, job: Mapping) -> str:
        """Run one claimed job to an end state. Returns what happened:
        succeeded | failed | paused | released | lost."""
        job_id = job["id"]
        channel_id = str(job.get("channel_id") or "")
        self._row_unconfirmed = False
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

        # A priced scene regeneration (migration 0076) is paid and settled by
        # its own row, not by the per-minute settle of a video run.
        regen_id = str(job.get("scene_regeneration_id") or "").strip()
        if regen_id:
            return self._process_regeneration(job, channel_id, clean, channel_row, regen_id)

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
            if self._already_delivered_and_charged(job):
                status = self._finish(job, "succeeded", None)
                # Only once the row is finished: if this write is lost too, the next attempt still
                # needs the file to see that the video exists (else it fails a charged job).
                if not self._row_unconfirmed:
                    self._result_path(job_id).unlink(missing_ok=True)
                return status
            status = self._finish(job, "failed", f"credits: {e} (nothing was run)")
            # A file kept for this re-queued attempt has done its job once the attempt is refused for good.
            if not self._row_unconfirmed:
                self._result_path(job_id).unlink(missing_ok=True)
            return status

        # The settlement happens INSIDE _execute, before the queue row is
        # finished: a kill between the two used to leave a "succeeded" job with
        # an open hold, which the 24 h sweep then released (a free video).
        # A paid video run (a credit hold, or an API-balance hold) counts only if
        # its render stage left a video behind: main.py reports it in a result
        # file. Without one, the job fails and the hold is released.
        result_file: Optional[Path] = None
        if (hold is not None or str(job.get("api_hold_ref") or "").strip()) and job.get("kind") == "daily":
            result_file = self._result_path(job_id)
            result_file.unlink(missing_ok=True)
            run_env = dict(run_env, **{run_request.RESULT_FILE_ENV: str(result_file)})
        settled = {"done": False}

        def settle(succeeded: bool) -> None:
            if settled["done"]:
                return
            settled["done"] = True
            self._settle_job(job, hold, charge=succeeded, channel_id=channel_id, since=run_started)

        try:
            outcome = self._execute(job, argv, run_env, channel_row,
                                    settle=settle if hold is not None else None,
                                    video_check=(lambda: self._run_made_video(result_file))
                                    if result_file is not None else None)
            # "paused": the run stopped at its storyboard (modules/storyboard_review)
            # and waits for a person. Released in full like a failed run — planning
            # is never charged on its own; the render is paid by the hold placed
            # when the storyboard is approved. (Safety net: _execute settles each
            # of these itself, before it finishes the job.)
            if hold is not None and outcome in ("succeeded", "failed", "paused"):
                settle(outcome == "succeeded")
        finally:
            # Not before the queue row is finished. A video that was made and charged, whose row could
            # not be finished (Supabase down for the retries), is re-queued by the stale sweep; its next
            # attempt finds the hold captured and decides from THIS file (_already_delivered_and_charged).
            # Deleting it here made that attempt fail a job the customer had already paid for.
            if result_file is not None:
                if self._row_unconfirmed:
                    logger.warning("job %s: its queue row could not be finished, so %s is kept for the "
                                   "re-queued attempt", job_id, result_file.name)
                else:
                    result_file.unlink(missing_ok=True)
        # Bookkeeping only, AFTER the job is finished and its hold settled: a slow or
        # failing Supabase can neither delay nor change either (it never raises).
        self._mirror_costs(run_started)
        # "released" (re-queued) keeps its hold for the next attempt; "lost"
        # belongs to whoever took the job. A job failed on its last attempt by
        # the stale sweep is released by expire_credit_reservations.
        return outcome

    #: How far back each job's cost mirror reaches: a send that failed (Supabase
    #: down, migration 0106 not applied yet) is retried by the next jobs for this
    #: long. Re-sending rows Supabase already has is free (ignore-duplicates).
    #: (Two days is a judgement call: long enough to ride out an outage of a
    #: day or so, short enough that each job sends a handful of rows, not the history.)
    COST_MIRROR_WINDOW = timedelta(days=2)

    def _mirror_costs(self, run_started: str) -> None:
        """Mirror the cost ledger after a job, whatever its outcome: a failed run
        spent money too. Bookkeeping only — any failure is logged and swallowed."""
        if self.cost_mirror is None:
            return
        try:
            since = (datetime.fromisoformat(run_started) - self.COST_MIRROR_WINDOW).isoformat()
            self.cost_mirror(since)
        except Exception as e:
            logger.warning("cost ledger mirror skipped (%s) — the local ledger is intact", type(e).__name__)

    def _result_path(self, job_id) -> Path:
        return self.repo_dir / f".run_result_{job_id}.json"

    def _run_made_video(self, result_file: Path) -> bool:
        """True when main.py wrote its result file after the render stage and
        the video it names is still on disk and not empty."""
        try:
            info = json.loads(result_file.read_text(encoding="utf-8"))
            video = Path(str(info.get("video_path") or ""))
            if not video.is_absolute():
                video = self.repo_dir / video
            return video.is_file() and video.stat().st_size > 0
        except (OSError, ValueError, AttributeError):
            return False

    def _already_delivered_and_charged(self, job: Mapping) -> bool:
        """A re-queued job whose hold is no longer open: the previous attempt may
        have rendered, captured the credits, and died before it could finish the
        row. When the reservation is `captured` and that attempt's result file
        still names a video, the job is done — failing it now would mean a
        charge for a video the customer is then told was not made."""
        ref = str(job.get("credit_ref") or "").strip()
        lookup = getattr(self.credits, "reservation", None)
        if not ref or int(job.get("attempts") or 0) <= 1 or job.get("kind") != "daily" or not callable(lookup):
            return False
        try:
            row = lookup(ref)
        except credit_rules.CreditsUnavailable:
            return False
        if (row or {}).get("status") != "captured" or not self._run_made_video(self._result_path(job["id"])):
            return False
        logger.warning("job %s: its credits were already captured and its video is on disk — "
                       "finishing it as succeeded instead of failing it", job["id"])
        return True

    # -- credit settlement ------------------------------------------------

    def _settle_job(self, job: Mapping, hold, *, charge: bool, channel_id: str, since: str) -> None:
        """Capture (``charge``) or release the job's hold. The amount is decided
        ONCE here, then applied with retries (credit_rules.apply_settlement). If
        the credits API stays unreachable, the decision (action and amount) is
        kept in a marker under output/ and the loop replays exactly that: the
        hold would otherwise sit open until the sweep releases it. Never raises."""
        try:
            plan = credit_rules.plan_settlement(self.credits, hold, succeeded=charge, channel_id=channel_id,
                                                since=since, ledger=self.ledger_reader)
        except Exception as e:  # noqa: BLE001 — a settlement bug must not strand the job row
            logger.error("job %s: could not decide the settlement of reservation %s (%s) — it stays open "
                         "until the sweep; settle it by hand", job["id"], hold.job_ref, type(e).__name__)
            return
        try:
            note = credit_rules.apply_settlement(self.credits, hold, plan)
        except Exception as e:  # noqa: BLE001
            logger.error("job %s: settlement failed unexpectedly (%s)", job["id"], type(e).__name__)
            note = None
        if note:
            logger.info("job %s: %s", job["id"], note)
            return
        self._save_pending(self._load_pending() + [{
            "job_id": job["id"], "job_ref": hold.job_ref, "org_id": hold.org_id, "hold": hold.amount,
            "action": plan.action, "amount_to_capture": plan.amount, "detail": plan.detail,
            "channel_id": channel_id, "at": _now(),
        }])
        logger.error("job %s: settlement of reservation %s (%s%s) is pending — the worker retries it every "
                     "%ds", job["id"], hold.job_ref, plan.action,
                     f" {plan.amount:.2f}" if plan.action == "capture" else "", int(PENDING_RETRY_SECONDS))

    def _pending_path(self) -> Path:
        return self.output_dir / PENDING_SETTLEMENTS_FILE

    def _load_pending(self) -> List[dict]:
        path = self._pending_path()
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError as e:
            logger.error("could not read %s (%s)", path.name, type(e).__name__)
            return []
        try:
            rows = json.loads(text)
            if not isinstance(rows, list):
                raise ValueError("not a list")
            return [r for r in rows if isinstance(r, dict)]
        except ValueError:
            # Never overwrite what may be the only record of an open hold: keep the
            # damaged file for a person (docs/WORKER_VPS.md) and start a clean one.
            aside = path.with_name(f"{path.name}.{int(time.time())}.corrupt")
            try:
                os.replace(path, aside)
            except OSError:
                pass
            logger.error("%s is unreadable — kept as %s; its pending credit settlements must be "
                         "settled by hand", path.name, aside.name)
            return []

    def _save_pending(self, rows: List[dict]) -> None:
        path = self._pending_path()
        try:
            if not rows:
                path.unlink(missing_ok=True)
                return
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(rows), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as e:
            logger.error("could not write the pending-settlements file (%s)", type(e).__name__)

    def _retry_pending_settlements(self) -> None:
        if self.credits is None:
            return
        if self._last_pending_retry is not None and \
                time.monotonic() - self._last_pending_retry < PENDING_RETRY_SECONDS:
            return
        self._last_pending_retry = time.monotonic()
        rows = self._load_pending()
        if not rows:
            return
        keep: List[dict] = []
        for row in rows:
            at = _parse_ts(row.get("at"))
            if at is not None and datetime.now(timezone.utc) - at > timedelta(hours=PENDING_GIVE_UP_HOURS):
                logger.error("credits: giving up on settling reservation %s (pending for over %dh) — "
                             "settle it by hand", row.get("job_ref"), PENDING_GIVE_UP_HOURS)
                continue
            try:
                hold = credit_rules.Hold(str(row["job_ref"]), str(row["org_id"]), float(row["hold"]))
                plan = credit_rules.SettlePlan(str(row["action"]), float(row["amount_to_capture"]),
                                               str(row.get("detail") or ""))
                if plan.action not in ("capture", "release"):
                    raise ValueError("action")
                # Exactly the decision made when the job ended: never recomputed
                # from the ledger, which by now also holds other jobs' costs.
                note = credit_rules.apply_settlement(self.credits, hold, plan)
            except Exception as e:  # noqa: BLE001 — a bad row must not stop the loop
                logger.error("credits: pending settlement row unreadable (%s) — dropped; settle "
                             "reservation %s by hand", type(e).__name__, row.get("job_ref"))
                continue
            if note:
                logger.info("job %s: %s (retried)", row.get("job_id"), note)
            else:
                keep.append(row)
        self._save_pending(keep)

    def _process_regeneration(self, job: Mapping, channel_id: str, clean: Mapping,
                              channel_row: Mapping, regen_id: str) -> str:
        """One scene of a run made again, as the person priced and confirmed it
        (modules/scene_regenerate.py). The database claims the hold before
        anything runs (start_scene_regeneration) and settles it with the
        regeneration's status (finish_scene_regeneration): the quote on
        success, a full release on any failure — the confirmed price, never a
        per-minute meter. A job it cannot claim is failed without running."""
        from modules import scene_regenerate  # noqa: PLC0415 — only these jobs need it

        job_id = job["id"]
        if job.get("kind") != "repair":
            return self._finish(job, "failed", "scene regeneration: not a repair job (nothing was run)")
        if self.credits is None or not callable(getattr(self.credits, "scene_regen_start", None)):
            return self._finish(job, "failed", "scene regeneration: this worker has no credits client to "
                                               "claim its hold (nothing was run)")
        try:
            terms = self.credits.scene_regen_start(regen_id, job_id)
        except credit_rules.CreditsUnavailable as e:
            return self._finish(job, "failed", f"scene regeneration: credits unavailable ({e}) (nothing was run)")
        if not terms:
            return self._finish(job, "failed", "scene regeneration: its hold is not open or it already ended "
                                               "(nothing was run)")
        try:
            argv = run_request.build_regenerate_args(channel_id, clean)
            run_env = run_request.build_regenerate_env(terms, clean, self.env)
        except run_request.InvalidRunRequest as e:
            self._settle_regeneration(job, regen_id, ok=False, code="invalid_job", error=str(e))
            return self._finish(job, "failed", f"scene regeneration refused (nothing was run): {e}")

        outcome = self._execute(job, argv, run_env, channel_row)
        if outcome in ("succeeded", "failed"):
            # Charged only when the run exited 0, its own result says the new
            # take is in place, AND the cut on disk is byte for byte the one
            # that result names. Otherwise the previous take is put back
            # first, so "failed, nothing charged" always means "unchanged".
            verdict = scene_regenerate.settle_outcome(self.output_dir, str(terms.get("slug") or ""), regen_id,
                                                      exited_ok=outcome == "succeeded")
            self._settle_regeneration(job, regen_id, ok=verdict["ok"], code=verdict["code"],
                                      error=verdict["error"], result=regeneration_summary(verdict["result"]))
        # "released" (re-queued) keeps its hold and its provider tasks for the
        # next attempt; "lost" belongs to whoever took the job.
        return outcome

    def _settle_regeneration(self, job: Mapping, regen_id: str, *, ok: bool, code: Optional[str],
                             error=None, result: Optional[dict] = None) -> bool:
        """Never raises. If the database cannot be reached the regeneration
        stays open and the expiry sweep takes it later — after the worker has
        settled it from its disk (_reconcile_regenerations), so the person is
        never charged for an unconfirmed end and a hold is never released
        while the new cut is in place. True when the database took it."""
        try:
            out = self.credits.scene_regen_finish(regen_id, job["id"], ok=ok, error_code=code,
                                                  error=scrub(str(error), self._secrets) if error else None,
                                                  result=result)
            logger.info("job %s: scene regeneration %s (%s)", job["id"],
                        (out or {}).get("status", "unknown"), "captured the quote" if ok else "hold released")
            return True
        except credit_rules.CreditsUnavailable as e:
            logger.error("job %s: could not settle the scene regeneration (%s) — the next sweep settles it "
                         "from this worker's files", job["id"], e)
            return False

    #: A regeneration this old is past every hold (the credit sweep releases a
    #: started hold after 24 h): it never blocks the expiry sweep.
    _RECONCILE_GIVE_UP_HOURS = 28

    def _reconcile_regenerations(self) -> bool:
        """BR-L-042. Before expire_scene_regenerations() fails a regeneration
        and releases its hold, settle each one it would take from the files on
        this worker: the new cut is in place and matches its result (capture
        the quote), or the previous take is put back (release). Returns False
        when one could not be settled, so the sweep leaves them all for the
        next round instead of releasing a hold while the new cut may be on
        disk. Never raises."""
        lister = getattr(self.credits, "scene_regen_unsettled", None)
        if not callable(lister):
            return True
        try:
            rows = lister()
        except credit_rules.CreditsUnavailable as e:
            if "HTTP 404" in str(e):
                # A database without migration 0085: the old sweep, as before.
                logger.warning("credits: scene_regenerations_unsettled() is missing (apply migration 0085); "
                               "unfinished regenerations are released without checking this worker's files")
                return True
            logger.info("credits: could not list unfinished scene regenerations (%s)", e)
            return False
        from modules import scene_regenerate  # noqa: PLC0415 — only regenerations need it

        settled = True
        for row in rows or []:
            try:
                regen_id = str(row.get("id") or "")
                job_id = row.get("render_job_id")
                verdict = scene_regenerate.reconcile_outcome(self.output_dir, str(row.get("slug") or ""),
                                                             regen_id)
                done = job_id is not None and self._settle_regeneration(
                    {"id": job_id}, regen_id, ok=verdict["ok"], code=verdict["code"], error=verdict["error"],
                    result=regeneration_summary(verdict["result"]))
            except Exception as e:  # one bad row must not stop the others
                logger.error("credits: could not settle scene regeneration %s (%s)", row.get("id"),
                             type(e).__name__)
                done = False
            if not done and not self._regeneration_is_ancient(row):
                settled = False
        return settled

    def _regeneration_is_ancient(self, row: Mapping) -> bool:
        created = _parse_ts(row.get("created_at"))
        return created is not None and \
            datetime.now(timezone.utc) - created > timedelta(hours=self._RECONCILE_GIVE_UP_HOURS)

    def _open_credit_hold(self, job: Mapping, channel_id: str, clean: Mapping):
        api_ref = str(job.get("api_hold_ref") or "").strip()
        if api_ref:
            # Paid from the API balance (migration 0031); settled in the database.
            # The API priced a length, and 0041 froze it into the job: without
            # it main.py would read the channel's target at run time instead.
            if credit_rules.frozen_duration(clean) is None:
                raise credit_rules.CreditRefused("its length was not fixed when it was queued "
                                                 "(no duration) — create it again")
            credit_rules.open_api_hold(self.credits, hold_ref=api_ref, job_id=job.get("id"))
            return None
        # Independent of NIGHTSHIFT_CREDITS_ENFORCE (review finding C2).
        return credit_rules.open_queue_hold(self.credits, job_ref=job.get("credit_ref"),
                                            channel_id=channel_id, params=clean)

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
        # Scene regenerations (migration 0076) whose job ended without them.
        expire_regens = getattr(self.credits, "scene_regen_expire", None)
        if callable(expire_regens) and self._reconcile_regenerations():
            try:
                n = expire_regens()
                if n:
                    logger.info("credits: released %d unfinished scene regeneration(s)", int(n))
            except credit_rules.CreditsUnavailable as e:
                logger.info("credits: scene regeneration sweep skipped (%s)", e)
        # Plans (migration 0034): expired credit lots. Separate, so a database
        # without 0034 still gets its holds swept.
        expire_lots = getattr(self.credits, "expire_lots", None)
        if expire_lots is None:
            return
        try:
            n = expire_lots()
            if n:
                logger.info("credits: %s expired credit(s) left the balance", n)
        except credit_rules.CreditsUnavailable as e:
            logger.info("credits: lot expiry skipped (%s)", e)

    def _execute(self, job: Mapping, argv: List[str], run_env: Mapping[str, str],
                 channel_row: Mapping, settle: Optional[Callable[[bool], None]] = None,
                 video_check: Optional[Callable[[], bool]] = None) -> str:
        job_id = job["id"]

        def end(status: str, error: Optional[str], charge: bool = False) -> str:
            # Settle the job's hold (when it has one) BEFORE the queue row ends.
            return self._finish(job, status, error,
                                before=(lambda: settle(charge)) if settle is not None else None)

        def ended_early(how: str, tail: List[str]) -> str:
            if how == "timeout":
                minutes = max(1, int(self.job_timeout_seconds // 60))
                # Shown to the customer: no setting names. Whatever was rendered
                # before the limit, the hold is released (not charged).
                logger.error("job %s: stopped after the %ds job limit (WORKER_JOB_TIMEOUT_SECONDS)",
                             job_id, int(self.job_timeout_seconds))
                return end("failed", format_error(
                    f"timed out: the run took longer than {minutes} minutes and was stopped; "
                    "nothing was charged", tail, self._secrets))
            return self._interrupted(job, how)

        lost = threading.Event()
        done = threading.Event()
        hb = threading.Thread(target=self._heartbeat_loop, args=(job_id, lost, done), daemon=True)
        hb.start()
        try:
            try:
                child_env = prepare_credentials(channel_row, run_env, self.repo_dir,
                                                token_client=self.token_client)
            except channel_tokens.ChannelTokenError as e:
                return end("failed", f"channel token unavailable (nothing was run): {e}")
            # A Vault token was never in this worker's env, so the scrubber
            # built at start-up does not know it: add this run's credentials.
            # A customer's token is a file, not an env var (BR-L-080): its strings
            # are added from the file the run reads.
            from_file: List[str] = []
            if channel_row.get("is_default"):
                name = "youtube_token.json"          # the operator's own default channel: Vault or its secret
            elif channel_row.get("is_operators") is not True:
                name = channel_credentials.customer_token_filename(str(channel_row.get("channel_id")))
            else:
                name = ""
            if name:
                try:
                    text = (Path(self.repo_dir) / name).read_text(encoding="utf-8")
                    from_file = channel_tokens.secret_strings(channel_tokens.ResolvedToken(
                        channel_tokens.SOURCE_VAULT, text))
                except OSError:
                    pass
            self._secrets = sorted(set(self._base_secrets) | set(secret_values(child_env)) | set(from_file),
                                   key=len, reverse=True)
            # One deadline for the whole job (prelude and run): see DEFAULT_JOB_TIMEOUT_SECONDS.
            deadline = time.monotonic() + self.job_timeout_seconds
            for cmd in self.prelude:
                rc, tail, how = self._run(cmd, child_env, lost, deadline)
                if how != "exited":
                    return ended_early(how, tail)
                if rc != 0:
                    return end("failed", format_error(f"{Path(cmd[-1]).name} exited with code {rc}",
                                                      tail, self._secrets))
            rc, tail, how = self._run([self.python, self.main_script, *argv], child_env, lost, deadline)
            if how != "exited":
                return ended_early(how, tail)
            if rc == 0:
                if video_check is not None and not video_check():
                    # A paid run that exited 0 with no rendered video behind it
                    # (nothing to deliver): failed, hold released.
                    logger.warning("job %s: the run exited 0 but its render stage left no video", job_id)
                    return end("failed", "The run finished without producing a video; nothing was charged.")
                return end("succeeded", None, charge=True)
            if rc == STORYBOARD_PAUSED_EXIT:
                # The job did what it was asked: the run is planned and waits
                # at "Storyboard ready". Not a failure, and not a finished
                # video — its hold is released.
                end("succeeded", None)
                return "paused"
            if rc == BUDGET_STOP_EXIT:
                # The channel's spend ceiling stopped the run before it spent
                # anything: no video, so the job fails and the hold is released.
                return end("failed", format_error(
                    f"main.py exited with code {rc}: the channel's spend ceiling stopped the run "
                    "before anything was spent; nothing was charged", tail, self._secrets))
            if rc == GEMINI_QUOTA_EXIT:
                # Gemini's per-day quota is spent for a stage the run cannot skip (modules/gemini_stages.py): the
                # log tail names the model, the retry-after and the fix. No video, so the job fails and the hold
                # is released.
                return end("failed", format_error(
                    f"main.py exited with code {rc}: Gemini's daily request quota is used up; nothing was "
                    "charged", tail, self._secrets))
            if rc == VOICE_GATE_EXIT:
                # The database said a custom voice this run uses may not be used (modules/voice_gate.py): refused before
                # anything was spent, and no other voice was substituted. No video, so the job fails and the hold is released.
                return end("failed", format_error(
                    f"main.py exited with code {rc}: a custom voice this run may not use; nothing was spent and nothing was "
                    "charged", tail, self._secrets))
            if rc == VOICE_GATE_UNAVAILABLE_EXIT:
                # Only with NIGHTSHIFT_VOICE_GATE_STRICT on: the ownership check could not be completed for a voice id that
                # may be a custom voice. Not a refusal of the voice: the operator reads the log tail for why.
                return end("failed", format_error(
                    f"main.py exited with code {rc}: the custom-voice ownership check could not be completed (strict mode); "
                    "nothing was spent and nothing was charged", tail, self._secrets))
            if rc == HELD_BEFORE_RENDER_EXIT:
                # The fact-check would block the publish gate: the run stopped before
                # the voice and the render were bought. No video, so the job fails
                # and the hold is released; the held row says why.
                return end("failed", format_error(
                    f"main.py exited with code {rc}: the fact-check held the script before the video "
                    "was made; nothing was charged", tail, self._secrets))
            return end("failed", format_error(f"main.py exited with code {rc}", tail, self._secrets))
        finally:
            done.set()
            hb.join(timeout=5)
            remove_credential_files(self.repo_dir)
            self._secrets = self._base_secrets

    # -- pieces -----------------------------------------------------------

    def _heartbeat_loop(self, job_id, lost: threading.Event, done: threading.Event) -> None:
        while not done.wait(self.heartbeat_seconds):
            ours = self.client.heartbeat(job_id, self.worker_id)
            if ours is False:
                logger.warning("job %s: no longer held by this worker (cancelled or re-queued) "
                               "— stopping its run", job_id)
                lost.set()
                return

    def _run(self, cmd: List[str], env: Mapping[str, str], lost: threading.Event,
             deadline: Optional[float] = None) -> Tuple[Optional[int], List[str], str]:
        """Run ``cmd`` in its own process group, streaming scrubbed output.
        Returns (exit code, output tail, how) where how is exited | lost | stopped
        | timeout (past ``deadline``, a ``time.monotonic()`` instant)."""
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
            elif deadline is not None and time.monotonic() >= deadline:
                how = "timeout"
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
            pass
        # Always, not only when the leader outlived the grace: the leader can exit
        # on SIGTERM and leave an ffmpeg / provider helper of the same group
        # running, which would keep the render slot busy for the next job.
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

    def _finish(self, job: Mapping, status: str, error: Optional[str],
                before: Optional[Callable[[], None]] = None) -> str:
        if before is not None:
            # The hold's settlement, ahead of the row: never raises past here.
            try:
                before()
            except Exception as e:  # noqa: BLE001
                logger.error("job %s: settlement step failed (%s)", job["id"], type(e).__name__)
        if error:
            error = format_error(error, [], self._secrets)
            if status == "failed":
                # A coded prefix the Command Center parses (modules/render_error.py):
                # the customer reads a sentence for the code, the operator keeps
                # the header and log tail that follow it.
                lines = error.splitlines()
                error = render_error.tag(render_error.classify(lines[0], lines[1:]), error)
        # Confirmed only by an explicit True (the row is terminal and ours). None (no answer) and False
        # ("no longer ours": a stale sweep re-queued it while this worker was cut off) both leave the
        # result file in place: the re-queued attempt may need it to see that this run was paid for.
        self._row_unconfirmed = self._with_retries(
            lambda: self.client.finish(job["id"], self.worker_id, status, error)) is not True
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


def _comment_inbox(url: str, key: str, worker_id: str,
                   token_client: Optional["channel_tokens.VaultTokenClient"]) -> "comment_replies.CommentInboxService":
    """The comment inbox (migration 0081) with its real clients: the channel's
    own token (resolved as a render run resolves it), the pipeline's own
    YouTube client for it, and the comment classifier. The model and the
    YouTube client are imported when first used."""
    def client_factory(token_json: str, ctx):
        from modules.youtube_uploader import YouTubeUploader  # noqa: PLC0415 — google libs only when needed

        return YouTubeUploader.from_token_json(token_json, ctx)

    def classifier(comments: list) -> list:
        from modules.comment_intelligence import classify_comments  # noqa: PLC0415

        return classify_comments(comments)

    return comment_replies.CommentInboxService(
        comment_replies.InboxStore(url, key),
        worker_id=worker_id,
        credentials=lambda cid: youtube_publish_credentials(cid, os.environ, token_client),
        client_factory=client_factory,
        classifier=classifier,
        sync_seconds=float(_int_env("NIGHTSHIFT_INBOX_SYNC_SECONDS", int(comment_replies.DEFAULT_SYNC_SECONDS))),
    )


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
    parser.add_argument("--job-timeout-seconds", type=float,
                        default=_int_env("WORKER_JOB_TIMEOUT_SECONDS", DEFAULT_JOB_TIMEOUT_SECONDS),
                        help="Stop a run that has not ended after this long and fail the job")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s queue_worker %(levelname)s %(message)s")
    log_redaction.install()
    if args.job_timeout_seconds < MIN_JOB_TIMEOUT_SECONDS:
        logger.warning("WORKER_JOB_TIMEOUT_SECONDS=%s is below the %ds minimum — using %ds",
                       int(args.job_timeout_seconds), MIN_JOB_TIMEOUT_SECONDS, DEFAULT_JOB_TIMEOUT_SECONDS)
        args.job_timeout_seconds = DEFAULT_JOB_TIMEOUT_SECONDS

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not url or not key:
        logger.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in the worker's env file "
                     "(docs/WORKER_VPS.md) — the queue lives in Supabase.")
        return 2

    token_client = channel_tokens.VaultTokenClient(url, key)
    downloads_dir = os.environ.get("NIGHTSHIFT_DOWNLOADS_DIR", "").strip()
    downloads = (paid_downloads.DownloadService(url, key, output_dir=REPO_DIR / "output",
                                                downloads_dir=Path(downloads_dir), worker_id=args.worker_id)
                 if downloads_dir and os.path.isabs(downloads_dir) else None)
    comments = None
    # OFF by default (BR-L-072): the inbox reads every connected channel's comments and
    # spends YouTube quota and classifier calls, so it runs only where an operator
    # turned it on (and applied migration 0081).
    if os.environ.get("NIGHTSHIFT_COMMENT_INBOX", "off").strip().lower() in ("on", "1", "true", "yes"):
        comments = _comment_inbox(url, key, args.worker_id, token_client)
    visibility = None
    # OFF by default: this is the one step that changes an existing video's privacy. A channel's own switch (default off,
    # set by its administrators) is the second lock; migration 0116 must be applied.
    if visibility_publish.enabled():
        visibility = visibility_publish.VisibilityService(
            url, key, worker_id=args.worker_id,
            credentials=lambda cid: youtube_publish_credentials(cid, os.environ, token_client))
        logger.info("publish when approved: ON (ceiling %s YouTube units a day)", visibility.ceiling)
    worker = Worker(QueueClient(url, key), worker_id=args.worker_id,
                    poll_seconds=args.poll_seconds, stale_minutes=args.stale_minutes,
                    grace_seconds=args.grace_seconds, job_timeout_seconds=args.job_timeout_seconds,
                    credits=credit_rules.CreditsRest(url, key),
                    token_client=token_client,
                    publisher=social_publish.SocialPublisher(
                        url, key, output_dir=REPO_DIR / "output", worker_id=args.worker_id,
                        youtube_credentials=lambda cid: youtube_publish_credentials(
                            cid, os.environ, token_client)),
                    downloads=downloads,
                    cost_mirror=_cost_mirror(url, key),
                    repurposer=repurpose.RepurposeService(url, key, output_dir=REPO_DIR / "output",
                                                          worker_id=args.worker_id),
                    comments=comments,
                    visibility=visibility)
    worker.install_signal_handlers()
    logger.info("worker %s started (poll %ss, stale after %s min, stop grace %ss, job limit %ss; a customer "
                "organization's job runs only on its own open hold)",
                args.worker_id, args.poll_seconds, args.stale_minutes, int(args.grace_seconds),
                int(args.job_timeout_seconds))
    return worker.run_forever(once=args.once)


if __name__ == "__main__":
    raise SystemExit(main())

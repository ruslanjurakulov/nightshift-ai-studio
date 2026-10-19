"""Reliability alerts: silence is an incident.

The operator bot already says when something FAILS (a render job, a deploy, a
worker). This module covers what it could not see: the day nothing happened at
all, and the problems that only show when a run starts.

* **Dead-man switch.** A channel the scheduler runs (ACTIVE, schedule enabled,
  verified, the operator's own, the same filter as ``tools/list_channels.py``)
  has a slot at its ``publish_hour_utc`` (15 when unset, as the scheduler does).
  If by slot + grace hours (``OPERATOR_DEADMAN_HOURS``, default 3, or the channel's
  own ``schedule_config.deadman_grace_hours``) there is no video row, held row or run
  event for it since the slot, one alert says so and names the likeliest cause from
  the GitHub run list: the workflow never started, it failed, it ended with
  nothing, or it is stuck queued. A run that is still in progress is not silence.
* **The daily workflow itself.** A failed scheduled run or manual dispatch of
  ``daily_video.yml`` (which jobs, at which step: workflow names, never a log).
* **Per video.** A video the publish gate blocked, a failed upload, and (as
  information) a video held for review. Operator channels only.
* **Scheduled readiness check.** ``tools/doctor_report.py`` (workflow
  ``doctor_scheduled.yml``) records the doctor's failing checks as an
  ``operator.doctor`` row; each failing check is an alert, and a check that stops
  reporting is one too.
* **Providers.** A balance snapshot that has stopped refreshing (a rejected key
  or a dead schedule) and a balance at zero.
* **Recovered.** An alert that was delivered and whose condition has cleared is
  followed once by an information note.

The restraint is the engine's (modules/operator_bot/alerts.py): every alert has a
stable key that ends in the UTC date, so it is one alert per cause per channel per
day, de-duplicated across restarts through the alert feed, rate limited, held in
quiet hours and silenced by a mute. This module only DECIDES; it reads, it never
starts, retries, repairs or spends anything.

What it says is built from channel ids, video ids, UTC times, counts and fixed
words, never a title, script, prompt, token, key or person. A source that cannot
answer is an unknown, which is silent here (the /health view says why), because an
unreadable table is not an incident and an unknown must never read as "missing"
(CLAUDE.md #5). Every detector is fail-safe: a bug in one logs once and costs the
others nothing.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Optional

from modules.operator_bot import analysis
from modules.operator_bot.i18n import Raw, t
from modules.operator_bot.sources import OperatorSources, Section, age_label, parse_ts
from modules.tg_text import safe_id

logger = logging.getLogger(__name__)

#: The slot of a channel with no ``publish_hour_utc``: the scheduler's own default
#: (tools/list_channels.DEFAULT_HOUR_UTC; a test pins that they agree).
DEFAULT_HOUR_UTC = 15
#: How far back the evidence is read. Two slots plus the grace, with room.
LOOKBACK = timedelta(hours=48)
#: A video, upload or workflow failure is news for this long (alerts.EVENT_WINDOW).
EVENT_WINDOW = timedelta(hours=12)
#: A run that has been "in progress" longer than a channel's whole job timeout (60 minutes) plus a second
#: channel queued behind it is hung, not working: it no longer excuses silence.
INPROGRESS_MAX = timedelta(hours=4)
#: How many failed runs get their jobs looked up in one pass.
MAX_JOB_LOOKUPS = 3
#: The scheduled readiness check reports every six hours; this long without a report is a dead check.
DOCTOR_STALE = timedelta(hours=30)
DOCTOR_WINDOW = timedelta(days=7)
#: A balance snapshot is refreshed every six hours (provider_balances.yml); this long without one is a
#: problem, and past a week it is a provider that was retired on purpose, which is not worth a daily ping.
PROVIDER_STALE = timedelta(hours=30)
PROVIDER_RETIRED = timedelta(days=7)

RUN_FAILED = ("failure", "timed_out", "startup_failure")
RUN_LIVE = ("in_progress",)
RUN_WAITING = ("queued", "waiting", "pending", "requested")
RUN_EVENTS_OK = ("schedule", "workflow_dispatch")

_JOB_CHANNEL = re.compile(r"^make-video \(([a-z0-9][a-z0-9-]{1,38})\)$")
_SLUG = re.compile(r"[^a-z0-9]+")
_KEY_DATE = re.compile(r":(\d{4}-\d{2}-\d{2})$")

_logged: set = set()


def _once(name: str, e: BaseException) -> None:
    """Log a detector's failure once per process: the pass runs every few minutes, and the same bug
    repeated every time would bury the one line that matters."""
    if name not in _logged:
        _logged.add(name)
        logger.warning("reliability: %s skipped (%s)", name, type(e).__name__)


def _guard(name: str, fn: Callable, *args):
    """A detector's alerts, or nothing when it fails. Never raises."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 - one broken detector must not silence the others
        _once(name, e)
        return []


def _alert(*args, **kw):
    from modules.operator_bot.alerts import Alert  # noqa: PLC0415 - alerts imports this module

    return Alert(*args, **kw)


# -- what is verdict-tracked, for the "recovered" note --------------------------------------

def family(key: str) -> str:
    """An alert key without its trailing UTC date: the condition itself, which outlives a day."""
    return _KEY_DATE.sub("", key)


@dataclass
class Sweep:
    """One reading that judges every condition under a key prefix at once (the readiness check, a balance
    table). ``bad`` are the families still bad. ``fine`` are the families PROVEN fine, or None when the reading
    is complete (then everything not bad is fine): a table that no longer lists a provider has not proven it
    fine, so its sweep names the ones it saw."""

    prefix: str
    kind: str
    note: Callable
    bad: set = field(default_factory=set)
    fine: Optional[set] = None

    def recovered(self, key: str) -> bool:
        fam = family(key)
        return key.startswith(self.prefix) and fam not in self.bad and (self.fine is None or fam in self.fine)


@dataclass
class Verdicts:
    """What this pass could judge, so the engine can follow an earlier alert with a note.

    ``fine`` holds alert keys whose condition was judged and is fine now; ``sweeps`` judges whole key
    prefixes (see :class:`Sweep`). A condition neither judged nor swept is an unknown and is never called
    recovered."""

    fine: dict = field(default_factory=dict)       # key -> (kind, channel_id, note line)
    sweeps: list = field(default_factory=list)     # of Sweep


def recoveries(state, verdicts: Verdicts) -> list:
    """One information note for each condition whose alert was DELIVERED and has cleared. Only the newest
    delivered alert of a condition counts (a failure that lasted three days is one recovery, not three), the
    note is a one-off key (``ok:<key>``) so it is said once, and an alert that was only marked as seen
    (muted, or the first run's baseline) gets no note, because the owner was never told it was broken."""
    newest: dict = {}
    for at, key, _kind, delivered, _sev in state.alerts:
        if delivered and not key.startswith("ok:"):
            fam = family(key)
            if fam not in newest or at > newest[fam][0]:
                newest[fam] = (at, key)
    out = []
    for _fam, (_at, key) in sorted(newest.items()):
        ok_key = f"ok:{key}"
        if state.last_seen(ok_key) is not None:
            continue
        hit = verdicts.fine.get(key)
        if hit is not None:
            out.append(_alert(hit[0], ok_key, "info", hit[2], hit[1]))
            continue
        for sweep in verdicts.sweeps:
            if sweep.recovered(key):
                out.append(_alert(sweep.kind, ok_key, "info", sweep.note(key)))
                break
    return out


# -- the schedule: which channels, when -----------------------------------------------------

@dataclass(frozen=True)
class Scheduled:
    channel_id: str
    hour: int
    grace_h: Optional[int]               # the channel's own override, None = the configured default
    anchor: Optional[datetime]           # when the row was created or last edited


def scheduled_channels(rows) -> list:
    """The channels the scheduler would run: ``tools/list_channels.due_channels`` without the fallback. The
    judgement itself is the registry's (ChannelContext.is_runnable and is_operators), so the dead-man and the
    schedule cannot disagree about what is scheduled. A row the registry would skip is skipped.

    One deliberate difference: with NO channel rows the scheduler falls back to the default channel; here
    there is nothing to judge, because an empty table is an unknown, not a schedule."""
    from modules.channels import ChannelContext  # noqa: PLC0415

    out = []
    for row in rows or []:
        try:
            ctx = ChannelContext.from_dict(dict(row))
        except Exception:  # noqa: BLE001 - a malformed row is skipped, as the registry does
            continue
        if not (ctx.is_runnable and ctx.is_operators):
            continue
        hour = ctx.schedule.publish_hour_utc
        raw = (row.get("schedule_config") or {}).get("deadman_grace_hours") if isinstance(row.get("schedule_config"), dict) else None
        grace = raw if isinstance(raw, int) and not isinstance(raw, bool) and 1 <= raw <= 12 else None
        stamps = [x for x in (parse_ts(ctx.created_at), parse_ts(ctx.updated_at)) if x]
        out.append(Scheduled(str(ctx.channel_id), DEFAULT_HOUR_UTC if hour is None else hour, grace,
                             max(stamps) if stamps else None))
    return out


def slot_start(day: date, hour: int) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc)


def slot_label(day: date, hour: int) -> str:
    return f"{day.isoformat()} {hour:02d}:00"


def _utc(now: datetime) -> datetime:
    return now.astimezone(timezone.utc)


# -- one pass's reads, shared by every detector ---------------------------------------------

class Evidence:
    """The reads the dead-man, the per-video alerts and the digest line share, taken once per pass.

    Three kinds of evidence that a channel's slot was worked, in the order they can be trusted: ``videos`` (a
    made, held or blocked row, written by the run itself), ``storyboards`` (a run that stopped for a person) and
    ``events`` (the run's own log, which reaches Supabase only when the daily intelligence poll mirrors it, so it
    can rescue a verdict but never prove a run did not happen).

    ``known`` is False when evidence cannot be proven absent: a source failed, or a read hit its row limit
    and the oldest rows (the ones nearest a slot) may have been cut. Then "no evidence" means "unknown"."""

    def __init__(self, ops: OperatorSources, now: datetime):
        self.ops, self.now = ops, now
        self.channels = ops.channels()
        self.sched = scheduled_channels(self.channels.data) if self.channels.ok else []
        ids = [c.channel_id for c in self.sched]
        since = now - LOOKBACK
        empty = Section(True, [])
        self.videos: Section = ops.recent_videos(since, ids) if ids else empty
        self.storyboards: Section = ops.recent_storyboards(since, ids) if ids else empty
        self.events: Section = ops.run_events(since, ids) if ids else empty
        self._runs: Optional[Section] = None
        self.known = bool(self.channels.ok and all(s.ok and not s.cap for s in (self.videos, self.storyboards, self.events)))

    @property
    def runs(self) -> Section:
        """The daily workflow's run list, asked for only when a verdict needs it."""
        if self._runs is None:
            self._runs = self.ops.daily_video_runs()
        return self._runs

    def _times(self, sec: Section, channel_id: str, *fields: str) -> list:
        out = []
        for r in (sec.data or []) if sec.ok else []:
            if r.get("channel_id") == channel_id:
                out += [x for x in (parse_ts(r.get(f)) for f in fields) if x]
        return out

    def made(self, channel_id: str) -> list:
        """When a video was made, held or blocked (a row of its own): the slot's product."""
        return self._times(self.videos, channel_id, "published_at", "held_at")

    def produced(self, channel_id: str) -> list:
        """When the slot was visibly worked: a video row, or a storyboard waiting for a person."""
        return self.made(channel_id) + self._times(self.storyboards, channel_id, "created_at")

    def stamps(self, channel_id: str) -> list:
        """Every sign of life: produced, plus the run's own events (late as they are)."""
        return self.produced(channel_id) + self._times(self.events, channel_id, "ts")


def due(ch: "Scheduled", start: datetime, stamps: list) -> bool:
    """Was this slot ever expected of the channel? Not when it has never produced anything and was created or
    switched on after the slot began (its first run is the next slot, not one that already passed)."""
    return not (ch.anchor is not None and ch.anchor > start and not stamps)


def _run_view(runs: Section, start: datetime, now: datetime) -> tuple:
    """(state, run) of the daily workflow since a slot: ``unknown`` (could not read), ``none`` (no run
    started), ``live`` (a job is running), ``waiting`` (queued, nothing running), ``failed``, ``empty`` (it
    ended without failing). Only scheduled runs and dispatches count; a run on a feature branch that someone
    dispatched is a run too, which is the point."""
    if not runs.ok:
        return "unknown", None
    mine = []
    for r in runs.data or []:
        made = parse_ts(r.get("created_at"))
        if r.get("event") in RUN_EVENTS_OK and made is not None and made >= start - timedelta(minutes=5):
            mine.append((made, r))
    if not mine:
        return "none", None
    mine.sort(key=lambda x: x[0], reverse=True)
    live = [r for _m, r in mine if r.get("status") in RUN_LIVE
            and now - (parse_ts(r.get("started_at")) or now) < INPROGRESS_MAX]
    if live:
        return "live", live[0]
    waiting = [r for _m, r in mine if r.get("status") in RUN_WAITING]
    if waiting:
        return "waiting", waiting[0]
    latest = mine[0][1]
    return ("failed" if latest.get("conclusion") in RUN_FAILED else "empty"), latest


# -- the dead-man switch --------------------------------------------------------------------

def deadman(ev: Evidence, grace_default: Optional[int], lang: str, verdicts: Verdicts) -> list:
    if grace_default is None or not ev.sched:
        return []
    now = _utc(ev.now)
    out = []
    for ch in ev.sched:
        stamps, produced = ev.stamps(ch.channel_id), ev.produced(ch.channel_id)
        grace = ch.grace_h or grace_default
        for day in (now.date(), now.date() - timedelta(days=1)):
            start = slot_start(day, ch.hour)
            end = start + timedelta(days=1)        # the next slot's own output is not this slot's
            deadline = start + timedelta(hours=grace)
            if now < deadline:
                continue
            key = f"deadman:{ch.channel_id}:{day.isoformat()}"
            label = slot_label(day, ch.hour)
            if any(start <= s < end for s in produced):
                verdicts.fine[key] = ("pipeline", ch.channel_id,
                                      t(lang, "alert.deadman_ok", channel=ch.channel_id, slot=label))
                continue
            # Only the run's own events: they say a run began, which silences the alarm, but not that a video
            # exists, so they never earn a "recovered" note.
            if any(start <= s < end for s in stamps) or not due(ch, start, stamps):
                continue
            if not ev.known:
                continue                 # evidence cannot be proven absent: an unknown, not silence
            state, run = _run_view(ev.runs, start, now)
            if state == "live":
                continue                 # a run is working on it; the deadline of a hung one is INPROGRESS_MAX
            hint = t(lang, f"alert.deadman_hint_{state}",
                     conclusion=safe_id((run or {}).get("conclusion"), 20) or "?",
                     number=safe_id((run or {}).get("number"), 12) or "?")
            out.append(_alert("pipeline", key, "warn",
                              t(lang, "alert.deadman", channel=ch.channel_id, slot=label, grace=grace,
                                hint=Raw(hint)), ch.channel_id))
    return out


# -- the daily workflow ---------------------------------------------------------------------

def workflow_failures(ev: Evidence, lang: str) -> list:
    if not ev.runs.ok:
        return []
    now, out, lookups = _utc(ev.now), [], 0
    failed = []
    for r in ev.runs.data or []:
        done = parse_ts(r.get("updated_at"))
        if (r.get("event") in RUN_EVENTS_OK and r.get("status") == "completed" and r.get("conclusion") in RUN_FAILED
                and done is not None and now - EVENT_WINDOW <= done <= now + timedelta(minutes=5)):
            failed.append(r)
    for r in sorted(failed, key=lambda x: str(x.get("created_at")), reverse=True):
        rid = safe_id(r.get("id"), 20)
        if not rid:
            continue
        where, chans, step = [], [], None
        if lookups < MAX_JOB_LOOKUPS:
            lookups += 1
            jobs = ev.ops.run_jobs(r.get("id"))
            if jobs.ok:
                for j in jobs.data or []:
                    if j.get("conclusion") in ("failure", "timed_out"):
                        m = _JOB_CHANNEL.match(str(j.get("name") or ""))
                        if m:
                            chans.append(m.group(1))
                        where.append(m.group(1) if m else words(j.get("name"), 24) or "?")
                        step = step or words(j.get("step"), 60) or None
        common = dict(number=safe_id(r.get("number"), 12) or rid, event=safe_id(r.get("event"), 20),
                      conclusion=safe_id(r.get("conclusion"), 20), sha=safe_id(r.get("sha"), 7))
        if where:
            line = t(lang, "alert.run_failed", jobs=", ".join(dict.fromkeys(where)), step=step or "?", **common)
        else:
            line = t(lang, "alert.run_failed_nojobs", **common)
        out.append(_alert("pipeline", f"wf:daily:{rid}", "warn", line,
                          chans[0] if len(set(chans)) == 1 and len(where) == 1 else None))
    return out


def words(value, limit: int) -> str:
    """A workflow's own job or step name (fixed text in the repository's YAML) made safe to print."""
    return re.sub(r"[^A-Za-z0-9 ._()/-]", "", "" if value is None else str(value)).strip()[:limit]


# -- one video ------------------------------------------------------------------------------

def video_alerts(ev: Evidence, lang: str) -> list:
    """A video the publish gate blocked, one whose upload failed, one held for review: operator channels only
    (the registry the scheduler uses). All three come from the video's own row, which the run writes the moment
    it ends, not from the event log, which is mirrored a day late. A failed upload does not fail the workflow
    (the render exists, so the run ends green with a held row whose cause says so): this is the only place it is
    heard. Held is information and goes under the ``approval`` kind (a person is to look); the others are problems
    of the pipeline. A row that was held and was later uploaded is not held any more."""
    if not ev.sched or not ev.videos.ok:
        return []
    mine = {c.channel_id for c in ev.sched}
    now, out = _utc(ev.now), []
    for r in ev.videos.data or []:
        ch, state, held = r.get("channel_id"), r.get("publish_state"), parse_ts(r.get("held_at"))
        vid = safe_id(r.get("video_id"), 24)
        if ch not in mine or not vid or held is None or parse_ts(r.get("published_at")) is not None:
            continue
        if not now - EVENT_WINDOW <= held <= now + timedelta(minutes=5):
            continue
        stamp = f"{vid}:{int(held.timestamp())}"
        if state == "blocked":
            out.append(_alert("pipeline", f"video:blocked:{stamp}", "warn",
                              t(lang, "alert.video_blocked", channel=safe_id(ch), video=vid), ch))
        elif state == "held" and r.get("hold_cause") == "upload_failed":
            out.append(_alert("pipeline", f"video:upload_failed:{stamp}", "warn",
                              t(lang, "alert.video_upload_failed", channel=safe_id(ch), video=vid), ch))
        elif state == "held":
            out.append(_alert("approval", f"video:held:{stamp}", "info",
                              t(lang, "alert.video_held", channel=safe_id(ch), video=vid), ch))
    return out


# -- the scheduled readiness check ----------------------------------------------------------

def check_slug(name: str) -> str:
    """A failing check's name reduced to a key-safe slug (``providers/elevenlabs`` -> ``providers-elevenlabs``)."""
    return _SLUG.sub("-", str(name or "").lower()).strip("-")[:48]


def doctor_alerts(ops: OperatorSources, now: datetime, lang: str, verdicts: Verdicts) -> list:
    sec = ops.doctor_results(now - DOCTOR_WINDOW)
    rows = [(parse_ts(r.get("at")), r) for r in (sec.data or [])] if sec.ok else []
    rows = sorted([(a, r) for a, r in rows if a is not None and a <= now + timedelta(minutes=5)],
                  key=lambda x: x[0], reverse=True)
    if not rows:
        return []                        # the check never reported (not set up yet) or cannot be read: silent
    at, latest = rows[0]
    today = _utc(now).date().isoformat()
    out, stale_key = [], f"doctor:stale:{today}"
    stale_note = lambda k: t(lang, "alert.doctor_stale_ok")  # noqa: E731
    if now - at > DOCTOR_STALE:
        out.append(_alert("health", stale_key, "warn", t(lang, "alert.doctor_stale", age=age_label(at, now))))
        verdicts.sweeps.append(Sweep("doctor:stale:", "health", stale_note, {family(stale_key)}))
        return out                       # an old verdict says nothing about today
    verdicts.sweeps.append(Sweep("doctor:stale:", "health", stale_note))
    failing = []
    if str(latest.get("title") or "").lower() == "fail":
        failing = [check_slug(x) for x in str(latest.get("body") or "").split(",")]
        failing = [x for x in dict.fromkeys(failing) if x][:10]
    bad = set()
    for slug in failing:
        key = f"doctor:check:{slug}:{today}"
        bad.add(family(key))
        out.append(_alert("health", key, "warn", t(lang, "alert.doctor_fail", check=slug)))
    verdicts.sweeps.append(Sweep("doctor:check:", "health", lambda k: t(
        lang, "alert.doctor_ok", check=family(k).split(":")[2]), bad))
    return out


# -- providers ------------------------------------------------------------------------------

def provider_alerts(ops: OperatorSources, now: datetime, low_credits: float, lang: str, verdicts: Verdicts) -> list:
    bal = ops.balances()
    if not bal.ok:
        return []
    today, out = _utc(now).date().isoformat(), []
    newest: dict = {}
    for r in bal.data or []:
        at = parse_ts(r.get("checked_at"))
        prov = safe_id(r.get("provider"), 24)
        if prov and at is not None:
            newest[prov] = max(newest.get(prov, at), at)
    stale_bad, stale_fine = set(), set()
    for prov, at in newest.items():
        key = f"provider:stale:{prov}:{today}"
        if now - at <= PROVIDER_STALE:
            stale_fine.add(family(key))
            continue
        stale_bad.add(family(key))
        if now - at <= PROVIDER_RETIRED:
            out.append(_alert("health", key, "warn", t(lang, "alert.provider_stale", provider=prov,
                                                        age=age_label(at, now))))
    verdicts.sweeps.append(Sweep("provider:stale:", "health", lambda k: t(
        lang, "alert.provider_stale_ok", provider=family(k).split(":")[2]), stale_bad, stale_fine))
    zero_bad, zero_fine = set(), set()
    for r in analysis.balance_flags(bal.data, low_credits):
        left, prov, metric = r.get("remaining_n"), safe_id(r.get("provider"), 24), safe_id(r.get("metric"), 24)
        if not prov or left is None:
            continue
        key = f"provider:zero:{prov}:{metric}:{today}"
        if left > 0:
            zero_fine.add(family(key))
        elif not r["low"]:               # an ElevenLabs zero is already the "low" alert
            zero_bad.add(family(key))
            out.append(_alert("balance", key, "warn", t(lang, "alert.provider_zero", provider=prov, metric=metric)))
    verdicts.sweeps.append(Sweep("provider:zero:", "balance", lambda k: t(
        lang, "alert.provider_zero_ok", provider=family(k).split(":")[2]), zero_bad, zero_fine))
    return out


# -- the entry point detect() calls ---------------------------------------------------------

def detect(ops: OperatorSources, now: datetime, low_credits: float, lang: str, verdicts: Verdicts) -> list:
    """Every reliability alert that applies now. Each detector is guarded on its own."""
    out: list = []
    ev = _guard("evidence", Evidence, ops, now)
    if isinstance(ev, Evidence):
        out += _guard("deadman", deadman, ev, ops.cfg.deadman_hours, lang, verdicts)
        out += _guard("workflow", workflow_failures, ev, lang)
        out += _guard("videos", video_alerts, ev, lang)
    out += _guard("doctor", doctor_alerts, ops, now, lang, verdicts)
    out += _guard("providers", provider_alerts, ops, now, low_credits, lang, verdicts)
    return out


# -- the digest line: expected against made, per channel and day ----------------------------

def digest_lines(ops: OperatorSources, lang: str) -> list:
    """One line per scheduled channel: videos made against the one a day it is scheduled for, for yesterday
    and today (UTC, the day a slot belongs to). [] when nothing is scheduled; an unknown is said as unknown."""
    try:
        now = _utc(ops.now())
        ev = Evidence(ops, now)
        if not ev.channels.ok:
            return [t(lang, "digest.expected_unknown", why=_why(lang, ev.channels))]
        if not ev.sched:
            return []
        if not (ev.videos.ok and ev.events.ok):
            return [t(lang, "digest.expected_unknown", why=_why(lang, ev.videos if not ev.videos.ok else ev.events))]
        grace = ops.cfg.deadman_hours if ops.cfg.deadman_hours is not None else 3
        out = []
        for ch in ev.sched:
            cells = [_cell(lang, ev, ch, day, now, ch.grace_h or grace)
                     for day in (now.date() - timedelta(days=1), now.date())]
            out.append(t(lang, "digest.expected", channel=safe_id(ch.channel_id), yesterday=Raw(cells[0]),
                         today=Raw(cells[1])))
        return out
    except Exception as e:  # noqa: BLE001 - a digest line must not break the digest
        _once("digest", e)
        return []


def _why(lang: str, sec: Section) -> Raw:
    from modules.operator_bot import views  # noqa: PLC0415 - views imports this module

    return views.unknown(lang, sec)


def _cell(lang: str, ev: Evidence, ch: Scheduled, day: date, now: datetime, grace: int) -> str:
    """One day's verdict for one channel. The day is the SLOT's day: from the slot to the next one."""
    start = slot_start(day, ch.hour)
    end = start + timedelta(days=1)
    in_slot = lambda s: s is not None and start <= s < end  # noqa: E731
    made = {r.get("video_id") for r in (ev.videos.data or [])
            if r.get("channel_id") == ch.channel_id
            and any(in_slot(s) for s in (parse_ts(r.get("published_at")), parse_ts(r.get("held_at"))))}
    stamps = ev.stamps(ch.channel_id)             # a storyboard or a run event is a run, not a video
    want = 1
    if not due(ch, start, stamps):
        return t(lang, "rel.cell_none")
    if made:
        return t(lang, "rel.cell", made=len(made), want=want)
    if now < start + timedelta(hours=grace):
        return t(lang, "rel.cell_due", made=0, want=want, hour=f"{ch.hour:02d}")
    if any(in_slot(s) for s in stamps):
        return t(lang, "rel.cell_ran", made=0, want=want)
    return t(lang, "rel.cell_missing", made=0, want=want) if ev.known else t(lang, "rel.cell_unknown")

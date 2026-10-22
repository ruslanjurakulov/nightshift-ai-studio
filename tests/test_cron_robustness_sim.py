"""A simulated stretch of days against GitHub's best-effort cron: what the scheduled run promises.

GitHub does not promise that a cron tick fires, or when. The repo's own history (268 scheduled runs over
seven weeks of an hourly cron) shows about one tick in four delivered, at random minutes, with gaps of up to a
day. ``daily_video.yml`` therefore ticks several times an hour, and the resolver, the concurrency group and the
guard in the run have to keep two promises however the ticks land:

* **At most once.** A channel's slot is never run again after it produced a video, and two runs of one slot never
  overlap. (A run that died before it wrote any row is retried by design; that is the only repeat.)
* **At least once when it can be.** If a tick lands anywhere in ``[slot, slot + window + 1h)``, which is the hours
  ``NIGHTSHIFT_CATCHUP_HOURS`` allows, the slot is run (readable evidence assumed).

The simulation drives the REAL ``tools.list_channels.due_channels`` (the resolver) and ``tools.slot_guard.decide``
(the guard in the run) over a fake clock. Only GitHub is modelled: tick delivery (drops, delays), the job queue
of a concurrency group (one running, one pending, a newer pending replaces an older one, nothing running is ever
cancelled) and a run that either writes its video row when it ends or dies without one. Nothing here touches the
network, Supabase, a provider or a real run.

The last class is the proof that the checks have teeth: with the guard replaced by "always go", or with the
concurrency group taken away, the same invariants are found broken.
"""

from __future__ import annotations

import contextlib
import heapq
import io
import logging
import os
import random
import unittest
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from unittest import mock

from modules import schedule_catchup
from modules.operator_bot.reliability import Scheduled
from tests.test_schedule_catchup import chan, registry
from tools import list_channels, slot_guard

UTC = timezone.utc
D0 = datetime(2026, 10, 20, tzinfo=UTC)
PRIMARY = schedule_catchup.PRIMARY_CRON
BACKUP = "15,30,45 * * * *"
MINUTES = {PRIMARY: (0,), BACKUP: (15, 30, 45)}
WINDOW = 3


@dataclass
class Job:
    channel: str
    slot_start: datetime
    catchup: bool
    created: datetime
    cron: str = ""
    cancelled: bool = False
    started: datetime | None = None
    guard_unreadable: bool = False
    went: bool = False


class SimEvidence:
    """The dead-man switch's ``Evidence`` as the scheduler reads it, over the simulated database at one instant:
    ``stamps`` (what is visible so far), ``known`` and ``sched``. An ``outage`` hides everything and is unknown."""

    def __init__(self, world, now, outage=False):
        self.known = not outage
        self.sched = [Scheduled(c["channel_id"], c["schedule_config"]["publish_hour_utc"], None, None)
                      for c in world.channel_rows]
        self._stamps = {} if outage else {
            c["channel_id"]: [t for ch, t in world.videos if ch == c["channel_id"] and t <= now]
            for c in world.channel_rows}

    def stamps(self, channel_id):
        return list(self._stamps.get(channel_id, []))


class SimSync:
    """The slice of Supabase the scheduler touches for attempts: ``insert_new`` (atomic, ignore-duplicates on the key)
    and a ``select_strict`` over ``system_events``. ``outage`` makes every call fail the way the real client does."""

    enabled = True

    def __init__(self, world, outage):
        self.world, self.outage = world, outage

    def insert_new(self, table, rows, on_conflict):
        if self.outage or table != "system_events":
            return None
        out = []
        for r in rows:
            if r[on_conflict] not in self.world.attempt_rows:
                self.world.attempt_rows[r[on_conflict]] = dict(r)
                out.append(dict(r))
        return out

    def select_strict(self, table, params=None):
        from modules.supabase_sync import SupabaseReadError

        if self.outage:
            raise SupabaseReadError(table, 503, "down")
        if table != "system_events":
            return []
        rows = [r for r in self.world.attempt_rows.values() if r["event"] == (params or {}).get("event", "")[3:]]
        limit = int((params or {}).get("limit") or 0)
        return rows[:limit] if limit else rows


class World:
    """One simulation. ``ticks`` is a list of ``(when, cron)``; ``random_ticks`` builds them from the workflow's
    crons with drops and delays. ``serialize`` False removes the concurrency group, ``guard`` replaces the guard."""

    def __init__(self, channel_rows, ticks, *, seed=0, run_minutes=(20, 50), setup_minutes=(3, 8), p_fail=0.0,
                 p_outage=0.0, serialize=True, guard=None, window=WINDOW, cap=None):
        self.channel_rows = channel_rows
        self.registry = registry(*channel_rows)
        self.rng = random.Random(seed)
        self.run_minutes, self.setup_minutes = run_minutes, setup_minutes
        self.p_fail, self.p_outage, self.serialize, self.window = p_fail, p_outage, serialize, window
        self.cap = cap
        self.guard = guard or slot_guard.decide
        self.videos = []                       # (channel, when its row became visible)
        self.attempt_rows = {}                 # event_key -> row: the durable "a scheduled run started" records
        self.starts = {}                       # (channel, slot_start) -> [(start, end or None, ok)]
        self.groups = {}                       # (channel, slot date) -> {"running": Job|None, "pending": Job|None}
        self.jobs = []
        self.queue, self.seq = [], 0
        self.delivered = []                    # (when, cron)
        for when, cron in sorted(ticks):
            self.delivered.append((when, cron))
            self.push(when, "tick", cron)

    def push(self, when, kind, payload):
        self.seq += 1
        heapq.heappush(self.queue, (when, self.seq, kind, payload))

    def between(self, lo_min, hi_min):
        return timedelta(minutes=self.rng.randint(lo_min, hi_min))

    # -- the event loop ---------------------------------------------------------------------

    def run(self):
        clean = {k: v for k, v in os.environ.items()
                 if k not in (list_channels.PAUSE_ENV, schedule_catchup.CATCHUP_ENV)}
        clean[schedule_catchup.CATCHUP_ENV] = str(self.window)
        clean.pop(schedule_catchup.ATTEMPT_ENV, None)
        if self.cap is not None:
            clean[schedule_catchup.ATTEMPT_ENV] = str(self.cap)
        logging.disable(logging.CRITICAL)
        try:
            with mock.patch.dict(os.environ, clean, clear=True), contextlib.redirect_stderr(io.StringIO()), \
                    contextlib.redirect_stdout(io.StringIO()):
                while self.queue:
                    when, _, kind, payload = heapq.heappop(self.queue)
                    getattr(self, f"on_{kind}")(when, payload)
        finally:
            logging.disable(logging.NOTSET)
        return self

    def io(self, now):
        """What one resolver or guard call can read and write at ``now``: the evidence and the attempts, both gone
        together in an outage (they are the same database)."""
        outage = self.rng.random() < self.p_outage
        return SimEvidence(self, now, outage=outage), SimSync(self, outage)

    def on_tick(self, now, cron):
        ev, sync = self.io(now)
        rows = list_channels.due_channels(now.hour, registry=self.registry, now=now, evidence=ev, evidence_sync=sync,
                                          backup_tick=schedule_catchup.is_backup_tick(cron))
        for r in rows:
            start = datetime.strptime(r["slot_start"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
            assert r["slot_date"] == start.strftime("%Y-%m-%d")
            job = Job(r["channel_id"], start, bool(r["catchup"]), now, cron)
            self.jobs.append(job)
            if not self.serialize:
                self.begin(job, now)
                continue
            g = self.groups.setdefault((job.channel, r["slot_date"]), {"running": None, "pending": None})
            if g["running"] is None:
                g["running"] = job
                self.begin(job, now)
            else:
                if g["pending"] is not None:
                    g["pending"].cancelled = True          # GitHub keeps ONE pending job; a newer one replaces it
                g["pending"] = job

    def begin(self, job, now):
        job.started = now
        self.push(now + self.between(*self.setup_minutes), "guard", job)

    def on_guard(self, now, job):
        ev, sync = self.io(now)
        job.guard_unreadable = not ev.known
        rc = self.guard(job.channel, job.slot_start.strftime("%Y-%m-%dT%H:%M:%SZ"), job.catchup,
                        sync=sync, evidence=ev, now=now, registry=self.registry)
        if rc != slot_guard.GO:
            self.push(now + timedelta(minutes=1), "end", (job, None, now))
            return
        job.went = True
        ok = self.rng.random() >= self.p_fail
        end = now + self.between(*self.run_minutes)
        self.starts.setdefault((job.channel, job.slot_start), []).append([now, None, ok])
        self.push(end, "end", (job, ok, now))

    def on_end(self, now, payload):
        job, ok, began = payload
        if ok is not None:
            for s in self.starts[(job.channel, job.slot_start)]:
                if s[0] == began and s[1] is None:
                    s[1] = now
            if ok:
                self.videos.append((job.channel, now))   # the run writes its row the moment it ends
        if not self.serialize:
            return
        g = self.groups[(job.channel, job.slot_start.strftime("%Y-%m-%d"))]
        g["running"] = None
        if g["pending"] is not None:
            nxt, g["pending"] = g["pending"], None
            g["running"] = nxt
            self.begin(nxt, now)


# -- what the promises mean, as checks on a finished World ---------------------------------------------

def slots(world, days):
    return [(c["channel_id"], D0 + timedelta(days=d, hours=c["schedule_config"]["publish_hour_utc"]))
            for c in world.channel_rows for d in range(days)]


def repeats(world):
    """Every way a slot ran twice that it should not: a run that began after the slot already had its video, or one
    that began while another run of the same slot was still going."""
    bad = []
    for key, runs in world.starts.items():
        runs = sorted(runs, key=lambda r: r[0])
        done = [r[1] for r in runs if r[2] and r[1] is not None]
        first_done = min(done) if done else None
        for i, (began, ended, ok) in enumerate(runs):
            if first_done is not None and began >= first_done:
                bad.append((key, "started after the slot's video existed", began))
            if i and runs[i - 1][1] is not None and began < runs[i - 1][1]:
                bad.append((key, "overlapped the run before it", began))
            if i and runs[i - 1][1] is None:
                bad.append((key, "started while the run before it never ended", began))
    return bad


def over_cap(world, cap=2):
    """Slots that started the pipeline more often than the cap, not counting a start the original tick made on a
    source it could not read (its documented fail-open, which cannot claim an attempt either)."""
    return [(key, len(runs)) for key, runs in world.starts.items() if len(runs) > cap]


def missed(world, days):
    """Slots that had a tick land in ``[slot, slot + window + 1h)`` and still never ran."""
    window, out = world.window, []
    for cid, start in slots(world, days):
        landed = any(start <= when < start + timedelta(hours=window + 1) for when, _ in world.delivered)
        if landed and not world.starts.get((cid, start)):
            out.append((cid, start))
    return out


def random_ticks(rng, days, crons, p_drop, max_delay_min):
    """GitHub's side: every cron match is a tick that is dropped with ``p_drop``, else delayed up to
    ``max_delay_min`` minutes. ``days`` full days after D0, plus one so the last window can close."""
    ticks = []
    for d in range(days + 1):
        for h in range(24):
            for cron in crons:
                for m in MINUTES[cron]:
                    if rng.random() >= p_drop:
                        ticks.append((D0 + timedelta(days=d, hours=h, minutes=m + rng.randint(0, max_delay_min)),
                                      cron))
    return ticks


CHANNELS = [chan("default", hour=22), chan("shop", hour=15), chan("night", hour=3)]


def simulate(seed, *, days=3, crons=(PRIMARY, BACKUP), p_drop=0.5, max_delay=120, **kw):
    ticks = random_ticks(random.Random(seed), days, crons, p_drop, max_delay)
    return World(CHANNELS, ticks, seed=seed, **kw).run()


class AtMostOnce(unittest.TestCase):
    def test_a_slot_runs_at_most_once_however_the_ticks_land(self):
        for seed in range(60):
            for p_drop in (0.0, 0.5, 0.77):
                w = simulate(seed, p_drop=p_drop)
                with self.subTest(seed=seed, p_drop=p_drop):
                    self.assertEqual(repeats(w), [])
                    self.assertTrue(all(len(v) <= 1 for v in w.starts.values()), w.starts)

    def test_every_tick_of_an_hour_landing_together_still_runs_the_slot_once(self):
        # The race: all four ticks of the hour arrive in the same minute, every resolver sees a free slot.
        at = D0 + timedelta(hours=22, minutes=10)
        w = World([chan("default", hour=22)], [(at, PRIMARY)] + [(at, BACKUP)] * 3, seed=1).run()
        self.assertEqual(len(w.jobs), 4)                              # every resolver did hand out the slot
        self.assertEqual(len(w.starts[("default", D0 + timedelta(hours=22))]), 1)
        self.assertEqual(sum(j.cancelled for j in w.jobs), 2)         # two pending jobs were replaced
        self.assertEqual(repeats(w), [])

    def test_a_tick_during_a_render_waits_its_turn_and_then_finds_the_video(self):
        slot = D0 + timedelta(hours=22)
        ticks = [(slot + timedelta(minutes=m), BACKUP) for m in (5, 20, 35, 50)]
        w = World([chan("default", hour=22)], ticks, seed=2, run_minutes=(60, 60)).run()
        self.assertEqual(len(w.starts[("default", slot)]), 1)          # the render outlived three more ticks
        self.assertEqual(len(w.videos), 1)
        self.assertEqual(repeats(w), [])

    def test_a_run_that_died_without_a_row_is_retried_but_a_video_ends_it(self):
        for seed in range(60):
            w = simulate(seed, p_fail=0.5)
            with self.subTest(seed=seed):
                self.assertEqual(repeats(w), [])

    def test_the_channels_do_not_hold_each_other_back(self):
        w = simulate(7, p_drop=0.0)
        for cid, start in slots(w, 3):
            self.assertEqual(len(w.starts[(cid, start)]), 1, (cid, start))

    def test_an_unreadable_source_never_starts_a_backup_tick_or_a_catch_up(self):
        # The hourly cron's own exact-hour run keeps its old behaviour (it goes ahead on an unknown, loudly), which
        # is why this does not assert "never twice" under outages: it asserts that the NEW ticks add no such path.
        went = 0
        for seed in range(60):
            w = simulate(seed, p_outage=0.3)
            for job in w.jobs:
                if job.went and job.guard_unreadable:
                    went += 1
                    with self.subTest(seed=seed, channel=job.channel):
                        self.assertEqual(job.cron, PRIMARY)
                        self.assertFalse(job.catchup)
        self.assertGreater(went, 0)               # the scenario does exercise the exact-hour exception


class TheAttemptCap(unittest.TestCase):
    """The money bound: a scheduled slot starts the pipeline at most the cap times (default 2, NIGHTSHIFT_SLOT_MAX_ATTEMPTS,
    at most 4), whatever dies and whichever ticks land. A retry is a fresh run that pays again."""

    def test_runs_that_die_after_spending_never_exceed_the_cap(self):
        for seed in range(60):
            for p_drop in (0.0, 0.5, 0.77, 0.9):
                for p_fail in (0.5, 1.0):
                    w = simulate(seed, p_drop=p_drop, p_fail=p_fail)
                    with self.subTest(seed=seed, p_drop=p_drop, p_fail=p_fail):
                        self.assertEqual(over_cap(w), [])
                        self.assertEqual(repeats(w), [])

    def test_a_slot_whose_every_run_dies_is_started_exactly_the_cap_times(self):
        for cap in (1, 2, 3, 4):
            for seed in range(10):
                w = simulate(seed, p_drop=0.0, p_fail=1.0, cap=cap, max_delay=10)
                with self.subTest(cap=cap, seed=seed):
                    self.assertEqual({len(v) for v in w.starts.values()}, {cap})
                    self.assertEqual(over_cap(w, cap), [])

    def test_the_default_cap_is_two(self):
        w = simulate(1, p_drop=0.0, p_fail=1.0, max_delay=10)
        self.assertEqual({len(v) for v in w.starts.values()}, {2})

    def test_four_ticks_in_the_same_minute_still_give_one_run_and_a_dying_run_gives_two(self):
        at = D0 + timedelta(hours=22, minutes=10)
        ticks = [(at, PRIMARY)] + [(at, BACKUP)] * 3
        ok = World([chan("default", hour=22)], ticks, seed=1).run()
        self.assertEqual(len(ok.starts[("default", D0 + timedelta(hours=22))]), 1)
        dying = World([chan("default", hour=22)], ticks, seed=1, p_fail=1.0).run()
        self.assertEqual(len(dying.starts[("default", D0 + timedelta(hours=22))]), 2)
        self.assertEqual(len(dying.attempt_rows), 2)

    def test_every_start_is_one_recorded_attempt(self):
        for seed in range(30):
            w = simulate(seed, p_fail=0.5)
            self.assertEqual(len(w.attempt_rows), sum(len(v) for v in w.starts.values()), seed)

    def test_an_outage_never_lets_a_backup_or_catch_up_past_the_cap(self):
        for seed in range(60):
            w = simulate(seed, p_outage=0.3, p_fail=1.0)
            fail_open = {}
            for j in w.jobs:
                if j.went and j.guard_unreadable:
                    fail_open[(j.channel, j.slot_start)] = fail_open.get((j.channel, j.slot_start), 0) + 1
            for key, runs in w.starts.items():
                with self.subTest(seed=seed, slot=key):
                    self.assertLessEqual(len(runs) - fail_open.get(key, 0), 2)

    def test_a_slot_that_used_its_attempts_is_not_handed_out_by_the_resolver(self):
        w = simulate(2, p_drop=0.0, p_fail=1.0, max_delay=10)
        slot = D0 + timedelta(hours=22)
        self.assertEqual(len(w.starts[("default", slot)]), 2)
        late = D0 + timedelta(hours=23, minutes=50)
        ev, sync = w.io(late)
        out = list_channels.due_channels(23, registry=w.registry, now=late, evidence=ev, evidence_sync=sync)
        self.assertNotIn("default", [r["channel_id"] for r in out])


class AtLeastOnceWhenATickLands(unittest.TestCase):
    def test_a_slot_runs_when_any_tick_lands_in_its_window(self):
        for seed in range(60):
            for p_drop in (0.0, 0.5, 0.77):
                w = simulate(seed, p_drop=p_drop)
                with self.subTest(seed=seed, p_drop=p_drop):
                    self.assertEqual(missed(w, 3), [])

    def test_the_hour_after_the_window_closes_is_not_run(self):
        slot = D0 + timedelta(hours=22)
        late = (slot + timedelta(hours=WINDOW + 1, minutes=2), BACKUP)    # 4h02 after: hour 2, three hours too late
        w = World([chan("default", hour=22)], [late], seed=3).run()
        self.assertEqual(w.starts, {})

    def test_the_last_minute_of_the_window_is_still_run(self):
        slot = D0 + timedelta(hours=22)
        w = World([chan("default", hour=22)], [(slot + timedelta(hours=WINDOW, minutes=59), BACKUP)], seed=4).run()
        self.assertEqual(len(w.starts[("default", slot)]), 1)

    def test_the_night_the_schedule_went_quiet_is_made_up(self):
        # 2026-10-21: runs at 17:45, 21:00 and 00:18, none for the 22:00 slot (the incident this change answers).
        # With the 00:18 run alone the new default window (3h) makes the slot up; the old one (1h) did not.
        slot = datetime(2026, 10, 21, 22, tzinfo=UTC)
        w = World([chan("default", hour=22)], [(datetime(2026, 10, 22, 0, 18, tzinfo=UTC), PRIMARY)], seed=5).run()
        self.assertEqual(len(w.starts[("default", slot)]), 1)

    def test_it_beats_the_old_schedule_on_the_delivery_rate_the_history_shows(self):
        seeds, old_hit, new_hit, total = range(40), 0, 0, 0
        for seed in seeds:
            new = simulate(seed, days=4, p_drop=0.77, max_delay=60)
            # The old pipeline: the hourly tick alone and a one-hour catch-up window.
            old = simulate(seed, days=4, p_drop=0.77, max_delay=60, crons=(PRIMARY,), window=1)
            for cid, start in slots(new, 4):
                total += 1
                new_hit += bool(new.starts.get((cid, start)))
                old_hit += bool(old.starts.get((cid, start)))
        self.assertGreater(new_hit / total, 0.95)
        self.assertLess(old_hit / total, 0.5)           # the same days under the old cron and window


class TheChecksHaveTeeth(unittest.TestCase):
    """The same invariants, run against a broken pipeline, must fail. If these pass, the checks above prove nothing."""

    def test_without_the_guard_in_the_run_a_slot_runs_twice(self):
        found = sum(bool(repeats(simulate(seed, guard=lambda *a, **k: slot_guard.GO))) for seed in range(30))
        self.assertGreater(found, 20)

    def test_without_the_attempt_claim_a_dying_slot_is_started_on_every_tick(self):
        always = lambda sync, channel, start, cap, now: (schedule_catchup.CLAIMED, 1)       # noqa: E731
        with mock.patch.object(schedule_catchup, "claim_attempt", always):
            counts = [max(len(v) for v in simulate(seed, p_drop=0.5, p_fail=1.0).starts.values()) for seed in range(20)]
        self.assertGreater(max(counts), 2)

    def test_without_the_cap_in_the_guard_or_the_resolver_the_cap_check_finds_it(self):
        w = simulate(3, p_drop=0.0, p_fail=1.0, guard=lambda *a, **k: slot_guard.GO)
        self.assertTrue(over_cap(w))

    def test_without_the_concurrency_group_ticks_in_one_hour_overlap(self):
        at = D0 + timedelta(hours=22, minutes=10)
        w = World([chan("default", hour=22)], [(at, PRIMARY), (at + timedelta(minutes=15), BACKUP)], seed=1,
                  serialize=False, run_minutes=(60, 60)).run()
        self.assertTrue(repeats(w))

    def test_without_the_evidence_check_in_the_resolver_a_finished_slot_is_scheduled_again(self):
        always_free = lambda ev, cid, start: schedule_catchup.UNWORKED          # noqa: E731
        with mock.patch.object(schedule_catchup, "slot_state", always_free):
            w = simulate(3, guard=lambda *a, **k: slot_guard.GO)
        self.assertTrue(repeats(w))

    def test_if_a_backup_tick_were_trusted_an_outage_would_start_runs_it_should_not(self):
        # The backup-tick rule is what keeps an outage from starting extra runs: treat every tick as the primary
        # one and unknown evidence starts runs from backup ticks.
        with mock.patch.object(schedule_catchup, "is_backup_tick", lambda cron: False):
            went = sum(1 for seed in range(30) for j in simulate(seed, p_outage=0.5).jobs
                       if j.went and j.guard_unreadable and j.cron == BACKUP)
        self.assertGreater(went, 0)


if __name__ == "__main__":
    unittest.main()

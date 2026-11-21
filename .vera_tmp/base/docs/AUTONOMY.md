# Nightshift Autonomy (Phase 4)

What Nightshift actually does on its own, what it does **not**, and exactly what
implementing real autonomy controls would require.

Like Phase 3 this layer is **read-only and derived**. It adds no tables, no
columns, no migrations, no environment variables, no new event names, and no AI
calls, and it does not touch the Python backend or the publish path.

## The honest autonomy posture

The `/autonomy` page reports this deployment's real behaviour:

| Capability | State | Why |
| --- | --- | --- |
| Collect analytics | AUTOMATIC | the scheduled intelligence poll really runs — evidenced by a recent `system.heartbeat` |
| Update learning | AUTOMATIC | evidenced by a recent `feedback.generated` / `feedback.applied` |
| Score topics | AUTOMATIC | same evidence — FeedbackEngine writes `topic_performance` |
| Monitor system | AUTOMATIC | heartbeat |
| **Publishing** | **UNCONDITIONAL** | `main.py` uploads without consulting the approval flag |
| Human approval | RECORDS ONLY | `tools/approve_run.py` sets `human_approved` for the audit trail; nothing reads it before upload |
| Autonomy mode | NOT CONFIGURED | no mechanism exists |
| Emergency stop | NOT CONFIGURED | no mechanism exists |
| Operational limits | NOT CONFIGURED | no mechanism exists |

The AUTOMATIC claims are only made when a real event within the last 48h proves
the scheduled work ran. Without that evidence the row reads NOT CONFIGURED
rather than asserting autonomy that isn't happening.

**Publishing is deliberately shown in amber.** It is the one genuinely
unconditional action in the system, and `tools/approve_run.py`'s own docstring
says so: wiring a publish gate to the approval flag "is a separate, deliberate
follow-up decision for the repo owner". This layer reports that fact; it does
not change it.

## Why there are no autonomy controls

The Phase 4 brief asks for autonomy modes, an emergency stop, daily limits and
approve/reject buttons. Those are **writes**, and they only mean anything if the
backend honours them. Two facts make that impossible without an explicit
architectural change:

1. **The Command Center is read-only.** It holds the anon key under RLS, and
   there is no insert/update policy on any table. It has no write path at all.
2. **The backend does not read any config the UI could write.** Nothing in
   `main.py` or the workflows consults a mode, a stop flag or a limit, so a
   control would have nothing to act on.

   (Backend *state* is now visible — see "Operational mirror" below. What is
   still missing is the reverse direction: config the backend obeys.)

An emergency-stop button the bot never reads would be exactly the fabricated
autonomy status the brief forbids, so the Controls panel says NOT CONFIGURED
and points here instead.

### What implementing them would require

Three coordinated changes, in this order:

1. ~~**Mirror existing backend state**~~ — **done** (see "Operational mirror").

2. **An autonomy config table the backend obeys.** e.g. `autonomy_config`
   (single row: mode, emergency_stopped, max_videos_per_day, max_retries,
   updated_at, updated_by) with authenticated update RLS. The change that makes
   it real is in the backend: `main.py` and the workflows must **read** it and
   stop/skip accordingly. Until the backend reads it, the toggle is decorative.

3. **An audit table for human actions** — `human_overrides` (id, subject_type,
   subject_id, action, reason, actor, created_at), authenticated insert+select,
   plus a matching `human.override` / `autonomy.mode.changed` event so the
   action appears in the normal stream.

Note that step 2 changes publishing behaviour. The current brief says the
publish gate must remain untouched, so it is **not** done here; it needs an
explicit decision.

## Operational mirror (step 1, implemented)

The bot keeps two pieces of operational state on disk under `history/`:

- `content_calendar.json` — `ContentPlanner`'s queue of candidate topics.
- `pipeline_runs.json` — `PipelineStateMachine`'s runs, including the
  `human_approved` audit flag set by `tools/approve_run.py`.

**These survive between workflow runs**: both `daily_video.yml` and
`intelligence_poll.yml` restore and save the `history` directory with
`actions/cache` (`chronos-history-*`). They are cached state, not lost state.

`SupabaseSync.mirror_planner_and_runs()` mirrors them into two new tables,
`content_queue` and `pipeline_runs`, and the intelligence poll calls it right
after the existing `mirror_from_store()`. Both tables carry a primary key,
indexes on status/stage and recency, and the same authenticated-read RLS as
every other table — the anon key still reads nothing without a signed-in user.

`pipeline_runs.started_at` / `updated_at` are the first and last **real** stage
transition timestamps, so runs can be ordered without inventing a clock.

This is **observability only**:

- nothing reads these rows back into the pipeline;
- `human_approved` is mirrored as the audit-trail flag it already is —
  mirroring it does not gate publishing, and publishing is unchanged;
- the mirror is defensive: a failure reading the queue cannot stop the runs
  from mirroring, and neither can fail the poll that called it.

Applying the updated `supabase/schema.sql` is required before these panels show
anything; until then the Command Center says the table was not found rather
than showing a misleading empty queue.

## What this layer does provide, from real data

- **Autonomy posture** — above.
- **Autonomy health** — counts of successful / failed / running agent-attributed
  events in a real window. Human interventions read `N/A` (nothing records
  them) rather than a misleading `0`. Never collapsed into an invented score.
- **Autonomous action log** — every agent-attributed `system_event` with its
  timestamp, agent, action, video and outcome.
- **Learning from failure** — failures grouped by agent+event with counts and
  the last-seen time. A cause is shown **only** when the backend actually
  recorded one in `metadata.error`; otherwise "not recorded". No guessed causes.
- **Best observed publishing window** — weekday/hour bucket with the highest
  mean views/day across published videos, requiring at least
  `WINDOW_MIN_VIDEOS` (5) measured videos. Labelled "best *observed* window" for
  this channel, never a universal best time. Below the floor: INSUFFICIENT DATA.
- **Duplicate topic coverage** — topics genuinely covered more than once in the
  published library (normalized comparison). This is real repetition, not a
  prediction about a future idea.
- **Content queue and pipeline runs** — mirrored from the bot's own state (see
  above), including each run's current stage and approval flag.
- **Content quality gate** (per video) — which stages actually completed
  (`script/voice/media/thumbnail/render/upload`) plus a count of recorded
  failures. **Read-only: it reports, it does not gate.** The publish path is
  untouched.

## Failure isolation

Every derivation is a pure function over rows already fetched for the page. If a
query returns nothing the panel shows its empty state; nothing here can throw
into, retry against, or otherwise affect video generation or publishing.

## Guarantees

- Two new **read-only** tables (`content_queue`, `pipeline_runs`) with the same
  authenticated-read RLS as every existing table. No new env vars, event names
  or AI calls.
- Publish gate, publishing behaviour, feedback algorithm, topic scoring, RLS
  model, realtime and authentication untouched. The only Python touched is
  `modules/supabase_sync.py` (a new additive method) and the intelligence poll's
  `mirror_to_supabase()` that calls it — `main.py` is not modified.
- Frontend remains read-only — no `insert`/`update`/`upsert`/`delete` anywhere —
  and references no secrets; only `NEXT_PUBLIC_SUPABASE_*`.
- Derivations are unit-tested in `command-center/tests/autonomy.test.ts`,
  including the insufficient-data and no-recorded-cause paths.

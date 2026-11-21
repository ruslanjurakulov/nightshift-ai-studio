# Nightshift Intelligence Layer (Phase 3)

How the Command Center turns the bot's existing output into a visible
OBSERVE → ANALYZE → LEARN → DECIDE → ACT → MEASURE → IMPROVE loop.

**The whole layer is read-only and derived.** It adds no tables, no columns, no
migrations, no environment variables, no new event names, and no AI calls. Every
figure it shows is computed at read time from rows the backend already writes.
Where the data cannot support a capability, the UI says so instead of inventing
one.

## Where the data comes from

| Concept | Real source |
| --- | --- |
| Decision | `system_events` row with `event = 'topic.selected'` (emitted by `main.py`, agent `topic_manager`, `metadata.topic`) |
| Score / reason | `topic_performance` (written by `modules/feedback_engine.py`) |
| Learning signal | `feedback_signals` (`HIGH_`/`LOW_` × `VIEW_VELOCITY`/`ENGAGEMENT`/`RETENTION`) |
| Metrics | `metrics_snapshots` |
| Audience demand | `demand_signals` |
| Outcome | the `system_events` that followed the decision |

There is deliberately **no `decisions` table**: a decision already exists as a
real event, and duplicating it would create a second competing source of truth.

## Decision model

`lib/decisions.ts` builds each decision by joining the `topic.selected` event to
the `topic_performance` row for its topic and the `feedback_signals` for that
same topic.

- **id** — the event's real `event_key`.
- **score / reason** — from `topic_performance`; `null` when the topic was never
  scored (then the decision is explicitly *not explainable*).
- **confidence** — a transparent function of evidence count, never a percentage:

  | Analyzed videos | Confidence |
  | --- | --- |
  | 0–1 | *(none — INSUFFICIENT DATA)* |
  | 2–3 | LOW |
  | 4–7 | MEDIUM |
  | 8+ | HIGH |

  The floor of 2 mirrors the FeedbackEngine's own `_MIN_VIDEOS`: below two
  videos there is no channel average to compare against.

- **outcome** — read from the events between this decision and the next one:
  `PUBLISHED`, `FAILED`, `IN_PROGRESS` (newest decision, under 6h old), else
  `UNKNOWN`. This is a **timeline reading, not a causal claim**, and the UI says
  so.

### Explainability

The score formula is the FeedbackEngine's own and is shown verbatim in the UI:

```
score = clamp(50 × mean(topic_avg / channel_avg), 0, 100)
```

where the ratios are the ones the engine already recorded in
`topic_performance.reason` ("4 video(s); retention 1.32x channel avg, …").
50 is exactly the channel average. When neither a reason nor a signal exists,
the UI shows **"Insufficient data to explain this decision."** and nothing else.

### Data lineage

`scoreLineage()` renders where each number came from — score ← formula ← ratios
← analyzed videos ← `metrics_snapshots`, plus the signal count and the last
update date. Every row names its source table.

## Learning signals

Surfaced as first-class objects at `/learning`: metric, direction (above/below
the channel baseline), value, baseline, the engine's own `detail`
("1.32x channel average"), video and analysis date. These are exactly the rows
`feedback_engine._record_signals` wrote — nothing is recomputed.

## Topic intelligence

`RISING` / `STABLE` / `DECLINING` / `NEW` / `INSUFFICIENT DATA`.

`topic_performance` is **upserted in place and keeps no score history**, so the
trend cannot come from it. It is instead derived from the dated
`feedback_signals`: the net direction (ups − downs) of the most recent analysis
date compared with the one before it. With fewer than two dated analyses there
is no trend and the state is `STABLE`, not a guess. The UI states this.

## Nightshift Memory

`/memory`. A memory is only created when real evidence supports it:

- **topic outperforms / underperforms** — `topic_performance.score` ≥ 60 or
  ≤ 40, with at least 2 analyzed videos. 60/40 are the score equivalents of the
  engine's own ±20% "about average" band (`_BAND`), reused rather than invented.
- **consistent metric pattern** — at least 3 same-direction signals for one
  metric on one topic, with **zero** opposing signals (a metric that flip-flops
  is not a pattern).

Each memory carries its evidence count, confidence, last-updated date and the
source tables. Below the evidence floor, **no memory is created at all** — there
are no low-confidence placeholder memories.

## Opportunity detection

Also on `/memory`. Derived, evidence-backed, with a recommended action:

- topic outperforming / declining (same thresholds and evidence rules as above);
- audience demand — a `demand_signals` phrase mentioned at least 3 times.

## Intelligence trace

On each video's detail page: decision → generation → published → metrics →
learning signals → topic score. A step is lit **only** when a real event or row
backs it, so an incomplete chain shows exactly how far the loop actually got.
This is what answers "how did this video's result change what Nightshift does
next?".

## Deliberately not implemented (and why)

These are shown in the UI with an honest state rather than a simulation:

- **Experiments** — `NOT CONFIGURED`. The backend records no experiments and
  there is no table for them. Rather than fabricate variants and winners, the
  panel says nothing is configured. Implementing this for real needs an
  `experiments` table (hypothesis, variants, sample size, metrics, outcome) plus
  a backend that actually assigns and measures variants.
- **Predictions** — `PREDICTION UNAVAILABLE`. Projecting performance needs a
  history of published videos with metrics; with the current history there is
  nothing to project honestly. When enough history exists this should start as a
  transparent heuristic over `topic_performance` + `feedback_signals`, not an ML
  model, and must always be labelled as a prediction with its confidence.
- **Human override** — not implemented. Recording an operator's approve /
  modify / reject is a **write**, and the Command Center deliberately holds only
  the anon key under RLS with no insert policy. Doing it properly requires a new
  `human_overrides` table (id, decision event_key, action, reason, actor,
  created_at) with an `authenticated` insert+select RLS policy, and a matching
  read path so overrides appear beside AI decisions. It was left out rather than
  half-built, because a fake override button that records nothing would be worse
  than none.

## Guarantees

- No new tables, columns, migrations, env vars, event names, or AI calls.
- The publish gate, feedback algorithm, topic scoring, Supabase schema, RLS,
  realtime, and authentication are untouched.
- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are used
  by the frontend; no service-role key is referenced anywhere in it.
- Pure derivations are unit-tested (`command-center/tests/intelligence.test.ts`),
  including the honest empty / insufficient-data behavior.

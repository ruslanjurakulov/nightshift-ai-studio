# Gemini quota: the per-day stop, per-stage models, and the request count

`modules/gemini_stages.py`, `modules/gemini_client.py` · variables `GEMINI_MODEL_TOPIC`, `GEMINI_MODEL_RESEARCH`,
`GEMINI_MODEL_SCRIPT`, `GEMINI_MODEL_FACTCHECK`, `GEMINI_MODEL_GROUNDING`, `GEMINI_MODEL_PACKAGING`,
`GEMINI_MODEL_OTHER` · exit code `80` · event `gemini.usage`

## Evidence

Actions run 40051405982 (the scheduled Chronos run of 24 Oct, step "Run Chronos bot") ended with a raw
traceback and `Process completed with exit code 1`:

```
google.genai.errors.ClientError: 429 RESOURCE_EXHAUSTED ... generate_content_free_tier_requests, limit: 20,
model: gemini-3.6-flash ... Generate content requests per day limit exceeded on Free Tier ... retryDelay 18573s
```

## Diagnosis

The first half of the traceback names the call: `main.py run()` -> `topic_manager.pick_topic()` ->
`_generate_topic()` -> `generate_with_retry()`. So the call **did** go through the shared handling, and no call site
bypasses it (`client.models.generate_content` is called in exactly one place, pinned by
`tests/test_gemini_quota.py`). The handling recognised the per-day quota (the Uzbek "kunlik limit tugadi" line
just above the traceback), did not retry, and then **re-raised the SDK's raw error**. Nothing between it and
`__main__` turned that into an ending the runners understand, so the owner saw a traceback and a red run.

The same log shows the failing run sent only **3** requests: two niche checks (both answered) and then the pick
(the 429). So about 18 of the day's 20 had been spent before this run started, by the first attempt of the same slot
("attempt 2 of 2") and/or by anything else that uses the same key and model (the 20:00 UTC intelligence poll, the
queue worker's comment classification, comment replies, manual runs). Which of those, the logs do not say; that is
what the request count below is for.

## What a per-day 429 does now

* It is **never retried** (as before) and logs **one** line: the model, the stage, the retry-after and the fix.
* `generate_with_retry` raises `GeminiDailyQuotaError` (chained to the SDK's error) instead of the raw 429.
  A stage that already degrades on any model failure keeps degrading, because it catches `Exception`:
  the niche check defers, research continues without notes, the title plan falls back to a heuristic,
  grounding and the packaging repair leave the verdicts and the hold as they were, comment classification and replies release their work,
  the frame critic skips the sheet.
* The stages that cannot be skipped, **the topic, the script and the fact-check**, let it reach `__main__`, which exits
  with **80** and no traceback. The fact-check is one of them because its verdicts are what the gate stands on:
  it used to be swallowed by a broad `except`, leaving `fact_results = None`, so the run bought the voice, stills,
  AI clips and the render and was only then blocked as `fact_check_not_run`. Now the run stops before any of that
  (the saved script is kept for `--resume`). Any other fact-check failure (not a quota) still goes on as before.
  Grounding stays advisory and still degrades: the checker's own verdicts stand. 75 is the storyboard pause, 78 the spend ceiling, 79 the fact-check hold, 81 the series refusal
  (`--series` names a series that is unknown, not ACTIVE or another channel's; red, nothing spent); 82 is the next
  free code.
* The queue worker fails the job (`[code:provider_quota]`, "nothing was charged") and the hold is released.
  The Actions step stays **red** with an `::error` annotation: unlike 75/78/79 this is an outage the owner has to
  act on, not a deliberate hold, and the settle step releases the hold on any failure.

## Per-stage models

Each variable is optional; empty means `GEMINI_MODEL`, so with none set every stage uses the one model it always
did. Nothing here chooses a model. A free-tier quota is per day **and per model**, so moving a stage to another
model gives it its own allowance.

| Variable | Stages (the label in the request count) |
| :-- | :-- |
| `GEMINI_MODEL_TOPIC` | `topic_pick`, `topic_gate` (the AI's own topic, and the one small niche question) |
| `GEMINI_MODEL_RESEARCH` | `research` |
| `GEMINI_MODEL_SCRIPT` | `script` (the title plan calls the script engine's `_gen`, so it is counted and modelled here too) |
| `GEMINI_MODEL_FACTCHECK` | `fact_check` (one request per batch of 30 claims, plus the split retry) |
| `GEMINI_MODEL_GROUNDING` | `grounding` (the evidence judge, one request per 15 claims) |
| `GEMINI_MODEL_PACKAGING` | `packaging_repair` |
| `GEMINI_MODEL_OTHER` | `comment_intel`, `comment_replies`, `video_critic` |

A value must be a plain model id, `[a-z0-9][a-z0-9._-]{0,63}`. Anything else (a key pasted into the wrong box, a
URL, `models/...`) is ignored with a warning that names the variable and never the value, and that stage uses
`GEMINI_MODEL`. They are repository **variables**: `daily_video.yml` reads them for the scheduled and dispatched
runs, and `deploy_web.yml` writes them into the worker's env file (run **Deploy web** after changing one).

### Which variable to set

* **One model for everything:** set the repository variable **`GEMINI_MODEL`** (Settings > Secrets and variables >
  Actions > Variables). It is passed to the scheduled and dispatched runs (`daily_video.yml`), the intelligence poll
  and the fact-check calibration, and to the worker (`deploy_web.yml`; run **Deploy web** after changing it).
  Empty or unset means the code default, `gemini-3.6-flash`.
* **A different model for one stage:** set that stage's `GEMINI_MODEL_*` variable as well; it overrides
  `GEMINI_MODEL` for its stage only. (The poll reads `GEMINI_MODEL_OTHER`, the calibration `GEMINI_MODEL_FACTCHECK`.)
* If the owner enables Gemini billing, nothing needs to change in the code: the same model then simply has a
  higher quota. A model switch is only needed if a different model is wanted.
* The doctor (`tools/doctor.py`) probes `GEMINI_MODEL` and every stage variable that is set, so a typo is reported
  as "Gemini has no model ... (GEMINI_MODEL_SCRIPT)" before a run, not as a 404 at the script stage.

## The request count

Every real attempt at the API is counted in `generate_with_retry`, retries included, keyed by stage and model.
At the end of a run one line is logged and one `gemini.usage` event is recorded (requests per stage and model, and
the per-day quota errors seen):

```
Gemini requests this run: 9 (fact_check gemini-3.6-flash x3, grounding gemini-3.6-flash x2, research gemini-3.6-flash x1, script gemini-3.6-flash x1, topic_gate gemini-3.6-flash x1, topic_pick gemini-3.6-flash x1)
```

A run that made no request (a saved script) logs and records nothing. The counter is thread-safe, never raises,
and holds only a stage label, a validated model id and numbers. It is **not** a cost-ledger entry: an entry with
no USD rate marks the run "unpriced", which makes the run's total unknown and charges the whole credit hold.

An estimate from the code, not a measurement: one full run needs roughly 10 to 20 requests (topic 1 to 3, niche
check 0 to 2, research 1, title 1, script 1, fact-check 1 per 30 claims and up to 3 when a batch is split,
grounding 1 per 15 claims, a packaging repair adds one rewrite plus a re-check). Read the real number from the
first runs' summary line.

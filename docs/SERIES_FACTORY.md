# Series Factory

A series is 3 or 4 episodes of one channel, planned together, priced before anything is spent, and made one at a time.
This page describes **slice S1** (a pure planner and a pure price preview), **slice S2** (migration 0120: the tables, the functions
that spend, and the queue kind; section "Slice S2" below) and **slice S3** (the worker's planning job and the plan page; section "Slice S3"
below). A fourth piece, the **format template** carrier (migration 0122, section "Format templates"), lets a plan ask for one of three formats.
All of it is dark: the worker is off unless `NIGHTSHIFT_SERIES_PLANNER` is on, the page is off unless `SERIES_FACTORY_ENABLED` is
on, and `request_series_plan` is still granted to nobody, so no customer can start a plan. Migration 0127 adds the per-person and platform-wide
daily caps (section "Plan caps"), also dark.

## What S1 is

| Piece | Where | What it does |
| :-- | :-- | :-- |
| `plan_series(...)` | `modules/series_planner.py` | ONE model call (through an injected `generate`) that outlines N episodes, parsed under a strict schema, each episode vetted on its own |
| `quote_series(durations_s, estimator)` | `modules/series_planner.py` | per-episode credits and a series total, from an injected estimator |
| `quoteSeries()` | `command-center/lib/credits.ts` | the same, as a pure TypeScript function over the existing `estimateRunCredits` (which is not changed) |
| `series_call_budget(n)` / `seriesCallBudget(n)` | both | the Gemini calls a series needs, as an estimate to compare with a daily quota |
| `gemini_generate(...)` | `modules/series_planner.py` | the adapter a later worker job passes as `generate`: one `gemini_client.generate_with_retry` call on `model_for("series_plan")`. Tested with a fake client only |

Tests use fakes only, with the network patched to fail: `tests/test_series_planner.py`, `command-center/tests/seriesQuote.test.ts`,
and a fixture both read, `tests/fixtures/series_quote_cases.txt`, so the Python and TypeScript totals cannot drift apart.

## What S1 is not

- **Not wired in S1 alone.** (S3 wires it into exactly one place, the worker's handler `modules/series_plan_worker.py`;
  `tests/test_series_planner.py::WiredOnlyByTheWorker` fails if anything else imports or names it.)
- (S1 alone:) no migration, no table, no route, no UI, no workflow change, no live model call, no change to how a run behaves.
  Slice S2 added the migration and the tables, and nothing else of this list.
- No quota API. `series_call_budget` only reports an estimate; it cannot refuse anything, because the repo cannot read the
  key's remaining daily quota.
- No series-scoped run. That is slice S0 (PR #576 for the Actions path; the queue path is migration 0120, see "Slice S2"),
  not this one.
- Not a script. An outline is a title, an angle, hooks, an open loop, a cliffhanger and key facts. The full script,
  its fact-check, the grounding step and the storyboard review all still happen per episode, later, as they do today.

## The outline is NOT fact-checked, and the UI must say so

Everything the planner returns is model text that no checker has read (CLAUDE.md rule 5: "did not run" is not "passed").
So every plan carries, explicitly:

- `fact_checked: false`
- `notice`: "Outline only: this text was written by a model in one call and has NOT been fact-checked. Each episode's script
  is fact-checked when that episode is made."

**The UI that shows a plan must label it so.** That means a visible "not fact-checked" label on the outline, its hook and CTA
variants and its key facts, in en, ru and uz, from `notice`/`fact_checked` and not from a hard-coded sentence that could be
left behind. Key facts are claims the episode *intends* to establish, not facts. The hooks and CTAs are packaging text; the
prompt carries `PACKAGING_CLAIM_RULE` (`modules/packaging_repair.py`), whose effect on real output is unmeasured.

## The plan, field by field

`plan_series(topic, n_episodes, *, generate, vet, niche, channel_name="", language="English", find_repeat=None,
held_topics_checked=None, stage="series_plan")` returns a `SeriesPlan`; `plan.to_dict()` is plain JSON.

- `n_episodes` is 3 or 4; anything else (2, 5, a bool, a string) is refused **before** any call is spent.
- `niche` is required. An empty or missing niche is `SeriesPlanError("no_niche")` before any call (CLAUDE.md rule 6, as
  `pick_topic` refuses a channel with no niche): with no niche the gate has no profile and does **no off-niche screening
  at all**, so every episode would pass (the reviewer's repro returned `ready` for "Pushpa 2 box office collection", "Best
  gaming laptops of 2026" and "Premier League transfer news"). A niche the word tables do not know ("anime", a customer's
  own words) is accepted, but the gate then cannot call anything off it; every episode of such a plan is unconfirmed (below).
- Per episode: `topic` (the standalone subject, what would be passed to a run as an explicit topic), `working_title`, `angle`,
  `hook_sentence`, `hook_variants` (2 or 3), `cta_variants` (2 or 3), `open_loop`, `cliffhanger`, `key_facts` (1 to 6).
  The episode number is assigned by order, never taken from the model.
- Per episode report: `usable`, `reasons` (fixed words), `vet` (`action`, `reason`, `detail`, `check` of the gate verdict),
  `repeat_of` (the channel's own past or held topic it repeats), `niche_confirmed`.
- Plan: `status` is `ready` (every episode usable and its niche confirmed), `ready_unconfirmed` (every episode usable, but at
  least one was accepted without confirmation), `partial` (some usable) or `blocked` (none), with `usable_episodes`;
  `held_topics_checked` is `true`/`false`/`null` as the caller said (see below); `plan_calls_made` is 1; `call_budget`.
- **Usable is not safe.** `unconfirmed_episodes` (numbers), `unconfirmed_count` and `requires_human_confirmation` list the
  usable episodes whose niche nobody confirmed: the gate's words could not place them and no model was asked
  (`niche_confirmed` false, `vet.detail` `unchecked`, `unverified` or `gate_off`). A refused episode is refused, not
  "unconfirmed". **The S3 UI must require a person to confirm each of those episodes before it is started**, and must
  never show `ready_unconfirmed` or a `requires_human_confirmation` plan as plainly ready (rule 5).

A rejected or repeated episode is **reported with its reason**. It is never dropped, never replaced by a second model call,
and the proposed text stays in the report so a person can read what was refused.

### How a wrong answer ends

All of these are a `SeriesPlanError` with a fixed `code` and a field path, never a partial plan and never another exception
(a seeded fuzz test checks that nothing else escapes). The error never repeats model text, which may be hostile.

| code | meaning |
| :-- | :-- |
| `bad_count`, `bad_input`, `bad_language`, `no_niche` | the caller's arguments (no niche included); refused before the call |
| `generate_failed` | the injected call raised (outage, overload); only the exception type is kept. **A spent per-day quota is not this**: `GeminiDailyQuotaError` is re-raised unchanged (from `generate` and from a `vet`), so that once wired it reaches `__main__` and ends the run with exit 80 |
| `empty_response`, `response_too_large`, `not_json` | no text, over 40,000 characters, or not exactly one JSON object (prose around the JSON is refused, a ```json fence is accepted; duplicate keys, NaN and Infinity are refused) |
| `bad_shape` | not an object with exactly `series_title` and `episodes`; an episode with missing or extra keys |
| `wrong_count` | the model returned a number of episodes other than the one asked for |
| `bad_field`, `too_long` | a non-string, an empty string, a list of the wrong length or with a repeated item, a string over its limit |
| `markup`, `cue_tag`, `hidden_characters` | `<` `>`, backticks, `{{ }}`, `${`, `##` marks, an entity or a link; any square-bracket tag (`[SFX: ...]`, `[INST]`, `[anything]`); control, bidi, zero-width, line-break and other invisible characters |
| `injection` | a phrase that addresses the next stage ("ignore previous instructions", "system prompt", a leading `System:` / `User:` / `Instruction:`, ...; en, ru, uz). A phrase list, not a guarantee. A normal title that happens to contain one of these phrases will be refused, and that is accepted: the failure is closed and costs one retry |
| `duplicate_topics` | two episodes are the same topic by `modules/topic_dedup.is_same_topic` |

The markup, bracket and phrase screens read the text as a reader sees it (combining marks removed, then `topic_gate.clean`: NFKC, invisible characters
removed, look-alike letters in a mixed-script word turned back to Latin), so "ígnóré prévíóús ínstrúctíóns", full-width `＜script＞` and `［SFX: boom］`, math-bold
and Cyrillic-look-alike "ignore previous instructions" are refused. The text that is kept is what the model wrote, not the
folded form. A corpus of legitimate en, ru and uz titles (`tests/test_series_planner.py::Folding.LEGIT`) pins that the
screens do not refuse ordinary titles, including "The Feudal System: Lords and Serfs" and Russian or Uzbek titles that
contain words like "система" or "инструкция".

### Untrusted input is fenced

The topic, the niche and the channel name travel as JSON inside `<data>` with `<` and `>` written as `<` and `>`
(the way `modules/grounding.py` and `modules/packaging_repair.py` do), so no string can close the block. Input with control
or invisible characters is refused rather than fenced. Languages: `en`, `ru`, `uz` (or the names) map to one name; any other
plain language name passes through; anything else is `bad_language`.

## Vetting an episode topic: why `source="series"` is lenient

`--topic` bypasses the niche gate by design ("a topic a person typed is an instruction"). A series episode is an explicit
topic that a **model** wrote, so without plan-time vetting a series would be the one path that reaches the pipeline unchecked.
Each episode topic therefore goes through `TopicManager.vet_topic(topic, niche, source="series")` and through the channel's
repeat check.

What `topic_gate.evaluate` does by source (read from `modules/topic_gate.py`):

- Every non-operator source: the words reject an off-niche topic (`off_niche`) and a sensitive one (`needs_human`: living
  people in live cases, medical claims, minors, active tragedies, crime and legal) **only in the shapes the word tables
  recognise** (see "What the words do not catch").
- A **strict** source (a trend, a competitor, any source the gate has not heard of) whose topic the words cannot place gets
  a model question. The gate allows `TOPIC_GATE_MODEL_CALLS` (default 2) per run; the rest are deferred as `unconfirmed`.
- A **lenient** source (`ai`, `content_opportunity:demand`) is accepted when the words cannot place it ("unchecked"), except a
  named person next to a gossip or news word, which gets one question.

Before this slice `series` was strict only because nobody had named it. Decision: **`series` is lenient** (one added word in
`LENIENT_SOURCES`, and `GATE_VERSION` bumped to `2026-10-24.1`). Why:

1. The episodes are one model call's outline of a person's own topic, told to stay inside the niche: the same trust as the AI
   pick, and unlike a trend feed from outside.
2. Strict would spend the per-run question budget on the first episodes and defer the rest, so a four-episode plan would be
   judged by the order of its episodes; and every question is another call against a free-tier day of 20.
3. The words reject what they recognise, for every source, with no model call (`tests/test_series_planner.py::TheRealGate`
   runs the real `vet_topic`). That is less than it sounds: see "What the words do not catch".
4. Strict would not have fixed the misses. The reviewer measured 126 episode topics: `series` and `ai` gave the same verdict
   on all 548 evaluations, and strict `trend` would not have caught the sensitive misses either (the model question asks
   only "is it in the niche?") while costing about 1.7 model calls per plan.

### What the words do not catch

The gate rejects only what its word lists recognise. The reviewer's adversarial set, 46 plausible history-channel topics:
**14 were rejected by the words, 2 were asked about, and about 30 were accepted, of which about 25 a human would hold**:
for example the McCann and Maura Murray disappearances, Epstein, Uvalde, Maui 2023, the Titan submersible, Taylor Swift,
Musk, Putin, and Russian and Uzbek medical-claim topics. `usable` and `ready` therefore never mean "safe to publish" or
"on-niche"; they mean no word rule said no. What stands between an accepted episode and a public video is the rest of the
pipeline (the fact-check gate, the storyboard review, private uploads) and a person.

Three cheap levers are in S1, all of them planner-side, and **the prompt one is unmeasured** (rule 8):

1. a channel with no niche cannot be planned (`no_niche`);
2. the plan lists the unconfirmed episodes and sets `requires_human_confirmation` (above);
3. the planning prompt tells the model to stay in the niche and to avoid living named people, active or recent criminal
   cases, current tragedies and health or medical claims. Nobody has measured how much a model obeys this, or whether it
   changes the episodes at all (the AI-pick prompt in `TopicManager` has no such text either).

What leaving `series` lenient costs, stated plainly: an episode the words cannot place is accepted without anyone confirming it is on-niche.
That is **not hidden**: the report keeps the verdict, `niche_confirmed` is `false` for it (`detail` is `unchecked`), and the UI
should show it as "niche not confirmed", not as a pass. If a later measurement shows lenient acceptance letting off-niche
episodes through, the fix is one word, and `tests/test_series_planner.py::GateVersion` ties the rule set's version to it.

### Repeats: used and held topics

`find_repeat` is `TopicManager.find_repeat` (the channel's own recent topics plus its held-before-render topics), or
`repeat_checker(used, held)` over plain lists. The planner does not load anything itself (it is pure), so the caller must call
`TopicManager.load_held_topics()` first and say so with `held_topics_checked=True`. `None` means "not known" and the plan keeps
it as `null`: an unloaded held list silently finds no repeats, and the plan must not look as if it had checked. A held episode
shows as "held, nothing charged"; the retry is a person's, never automatic. The series' own umbrella topic is not
repeat-checked, only the episodes are.

## The price preview

`quote_series(durations_s, estimator)` and `quoteSeries({prices, durationsS, videos})` return:

- `episodes[]`: `credits`, `basis`, `gap`, `floor_applied`, `duration_s` per episode. An unknown price is `null` with the named
  gap (`no_prices`, `no_length`, `no_history`, `unpriced_history` from `estimateRunCredits`; `unknown`, `estimator_error`
  (Python only) and `invalid_estimate`). Never 0. `invalid_estimate` is a credits value that is NaN, infinite, negative, not
  a number, or above 1e12 (`MAX_EPISODE_CREDITS` / `SERIES_MAX_EPISODE_CREDITS`); both languages validate it the same way
  and the shared fixture pins it (an estimator that returned 3e306 used to raise an `OverflowError` in Python and a
  TypeScript caller would have summed NaN or Infinity into a total).
  `count_mismatch` is an episode with a length but no estimate, or an estimate but no length, when `aggregate_quote` /
  `aggregateSeriesQuote` get lists of different lengths: it is kept as an unpriced episode (nothing is zipped short or
  dropped), so the quote is not complete. The shared fixture pins it in both languages.
- `total_credits`: `null` if **any** episode is `null`. Never 0, never a partial sum presented as the total. Rounded up to the
  cent, as a hold is.
- `partial_sum_priced_only`: the sum of the priced episodes alone, under a name that says so; `null` when none is priced.
- `complete`, `unknown_episodes`, `gaps`.
- `gemini_calls`: the budget below.

A price of 0 is a price (`credits: 0`); only `null` is a gap. An invalid length (0, negative, NaN) is passed to the estimator as
unknown, so a channel with history can still price it per video, as `estimateRunCredits` does today. The planning call itself
is not in the quote (no credit price exists for it; owner decision 3), and neither is a voice.

### Gemini call budget (unmeasured)

| | calls |
| :-- | :-- |
| the plan | 1 (exact) |
| one episode made later | 5 to 12 |
| 3 episodes | 16 to 37 |
| 4 episodes | 21 to 49 |

The per-episode range comes from reading the call sites (topic given: research 1, title plan 1, script 1, fact-check
about 2, grounding judge 1 to 3; packaging repair adds 3 to 5 when it triggers; a storyboard-review channel repeats the
fact-check on resume). **None of it was measured on a real run, so every number is labelled "estimate, unmeasured"** in the
quote. The only measured fact is the one in PR #572's log: a free-tier model with a limit of 20 requests per day. A caller can
compare `total_calls_low` and `total_calls_high` with its quota; the planner does not refuse anything itself.

## Slice S2: tables and functions (migration 0120)

Owner approval and an independent security review come before the merge, because the merge applies the file live. The file is
`supabase/migrations/0120_series_tables.sql`; its rollback is `docs/sql/rollback_0120_series_tables.sql`; the lab tests are
`tests/security/test_sec_series_tables.py` (behaviour, with real concurrent transactions for the races) and
`tests/test_series_tables_migration.py` (what the file itself must say). Slice S2 only stores and spends: it never calls Gemini and
nothing in the application calls it yet.

### What exists

| Object | What it is |
| :-- | :-- |
| `series_plans` | one "plan a series" press: org, channel, optional series, topic, niche (from the series or the channel, never typed), language, `n_episodes` (3 or 4), `duration_s` (each episode), state `requested` / `ready` / `failed`, then the title, a `report` and a `quote` (the planner's words and preview), the queue row (`render_job_id`) and the press's idempotency key |
| `series_episodes` | the 3 or 4 episodes of a ready plan: `topic`, `outline` (model text), `usable`, `needs_confirmation`, `duration_s`, state `planned` / `started`, and once started the hold (`credit_ref`, `credits_held`), the queued run (`render_job_id`) and who started it |
| `render_jobs.kind = 'series_plan'`, `render_jobs.series_plan_id` | the queue row of a planning press; a planning job has its plan and no other job does (a CHECK) |
| `render_job_params_valid` | 0029's body plus the optional `series` key (a slug, `^[a-z0-9][a-z0-9._-]{0,63}$`, never on a repair) and the rule for the new kind (a topic and a niche, optionally a language and a series, nothing a run takes) |
| `render_jobs_payment_guard` | 0111's body plus one block: a job linked to a series plan must be exactly the job that plan queued, and is paid by nobody |

Both replaced functions are the latest bodies in the repo, verbatim, plus marked additions; a DO block at the top of the migration
refuses to replace a body it has not seen (the 0064 / 0103 drift lesson), and `tests/test_series_tables_migration.py` recomputes the
four hashes from the migration files.

### The functions (exact signatures)

| Function | Who | Returns |
| :-- | :-- | :-- |
| `request_series_plan(p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text, p_template text default null) returns jsonb` (the eighth argument is migration 0122's; 0120 had seven) | **nobody yet** (see below); editor or above once granted | `{id, status: 'requested', render_job_id, replayed}` |
| `finish_series_plan(p_plan uuid, p_ok boolean, p_title text, p_report jsonb, p_quote jsonb, p_episodes jsonb, p_error_code text default null, p_error text default null) returns jsonb` | service role only | `{id, status: 'ready' or 'failed', replayed}` |
| `quote_series_episode(p_episode uuid) returns jsonb` | any member of the organization (viewer or above) | `{episode_id, plan_id, n, status, duration_s, exempt, price_status: 'priced' / 'unpriced' / 'included', credits (or null), needs_confirmation, blocked_by (a word or null), may_start, startable}` |
| `start_series_episode(p_episode uuid, p_max_credits numeric, p_idem text, p_confirmed boolean default false) returns jsonb` | an **admin** of the organization (a platform administrator in the operator's own organization) | `{id, plan_id, n, status: 'started', render_job_id, credit_ref, credits_held, started_at, replayed}` |

Reading is by RLS: a member selects their organization's `series_plans` and `series_episodes`. There is no direct write for any API role,
the service key included.

Errors are SQLSTATE plus a fixed word (the message). The ones a UI maps: `not_found` (P0002; a missing id, another organization's id, a
channel or series outside the caller's scope: one answer, no oracle), `forbidden` (42501; a viewer, or an editor starting an episode),
`invalid_*` (22023; `invalid_topic`, `invalid_episode_count`, `invalid_duration`, `invalid_language`, `invalid_template` (0122),
`invalid_idempotency_key`, `no_niche`), `idempotency_conflict`, `plan_in_progress`, `earlier_episode_not_finished`, `episode_not_usable`, `plan_not_ready`,
`already_started`, `series_not_runnable`, `price_changed` (all NS409; the current price is in the error detail, `credits=15.00`),
`unpriced` and `confirmation_required` (NS400), `price_required` (22023), `insufficient credits` (NS402, as every hold), `rate_limited`
(NS429, `limit=5 per 24 hours`), and, since migration 0127, `series_user_cap` (NS429, `limit=3 per 24 hours`) and `series_global_cap` (NS429, no detail)
for a plan request, and `parallel run limit reached` (NS429, the plan's concurrency limit, from the existing hold trigger).

### The money

- **The database prices the episode.** `series_episode_price(seconds)` is the formula the payment guard already enforces for a queued run:
  `max(job_minimum, video_minute x (1 + margin) x seconds / 60)` rounded up to the cent. The browser sends the price it saw
  (`p_max_credits`); the function refuses (`price_changed`, in either direction) unless it equals the price as computed now, and the hold is
  the database's number, never `p_max_credits`.
- **Unpriced refuses, never 0.** No `video_minute` rate, or a zero one, is `unpriced`: nothing is held and nothing is queued. The operator's
  own organization pays nothing (`included`, no hold) and needs no rate.
- **One hold per episode, taken when it starts.** `reserve_credits(org, 'rj-se-<episode id without dashes>', price)`. The reference is derived
  from the episode id, so no path holds twice for one episode (a released reference is burnt too). The run is an ordinary `daily` job that
  carries that hold, so the payment guard checks it like any queued run and the worker captures or releases it like any run. Nothing is
  held for an episode that has not started, so nothing waits on the 3 hour hold expiry. The hold counts against the plan's parallel-run
  limit like any other.
- **Idempotent.** The idempotency key of a start is `se:<episode id>`; `p_idem` must be exactly that. Pressing again (a retry, a second tab,
  a second admin) answers the first start with `replayed: true` and holds nothing more. The same key with another confirmed price or flag is
  `idempotency_conflict`.
- **One episode at a time, in order.** Episode n starts only when every earlier episode was started and its run has `succeeded` (a run that
  stops at its storyboard review ends `succeeded`, 0057). A failed, cancelled or running earlier episode blocks the later ones
  (`earlier_episode_not_finished`). **An episode is started once**: a retry of a failed episode is a person's decision and belongs to a later
  slice (it needs a fresh hold reference). A hold that expired un-started is not revived; the press answers as a replay and the episode
  shows its run's real state.
- **A series that cannot run stops the start before a hold**: the plan's series must still belong to the plan's channel and be `ACTIVE`
  (`series_not_runnable`), as `main.py` would only discover after the hold.
- **An unconfirmed episode does not start by accident.** An episode the planner accepted without confirming its niche
  (`needs_confirmation`) starts only with `p_confirmed = true`, the S3 UI's explicit step; an episode the vetting refused (`usable = false`)
  never starts. The database cannot know that a person read the "niche not confirmed" label; it only refuses the call that did not claim to.

### Planning is free, capped, and DORMANT in this migration

- `series_plan_daily_limit()` is 5 plans per organization per rolling 24 hours, a **placeholder for owner decision 3** (one function to
  change). One plan in flight per channel; a plan never finished frees its channel after 2 hours and its queue row is cancelled if no
  worker took it. The cap counts failed plans (a model call may have been spent; see "What counts" under "Plan caps") and is checked after the idempotency replay, under an advisory lock
  per organization, so concurrent requests cannot both pass it.
- **Since migration 0127 there are two more caps, in the same function, counted from the plan rows** (see "Plan caps (migration 0127)" below):
  3 plans per person per rolling 24 hours (in any organization) and 30 per rolling 24 hours for all organizations together.
- **`request_series_plan` is granted to nobody**, as 0117 did with `request_voice_clone`: it writes a plan and one queue row, and the live
  queue worker has no handler for the kind (`run_request.KINDS` is `daily` and `repair`; it would fail the job as "invalid job (nothing was
  run)"). The grant ships in S3, with the worker and the UI. `start_series_episode` and `quote_series_episode` are granted, but an episode
  exists only after `finish_series_plan`, which only the worker can call, so they have nothing to act on until then.
- The queue row is paid by nobody: planning is not credit-priced in this slice. If owner decision 3 goes the other way, the guard block and
  `request_series_plan` change together.

### Hard conditions before `request_series_plan` may be granted (independent security review of #590)

The review found migration 0120 safe to apply as it stands. These findings are the conditions that S3 (or whoever grants the function) must
meet **before** `grant execute on function public.request_series_plan(...) to authenticated`. They are conditions, not suggestions; none is
met by 0120, which is why the function is granted to nobody.

- **F4: the cap is per organization, and one account can have many organizations. MET by migration 0127** (merged as #630; the caps are in the database, dark,
  because the function is still granted to nobody; read "Plan caps" below for what it does, what is still the owner's, and the HARD CONDITION on abuse
  that applies before ANY grant). `create_organization` allows 10
  organizations per account, so one person could make 10 x 5 = 50 planning requests a day (each one a model call on the platform's shared
  Gemini key). 0127 adds a per-user cap (default 3 a day) and a platform-wide cap (default 30 a day), in the database, before the grant.
- **F5: what happens when the function is called before its worker exists, and what is not yet handled.**
  - Until a handler exists, the queue worker fails a `series_plan` job as "invalid job (nothing was run)" (`run_request.KINDS` is `daily` and
    `repair`) and the plan stays `requested`, blocking its channel, until the 2 hour expiry. S3 ships the handler with the grant, never the
    grant alone.
  - There is no restart path after a failed, cancelled or expired episode: the hold reference `rj-se-<episode id>` is derived from the episode
    id, and `reserve_credits` refuses a reused reference even when released, and a failed earlier episode blocks every later one. A restart needs
    a new reference scheme (an attempt number) and its own review.
  - `render_jobs_voice_guard` (0117) is a `BEFORE INSERT` trigger on all of `render_jobs`, so it also runs on a `series_plan` job and checks the
    channel's configured voices at queue time: a channel whose configured custom voice was detached or deleted would make planning fail. Decide
    in S3 whether planning should be exempt (it uses no voice) or should fail early with a clear message (rule 6).
  - `request_series_plan` accepts only ASCII language names (`^[A-Za-z][A-Za-z -]{0,39}$`): "Русский" or "O'zbek" are refused as
    `invalid_language`. The S3 UI must send an English name or a language code, not the interface string.
- **F1: apply the migration as ONE transaction.** `set local lock_timeout` and the drift guards assume it: the Supabase SQL editor,
  `apply_migration`, or `psql --single-transaction -v ON_ERROR_STOP=1 -f supabase/migrations/0120_series_tables.sql`. A plain `psql -f` without
  those flags runs every statement on its own and could leave the file half applied (for instance the tables created and the payment guard not
  yet replaced) if one statement failed.

### What S2 does not do

No worker job (S3), no UI (S3), no Gemini call, no route. `request_series_plan` is not callable. No restart of a failed episode, no cancel.
`storyboard_id` is not on the episode (S3 can add it; the storyboard is found by its topic and channel). The per-run storyboard-review
override (owner decision 4) is not set by `start_series_episode`; the episode run is a plain queue run with an explicit topic until that
decision is made. A migration cannot be fact-checked or measured: nothing here was run against a live database.

## Slice S3: the worker and the page (no migration, dark by default)

S3 adds **no migration and no grant**. `request_series_plan` is still granted to nobody (`tests/test_series_tables_migration.py::Dormant`
fails if any migration grants it). The grant lets customers spend the shared Gemini key, so it is a separate owner decision.

### The worker: `modules/series_plan_worker.py`, called from `tools/queue_worker.py`

A `render_jobs` row of kind `series_plan` is not a run. `Worker.process` hands it to the planning service **before** `run_request.plan_run`
(which still refuses the kind, so `main.py` can never be started for one). The service, in the worker's own process:

1. reads the plan (`series_plans`, service key), refuses a plan that is not `requested`, a plan of another channel, a channel never confirmed
   against YouTube, a server with no `GEMINI_API_KEY`, and a spent-quota cooldown, all **before** a model call;
2. makes ONE `generate` through `series_planner.plan_series` with `gemini_generate()` (`generate_with_retry`, stage `series_plan`), the channel's
   `TopicManager` as the vet (history rebuilt from Supabase, held topics loaded), on a thread with a deadline;
3. ends the plan with `finish_series_plan` (service key): `p_ok` true with the title, the report (the plan without its episodes), the quote and
   one entry per episode (`topic`, `outline` = the episode's whole report, `usable`, `needs_confirmation` = usable and niche unconfirmed), or
   `p_ok` false with a closed word and a fixed sentence.

Hard limits: 3 or 4 episodes (anything else is refused before a call); the call budget `series_call_budget(n)["plan_calls"]` is 1 and a second
`generate` is refused; at most `CHRONOS_TOPIC_GATE_MODEL_CALLS` (default 2) small niche questions on top; 300 s wall clock, after which no
further call is made (the model call, and every vet and gate question, check the same cancel flag) and the plan ends as `timeout`.

**How many HTTP requests that is, honestly.** "One call" is one `generate`, not one HTTP request: each `generate`, and each gate question, is
`generate_with_retry`, which makes up to `GEMINI_MAX_RETRIES` (default 5) attempts when the API answers 429/5xx. So one attempt of a job is
at most (1 + 2) x 5 = 15 requests, in a bad hour, and 1 to 3 in a good one. The service never goes back to the model for the same job:
**once a `generate` has been started, a lost delivery of the ending or a shutdown ends the plan as failed (`worker_error`) instead of
releasing the job**, so a job cannot make up to 3 `generate`s through re-queues (the choice made: no stored answer to resume from, because
that needs a place to keep model text; the customer plans again, which counts against the daily cap). The one remaining way to a second
`generate` for the same job is a worker that DIES (the stale sweep re-queues it, up to 3 attempts). **Since migration 0127 a person is
capped at 3 plans a day and the platform at 30 (F4, "Plan caps" below), on top of the per-organization 5 a day of migration 0120; before 0127 is applied
the only cap is the per-organization one.** **No credit hold**: planning is a platform cost, the customer is charged nothing on every
path (the job has no `credit_ref`, and a test fails if a planning job touches the credits client). The quote stored with a plan carries the
Gemini-call budget and the episode length and **no credits**: the price of an episode is `quote_series_episode`'s, computed when it is read.

| Ending | Plan | Job |
| :-- | :-- | :-- |
| plan made | `ready` | `succeeded` |
| `NIGHTSHIFT_SERIES_PLANNER` off | `failed` / `planner_not_enabled` | `failed` ("series planning failed (planner_not_enabled)"), as today, but the plan no longer sits `requested` for 2 h |
| Gemini per-day quota spent (`GeminiDailyQuotaError`, main.py's exit 80) | `failed` / `gemini_quota` | `failed`, coded `provider_quota`, "nothing was charged"; further planning jobs end the same way for `max(30 min, min(retry-after or 30 min, 1 hour))` **without** calling the API (a short Google hint does not give a short pause) |
| the planner's own refusal (bad answer, no niche, ...) | `failed` / the planner's code | `failed` |
| timeout / exception / answer too large to store | `failed` / `timeout`, `worker_error`, `result_too_large` | `failed` |
| the database cannot be told | stays `requested` | put back in the queue only if no model call was made and it is not the last attempt; otherwise the job fails (a release would ask the model again, or fail the row and leave the plan `requested`) and the 2 hour expiry frees the channel |
| job taken over by another worker (`lost`) | left to its new holder | left alone |
| re-queued job whose plan already ended | unchanged | `succeeded` / `failed` to match, **no model call** (idempotent) |

The words are pinned equal to the page's list (`WORKER_ERROR_CODES` in `command-center/lib/seriesPlan.ts`). Model text is stored as data only
and never repeated in a log, an error or a job row; the error stored on a failed plan is one of our fixed sentences.

The switch is `NIGHTSHIFT_SERIES_PLANNER` (`on` / `1` / `true` / `yes`; empty is off): `deploy/.env.worker.example`, `WORKERENV_` in
`deploy_web.yml`, `tests/test_worker_env_allowlist.py`, `tests/test_switch_reachability.py`.

### The page: `/{channel}/series/{plan id}` and "Plan a series" on `/{channel}/series`

Behind the server flag `SERIES_FACTORY_ENABLED` (`on` / `1` / `true` / `yes`; read per request on the server, never `NEXT_PUBLIC_`; documented in
`deploy/.env.web.example`, mapped by `WEBENV_` in `deploy_web.yml`). **Off: the plan page is the public 404 and makes no database call, and the
series page is exactly as before** (no form, no read of `series_plans`). A path that is not a plan id is a 404 before the database is asked.

- Outline cards with the hook and call-to-action variants, the open loop, the cliffhanger and the key facts. **Every outline carries "Not
  fact-checked"** (the page, whatever `report.fact_checked` says, and again on each card), in en, ru and uz. Model text is cut to a bounded plain string and drawn only as a React
  text node (tests render a hostile outline and assert no element, handler or link comes out of it).
- Per-episode and total price from `quote_series_episode` (the database's). An episode with no price or an unreadable quote is "not priced" /
  "price unavailable", and the total is then "not complete", never a smaller number and never 0. The operator's own organization reads
  "Included", not "0 credits".
- A status chip per episode (refused, needs your confirmation, ready, waiting, not priced, queued, running, storyboard waiting, video made,
  run finished, failed, cancelled); the storyboard and video chips link to `/{channel}/videos/storyboard/{id}` and `/{channel}/videos/{id}`.
- **Start episode** calls `start_series_episode(episode, price shown, 'se:<episode id>', confirmed)`. The database holds ITS price and refuses
  (`price_changed`) unless the price shown is still the current one. An episode whose niche nobody confirmed (`needs_confirmation`) shows why in
  the gate's words and cannot be started until the person ticks "I read this topic and confirm it is inside this channel's niche"
  (`p_confirmed` true). The button is not drawn unless the database says the episode `startable` and the person `may_start` (an administrator).
- Refusals are read out in the sheet, in words: `price_changed` (with the new price), insufficient credits (with the numbers),
  `unpriced`, `earlier_episode_not_finished`, rate limited, the plan's parallel-run limit, `forbidden`, `series_not_runnable`, and the rest;
  anything unknown is a generic "nothing was held". A stale page is refreshed when the refusal says it is stale.
- States: loading (`loading.tsx`), being made (the page re-reads itself every 5 s for 2 minutes, every 30 s until 10 minutes, then stops and offers
  "Check again"; "taking longer than usual" after 10 minutes, and that nothing is charged), failed (a sentence per code, "nothing was charged", a way to plan again), not found, migration not installed, read
  failed with Retry, empty recent-plans list.
- The "Plan a series" form sends the English name of the language (the database refuses `Русский` / `O'zbek`), a key that is stable for the same
  request and new for a changed one, and no price. The database's refusal of the call while it is ungranted (`permission denied for function`,
  or the function not found) is shown as **"not available yet; nothing was started and nothing was charged"**, never as a failure.

### What the owner must do, in order

1. Confirm migration 0120 is applied (it merged as #590).
2. Merge S3 (this changes nothing visible: the worker is off, the page is off).
3. Worker: set the repository variable `NIGHTSHIFT_SERIES_PLANNER=on` and run "Deploy web". Needs `GEMINI_API_KEY` in the worker env (it is
   there for runs). With the grant still missing no plan can exist, so this is safe on its own.
4. Web: set `SERIES_FACTORY_ENABLED=on` and run "Deploy web". The form appears; pressing it says "not available yet".
5. **The grant**, in its own migration and PR, only after the conditions below: `grant execute on function public.request_series_plan(text, text,
   integer, text, integer, text, text, text) to authenticated;` (eight arguments since migration 0122; the seven-argument function no longer exists). Granting before step 3 is also safe (the job fails cleanly as `planner_not_enabled`),
   but every plan then fails; granting it is what lets customers spend the shared Gemini key.

### Conditions before the grant that S3 does NOT meet

- **F4 (met by migration 0127, once it is merged and applied):** the cap was per organization and one account can have 10 organizations (50 plans a
  day on the shared key). 0127 adds the per-user and the platform-wide cap in the database; S3 can only slow this down on the worker side (the quota
  cooldown), not cap it. See "Plan caps (migration 0127)".
- **F5, met in code:** the handler now exists (a `series_plan` job is no longer failed as "invalid job"); the language sent is the English name;
  `render_jobs_voice_guard` firing on the planning job's insert is surfaced as its own sentence ("this channel's configured voice isn't
  available"). Not decided: whether planning should be exempt from that guard (it uses no voice); that needs a migration.
- No restart of a failed or cancelled episode (still a later slice), no cancel, no per-run storyboard-review override (owner decision 4), no
  semantic originality check on the episodes (the repeat check is the word rule only), and `held_topics_checked` is `true` only when some held
  topics were found (the manager cannot tell "none held" from "could not be read"), otherwise the page says it may not have checked.
- A quota hit while vetting an episode is swallowed by `TopicManager._ask_on_niche` (existing behaviour: an unanswered question defers the
  episode), so such an episode shows as "not confirmed" instead of ending the plan.
- Planning's Gemini calls are not in the cost ledger (a gap, not a zero); nothing was run against Gemini, Supabase or a browser: see
  "Unmeasured and unverified".

## Plan caps (migration 0127, dark: no grant, no switch)

Finding F4 of the review of #590: each plan costs ONE `generate` on the shared `GEMINI_API_KEY` plus up to `CHRONOS_TOPIC_GATE_MODEL_CALLS` niche
questions, each up to `GEMINI_MAX_RETRIES` HTTP attempts, at no charge to the customer, and the only cap was 5 plans per organization per 24 hours
while one account can own ten organizations. Migration 0127 (`supabase/migrations/0127_series_plan_caps.sql`) adds two caps **inside
`request_series_plan`**, counted in the database from `series_plans` (never from the client), after the organization cap:

| Cap | Counts | Default | Refusal (NS429) |
| :-- | :-- | :-- | :-- |
| per person | the plans one person (`requested_by`) requested in the last 24 hours, in any organization | **3** | message `series_user_cap`, detail `limit=3 per 24 hours` |
| platform-wide | the plans all organizations requested in the last 24 hours (the operator's own included) | **30** | message `series_global_cap`, no detail |

* **Order of the checks:** replay of an accepted press (never refused by a cap) -> channel busy (`plan_in_progress`) -> organization cap (`rate_limited`, 5) ->
  person (`series_user_cap`) -> platform (`series_global_cap`). A refusal raises, so the whole call rolls back: no plan row, no queue row.
* **What counts:** every plan row in the window, whatever its status, exactly as the organization cap does. That includes a failed plan and an expired one. An
  expired plan whose queue row the sweep cancelled never reached a worker and spent no model call, and it still counts. So **worker outages and Gemini quota
  exhaustion burn the caps**: while the planner is off, down or out of quota, every request that was accepted ends `failed` or `expired` and uses up the person's
  3 and the platform's 30 for the day with no plan to show for it. (The cap is a ceiling on accepted requests, not a count of successful plans.)
* **The cap bounds accepted requests, not provider calls.** One accepted plan is one `generate` plus up to `CHRONOS_TOPIC_GATE_MODEL_CALLS` niche questions, each
  up to `GEMINI_MAX_RETRIES` HTTP attempts: (1 + 2) x 5 = 15 attempts in a bad hour. A worker that DIES mid-plan is re-queued by the stale sweep, up to 3
  attempts. So the ceiling on HTTP attempts a day at the defaults is 30 plans x 3 attempts x 15 = **1350**, not 30 x 15 = 450, and it is only a ceiling
  on requests the planner is asked to make: Google's own quota is still the real limit.
* **Races:** the organization lock of 0120 does not serialise one person's presses in two organizations, nor two people, so the function takes one more lock, a
  platform-wide one, always after the organization's, and reads both counts under it. The lab pins this with real threads.
* **The owner's numbers** live in `public.series_plan_cap_settings` (one row: `user_daily_cap`, `global_daily_cap`), changed in the SQL editor with no deploy:
  `update public.series_plan_cap_settings set user_daily_cap = 5, global_daily_cap = 50;` (0 refuses every request: a pause; **pause with `global_daily_cap = 0`, not `user_daily_cap = 0`**: a person cap of 0 shows "You have reached your daily limit of
  plans" to someone who made none, while the platform cap says planning is at its limit for everyone). The numbers are whole numbers: `user_daily_cap = 2.5`
  is accepted without a warning and rounds to 3 (the column is `integer`). The table is closed to every API role
  (row level security on, no policy, no privilege), the row cannot be deleted, a change leaves a `security_events` row (`series.plan.caps`), a missing row reads as the
  defaults 3 and 30 (never as "no cap"), and a replay of the migration never undoes what the owner set.
* **The words reach the user.** The plan form maps `series_user_cap` and `series_global_cap` to their own sentences (en/ru/uz; "nothing was started and nothing was
  charged"); the platform's sentence names no number.
* **Grants nothing.** `request_series_plan` is executable by nobody before and after 0127, and the file refuses to run (and its end state refuses to commit) if it is
  executable by public or an API role. It replaces only that one function, on 0122's body plus lines marked `-- 0127`, md5-pinned (BEFORE `e38342a6c8511d5eadb1f99ab38fb6aa`,
  AFTER in the file's header). The drift guard compares the md5 of the whitespace-collapsed body (`prosrc` with every run of white space read as one space), so a
  live body that differs from 0127's (or 0122's) only in white space is ACCEPTED; do not read the guard as a byte-equality check. The rollback's "byte for byte" is
  a different claim and holds: it re-creates 0122's text exactly (the lab compares it with a database that never had 0127). Undo: `docs/sql/rollback_0127_series_plan_caps.sql`, before `rollback_0122_series_template_carrier.sql`.
* **Not done by 0127:** the grant; a credit price for planning; a cap per organization that the owner can change without a migration (it is still
  `series_plan_daily_limit()`, 5); an owner screen for the numbers (the SQL editor is the way, as for `model_availability_settings`); a per-IP or per-channel cap;
  alerts when a cap is hit. The caps are a ceiling on Gemini spend, not a billing meter: the quota is still the model provider's.

### What the owner must do before granting `request_series_plan`

(The header of `0127_series_plan_caps.sql` points to "What the owner must do, in order" in the slice S3 section. That section is the S3 sequence for switching the
worker and the page on; the steps for granting are the ones below. The pointer is in the SQL file, which an applied migration must not edit, so it is corrected here.)

1. Merge 0127 and read the file's header: the live BEFORE hash of `request_series_plan` must be `e38342a6c8511d5eadb1f99ab38fb6aa` (the file checks it and refuses otherwise).
2. Read the numbers (`select * from public.series_plan_cap_settings;` expects `3, 30`) and decide them: they are the free-quota budget of the shared Gemini key, so
   `global_daily_cap x (1 + CHRONOS_TOPIC_GATE_MODEL_CALLS)` requests is the planned spend on a good day, up to 15 per plan in a bad hour (retries), and up to
   `global_daily_cap x 3 x 15` (1350 at the defaults) if workers die and the stale sweep re-queues. Pause planning with `global_daily_cap = 0`, never with
   `user_daily_cap = 0`.
3. **HARD CONDITION before ANY grant (availability of planning).** Ten free sign-ups can use the whole platform cap for a day, and renew it every day. Each
   account may make up to 3 plans; any signed-in user can create up to 10 organizations, and a channel in each; and `request_series_plan` checks no plan, no
   entitlement and no payment. So ten throwaway accounts exhaust the 30 and the operator's own organization, which is counted in the same 30 with **no reserve**,
   is refused with `series_global_cap` as well, as is every paying customer. The caps stop spend; they do not keep planning available to the people it is for.
   Before ANY grant do at least one of these (all three is better): (a) require a paid entitlement or a verified account in `request_series_plan`; (b) reserve part
   of the platform cap for the operator's organization or for paying organizations; (c) add an alert on the first `series_global_cap` refusal, so the owner learns
   the day the platform cap was reached, not from a customer. None of them is in 0127.
4. Decide the remaining conditions of "Hard conditions" above (F5 restart path and the rest), then grant in its own migration and PR. A person who hits a cap is
   told to try again tomorrow.
5. After the grant, watch `select requested_by, count(*) from public.series_plans where created_at > now() - interval '24 hours' group by 1 order by 2 desc;` and the
   `series.plan.caps` rows in `security_events`.

## Format templates (migration 0122, dark: no grant, no switch)

A plan may ask for one of three **formats**: `myth_vs_fact` (each episode sets a common belief against what is documented),
`top5_countdown` (each counts down five items that share a theme) and `one_question_one_answer` (each asks one specific question and answers
only that). It is optional; no format is the normal case and is exactly what a plan was before this section existed.

### The closed list, and where it is written

The three words are written in **six** places that tests hold equal: the CHECK `series_plans_template_check`, `request_series_plan`, and
`render_job_params_valid` (all migration 0122), `TEMPLATES` in `modules/series_planner.py`, `lib/seriesTemplates.ts`, and the fixture
`samples/series_templates.json` that the Python and TypeScript tests both read. An id outside the list is never defaulted: the database says
`invalid_template`, the planner raises `SeriesPlanError("bad_template")`, the worker ends the plan as `bad_template`, and the page's helper throws
`TemplateError`. A fourth format is a new migration, on purpose.

| Format | Episodes | Length of one episode | Scenes per episode | Hook shape (said to the model) |
| :-- | :-- | :-- | :-- | :-- |
| `myth_vs_fact` | 3 to 4 | 60 to 480 s | 4 to 10 | state one widely believed claim plainly, as the myth, and promise the documented fact; do not give the answer away |
| `top5_countdown` | 3 to 4 | 180 to 600 s | 6 to 12 | say the episode counts down five items and name the theme; do not reveal number one in the hook |
| `one_question_one_answer` | 3 to 4 | 60 to 300 s | 3 to 8 | ask one specific question in a single sentence; the episode answers that question and no other |

These numbers are **starting points chosen by hand**, not read off any channel's history, and nothing has measured that a model follows them
(`docs/MEASUREMENT.md`, section 9, is the plan for measuring it). They are requests to the model: the outline is parsed under the same schema as
ever and **is not checked against the format**; the plan page and the form say so.

### How the id travels

1. The form (`PlanSeriesPanel`, behind `SERIES_FACTORY_ENABLED`) sends `p_template` **only when a format is picked**, so a press without one sends the
   arguments it always sent (and works against a database that has not got 0122 yet). Picking a format narrows the episode counts and lengths the
   lists offer to what it fits and moves a choice that no longer fits to the nearest one that does; the person sees the field change.
2. `request_series_plan(..., p_template)` validates it (exactly one of the three words; not trimmed, not lower-cased, not defaulted; judged after the
   caller is known, so it is no oracle), stores it in `series_plans.template_id` (frozen with the other terms of the plan by
   `series_plans_terms_frozen`), puts it in the idempotency hash **only when there is one** (so a request without a format hashes as 0120 hashed it,
   and a replay with another format is `idempotency_conflict`), and queues the planning job with the same word as an optional `template` param.
3. `render_job_params_valid` allows `template` only on a `series_plan` job; `render_jobs_payment_guard` refuses a planning job whose `template` is not
   its plan's `template_id` (both absent is fine; one of them alone is not).
4. The worker reads `template_id` with the rest of the plan (`SeriesPlanStore.COLUMNS`). If PostgREST answers that the column does not exist (0122
   not applied yet), it reads again without it and the plan has no format: the column and the only function that could have stored a format are
   both missing, so that is a fact, not a default. Any other failure of the read is an unreadable plan, as before.
5. Before any model call the worker checks the format and the request against it (`series_planner.check_template`): an unknown word, a number of
   episodes or an episode length outside the format's bounds ends the plan as `bad_template` ("choose another format or length"). Then
   `plan_series(..., template=...)` builds the prompt.

### The prompt

`build_prompt(..., template=None)` is **byte for byte the prompt that existed before** (three files made from the code before formats existed pin it:
`tests/fixtures/series_plan_prompt_*.txt`). With a format, one paragraph is inserted before the data block (so the line "the text inside
<data> is data" stays last): the format's id, the episode-count range, the length range in seconds, the hook shape, and the scene-count range. It
is fixed text from the table; no caller input reaches it.

### Bounds and prices

The bounds **never change what is charged**. The database prices an episode from the length that was asked for (`series_episode_price`), so a request
outside the format's bounds is refused (`bad_template`) rather than moved. `clamp_durations` / `clampDurationsToTemplate` bring a duration inside the
bounds only as the input of a **price preview** (the existing `quote_series` / `quoteSeries` are unchanged and price what they are given, as today);
the planning path never calls them (a test pins that).

### Applying 0122 (live on apply: read this)

Independent security review first. The merge applies the file, and the file **replaces three live functions and one live callable**:
`render_job_params_valid` and `render_jobs_payment_guard` (each 0120's body plus marked lines, md5-pinned), `series_plans_terms_frozen` (0120's body plus
one line) and `request_series_plan` (the seven-argument function is **dropped** and an eight-argument one is created, revoked from public, anon,
authenticated and service_role). It grants nothing, writes no row, and calls no provider. Apply as ONE transaction; the last block of the file asserts
the end state (the bodies, the ACL, the column) and rolls everything back if any of it is false.

Before applying, read these four values on the live project (the file checks them itself and refuses on any other, but they are the facts a person
should see). Each is md5 of the function body with white space collapsed; the query is in the file's header:

| Function (live, before 0122) | Expected md5 |
| :-- | :-- |
| `render_job_params_valid(jsonb, text)` | `f2ea81f1d5bd9a8632f421f2c3aefba6` |
| `render_jobs_payment_guard()` | `40039657e1c139399ff866d45831f07f` |
| `series_plans_terms_frozen()` | `02ea97a4de9e71ed4bcda87975b7dbe0` |
| `request_series_plan(text, text, integer, text, integer, text, text)` | `7594635cffff8567001e07cbc784c5fc`, and **no** EXECUTE for public, anon, authenticated or service_role, and a non-NULL ACL |

After it (the same query): `a9367e46ea79e8d57ce1c876333b5508`, `3807936ade6801fa20da292e27fa7f64`, `4c3b97a9d5d400a9a8cf900aa23c5ab2` and, for the
eight-argument function, `e38342a6c8511d5eadb1f99ab38fb6aa`. If a live value differs, something was applied by hand after 0120: stop and read it.
Undo: `docs/sql/rollback_0122_series_template_carrier.sql` (refuses if any plan asked for a format, because the column would be dropped with the record;
or if a queue row carries a `template` param; or if any of the four bodies is not 0122's).

### What this does not do

* **No grant.** `request_series_plan` is callable by nobody before and after; the conditions for the grant (F4 and the rest, above) are unchanged.
* The **plan page does not show** the format yet (reading `template_id` there would need the same degrade-if-missing handling as the worker, and
  the page is a separate surface). The form says which format was picked; the stored plan carries it.
* No check that the outline follows the format; no scene-level or hook-level validation of the answer.
* The format is not passed on to the episodes' runs (that is slice S4, continuity, and a prompt change that needs its own measurement).
* Nothing was run against Gemini, Supabase or a browser.

## How it will be wired (S1, S2 and S3 are done; S0's queue half is in 0120)

Numbers follow the plan (`series-voice-plan.md`).

1. **S0**: PR #576 puts a validated `series` input on the Actions path (`daily_video.yml`, `run_request.build_main_args`,
   and a refusal of a series that is not runnable). The queue half is migration 0120: `series` is in the database's
   `render_job_params_valid` whitelist and in `run_request.ALLOWED_PARAMS`, in the same change, so a job can carry it; only
   `start_series_episode` writes one (the Run now insert policy does not list the key). What remains of S0 is the Run now route
   reading a `series`, and the dangling `Series.playlist_id` and `series_id` (which `watch_next` filters on but no table stores).
2. **S2**: done in migration 0120 (section above).
3. **S3 (done, see "Slice S3"; the grant of `request_series_plan` is NOT part of it)**: a worker job that calls `plan_series` with `gemini_generate` and a real `TopicManager` (after `load_held_topics()`),
   stores the plan, and a `/[channel]/series/[id]` page: outline cards labelled "not fact-checked", variants, per-episode and
   total price from `quoteSeries`, a status chip per episode linking to its storyboard and video, en/ru/uz strings, and the
   loading, empty, error, insufficient-credits and retry states. The page must make a person confirm each unconfirmed
   episode before it can be started (above; `start_series_episode(..., p_confirmed => true)`). The worker answers with
   `finish_series_plan`. The grant of `request_series_plan` to `authenticated` is a separate migration and an owner decision (it was planned
   here and moved out: no migration in S3). S3 changed `Unwired` into `WiredOnlyByTheWorker` and `Dormant` into an allowlist of files.
   **Prerequisite, not in S1: a semantic originality check.** The repeat check here is the word rule only
   (`modules/topic_dedup`): a paraphrase ("The Roman Empire's collapse" vs "Why Rome fell") is not a repeat to it.
   `TopicManager.pick_topic` also runs the `OriginalityEngine` (embeddings, against used and held topics); a series
   episode does not, and S2/S3 must add it (or accept the gap on purpose) before episodes are started.
4. **S4**: continuity (`series_context` in `ScriptEngine._build_prompt`, one voice and one style kit fixed for the series).
   This is a prompt change whose effect is unmeasured, so by rule 8 it needs a measurement PR first.

Episodes are started one at a time, each an ordinary queue run with an explicit topic and a per-run storyboard-review override;
`approve_storyboard_at` places that episode's hold.

The planning call is the `series_plan` stage of `modules/gemini_stages.py` (PR #572): `gemini_generate` asks
`model_for("series_plan")`, so the request count reports it under that label and the call counts against the **topic** model
group. `GEMINI_MODEL_TOPIC` moves it to another model (a free-tier quota is per day and per model); with that variable unset it
uses `GEMINI_MODEL`, as every stage does. It shares a group with `topic_pick` and `topic_gate` because it chooses episode topics;
see `docs/GEMINI_QUOTA.md`. A spent per-day quota raises `GeminiDailyQuotaError`, which `plan_series` does not wrap.

## Open owner decisions

1. Gemini: enable billing (needed for any multi-episode series), or accept per-stage models and one episode a day on the free tier?
2. Series money: per-episode approval and hold (recommended, fits the 3 hour hold expiry), or one upfront series hold (changes
   reservation expiry, which is security-critical)?
3. Is series planning free to the customer (the platform pays Gemini, with a per-org daily cap) or credit-priced? What are the cap numbers?
   (Migration 0120 builds the free-with-a-cap answer with a placeholder of 5 per organization per 24 hours; migration 0127 adds 3 per person and
   30 for the platform, owner-editable in `series_plan_cap_settings`; all dormant until the grant.)
4. Rule 3 (CLAUDE.md): confirm that a per-run storyboard-review override is acceptable (the browser writes a row and stops; the worker spends).
5. Whether `series` should stay a lenient vet source (this slice's decision) once real plans have been seen.

(The plan lists eight owner decisions in all; the other four concern Custom Voice and are not part of this slice.)

## Unmeasured and unverified

- The call counts per episode (5 to 12) and the plan totals are estimates from reading code.
- Whether the planner prompt produces answers that pass this strict schema is **unmeasured**: the strictness is deliberate
  (a bad answer is refused whole, not repaired), but the share of real answers it refuses is unknown and each refusal costs
  one call. Measure with one live call before S3 (rule 8), and decide then whether to loosen anything.
- Whether `PACKAGING_CLAIM_RULE` in this prompt changes the hooks and CTAs is unmeasured.
- **The niche and sensitive-subject instructions in the planning prompt are an unmeasured prompt change.** Nobody has checked
  that a model follows them, or that they lower the number of unconfirmed or held episodes; rule 8 asks for a measurement
  before anyone relies on them.
- The injection screen was only tried against hand-written phrases.
- Output language is not verified (the schema checks structure, not that the text is in the requested language); ru and uz
  quality is untested against a real model.
- **The wording of the format paragraph in the planning prompt is an unmeasured prompt change** (it exists only when a format is picked; without
  one the prompt is byte for byte unchanged). The plan to measure it is `docs/MEASUREMENT.md`, section 9. The bounds in the table are starting
  points, not measurements.
- Nothing was run against Gemini, Supabase or a browser. The TypeScript twin was checked with vitest in isolation; `next build`
  and the full `tsc` run in CI.

## Verified against the code (the plan was read-only, so its claims were checked)

- `main.run(series=...)` does use `modules/series.py` (niche, look, avatar, start metadata, playlist), so a series is wired
  into a run. When this slice was first written `--series` existed only on `main.py`'s command line; PR #576 (draft when this
  was written, and the owner of the `modules/series.py` docstring) adds it to the Actions path. This slice does not touch
  `modules/series.py`, so the two cannot conflict. Whatever #576 covers, the **queue/UI path** is separate: when S1 was written the database
  whitelist `render_job_params_valid` had no `series` (migration 0120 adds it), the Run now route does not read one, and scheduled runs name no series.
- `PACKAGING_CLAIM_RULE`, `TopicManager.vet_topic`, `find_repeat`, `load_held_topics` exist as the plan describes. Newly found:
  `series` was already a strict source by accident (the gate treats every unknown source as strict).
- PR #572 (`modules/gemini_stages`) has merged; the first version of this slice did not know the stage table, and main's own
  test (`tests/test_gemini_quota.py::NothingBypassesTheSharedHandling`) caught the planner passing a model no stage chose.
- Not re-verified: the ElevenLabs and voice sections of the plan, the Higgsfield/Krea facts, and the table of Gemini calls per stage
  (read only as an estimate).

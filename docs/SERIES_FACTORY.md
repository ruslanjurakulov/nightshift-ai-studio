# Series Factory

A series is 3 or 4 episodes of one channel, planned together, priced before anything is spent, and made one at a time.
This page describes **slice S1** (a pure planner and a pure price preview) and **slice S2** (migration 0120: the tables, the functions
that spend, and the queue kind; section "Slice S2" below). Nothing here runs yet: no worker job, no route, no UI.

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

- **Not wired.** Nothing in `main.py`, `tools/`, `modules/`, a route, a component or a workflow imports or names it.
  `tests/test_series_planner.py::Unwired` fails if something does, so the PR that wires it has to change that test on purpose.
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
| `request_series_plan(p_channel text, p_topic text, p_n integer, p_language text, p_duration_s integer, p_series text, p_idem text) returns jsonb` | **nobody yet** (see below); editor or above once granted | `{id, status: 'requested', render_job_id, replayed}` |
| `finish_series_plan(p_plan uuid, p_ok boolean, p_title text, p_report jsonb, p_quote jsonb, p_episodes jsonb, p_error_code text default null, p_error text default null) returns jsonb` | service role only | `{id, status: 'ready' or 'failed', replayed}` |
| `quote_series_episode(p_episode uuid) returns jsonb` | any member of the organization (viewer or above) | `{episode_id, plan_id, n, status, duration_s, exempt, price_status: 'priced' / 'unpriced' / 'included', credits (or null), needs_confirmation, blocked_by (a word or null), may_start, startable}` |
| `start_series_episode(p_episode uuid, p_max_credits numeric, p_idem text, p_confirmed boolean default false) returns jsonb` | an **admin** of the organization (a platform administrator in the operator's own organization) | `{id, plan_id, n, status: 'started', render_job_id, credit_ref, credits_held, started_at, replayed}` |

Reading is by RLS: a member selects their organization's `series_plans` and `series_episodes`. There is no direct write for any API role,
the service key included.

Errors are SQLSTATE plus a fixed word (the message). The ones a UI maps: `not_found` (P0002; a missing id, another organization's id, a
channel or series outside the caller's scope: one answer, no oracle), `forbidden` (42501; a viewer, or an editor starting an episode),
`invalid_*` (22023; `invalid_topic`, `invalid_episode_count`, `invalid_duration`, `invalid_language`, `invalid_idempotency_key`,
`no_niche`), `idempotency_conflict`, `plan_in_progress`, `earlier_episode_not_finished`, `episode_not_usable`, `plan_not_ready`,
`already_started`, `series_not_runnable`, `price_changed` (all NS409; the current price is in the error detail, `credits=15.00`),
`unpriced` and `confirmation_required` (NS400), `price_required` (22023), `insufficient credits` (NS402, as every hold), `rate_limited`
(NS429, `limit=5 per 24 hours`), and `parallel run limit reached` (NS429, the plan's concurrency limit, from the existing hold trigger).

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
  worker took it. The cap counts failed plans (a model call was spent) and is checked after the idempotency replay, under an advisory lock
  per organization, so concurrent requests cannot both pass it.
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

- **F4: the cap is per organization, and one account can have many organizations.** `create_organization` allows 10 organizations per
  account, so one person can make 10 x 5 = 50 planning requests a day (each one a model call on the platform's shared Gemini key). Add a
  per-user cap and/or a global daily cap, in the database, before the grant.
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

## How it will be wired (S1 and S2 are done; S0's queue half is in 0120)

Numbers follow the plan (`series-voice-plan.md`).

1. **S0**: PR #576 puts a validated `series` input on the Actions path (`daily_video.yml`, `run_request.build_main_args`,
   and a refusal of a series that is not runnable). The queue half is migration 0120: `series` is in the database's
   `render_job_params_valid` whitelist and in `run_request.ALLOWED_PARAMS`, in the same change, so a job can carry it; only
   `start_series_episode` writes one (the Run now insert policy does not list the key). What remains of S0 is the Run now route
   reading a `series`, and the dangling `Series.playlist_id` and `series_id` (which `watch_next` filters on but no table stores).
2. **S2**: done in migration 0120 (section above).
3. **S3**: a worker job that calls `plan_series` with `gemini_generate` and a real `TopicManager` (after `load_held_topics()`),
   stores the plan, and a `/[channel]/series/[id]` page: outline cards labelled "not fact-checked", variants, per-episode and
   total price from `quoteSeries`, a status chip per episode linking to its storyboard and video, en/ru/uz strings, and the
   loading, empty, error, insufficient-credits and retry states. The page must make a person confirm each unconfirmed
   episode before it can be started (above; `start_series_episode(..., p_confirmed => true)`). S3's migration grants
   `request_series_plan` to `authenticated` and its worker answers with `finish_series_plan`. This PR must update `Unwired`
   (and `tests/test_series_tables_migration.py::Dormant`).
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
   (Migration 0120 builds the free-with-a-cap answer with a placeholder of 5 per organization per 24 hours; it is dormant until S3.)
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

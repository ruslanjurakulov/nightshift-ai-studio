# Series Factory

A series is 3 or 4 episodes of one channel, planned together, priced before anything is spent, and made one at a time.
This page describes **slice S1**, which is the first and smallest piece: a pure planner and a pure price preview.
Nothing here runs yet.

## What S1 is

| Piece | Where | What it does |
| :-- | :-- | :-- |
| `plan_series(...)` | `modules/series_planner.py` | ONE model call (through an injected `generate`) that outlines N episodes, parsed under a strict schema, each episode vetted on its own |
| `quote_series(durations_s, estimator)` | `modules/series_planner.py` | per-episode credits and a series total, from an injected estimator |
| `quoteSeries()` | `command-center/lib/credits.ts` | the same, as a pure TypeScript function over the existing `estimateRunCredits` (which is not changed) |
| `series_call_budget(n)` / `seriesCallBudget(n)` | both | the Gemini calls a series needs, as an estimate to compare with a daily quota |
| `gemini_generate(...)` | `modules/series_planner.py` | the adapter a later worker job passes as `generate`: one `gemini_client.generate_with_retry` call. Tested with a fake client only |

Tests use fakes only, with the network patched to fail: `tests/test_series_planner.py`, `command-center/tests/seriesQuote.test.ts`,
and a fixture both read, `tests/fixtures/series_quote_cases.txt`, so the Python and TypeScript totals cannot drift apart.

## What S1 is not

- **Not wired.** Nothing in `main.py`, `tools/`, `modules/`, a route, a component or a workflow imports or names it.
  `tests/test_series_planner.py::Unwired` fails if something does, so the PR that wires it has to change that test on purpose.
- No migration, no table, no route, no UI, no workflow change, no live model call, no change to how a run behaves.
- No quota API. `series_call_budget` only reports an estimate; it cannot refuse anything, because the repo cannot read the
  key's remaining daily quota.
- No series-scoped run. `main.run(series=...)` resolves a `modules/series.py` series for niche, look and playlist, but the
  queue and UI path never carries one (see "Verified against the code" below). That is slice S0 in the plan, not this one.
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

`plan_series(topic, n_episodes, *, generate, vet, niche="", channel_name="", language="English", find_repeat=None,
held_topics_checked=None, stage="series_plan")` returns a `SeriesPlan`; `plan.to_dict()` is plain JSON.

- `n_episodes` is 3 or 4; anything else (2, 5, a bool, a string) is refused **before** any call is spent.
- Per episode: `topic` (the standalone subject, what would be passed to a run as an explicit topic), `working_title`, `angle`,
  `hook_sentence`, `hook_variants` (2 or 3), `cta_variants` (2 or 3), `open_loop`, `cliffhanger`, `key_facts` (1 to 6).
  The episode number is assigned by order, never taken from the model.
- Per episode report: `usable`, `reasons` (fixed words), `vet` (`action`, `reason`, `detail`, `check` of the gate verdict),
  `repeat_of` (the channel's own past or held topic it repeats), `niche_confirmed`.
- Plan: `status` is `ready` (every episode usable), `partial` (some) or `blocked` (none), with `usable_episodes`;
  `held_topics_checked` is `true`/`false`/`null` as the caller said (see below); `plan_calls_made` is 1; `call_budget`.

A rejected or repeated episode is **reported with its reason**. It is never dropped, never replaced by a second model call,
and the proposed text stays in the report so a person can read what was refused.

### How a wrong answer ends

All of these are a `SeriesPlanError` with a fixed `code` and a field path, never a partial plan and never another exception
(a seeded fuzz test checks that nothing else escapes). The error never repeats model text, which may be hostile.

| code | meaning |
| :-- | :-- |
| `bad_count`, `bad_input`, `bad_language` | the caller's arguments; refused before the call |
| `generate_failed` | the injected call raised (quota, outage); only the exception type is kept |
| `empty_response`, `response_too_large`, `not_json` | no text, over 40,000 characters, or not exactly one JSON object (prose around the JSON is refused, a ```json fence is accepted; duplicate keys, NaN and Infinity are refused) |
| `bad_shape` | not an object with exactly `series_title` and `episodes`; an episode with missing or extra keys |
| `wrong_count` | the model returned a number of episodes other than the one asked for |
| `bad_field`, `too_long` | a non-string, an empty string, a list of the wrong length or with a repeated item, a string over its limit |
| `markup`, `cue_tag`, `hidden_characters` | `<` `>`, an entity, a link or a code fence; `[SFX: ...]` or any `[word: ...]` tag; control, bidi, zero-width, line-break and other invisible characters |
| `injection` | a phrase that addresses the next stage ("ignore previous instructions", "system prompt", ...; en, ru, uz). A phrase list, not a guarantee. A normal title that happens to contain one of these phrases will be refused, and that is accepted: the failure is closed and costs one retry |
| `duplicate_topics` | two episodes are the same topic by `modules/topic_dedup.is_same_topic` |

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

- Every non-operator source: the words reject a clearly off-niche topic (`off_niche`) and a sensitive one (`needs_human`:
  living people in live cases, medical claims, minors, active tragedies, crime and legal).
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
3. The words still reject what matters most (off-niche, sensitive), for every source. `tests/test_series_planner.py::TheRealGate`
   runs the real `vet_topic` and shows the rejections with no model call.

What this costs, stated plainly: an episode the words cannot place is accepted without anyone confirming it is on-niche.
That is **not hidden**: the report keeps the verdict, `niche_confirmed` is `false` for it (`detail` is `unchecked`), and the UI
should show it as "niche not confirmed", not as a pass. If a later measurement shows lenient acceptance letting off-niche
episodes through, the fix is one word.

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
  gap (`no_prices`, `no_length`, `no_history`, `unpriced_history` from `estimateRunCredits`; `unknown`, `estimator_error`,
  `invalid_estimate` from the Python side). Never 0.
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

## How it will be wired (not in S1)

Numbers follow the plan (`series-voice-plan.md`).

1. **S0** (separate, needs a migration): carry a validated `series_id` through `run_request.build_main_args`, the Run now route
   and the queue params (`render_job_params_valid` whitelist), and fix `Series.playlist_id` and the `series_id` that
   `watch_next` filters on but no table stores.
2. **S2** (migration, owner approval and independent security review): `series_plans` and `series_episodes`, functions in the
   `quote_workflow` / `start_workflow_run` style (`request_series_plan` rate-limited per org and idempotent,
   `finish_series_plan` for the service role, `start_series_episode` that reserves and queues), `render_jobs` kind
   `series_plan`, RLS with members reading and no direct writes.
3. **S3**: a worker job that calls `plan_series` with `gemini_generate` and a real `TopicManager` (after `load_held_topics()`),
   stores the plan, and a `/[channel]/series/[id]` page: outline cards labelled "not fact-checked", variants, per-episode and
   total price from `quoteSeries`, a status chip per episode linking to its storyboard and video, en/ru/uz strings, and the
   loading, empty, error, insufficient-credits and retry states. This PR must update `Unwired`.
4. **S4**: continuity (`series_context` in `ScriptEngine._build_prompt`, one voice and one style kit fixed for the series).
   This is a prompt change whose effect is unmeasured, so by rule 8 it needs a measurement PR first.

Episodes are started one at a time, each an ordinary queue run with an explicit topic and a per-run storyboard-review override;
`approve_storyboard_at` places that episode's hold. The model for the planning call is `config.GEMINI_MODEL` today. PR #572
(per-stage models) had not merged when this was written; `plan_series` passes `stage` to `generate` so choosing a per-stage
model later is a change in the adapter, not here.

## Open owner decisions

1. Gemini: enable billing (needed for any multi-episode series), or accept per-stage models and one episode a day on the free tier?
2. Series money: per-episode approval and hold (recommended, fits the 3 hour hold expiry), or one upfront series hold (changes
   reservation expiry, which is security-critical)?
3. Is series planning free to the customer (the platform pays Gemini, with a per-org daily cap) or credit-priced? What are the cap numbers?
4. Rule 3 (CLAUDE.md): confirm that a per-run storyboard-review override is acceptable (the browser writes a row and stops; the worker spends).
5. Whether `series` should stay a lenient vet source (this slice's decision) once real plans have been seen.

(The plan lists eight owner decisions in all; the other four concern Custom Voice and are not part of this slice.)

## Unmeasured and unverified

- The call counts per episode (5 to 12) and the plan totals are estimates from reading code.
- Whether the planner prompt produces answers that pass this strict schema is **unmeasured**: the strictness is deliberate
  (a bad answer is refused whole, not repaired), but the share of real answers it refuses is unknown and each refusal costs
  one call. Measure with one live call before S3 (rule 8), and decide then whether to loosen anything.
- Whether `PACKAGING_CLAIM_RULE` in this prompt changes the hooks and CTAs is unmeasured.
- The injection screen was only tried against hand-written phrases.
- Output language is not verified (the schema checks structure, not that the text is in the requested language); ru and uz
  quality is untested against a real model.
- Nothing was run against Gemini, Supabase or a browser. The TypeScript twin was checked with vitest in isolation; `next build`
  and the full `tsc` run in CI.

## Verified against the code (the plan was read-only, so its claims were checked)

- `main.run(series=...)` does use `modules/series.py` (niche, look, avatar, start metadata, playlist), so the old module
  docstring ("not wired into a run") was stale; this slice corrects the docstring only.
- `--series` exists only on `main.py`'s command line: `modules/run_request.py` never mentions it, `daily_video.yml` has no
  series input, and the Run now route does not read one.
- `PACKAGING_CLAIM_RULE`, `TopicManager.vet_topic`, `find_repeat`, `load_held_topics` exist as the plan describes. Newly found:
  `series` was already a strict source by accident (the gate treats every unknown source as strict).
- PR #572 (`modules/gemini_stages`) had not merged into `origin/main` when this was built.
- Not re-verified: the ElevenLabs and voice sections of the plan, the Higgsfield/Krea facts, and the table of Gemini calls per stage
  (read only as an estimate).

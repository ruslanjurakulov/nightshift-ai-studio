# Grounded fact-check

`modules/grounding.py` · switches `NIGHTSHIFT_GROUNDED_FACTCHECK`, `NIGHTSHIFT_FACTCHECK_SYSTEM_PROMPT` · files `output/<slug>/fact_check.json`, `output/<slug>/grounding.json`

## Why

The fact-check (`modules/fact_checker.py`) asked the same model that wrote the script. It shares the
writer's blind spots, so a wrong date the writer "remembers" can pass, and on an obscure topic it cannot
confirm anything, so every claim is flagged (run 2026-10-22: 28 of 28 held before render). Grounding adds a
second, checkable opinion: passages from the English Wikipedia, a free, keyless, citable source.

## Read this first: what it does and does not prove

* A verbatim quote proves that **the page says those words**. It does **not** prove the claim is true
  (Wikipedia can be wrong), and it does not prove the words are *about* the claim: a **judge model** decides
  that, and the checks in code below are **guards, not proof**. They refuse many wrong clearances; a sentence
  that is about something else can still get through. A person still reviews every video, and the review
  panel shows each clearance with its quote and its source so it can be audited.
* **Grounding is conservative.** It starts from the checker's verdicts and can only clear a claim under the
  guards below. It adds a flag when a source contradicts a claim.
* **A checker verdict that was clamped is never cleared.** Until the change in "The checker's system prompt"
  below, `FACT_CHECK_SYSTEM_PROMPT` was defined in `modules/fact_checker.py` but never sent, so the model had not
  been told the three verdict words and answered in a schema of its own (JSON booleans, an `explanation` key;
  Actions run 39749438994). Anything that is not one of the three words is read as `unverifiable`
  (`FactCheckResult.clamped`), because the word it meant may have been `likely_inaccurate`. That rule is
  unchanged and is what keeps a model that ignores the prompt from clearing anything. The log carries a
  per-batch histogram of the raw verdict words and the item keys (structure only), and `fact_check.json` rows
  show `clamped` / `raw_verdict`.

## The checker's system prompt

**Evidence.** Run 39749438994 (topic "Lost Colony of Roanoke"): `verdict outside the three known values for 30
of 30 claim(s) ... verdicts {True=29, False=1}; item keys {claim,explanation,index,verdict=30}`, then `22 of
22 ... {True=22}; item keys {explanation,index,verdict=22}`. All 52 claims were clamped to `unverifiable`, all 52
were flagged, and the publish gate held the video (`fact_check_flagged:43`, exit 79).

**Diagnosis.** The call was `generate_with_retry(client, GEMINI_MODEL, prompt)` with no config, so
`FACT_CHECK_SYSTEM_PROMPT` (the three words, the `reasoning` key) never reached the model. It invented
booleans and `explanation`, which is what a model does with a schema it was never given.

**Change.** The prompt is sent through the same `json_config(None, system_instruction=...)` helper the research
and video-critic calls use (JSON MIME type, no response schema), unless `NIGHTSHIFT_FACTCHECK_SYSTEM_PROMPT` is
`off` / `0` / `false` / `no` / `disabled` / `none`. Empty (what the deploy writes for an unset variable) is ON.
Nothing in how the answer is read changed: a boolean, an unknown word, a missing `verdict` key are still
clamped to `unverifiable`, the parser still reads `reasoning` only (a valid word under `explanation` is read with
empty reasoning), and `requires_human_review` is still computed from the verdict. `tests/test_factcheck_system_prompt.py`
pins each of those. The variable reaches the runners like `NIGHTSHIFT_GROUNDED_FACTCHECK`: `daily_video.yml`,
`deploy_web.yml` (into `/opt/nightshift/.env.worker`) and `deploy/.env.worker.example`.

**What this changes for real.** Before, no checker verdict could ever be `likely_accurate`, so nothing was
cleared and nothing the checker said could be wrong in the lenient direction. After, the model can answer
`likely_accurate`, and **that verdict is not flagged for review**; the evidence lookup can also now clear
`unverifiable` claims. The guards in code are unchanged; what is NOT known is how the live model behaves.

**Precondition, measured live, before merging.** The false-accept rate of the checker on plausible-sounding
falsehoods has to be measured against the real model, and the result posted on the pull request:

    GEMINI_API_KEY=... python3 tools/factcheck_calibration.py --live

It asks the same request the pipeline sends about the 40 claims of `tools/factcheck_calibration_claims.json`
(15 true, 15 false including popular myths and one-detail swaps, 10 obscure). **Pass: 0 of the 15 false claims
come back `likely_accurate`.** It also reports how many of the 15 true claims clear (never required) and the
obscure ones (reported only). A run with any clamped or unresolved verdict is INCONCLUSIVE, not a pass. 15
false claims can only show that the rate is not high: a clean run is evidence, not a guarantee. The harness
measures the checker alone; the grounded lookup's own false-accept rate on reversals is the separate
measurement under "Documented residual" below. Offline (no `--live`) it only validates the data file; the
unit tests run it against a fake client.

## What it does, in order

1. `fact_check_claims` runs exactly as before and never sees the evidence. Its verdicts are the baseline.
2. `grounding` looks the topic and the names in the narration up: **three requests** for a normal video (a
   search for the topic, the full text of its best page, and ONE `titles=A|B|C` request for the names), on
   `en.wikipedia.org` only. At most 15 requests including retries, no redirect followed, a 1 MB cap per answer, one `User-Agent` that
   names the project, no secret. **Time bounds, said plainly:** the body is read in 8 KB chunks with the clock
   checked **between chunks**, and each `recv` has the 10 s socket timeout, so a server that sends *nothing* is
   cut; a server that deliberately sends a byte every few seconds **is NOT bounded** (a chunk only completes when
   8 KB have arrived, and the 90 s deadline is checked only between requests). There is no watchdog thread. The
   whole lookup is a **best-effort** step: its failure or slowness cannot block publishing beyond what the
   surrounding job timeout allows. Disambiguation and missing pages are skipped, every page is cut into passages of at most 700
   characters, and each claim is offered the (at most 3) passages that share words with it. The passages are
   saved in `grounding.json` (written atomically, UTF-8) with a `fetched_at` time and **reused** when the same topic
   is run again within 24 hours of the **first** fetch (no request; reuse and merging keep the oldest time, so a
   file cannot be kept alive by being reused). A file from an incomplete lookup records which steps failed (`failed_steps`); a re-run asks again for
   those steps only. An older file, one without a readable `fetched_at`, or one that says `complete: false` without naming
   what failed (everything is asked again) is not trusted as complete.
3. One model call per 15 claims (not per claim) matches the claims against the passages **only** and answers
   `supported` (snippet id and the exact words), `contradicted` (snippet id) or `not_found`. The call has a
   timeout and the whole matching phase has a deadline.
4. The answer is applied in code. The result keeps the checker's own verdict, the status, the effect
   (`upgraded` / `flagged` / `none`), the cited sources (title, URL, snippet id), the quote and, when it
   refused, the reason.

## The guards (each pinned by `tests/test_grounded_factcheck*.py`)

* `not_found` changes nothing.
* **A clearance** (`unverifiable` to `likely_accurate`) needs all of:
  * a snippet that was offered for that claim, and a quote found in that snippet (25 to 300 characters; `...`
    may join pieces of at least 12 characters, in order, **inside one sentence**);
  * every number of the claim in the quote, **one group per number** ("three ships" does not back "three ships
    and five hundred men"), and the same era (BC/AD) and regnal numerals as the quote's whole sentence
    ("Louis XIV" is not "Louis XV"; "Napoleon" is not "Napoleon III" even if the "III" is just outside the quote);
  * at least three of the claim's content words, or half of them, in the quote;
  * the claim's capitalised names in the quote's sentence;
  * no hedge ("allegedly", "legend", "according to", "unlikely", "falsely", "hoax", ...) in the **whole
    sentence** of the quote that the claim does not carry, and the same negation ("not", "never", "n't") on both
    sides;
  * room in the clearance budget: one claim per quote, two per snippet, at most 40% of a script's claims and
    never more than 10 (the count is recorded as `upgrade_cap` / `upgraded` / `refused_by_cap`).

  A result the checker called `likely_inaccurate`, or whose verdict was clamped, is never cleared.
* **A flag** (`contradicted` citing an offered snippet) turns the verdict into `likely_inaccurate`. This is the
  restrictive direction, so a quote is recorded when it checks out but is not required.
* **An outage changes nothing and says so.** Rate limit, timeout, an error page, a refused user agent, a failed
  model call: every verdict stays as the checker gave it, `grounding.unavailable` holds a reason word
  (`http_429`, `timeout`, `bad_response`, `judge_failed`, ...), the log carries a warning and the publish gate
  adds the warning `grounding_unavailable`. After a rate limit whose `Retry-After` is at most 20 s the lookup is
  tried once more. A lookup that worked and found no article is "no evidence", not an outage.
* **Snippets are untrusted data.** Anyone can edit Wikipedia. Snippets travel only inside a JSON block that the
  prompt declares to be data (and `<`/`>` are escaped inside it). Text inside a snippet can still persuade the
  judge model, so the guards above are what stand between it and a clearance.
* **Nothing about publishing changes.** The gate's blocks, exit code 79 and the early stop are untouched; the
  gate only *records* the lookup in `fact_check.grounding` of its event.

## Documented residual: semantic reversals

The guards are lexical. A sentence that says the **opposite** with the same words and numbers can still pass:

* verb swap ("X conquered Y" cleared by "X abandoned Y"), role reversal ("A defeated B" by "B defeated A"),
  comparative reversal ("The Ottomans won" by "The Ottomans lost", "larger than" by "smaller than").
* hedge and negation synonyms that are not on the lists (the lists are data and will grow).

**Precondition for the checker-prompt change** (the PR that sends `FACT_CHECK_SYSTEM_PROMPT` and so lets
clearances happen): before it merges, measure the **false-accept rate** of the guards plus the judge model
on exactly these shapes (reversals, hedge synonyms, negation synonyms), on real judge output, and decide with
the owner whether that rate is acceptable. That PR also carries the live calibration of the checker itself
(`tools/factcheck_calibration.py --live`, above). Neither measurement has been made: both need a Gemini key
with quota. Until the prompt is sent, clearances are refused for every clamped verdict, which was every real
verdict in run 39749438994.

## Turning it off

ON unless `NIGHTSHIFT_GROUNDED_FACTCHECK` is one of `off`, `0`, `false`, `no`, `disabled`, `none`
(case-insensitive). An unrecognised value keeps it ON and logs a warning (it never echoes the value).

* **One run, from a shell:** `NIGHTSHIFT_GROUNDED_FACTCHECK=off python main.py ...`. The variable is read when
  the fact-check runs, so setting it for a process switches it off for exactly that run.
* **Everything on GitHub Actions:** set the repository **variable** `NIGHTSHIFT_GROUNDED_FACTCHECK` to `off`
  (Settings, Secrets and variables, Actions, Variables). `daily_video.yml` passes it to every run.
* **The queue worker:** the same variable; `deploy_web.yml` copies it into `/opt/nightshift/.env.worker`
  on the next deploy.

A run with it off records `{"enabled": false}` in the event, so "off" is never confused with "found nothing".

## Where to see what it did

* `output/<slug>/fact_check.json`: per claim, a `grounding` object (only when evidence was involved) and, when
  the checker's verdict was clamped, `clamped` / `raw_verdict`.
* `output/<slug>/grounding.json`: the topic, the summary and every passage used, with the page revision id, so a
  quote can be audited after the page has changed.
* The `publish.allowed` / `publish.blocked` event: `fact_check.grounding` (counts, sources, `cleared` with the
  claim id, source and quote of each clearance, `clamped_verdicts`, `unavailable`).
* A held run: `hold_detail.grounding`, and `sources` on each flagged non-narration text. The video page's review
  panel shows "Sources checked online", each cleared claim with its quote, for held runs and, for uploaded
  ones, from the gate event.

## Limits

* English Wikipedia only. A script in another language is looked up with the names as written; claims that
  share few names or numbers with the English text come back `not_found` and are judged as before.
* The names are looked up as exact page titles: "Captain Morehouse" is no page and is skipped.
* Wikimedia rate-limits shared addresses (a CI runner or a cloud host can be throttled with `429` and
  `Retry-After`). The lookup honours it within its caps and then gives up as `unavailable`; if that is common on
  the runners, an authenticated Wikimedia API client is the follow-up (it needs a secret, so its own change).
* The research step (`research_engine.py`) is still the model's recall. Only the fact-check is grounded.

## Cost

Wikipedia is free. The model call is one per 15 claims with candidate passages, recorded in the cost ledger as
`gemini_input_tokens` / `gemini_output_tokens` with stage `fact_check_grounding`, so the spend guard and the
channel budget see it. A 28-claim script is two calls of roughly 5 to 8 thousand input tokens and about a
thousand output tokens in all: about a cent or less at flash-tier prices (an estimate, not a measurement: the
repository sets no price, see `CHRONOS_PRICE_GEMINI_*`, and the first real runs will show the token counts).

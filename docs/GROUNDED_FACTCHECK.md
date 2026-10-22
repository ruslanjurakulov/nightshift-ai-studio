# Grounded fact-check

`modules/grounding.py` · switch `NIGHTSHIFT_GROUNDED_FACTCHECK` · files `output/<slug>/fact_check.json`, `output/<slug>/grounding.json`

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
* **A checker verdict that was clamped is never cleared.** `FACT_CHECK_SYSTEM_PROMPT` is defined in
  `modules/fact_checker.py` but never sent, so the model has not been told the three verdict words, and
  anything else it says is read as `unverifiable` (`FactCheckResult.clamped`). The word it meant may have been
  `likely_inaccurate`. So until the checker's prompt is fixed (a **separate, measured** change, CLAUDE.md #8),
  most clearances will be refused by design, and this feature's enforcement only becomes meaningful once real
  checker verdicts reach it. The log now carries a per-batch histogram of the raw verdict words and the item
  keys (structure only), and `fact_check.json` rows show `clamped` / `raw_verdict`, so the next real run
  proves or kills that theory.

## What it does, in order

1. `fact_check_claims` runs exactly as before and never sees the evidence. Its verdicts are the baseline.
2. `grounding` looks the topic and the names in the narration up: **three requests** for a normal video (a
   search for the topic, the full text of its best page, and ONE `titles=A|B|C` request for the names), on
   `en.wikipedia.org` only. At most 15 requests including retries, no redirect followed, a 1 MB cap per answer, the body read in
   8 KB chunks with the clock checked **between chunks** (a read that stalls inside one chunk is bounded by the
   socket timeout of 10 s, and the whole lookup by a 90 s deadline checked between requests; there is no
   wall-clock watchdog), one `User-Agent` that names the project, no secret. Disambiguation and missing pages are skipped, every page is cut into passages of at most 700
   characters, and each claim is offered the (at most 3) passages that share words with it. The passages are
   saved in `grounding.json` with a `fetched_at` time and **reused** when the same topic is run again within 24 hours (no
   request). A file from an incomplete lookup records which steps failed (`failed_steps`); a re-run asks again for
   those steps only. An older file, or one without a readable `fetched_at`, is ignored.
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

**Precondition for the checker-prompt change** (the separate PR that sends `FACT_CHECK_SYSTEM_PROMPT` and so
lets clearances happen): before it merges, measure the **false-accept rate** of the guards plus the judge model
on exactly these shapes (reversals, hedge synonyms, negation synonyms), on real judge output, and decide with
the owner whether that rate is acceptable. Until then clearances are refused for every clamped verdict, which
is every real verdict today.

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

# Grounded fact-check

`modules/grounding.py` · switch `NIGHTSHIFT_GROUNDED_FACTCHECK` · files `output/<slug>/fact_check.json`, `output/<slug>/grounding.json`

## Why

The fact-check (`modules/fact_checker.py`) asked the same model that wrote the script. It shares the
writer's blind spots, so a wrong date the writer "remembers" can pass, and on an obscure topic it cannot
confirm anything, so every claim is flagged (run 2026-10-22: 28 of 28 held before render). Grounding adds a
second, checkable opinion: passages from the English Wikipedia, a free, keyless, citable source.

## What it does, in order

1. `fact_check_claims` runs exactly as before and never sees the evidence. Its verdicts are the baseline.
2. `grounding` looks the topic and the names in the narration up (MediaWiki API, `en.wikipedia.org`,
   at most 15 requests per video, retries included, 10 s timeout each, 90 s in all, one host, a
   `User-Agent` that names the project, no secret of any kind). Disambiguation and missing pages are skipped,
   redirects are followed, every page is cut into passages of at most 700 characters, and each claim is
   offered the (at most 3) passages that share words with it.
3. One model call per 15 claims (not per claim) matches the claims against the passages **only** and answers
   `supported` (with the snippet id and the exact words), `contradicted` (with the snippet id) or `not_found`.
4. The answer is applied in code, under the rules below. The result keeps the checker's own verdict, the
   status, the effect (`upgraded` / `flagged` / `none`), the cited sources (title, URL, snippet id) and the quote.

## The rules (all enforced in code, each pinned by `tests/test_grounded_factcheck.py`)

* **`not_found` changes nothing.** Today's verdict logic stays exactly as it is; nothing becomes more lenient
  because evidence was looked for.
* **An upgrade** (`unverifiable` to `likely_accurate`) needs *all* of: a snippet that was offered for that
  claim; a quote that really appears in that snippet's text (a made-up quote does not count; 25 to 300
  characters; `...` may join pieces in order); every number and date of the claim in the quote (a wrong year
  cannot pass); at least two content words shared with the claim; and no hedge ("allegedly", "legend",
  "according to", ...) in the quote that the claim does not carry. A claim the checker called
  `likely_inaccurate` is never upgraded.
* **A flag** (`contradicted` citing an offered snippet) turns the verdict into `likely_inaccurate`. This is
  the restrictive direction, so a quote is recorded when it checks out but is not required.
* **An outage changes nothing and says so.** Rate limit, timeout, an error page, a refused user agent, a failed
  model call: every verdict stays as the checker gave it, `grounding.unavailable` holds a reason word
  (`http_429`, `timeout`, `bad_response`, `judge_failed`, ...), the log carries a warning and the publish gate
  adds the warning `grounding_unavailable`. A lookup that worked and found no article is `no evidence`, not an
  outage.
* **Snippets are untrusted data.** Anyone can edit Wikipedia. Snippets travel only inside a JSON block that
  the prompt declares to be data (and `<`/`>` are escaped inside it), and because an upgrade needs the code-side
  checks above, text inside a snippet cannot talk a claim into passing. At worst it adds a flag.
* **Nothing about publishing changes.** The gate's blocks, exit code 79 and the early stop are untouched: the
  only inputs that moved are the verdicts, and only in the ways above. The gate merely *records* the lookup in
  `fact_check.grounding` of its event.

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

* `output/<slug>/fact_check.json`: per claim, a `grounding` object (only when evidence was involved).
* `output/<slug>/grounding.json`: the summary and every passage used, with the page revision id, so a quote can
  be audited after the page has changed.
* The `publish.allowed` / `publish.blocked` event: `fact_check.grounding` (counts, sources, `unavailable`).
* A held run: `hold_detail.grounding`, and `sources` on each flagged non-narration text. The video page's review
  panel shows "Sources checked online" for held runs and, for uploaded ones, from the gate event.

## Limits, said plainly

* It is the English Wikipedia only. A script in another language is looked up with the names as written;
  claims that share few names or numbers with the English text come back `not_found` and are judged as before.
* Wikipedia can be wrong, and a quote proves the page says it, not that it is true. That is why a person still
  reviews every video.
* Wikimedia rate-limits shared addresses (the egress of a CI runner or a cloud host can be throttled with
  `429` and `Retry-After`). The lookup honours it within its caps and then gives up as `unavailable`; if that
  turns out to be common on the runners, an authenticated Wikimedia API client is the follow-up (it needs a
  secret, so it needs its own change).
* The research step (`research_engine.py`) is still the model's recall. Only the fact-check is grounded.

## Cost

Wikipedia is free. The model call is one per 15 claims with candidate passages, recorded in the cost ledger as
`gemini_input_tokens` / `gemini_output_tokens` with stage `fact_check_grounding`, so the spend guard and the
channel budget see it. A 28-claim script is two calls of roughly 5 to 8 thousand input tokens and about a
thousand output tokens in all: about a cent or less at flash-tier prices (an estimate, not a measurement: the
repository sets no price, see `CHRONOS_PRICE_GEMINI_*`, and the first real runs will show the token counts).

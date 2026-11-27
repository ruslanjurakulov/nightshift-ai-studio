# S9 — Studio generation through the connected MCP: diagnosis (22 Nov 2026)

Stream S9 of the build program. The owner's goal: generate Studio clips and pictures through our own MCP connection (Claude or
ChatGPT connected to Nightshift with OAuth), so Atlas can produce the site's new cinematic sample clips that way, which also
tests the MCP end to end. This file is the evidence and the diagnosis. The build comes after it, in its own PRs (CLAUDE.md #8).

## Summary

**Most of the tool set the brief proposes is already on `main`.** It shipped as #818 (`f2db2582`, migration 0191). An OAuth
connection that holds the `studio:create` permission gets five Studio tools: `list_creative_models`, `list_media`,
`quote_creative`, `create_creative` and `get_creative_job`. The live connection Atlas uses shows none of them for two reasons,
and neither is missing code:

1. **That connection was never given `studio:create`.** The server's instructions to it say so: *"This connection was not given
   permission to … generate pictures and clips in the Studio; the person can disconnect it and connect it again, allowing that."*
   0191 makes Studio spending its own consent line, unticked by default. Remedy: the owner disconnects the app and connects it
   again with "Studio" ticked. No code change.
2. **No video model is switched on for assistants.** Only `recraft-v4.1` and `recraft-v4.1-flash` (t2i, pictures) have
   `mcp_oauth_exposure: true`, on the vendor's written permission of 2026-11-17/18. A test (`tests/test_mcp_oauth_creative_migration.py`)
   pins that allow-list. So even with the permission, the connection can make **pictures and no clips**. This is the real blocker
   for "cinematic sample clips through MCP". It is a terms question, not code (see "Models" below).

The code gaps that remain are small: `list_creative_jobs` does not exist, no test drives the Studio tools through the real
`/api/mcp` route, and two of the five attacks in the brief (oversized prompt, prompt injection inside a prompt) have no pinned test.

## What fbc7e07f has, and how far it is from main

`origin/claude/mcp-creative-tools` (tip `fbc7e07f`) forks from `main` at `a758a9d6` and is 26 commits behind `main` (`a747e248`).
Its history mixes two pieces of work:

- **The MCP Studio tools** (`b5c104a5` … `e06539f2`, `ff2109c6`): renumbered 0176 → 0191, Breach and Lens rounds. **Merged** as #818.
- **Brain / Nightshift AI chat on the same branch** (`5b425f42`, `747bd447` … `fbc7e07f`, migration 0199). **Merged** as #843
  (`775099e9`).

`git diff origin/main fbc7e07f` over `0191_mcp_oauth_creative.sql`, `lib/api/mcp.ts`, `lib/api/mcp-oauth.ts` and
`0199_studio_ai_chat.sql` is empty. Everything else that differs is work `main` added after the fork (328 files, about 27k lines
the branch lacks). **The branch has nothing left that `main` lacks, so there is nothing to merge from it.** It was "left blocked
without a PR" only in the sense that its PR was #818 and the branch was then reused. S9 branches start from `main`.

## What 0191 provides (applied live: the program file lists everything up to 0209 as applied)

- **Permission `studio:create`.** An unticked line of its own on the consent page. A request that asks only for it is refused as
  `studio_only`. No existing connection gained it.
- **Per-model switch `spec.mcp_oauth_exposure`.** Only JSON `true` turns a model on. `oauth_creative_model_state()` is the one
  judgement the list, the quote and the create share. A model must be on sale for the `'mcp'` surface (`sellable_models(cap, 'mcp')`,
  0188), which needs `api_exposure` `web_mcp` or `any`, so a vendor's web-only model is never offered whatever the switch says.
  It must also have no `blocked_countries` and no rights acknowledgement. Each refusal has its own word: `model_not_offered`,
  `model_temporarily_off`, `acknowledgement_required`.
- **Quote, then create.** `oauth_creative_quote` stores the price `creative_price` computed, for one connection, for 15 minutes.
  `oauth_creative_create(token, quote_id, idem_key)` takes nothing else. The model, params and credits are the stored quote's, so
  what the person was shown is what runs. It refuses another connection's quote (same 404 as an unknown id), a used one, an expired
  one, and a price that is not exactly the quote (`price_changed`, nothing held). It checks the connection's monthly limit under the
  credit account's lock, calls the Studio's own `create_creative_job` with the quote as `max_credits`, and undoes the hold if the job
  holds anything else. It writes `api_requests` and `app_audit_log` (`creative.generate`).
- **Records.** `oauth_creative_quotes`, `oauth_creative_jobs` (connection, quote, key, hold), and `oauth_creative_rate_counters`:
  30 quotes and 10 creates a minute per connection, on top of the 120 requests a minute every connection has. RLS on, no policy.
- **Reads.** `oauth_creative_get` returns only a job this connection started, with files only once it completed.
  `lib/api/operations.ts` `withFileLinks` turns them into absolute, signed, short-lived links. `oauth_media_list` returns the
  workspace's files by id, never by path.
- **Tests.** `tests/security/test_sec_mcp_oauth_creative.py` (22 lab tests on a real PostgreSQL), `test_sec_breach_0191_scope_challenge.py`,
  `tests/test_mcp_oauth_creative_migration.py`, `command-center/tests/mcp-oauth-creative.test.ts` (21 tests on the MCP layer, called
  through `buildMcpServer` directly).

## How an OAuth-connected MCP call is authorized and metered

1. `app/api/mcp/route.ts`: the bearer is classified. An OAuth token is hashed, and `oauth_check` (0147) says whether it is a live
   token of a live grant, for which resource and with which scopes. A token for another resource gets 401 (RFC 8707). The body is
   capped at 256 KB. Each request is counted (120 a minute per connection).
2. `buildMcpServer(caller, { scopes, origin })` registers only the tools whose scope the grant holds (`OAUTH_TOOL_SCOPES`). A call to
   a tool the grant lacks is answered with the permission to give, not "not found".
3. `oauthRpc` (`lib/api/mcp-oauth.ts`) is an allow-list. Only named functions are reachable, renamed to take `p_token_hash`.
   Anything else is refused before the network, so the USD-balance functions cannot be reached by a mapping mistake.
4. Every door opens with `oauth_ctx`, which resolves grant → user → organization, checks membership, plan and activation, and
   reports `exempt := credits_exempt(org)`.
5. **Money.** Generations spend the workspace's credits through `create_creative_job` (the Studio's hold, capture and refund).
   **The per-connection monthly limit** (`oauth_grants.monthly_limit_credits`) is checked in `oauth_creative_create` against
   `oauth_grant_month_credits`, which since 0191 counts creative holds as well as videos. **The owner-exempt workspace:** where
   `ctx.exempt` is true (the operator's own organization, `credits_exempt`), the monthly limit is not applied and the quote shows no
   "left of the limit" figure, because it is not a ceiling there (0191 lines 644-645 and 766). Atlas's sample clips run on that
   workspace, so they are limited by the rate buckets and by the quote-equals-create rule, not by a credit ceiling.

## Models: why there are no clips, and what would change it

`schemas/model_registry.json` has 34 models with t2v or i2v. **32 are `api_exposure: web_only`**: their vendor's terms, as recorded,
do not allow anything but our own web app. 0188/0191 never offer those to an assistant, and the switch cannot override that. Two are
`api_exposure: any`: **`luma-ray-3.2`** and **`seedance-1.5-pro`**. They are the only video models that could be switched on for
assistants without first changing what we recorded about the vendor's terms. Recraft was switched on only with the vendor's written
permission. So turning either on needs:

1. **Scout** checks the vendor's current terms for use through an end user's own AI assistant (a connector), and whether written
   permission is needed.
2. **The owner decides**, and obtains written permission where the terms need it.
3. A reviewed registry change (`mcp_oauth_exposure: true`, the terms cited) plus the allow-list in
   `tests/test_mcp_oauth_creative_migration.py`.

Nothing in S9 turns a model on without step 2. Rule 4 also applies: no "if Luma is off, use something else". `create_creative`
runs only the quoted model, and `list_creative_models` lists only what is on.

**An alternative only Atlas and the owner can choose:** an operator-only exposure, meaning "on for assistants only in the
credits-exempt operator workspace", for first-party marketing work. It changes who the "end user" is in the vendor-terms question,
needs its own migration, and is a policy decision. I will not build it unless asked.

## The tool set

The brief's five tools, refined against what exists:

| Brief | On main (0191) | S9 action |
| :-- | :-- | :-- |
| `list_studio_models(tool)` | `list_creative_models(capability)` returns only models on sale and on for assistants, with `output`, `aspect_ratios`, `durations_s`, `inputs`, `audio_out`, `max_prompt_chars` and no price | **Keep the name.** Renaming breaks connected clients. Description: no change |
| `quote_creative({tool, model, prompt, params})` | `quote_creative({capability, model, params})`. The prompt goes in `params.prompt`. It returns `credits` and `quote_id`, or a refusal plus `remedy` | Keep |
| `create_creative({…, max_credits, idempotency_key})` | `create_creative({quote_id, idempotency_key})`: the stored quote **is** the confirmation, so nothing at create can differ from what was shown | **Keep the stronger form.** The brief's "refuse unless max_credits equals the quote" is already enforced in the database, where the assistant cannot send a different body at all |
| `get_creative_job(id)` | Exists. It returns status, held and charged credits, `error_code`, and signed short-lived file links once completed | Keep |
| `list_creative_jobs` | **Missing** | **Build** (PR S9-a, needs a migration: `oauth_creative_list`, this connection's jobs only, newest first, `limit` ≤ 50) |
| — | `list_media` (sources for edit and i2v) | Keep |

Hard requirements against main:

| Requirement | Status |
| :-- | :-- |
| Descriptions tell the model to show the price first | Done: server instructions plus the `quote_creative` and `create_creative` descriptions; a test pins it |
| Per-connection spending limit | Done (exempt on the operator workspace, by design) |
| No silent model swap | Done: create takes only the quote, and a routed mode is refused ("name one model") |
| Nothing is published | Done: results stay private in the library, and no Studio tool can publish |
| Every refusal names its remedy | Done for the codes in `STUDIO_REMEDY`. S9-a's new code gets one too |
| Breach: another org's job or asset | Pinned (`another_workspaces_file…`, `a_quote_is_not_usable_by_another_connection…`, `get` by the starting connection only) |
| Breach: replay with a changed price | Pinned (`a_moved_price_is_refused_as_price_changed…`, create carries no price) |
| Breach: same idempotency key, different body | Pinned (`one_key_creates_once_and_one_quote_pays_once`). S9 re-runs it through the route |
| Breach: oversized prompt | **Not pinned.** The route caps the body at 256 KB. Whether `creative_price` / `create_creative_job` enforce `limits.max_prompt_chars` for every model is **unverified** → Breach |
| Breach: prompt injection inside a prompt | **Not pinned.** A prompt is data passed to a model. The risk is our tool *results* echoing it back into the assistant's context as if it were ours → Breach |
| Probe: MCP-protocol test (tools/list, tools/call through the route with a test token) | **Missing for the Studio tools.** `mcp-assistant-session.test.ts` drives the route but never `studio:create`. `mcp-oauth-creative.test.ts` calls `buildMcpServer` directly → PR S9-b |

## Plan

- **S9-b `claude/nsai-s9-mcp-route-test`** (no migration, ready first): Probe's end-to-end test. A test OAuth token through
  `POST /api/mcp` runs `initialize` → `tools/list` (exactly five Studio tools with `studio:create`, none without) →
  `tools/call` `list_creative_models` → `quote_creative` → `create_creative` → `get_creative_job`. The database is stubbed at
  `oauthCheck` and the RPC, and the test asserts what is sent. Breach's two unpinned attacks run in the same PR. Any finding goes to
  Sentinel, then to a fix and a `tests/security/` pin.
- **S9-a `claude/nsai-s9-list-jobs`** (needs a migration number from Atlas): `oauth_creative_list` plus the `list_creative_jobs`
  tool, with its rollback, lab tests and `MIGRATIONS.md` entry.
- **Models (owner):** Scout's terms report on `luma-ray-3.2` and `seedance-1.5-pro`. No registry change without the owner's decision.
- **Owner, now:** reconnect the MCP app with "Studio" ticked. Recraft pictures then work through MCP today, and Atlas can run the
  first end-to-end test with a picture while the video question is open.

## Decisions after the diagnosis (Atlas, 22 Nov)

- **The live connector, after reconnecting with `studio:create`, lists no model at all.** Recraft is not on sale live. The models on
  sale (Ideogram 3/4/4.5, GPT Image 2.6, MiniMax H3) are all `web_only`. Atlas therefore decided on an **operator-only route**: a
  connection whose workspace is the operator's own (credits-exempt, first-party marketing) may use `web_only` models on sale in the
  Studio, for every API capability. Every other workspace gets exactly today's answers. ByteDance models are excluded always, operator
  included (`docs/FILM_STUDIO.md`, BytePlus terms §4.2.3).
- **Breach found three LOW defects**, triaged by Sentinel; Atlas requires all three fixed before the operator route goes live:
  - **F1:** a model's own prompt limit is not checked before the hold.
  - **F2:** refusals echo caller-supplied parameter keys into server text, a prompt-injection vector.
  - **F3:** settings an adapter does not wire are charged and dropped.

  F1 and F3 have one root cause: `creative_price` does not know a model's full contract. They are fixed there, which covers web,
  `/v1`, Film and MCP together.
- **Registry corrections in 0219:**
  - `seedance-1.5-pro` becomes `web_only`.
  - `luma-ray-3.2` becomes `web_only` with `terms_gate: written_consent_required`, citing the Luma API Terms of Use (2026-04-28)
    §5, items 4 and 5.
  - The luma-uni notes now point to those terms.

**Migrations and PRs (they replace the plan above):**

| Number | What | Branch |
| :-- | :-- | :-- |
| 0218 | `creative_price`: prompt limit counted in UTF-16 units, `takes_negative_prompt`, seed refused until it is wired, no caller key echoed (SQL) | `claude/nsai-s9-creative-price` |
| 0219 | operator-only assistant exposure, recorded per quote/job/audit, `operator_only` in the list, registry corrections | `claude/nsai-s9-operator-models` |
| 0221 | `oauth_creative_list` and `list_creative_jobs` | `claude/nsai-s9-list-jobs` |
| — | route-level MCP test, Breach pins, F2's TypeScript half | `claude/nsai-s9-mcp-route-test` |

0218 and 0219 merge together, in that order.

# Model API keys: the owner pastes a vendor key, the server checks it with the vendor, and FORGETS it

The owner opens a vendor's own key page from a link, creates a key there, pastes it into the Command Center, and, if the vendor accepts it,
the card says **API verified at <time>. The key was not saved.** This page is DARK: it does nothing until the server switch
`NIGHTSHIFT_MODEL_KEYS` is exactly `on`, and it is for the platform **owner** only (an administrator is refused like a stranger).

**Design: verify and forget (the owner's decision, 2026-10-25).** The key is **never stored anywhere**: no database, no Vault, no table, no
migration, no audit row, no log line, no cookie, no browser storage, not even its last four characters. It lives in the memory of one request.
CLAUDE.md rule 1 is untouched and fully respected. The verdict lives in the page's state for this visit only; a reload shows "Not checked".

The code: `command-center/lib/model-keys.ts` (the vendor list and the pure rules), `command-center/lib/server/model-keys.ts` (the one vendor
request), `command-center/app/api/owner/model-keys/route.ts`, `command-center/app/(app)/[channel]/model-keys/page.tsx`,
`command-center/components/model-keys/ModelKeysBoard.tsx`. There is **no migration** and no SQL.

## What this does NOT do

* It does not save the key. To use a verified key a run needs it in **GitHub Actions secrets and the worker environment** under the name the
  card shows ("Nothing is stored. To use a verified key, add it to GitHub Actions secrets and the worker environment as `OPENAI_API_KEY`").
  Workers read their keys from the environment exactly as before.
* It does not change which key a run uses. Each card shows which key a run uses today, from the **names** of the GitHub secrets only (never
  their values): `env` (the secret is set), `none`, or `unknown` (GitHub is not configured, did not answer, or reported more secrets than were
  read; never shown as "none"). The page asks about **every** name the vendors' sets mention (`ALL_ENV_NAMES`), not the Providers board's
  shorter allowlist, and pages through all of the listing (100 a page, at most 10 pages); a name that was not seen in a listing that may be cut
  short is `unknown`.
* It writes no audit row. The only existing audit action that could carry it, `secret.write`, would say "a secret was written" when nothing
  was; a new action would need `audit_action_allowed` replaced in a migration, which this design deliberately avoids. The server logs one
  line per check (`[model-key] user=<id prefix> provider=<vendor> outcome=<verdict>`), nothing about the key. If an audit trail of checks is
  wanted later, it is a separate decision and a migration.

## The flow

1. The card's **Get a key** link opens the vendor's own page (`target=_blank`, `rel="noopener noreferrer"`). Only a link read in the
   vendor's own documentation is offered; Kling's is not (its documentation site is JavaScript-only) and neither are Lightricks's and Vidu's (their pages name no address), so those cards say "link unverified".
2. The owner pastes the key into a password field (no `name`, so it can never be part of a native form submission or a URL) and presses
   **Verify**. The field is emptied the moment the key is sent.
3. `POST /api/owner/model-keys` `{action: "verify", provider, key}`. In order: same origin (403) -> switch (404) -> signed in (401) ->
   **platform owner** (403) -> second factor (`guardAdminPost`, `requireRecentMfa`) -> rate limit per person (20 per 10 minutes, in
   process, 429) -> `Content-Type: application/json` (else 415) -> body <= 16 KB -> vendor in the closed list (400) -> key is one printable token of 16-512 characters (400).
4. **One free GET to the vendor's fixed host**, with the key in the vendor's documented auth header, an 8 second timeout and
   `redirect: "manual"`. No part of the URL is typed by anyone. A vendor with no free check is **not called at all**: only the key's shape is
   checked and the verdict is `format_only`.
5. The answer is `{ok: true, state, at}` (and `reason` for "could not reach"): `state` is `verified`, `rejected`, `could_not_reach` or
   `format_only`. Never the key. Then the key is out of scope and garbage collected.

## What each verdict means

| Chip | Meaning |
| --- | --- |
| Not checked | Nothing was checked in this visit. |
| Checking... | A request is in flight. |
| API verified | The vendor answered the free request with success **and** a body of the documented shape, at the time shown. It is not a promise the key has credit or a given permission. The key was not saved. |
| Rejected by vendor | The vendor answered with a status it uses for a bad key (401/403; 400 only for Google, where the documentation says so). For vendors that can limit a key to some endpoints the card adds that a limited key can also be refused here; for Alibaba it adds that the check uses the Singapore endpoint. |
| Format only | The vendor has no free check we could rely on. The key's shape was checked, the key was **not** sent to the vendor. "Key format looks right; cannot be verified without a paid call." |
| Could not reach vendor - retry | Timeout, no connection, a redirect (never followed), 429, 5xx, or a 200 that is not the documented shape. The key is not judged. |

## Vendors and how each key is checked

Every request below is a GET that is free and creates nothing. The page was written from the vendor's own documentation (opened
2026-10-25); **no key was used and no vendor was called while building this**. `format_only` vendors are never called.

| Vendor | Env name today | Check (host + path) | Header | Documentation read | Key page (read on) |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `api.openai.com` `/v1/models` | `Authorization: Bearer` | https://developers.openai.com/api/reference/resources/models/methods/list | https://platform.openai.com/api-keys (https://developers.openai.com/api/docs/quickstart) |
| Google (Gemini, Veo) | `GEMINI_API_KEY`, `VEO_API_KEY` | `generativelanguage.googleapis.com` `/v1beta/models` | `x-goog-api-key` | https://ai.google.dev/api/models | https://aistudio.google.com/apikey (https://ai.google.dev/gemini-api/docs/api-key) |
| xAI | `XAI_API_KEY` | `api.x.ai` `/v1/models` | `Authorization: Bearer` | https://docs.x.ai/developers/rest-api-reference/inference/models | https://console.x.ai/team/default/api-keys (https://docs.x.ai/developers/quickstart) |
| ElevenLabs | `ELEVENLABS_API_KEY` | `api.elevenlabs.io` `/v1/models` | `xi-api-key` | https://elevenlabs.io/docs/api-reference/models/list | https://elevenlabs.io/app/settings/api-keys (https://elevenlabs.io/docs/overview/administration/workspaces/api-keys) |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | `api.assemblyai.com` `/v2/transcript?limit=1` | `Authorization` (key as is) | https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/list | https://www.assemblyai.com/dashboard/home (https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file) |
| Black Forest Labs | `BFL_API_KEY` | `api.bfl.ai` `/v1/credits` | `x-key` | https://docs.bfl.ml/api-reference/get-the-users-credits | https://dashboard.bfl.ai (https://docs.bfl.ml/quick_start/get_started) |
| Recraft | `RECRAFT_API_TOKEN` | `external.api.recraft.ai` `/v1/users/me` | `Authorization: Bearer` | https://www.recraft.ai/docs/api-reference/endpoints | https://app.recraft.ai/profile/api (https://www.recraft.ai/docs/api-reference/models/recraft-v4-1) |
| Ideogram | `IDEOGRAM_API_KEY` | `api.ideogram.ai` `/v2/account/api-keys` | `Api-Key` | https://developer.ideogram.ai/v2/api-reference/account/api-keys | https://ideogram.ai/platform (https://developer.ideogram.ai/v2/ideogram-api/api-setup) |
| MiniMax | `MINIMAX_API_KEY` | `api.minimax.io` `/v1/models` | `Authorization: Bearer` | https://platform.minimax.io/docs/api-reference/models/openai/list-models | https://platform.minimax.io/user-center/basic-information/interface-key (https://platform.minimax.io/docs/guides/quickstart-preparation) |
| Runway | `RUNWAYML_API_SECRET` | `api.dev.runwayml.com` `/v1/organization` | `Authorization: Bearer` + `X-Runway-Version: 2024-11-06` | https://docs.dev.runwayml.com/api.md | https://dev.runway.com (https://docs.dev.runwayml.com/ai-context.md) |
| Luma | `LUMA_AGENTS_API_KEY` | `agents.lumalabs.ai` `/v1/files?limit=1` | `Authorization: Bearer` | https://docs.agents.lumalabs.ai/api/resources/files/methods/list/ | https://platform.lumalabs.ai/ (https://docs.lumalabs.ai/reference/getcredits.md) |
| Krea | `KREA_API_KEY` | `api.krea.ai` `/jobs?limit=1` | `Authorization: Bearer` | https://api.krea.ai/openapi.json (the OpenAPI document the Krea docs link; `GET /jobs` lists the token's own jobs, 401 for a bad token) | https://www.krea.ai/settings/api-tokens (https://www.krea.ai/docs/developers/api-keys-and-billing.md) |
| Alibaba Cloud (Wan) | `WAN_API_KEY` | `dashscope-intl.aliyuncs.com` `/api/v1/models?page_size=1` | `Authorization: Bearer` | https://www.alibabacloud.com/help/en/model-studio/list-models | https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key (https://www.alibabacloud.com/help/en/model-studio/get-api-key) |
| **Lightricks (LTX)** | `LTX_API_KEY` | **format only**: LTX's own OpenAPI document (https://docs.ltx.io/openapi.json) has no read without a job id; every other path is a POST that starts a billed generation, so no free account, credits or models call exists | – | https://docs.ltx.io/openapi.json | **link unverified** (the authentication page says "Sign in to the Developer Console" and names no address in the text read) |
| **Vidu (Q3, Q4 preview)** | `VIDU_API_KEY` | **format only**: the one free read, Account Balance (`GET /ent/v2/credits`), lists a required `show_detail` parameter in the body of a GET and an example answer whose field (`remains`) differs from its own table (`remaining_credits`), so no check is built on it; the key is never sent anywhere | – | https://platform.vidu.com/docs/overview/faq (the Account Balance page is `.../docs/api-reference/task-management/account-balance`) | **link unverified** (the FAQ names an "API Key Management" menu and no address) |
| **Pika (Pika 2.5)** | `PIKA_API_KEY` | **format only**: the one free read, the org balance (`GET /billing/balance`), is described by the OpenAPI document with a Bearer scheme that is "a console session JWT" for `/billing` reads while llms.txt says the same API key reads it; which header it takes is not settled by the pages, so a 401/403 could not be told from a rejected key and the key is never sent anywhere | – | https://dev.pika.art/llms.txt | https://dev.pika.art/keys (https://dev.pika.art/llms.txt) |
| **Kling** | `KLING_API_KEY` or `KLING_ACCESS_KEY` + `KLING_SECRET_KEY` | **format only**: no free account endpoint could be confirmed (the official API reference is a JavaScript-only site) | – | – | **link unverified** |
| **BytePlus ModelArk (Seedance)** | `SEEDANCE_API_KEY` | **format only**: the model list in the documentation is a control-plane call of the BytePlus account, not a call made with a ModelArk API key; no free call for the key itself is documented | – | https://docs.byteplus.com/en/docs/modelark/manage-api-keys | https://console.byteplus.com/ark/region:ark+ap-southeast-1/apiKey (same page) |

Vendor-specific honesty:

* **Ideogram**: the only account read in the documentation requires a key whose owner is an organization admin and answers **404** to
  other keys. Only 200 verifies and only 401 rejects; a 404 reads "could not reach — retry" with the reason "not what the documentation
  describes". A valid key of a non-admin member therefore cannot be saved until a free check exists for it.
* **Google** answers a key it does not know with **400**; its documentation groups 400/402/403 as client errors for invalid keys.
* **xAI**: 401 (no or invalid token) and 403 are rejections; 400 is "check your request" and is not.
* **OpenAI and ElevenLabs** can limit a key to some endpoints; a key that may not read the model list is refused here although it is valid.
* **Alibaba**: the Singapore endpoint of the documentation; the repository notes that the shared host is in maintenance mode and keys are
  region/workspace specific, so a valid key can be refused (or the host unreachable) here.
* **MiniMax, Luma, Alibaba, AssemblyAI**: the response *shape* is checked from the documentation's description (`data` array,
  `page_details`, `output`, any object for Luma). A vendor answering 200 in another shape reads "could not reach", never "API verified".
* **Krea**: the check is `GET /jobs?limit=1` (the token's own jobs; the answer must hold an `items` array). Krea's OpenAPI document lists only 401 for a bad
  token. Nothing was called while building this. **Lightricks** has no free read at all, so its key is never sent anywhere. **Vidu** has one (Account Balance) whose page contradicts itself (a required body on a GET; two names for the same field), so its key is never sent anywhere either.
* **Pika**: format only until a live probe settles it. `GET /billing/balance` (a numeric `balance_micro_usd`) is free, but the OpenAPI document lists a Bearer scheme that it describes, for `/billing` reads, as a console session JWT next to the `X-API-Key` header, while llms.txt says the same API key reads the balance; a 401 or 403 would read as "the vendor rejected this key" about a key that may be fine.
* Unconfirmed everywhere: how each vendor words its error body (the body is never read for meaning), and rate limits of these endpoints.

## Security notes for the reviewer

There is no database object to review. What to check in the code:

1. **Owner only, in the application layer.** The route asks `requireRole("owner")` (the platform roster's owner, not an admin), then the second
   factor and the recent-code rule. There is no second, database-side check any more (the earlier design had one); the route is the gate.
2. **The key's path.** Browser -> HTTPS -> the Next.js route (request body) -> HTTPS header to the vendor. For a format-only vendor the key goes
   to our server for a shape check only and nowhere else.
3. **No persistence.** `tests/model-keys-registry.test.ts` ("nothing is persisted") fails if the feature's files mention a database client,
   an rpc, Vault, an audit write, browser storage, a cookie or a file write, if the route imports anything but the sign-in/role/gate helpers,
   or if any migration or SQL file mentions the old design's names.
4. **SSRF.** The host of every request is the registry's fixed origin; a registry path that tried to change it is refused before any call
   (tested); redirects are never followed.
5. **Output.** The key is in no response, header, log line or thrown error (`redactKey`, `safeErrorText`; tested against a vendor that echoes
   the key back).
6. **Only JSON is read.** Any other `Content-Type` is a 415 before the body is touched.

## Production checks before the switch is turned on (the owner / the reviewer)

Code cannot prove these; each is a setting on the server or in GitHub.

* **Nothing records the POST body of `/api/owner/model-keys`.** Caddy (access log with a body field, `log` directives, `request_body` in a
  debug config), any WAF or CDN in front, and any APM or error reporter (Sentry-style breadcrumbs, session replay, request capture) must not
  keep request bodies for that path. The key is in that body once.
* **`NIGHTSHIFT_ADMIN_MFA=enforce`** (docs/security/ADMIN_MFA.md). The route's second-factor checks only bite in `enforce`; in any other mode
  a password-only owner session can verify keys.
* **`APP_ORIGIN` is the real site origin.** The same-origin check (`requireSameOrigin`) compares the request's `Origin` with the public
  origin (`APP_ORIGIN`, which compose derives from `DOMAIN`). Confirm it is set and is the address the owner uses.
* **`GITHUB_SECRETS_TOKEN` scope.** This page needs only *Secrets: read* on the bot repository (it lists secret **names**). The token the
  site already holds can also write secrets (the Providers board and `/api/setup/secrets`) and dispatch workflows. That is the real exposure
  of any key, and it is not changed by this page: consider a second, read-only token for this page if the repository is ever shared.
* **The owner roster.** `select email, role from app_members where role = 'owner'` must list exactly the people who may check keys here
  (migration 0043 also returns `owner` for the default-organization roster while `app_members` is empty).

## Why Vault is not used (the owner's decision)

An earlier draft of this change stored the verified key in Supabase Vault so workers could one day read it. The owner rejected that for
security reasons: the Supabase service role can read `vault.decrypted_secrets`, so every holder of the service key (the operator bot, the
queue worker) would be able to read these keys, and the real exposure of a key is whoever can write to GitHub Actions secrets and the worker
environment, which is where the key has to be for a run anyway. So: no Vault, no read function, no "workers read Vault" follow-up. If a
different design is wanted later, it is a new decision with its own review.

## Enabling it (the owner, later; not part of this change)

Set the repository variable `NIGHTSHIFT_MODEL_KEYS=on`; Deploy web. Sign in as the owner (second factor), open **Model API keys**. To
switch it off set the variable empty: the page and the route go dark. Nothing needs cleaning up, because nothing is stored.

## Tests

* `command-center/tests/model-keys-registry.test.ts`: every registry provider has an entry, every request is pinned (no generation endpoint),
  https origins only, which statuses reject, the header/shape per vendor, env names are mapped by the deploy, key shape rules, the request
  body (only `verify`), the exact variable names shown, and **nothing is persisted** (code scan, route imports, no migration).
* `command-center/tests/model-keys-verify.test.ts`: against a fake vendor on 127.0.0.1 (no network): per vendor the exact request, 401/403 ->
  rejected, 5xx/429/timeout/drop/redirect/oversize/bad shape -> could not reach, a format-only vendor is never called, the key never comes
  back, a registry path that tries to change the host is refused.
* `command-center/tests/model-keys-route.test.ts`: switch, same-origin, owner-only (403 for an administrator), second factor, rate limit,
  unknown vendor, no `save`/`remove` action, format-only never calls out, **no database client is created, no cookie is set, the vendor's
  GET is the only request, one log line**, and every response, header and captured log line (also for a transport error that quotes the key)
  is searched for the key and fragments of it.
* `command-center/tests/model-keys-ui.test.tsx`, `model-keys-page.test.tsx`: states, links, the password field, the field emptied on send,
  the verdict text with the time and "not saved", the variable name on every card, nothing written to browser storage, the page reads no
  database, en/ru/uz.

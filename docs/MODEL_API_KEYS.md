# Model API keys: the owner's key per vendor, checked with the vendor, kept in Vault

The owner opens a vendor's own key page from a link, creates a key there, pastes it into the Command Center, and, if the vendor accepts it,
the card says **API verified**. The key is then kept encrypted in Supabase Vault. This page is DARK: it does nothing until the server
switch `NIGHTSHIFT_MODEL_KEYS` is exactly `on`, and it is for the platform **owner** only (an administrator is refused like a stranger).

Migration `0123_model_api_keys.sql` (rollback: `docs/sql/rollback_0123_model_api_keys.sql`). The code: `command-center/lib/model-keys.ts`
(the vendor list, pure), `command-center/lib/server/model-keys.ts` (the vendor check and the database calls),
`command-center/app/api/owner/model-keys/route.ts`, `command-center/app/(app)/[channel]/model-keys/page.tsx`,
`command-center/components/model-keys/ModelKeysBoard.tsx`.

## What this does NOT change

**Workers keep reading their keys from the environment (GitHub secrets), exactly as before.** A key stored here is not used by any run.
The page says so on every card ("Key used by runs"). Nothing in `modules/`, `tools/`, a workflow or a worker reads Vault for a model key,
and there is deliberately **no function that returns a stored key to anyone**, not the owner and not the service role (see "Follow-up").

## CLAUDE.md rule 1, stated plainly

Rule 1 says keys typed into the Command Center are sealed to the repository's public key, PUT to GitHub Actions secrets and dropped, and
"never touch Supabase". This feature is the owner's explicit request to do otherwise for vendor model keys: the key passes through the
Next.js server once and is stored in Vault (the same place Instagram, TikTok and customer YouTube tokens already live: migrations 0022
and 0028). It asks for one more fragment than rule 1 allows: **the last four characters** are stored beside the status and shown to the
owner as a mask (`•••• wxyz`), because the owner asked for it. Neither is hidden here, and rule 1's sentence should be amended (or this
feature refused) by the owner, not by this change. Everything else in rule 1 holds: the key is never logged, never in a URL, never in an
error text or an audit row, never returned to the browser.

## The flow

1. The card's **Get a key** link opens the vendor's own page (`target=_blank`, `rel="noopener noreferrer"`). Only a link read in the
   vendor's own documentation is offered; Kling's is not (its documentation site is JavaScript-only), so its card says "link unverified".
2. The owner pastes the key into a password field (no `name`, so it can never be part of a native form submission or a URL) and presses
   **Verify and save**. The field is emptied the moment the key is sent.
3. `POST /api/owner/model-keys` `{action: "save", provider, key}`. In order: same origin (403) → switch (404) → signed in (401) →
   **platform owner** (403) → second factor (`guardAdminPost`, `requireRecentMfa`) → rate limit per person (20 per 10 minutes, 429) →
   body ≤ 16 KB → vendor in the closed list (400) → key is one printable token of 16–512 characters (400) → for a vendor with no free check,
   the owner's explicit confirmation (400 `confirm_required`).
4. **One free GET to the vendor's fixed host**, with the key in the vendor's documented auth header, an 8 second timeout and
   `redirect: "manual"`. No part of the URL is typed by anyone. A vendor with no free check is **not called at all**.
5. Only a key the vendor accepted is stored: `owner_model_key_store(provider, secret, 'verified')`, as the signed-in owner (anon key and
   session; never a service key). A rejected check stores nothing and leaves a stored key as it was. An unreachable vendor stores nothing and
   says "Could not reach vendor — retry".
6. The answer is a state word (`verified`, `rejected`, `unreachable`, `format_only`), never the key. The page is refreshed and reads the
   stored status back.

## What each verdict means

| Chip | Meaning |
| --- | --- |
| Not set | Nothing is stored for this vendor. |
| Checking… | A request is in flight. |
| API verified | The vendor answered the free request with success **and** a body of the documented shape, on the date shown. It is not a promise the key has credit or a given permission. |
| Rejected by vendor | The vendor answered with a status it uses for a bad key (401/403; 400 only for Google, where the documentation says so). Nothing was saved. For vendors that can limit a key to some endpoints the card adds that a limited key can also be refused here; for Alibaba it adds that the check uses the Singapore endpoint. |
| Format only | The vendor has no free check we could rely on. The key's shape was checked, the key was **not** sent to the vendor, and the owner ticked a box saying so. "Key format looks right; cannot be verified without a paid call." |
| Could not reach vendor — retry | Timeout, no connection, a redirect (never followed), 429, 5xx, or a 200 that is not the documented shape. The key is not judged; nothing was saved. |

## Vendors and how each key is checked

Every request below is a GET that is free and creates nothing. The page was written from the vendor's own documentation (opened
2026-10-25); **no key was used and no vendor was called while building this**. `format_only` vendors are never called.

| Vendor | Env name today | Check (host + path) | Header | Documentation read | Key page (read on) |
| --- | --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `api.openai.com` `/v1/models` | `Authorization: Bearer` | https://developers.openai.com/api/reference/resources/models/methods/list | https://platform.openai.com/api-keys (https://developers.openai.com/api/docs/quickstart) |
| Google (Gemini, Veo) | `GEMINI_API_KEY`, `VEO_API_KEY` | `generativelanguage.googleapis.com` `/v1beta/models` | `x-goog-api-key` | https://ai.google.dev/api/models | https://aistudio.google.com/apikey (https://ai.google.dev/gemini-api/docs/api-key) |
| xAI | `XAI_API_KEY` (#607, not mapped yet) | `api.x.ai` `/v1/models` | `Authorization: Bearer` | https://docs.x.ai/developers/rest-api-reference/inference/models | https://console.x.ai/team/default/api-keys (https://docs.x.ai/developers/quickstart) |
| ElevenLabs | `ELEVENLABS_API_KEY` | `api.elevenlabs.io` `/v1/models` | `xi-api-key` | https://elevenlabs.io/docs/api-reference/models/list | https://elevenlabs.io/app/settings/api-keys (https://elevenlabs.io/docs/overview/administration/workspaces/api-keys) |
| AssemblyAI | `ASSEMBLYAI_API_KEY` | `api.assemblyai.com` `/v2/transcript?limit=1` | `Authorization` (key as is) | https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/list | https://www.assemblyai.com/dashboard/home (https://www.assemblyai.com/docs/getting-started/transcribe-an-audio-file) |
| Black Forest Labs | `BFL_API_KEY` | `api.bfl.ai` `/v1/credits` | `x-key` | https://docs.bfl.ml/api-reference/get-the-users-credits | https://dashboard.bfl.ai (https://docs.bfl.ml/quick_start/get_started) |
| Ideogram | `IDEOGRAM_API_KEY` | `api.ideogram.ai` `/v2/account/api-keys` | `Api-Key` | https://developer.ideogram.ai/v2/api-reference/account/api-keys | https://ideogram.ai/platform (https://developer.ideogram.ai/v2/ideogram-api/api-setup) |
| MiniMax | `MINIMAX_API_KEY` | `api.minimax.io` `/v1/models` | `Authorization: Bearer` | https://platform.minimax.io/docs/api-reference/models/openai/list-models | https://platform.minimax.io/user-center/basic-information/interface-key (https://platform.minimax.io/docs/guides/quickstart-preparation) |
| Runway | `RUNWAYML_API_SECRET` | `api.dev.runwayml.com` `/v1/organization` | `Authorization: Bearer` + `X-Runway-Version: 2024-11-06` | https://docs.dev.runwayml.com/api.md | https://dev.runway.com (https://docs.dev.runwayml.com/ai-context.md) |
| Luma | `LUMA_AGENTS_API_KEY` | `agents.lumalabs.ai` `/v1/files?limit=1` | `Authorization: Bearer` | https://docs.agents.lumalabs.ai/api/resources/files/methods/list/ | https://platform.lumalabs.ai/ (https://docs.lumalabs.ai/reference/getcredits.md) |
| Alibaba Cloud (Wan) | `WAN_API_KEY` | `dashscope-intl.aliyuncs.com` `/api/v1/models?page_size=1` | `Authorization: Bearer` | https://www.alibabacloud.com/help/en/model-studio/list-models | https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key (https://www.alibabacloud.com/help/en/model-studio/get-api-key) |
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
* **MiniMax and Luma, Alibaba, AssemblyAI**: the response *shape* is checked from the documentation's description (`data` array,
  `page_details`, `output`, any object for Luma). A vendor answering 200 in another shape reads "could not reach", never "API verified".
* Unconfirmed everywhere: how each vendor words its error body (the body is never read for meaning), and rate limits of these endpoints.

## Storage (migration 0123)

* `model_api_key_status` (provider, status `verified`/`format_only`, last4, verified_at, checked_by, checked_by_email): RLS on, **one**
  select policy (`platform_role() = 'owner'`), `select` granted to `authenticated` only, no write privilege for any API role.
* `model_api_key_refs` (provider → Vault secret id): RLS on, **no policy, every privilege revoked** from every API role, the service role
  included (the 0022 pattern).
* `owner_model_key_store`, `owner_model_key_remove`, `owner_model_key_status`: `security definer`, `search_path = ''`, `authenticated`
  only, each refuses everyone but the platform **owner** (an admin gets `owner_required`), store and remove also run `owner_guard` (second
  factor gate and a per-person rate limit of 20 per 10 minutes) and write an audit row. They replace **no** existing function:
  `audit_action_allowed` is untouched (the existing action `secret.write` is reused with `detail.store = 'vault'`), so there is no drift
  guard to compare. The audit detail names the vendor, the operation and the status; never the key, never the last four.
* A validation refusal is **returned** as a document, never raised, so an expected failure does not put the statement and its parameters
  (the key) in the Postgres error log.

## What the reviewer must verify before this is applied live

1. **Who is `owner`.** `platform_role()` returns `owner` for the roster row of role owner, and (0043) for the default-organization roster
   members while `app_members` is empty. Confirm in production `select email, role from app_members where role = 'owner'` is exactly who
   should be able to store keys.
2. **Logs.** The key is an argument of `owner_model_key_store`, carried by PostgREST from the Next.js server. Check that the project's
   Postgres logging does not record statement parameters on error or on slow statements (`log_parameter_max_length`,
   `log_min_duration_statement`, `pg_stat_statements`, auto_explain), and that PostgREST/API-gateway logs do not keep request bodies. The
   same exposure exists for 0022/0028 today. The Caddy access log must not log bodies.
3. **Vault reach.** Run the `Verify` block at the end of the migration. Also check `has_schema_privilege` of `anon`, `authenticated` and
   `service_role` on schema `vault` and on `vault.decrypted_secrets`: if the service role can read decrypted secrets, any holder of the
   service key (the operator bot, the queue worker) can read these keys directly, bypassing "no read function".
4. **The grants** (`Verify` block): no `anon`/`service_role` privilege on either table or any of the five functions; the helper functions
   are executable by no API role; the status table has exactly one policy.
5. **Client**: `rel="noopener noreferrer"` on the vendor links, the password field has no `name`, the field is emptied on send, the answer
   has no key.
6. **Server**: nothing in `lib/server/model-keys.ts` returns or logs a key, a vendor body, or an exception message unredacted (`redactKey`,
   `safeErrorText`); `redirect: "manual"`; the host is the registry's.
7. **The deviation from CLAUDE.md rule 1** above is accepted by the owner.
8. After applying: with the switch still off, `curl -X POST .../api/owner/model-keys` (same origin) must answer 404.

## Enabling it (the owner, later; not part of this change)

Apply 0123 after the review above; set the repository variable `NIGHTSHIFT_MODEL_KEYS=on`; Deploy web. Sign in as the owner (second
factor), open **Model API keys**. To switch it off again set the variable empty: the page and the route go dark, stored keys stay in Vault
until removed on the page (or by the rollback file).

## Follow-up: letting workers read Vault (design only, not built)

Not part of this change, and each point is a decision for the owner and a reviewed migration:

* **No implicit fallback (CLAUDE.md rule 4).** The key a run uses is a *choice*, per vendor, not "env, else Vault". Add a column
  `use_for_runs boolean not null default false` to `model_api_key_status`, set only by an owner function with its own audit row and
  confirm step. Env stays the default; with it false nothing changes for any run.
* **One service-only read.** `read_model_api_key(p_provider)`: `service_role` only (the 0022 `read_channel_token` pattern), returns the key
  only when `use_for_runs` is true, audits each read (provider and worker, not the key), and is rate limited. This is the first and only
  decrypting function; it needs its own review (item 3 above becomes critical).
* **Worker side.** A small `modules/model_keys.py`: at worker start, for each vendor with `use_for_runs`, read the key once and put it into
  the adapter's `env` mapping in memory (the adapters already take an `env` mapping: `build_adapter(key, env=...)`), never into
  `os.environ`, a file, a log or an exception (the `secrets()` redaction list of the adapter base class covers it). If the read fails the
  run **stops** with the remedy; it does not fall back to the environment key.
* **Reporting.** `tools/doctor.py` gets a "key source per vendor" line (env / vault / none), the Python twin of the page's line.
* **Vendor says no.** A worker that gets an auth refusal for a Vault key calls a service-only `mark_model_api_key_rejected(provider)` so the
  card stops saying "API verified" for a key that has been revoked at the vendor.
* **Deploy.** Nothing in `deploy_web.yml` changes; the worker already has the service key.

## Tests

* `command-center/tests/model-keys-registry.test.ts`: the vendor list equals the database's, every registry provider has an entry, every
  request is pinned (no generation endpoint), https origins only, env names are mapped by the deploy, key shape rules, the request body.
* `command-center/tests/model-keys-verify.test.ts`: against a fake vendor on 127.0.0.1 (no network): per vendor the exact request, 401/403 →
  rejected, 5xx/429/timeout/drop/redirect/oversize/bad shape → could not reach, a format-only vendor is never called, the key never comes
  back.
* `command-center/tests/model-keys-route.test.ts`: switch, same-origin, owner-only (403 for an administrator), second factor, rate limit,
  unknown vendor, the format-only confirmation, nothing stored unless verified, and the captured responses, headers and log lines are
  searched for the key and its last four.
* `command-center/tests/model-keys-ui.test.tsx`, `model-keys-page.test.tsx`: states, links, the password field, the field emptied on send,
  the source line, en/ru/uz.
* `tests/security/test_sec_model_api_keys.py` (needs the lab Postgres): owner stores into Vault, replace in place, remove destroys the secret,
  the audit row carries neither key nor last four, an administrator / member / stranger / anon / service key are all refused, RLS on the
  status table, the refs table closed to everyone, the rollback restores the schema and a replay applies again.

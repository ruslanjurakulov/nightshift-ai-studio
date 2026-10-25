# The owner's model switch (migration 0124)

A per-provider and per-model ON/OFF switch in the owner's login. Example: every API key is connected, but the Seedance vendor balance
ran out. The owner turns the provider OFF; people stop being offered its models and stop being able to start them; nothing is charged
or held for a refused request; nothing is quietly replaced by another model (CLAUDE.md #4). Later the owner turns it ON again.

It is a **temporary, operational pause**. It is not the sale lifecycle of 0035 (`model_registry.availability`: hidden / beta / ga /
disabled, which needs a real probe to come back). That column is never touched by a switch, and a model switched back ON is exactly as
sellable as it was.

**Shipped dark.** Applying the migration changes nothing for anybody until the owner puts the switches in force (below).

## Turning it on (the owner's steps, none of them done by the PR)

1. Merge and apply migration `0124_model_switch.sql` (live on apply, see "What the review must verify").
2. Put the switches in force, in the Supabase SQL editor:
   `update public.model_availability_settings set enforced = true;`
   (the change is logged by a trigger; `enforced = false` puts everything back at once, the log is kept).
3. Set the repository variable `NIGHTSHIFT_MODEL_SWITCH` to `on` and run Deploy web: the Models page gets a **Switches** view
   (platform owner only) and the queue worker starts asking the database before a channel run spends anything.
4. Optional, separate, default OFF: `update public.model_availability_settings set auto_suggest = true;` (see "The alert").

Two switches on purpose: the database flag (`enforced`) is what hides and refuses; the server variable only shows the owner's view and
arms the worker's pre-spend gate. With the variable off the view does not exist and `POST /api/owner/model-switch` answers 404. With the
flag off no switch can be recorded (`not_enforced`) and every model is available whatever a row says.

## What a switch is

`model_availability (scope 'model'|'provider', target, enabled, reason, note, changed_by, changed_by_email, changed_at)`.

* **No row = enabled.** A row with `enabled = false` hides; a row with `enabled = true` records the last turn-on.
* A provider OFF hides every model of that provider at once. A model row can only turn **one model off**: a model row that says "on"
  does not override a provider that is off.
* `reason` is a closed list, required for OFF: `out_of_funds`, `vendor_outage`, `terms_review`, `other`. `note` is optional, at most 200
  characters, one line, plain text (for the owner only: never type a key).
* Only `owner_set_model_switch()` writes it: platform **owner** (an admin who is not the owner is refused), through `owner_guard()`
  (platform admin, the second-factor test of 0107, a rate limit of 60 calls in 10 minutes), and the change, the jobs it stops, the log
  row (`model_availability_log`, append-only, even for the table owner) and a `security_events` row are one transaction: an audit that
  cannot be written stops the change.
* No API role has any privilege on any of the four tables. The doors are definer functions: `model_is_available(text)` and
  `models_switched_off()` (authenticated, service role: a boolean and ids, **never a reason**), `model_switch_state()` (service role: the
  queue worker), and the four `owner_*` functions (the function decides: owner only).

## Where it is enforced (server side; the Command Center only draws it)

| Entry point | How |
|---|---|
| Every list that reads `sellable_models()` (Models page, Studio parameters, captions panel, AI tools, API/MCP model checks) | `sellable_models()` omits a switched-off model, on every surface |
| The Studio's own model list (a direct read of `model_registry`) | the RLS policy `model_registry_select` adds `model_is_available(id)` for customers; a platform admin still reads every row, so `loadStudioModels()` subtracts `models_switched_off()` |
| Studio quote (`quote_creative_job`) and start (`create_creative_job`, exact and routed), a stale page included | `creative_price()` refuses `model_temporarily_off` (NS400, HTTP 503) **before** anything is priced, held or charged |
| The router's pick (`quote_creative_route`, `route_model`) and its failover (`reroute_creative_job`) | candidates come from `sellable_models()` and `creative_price()`: a switched-off model is no candidate; a stale pick is `route_changed` (409), no candidate left is `no_model_available` |
| API and MCP (`api_creative_quote`, `api_creative_create`) | `api_creative_model_ok()` + `api_creative_refusal()` answer `503 model_temporarily_off` (a model the vendor keeps off the API stays `model_not_sellable`) |
| Workflows (series of creative steps) | the quote names the step with reason `model_temporarily_off`; `start_workflow_run` refuses `unpriced` (NS400) and holds nothing; a step stopped later fails that step and the run, as any failed job does |
| The worker's last gate before the vendor is called | `advance_creative_job('submitting')` ends a job whose model is off and which was not sent: failed, hold released, the worker is told it is not its job to send |
| Channel pipeline runs (daily, repair, series episodes, API videos, scene regeneration) | `modules/model_switch.py` + `tools/queue_worker.py`: before the hold is opened and before `main.py` starts, the worker asks `model_switch_state()` and stops a run whose **video or image provider** is switched off (coded `switched_off`, nothing run, nothing charged, hold released by the existing sweep) |

Series *planning* is a Gemini text call (not a registry model) and is not gated. Voice cloning (0117) is not a model pick and is not
gated. GitHub Actions runs of `main.py` (the owner's scheduled runs) do not pass the queue worker and are not gated.

## The in-flight rule (exact)

A creative job is **sent** once `submit_started_at` or `provider_task_id` is set (the first is written before the vendor call, the second
after it).

* **Sent jobs are never touched.** They run to the end, are charged on success and released on failure, exactly as before.
* **A job not sent** (status `queued` or `running`, neither field set) when its model is switched OFF is **stopped**: status `failed`,
  `error_code = 'model_temporarily_off'`, charged 0, hold released in the same transaction (`creative_end_locked`), a job event logged,
  the user notified like any failed job ("credits returned"). It happens at the moment of the switch (`model_switch_stop_jobs`, one
  organization's account at a time, `for update skip locked`), and again at the last gate if a job slipped through (a worker held the
  row, a job was re-queued, a job was created in the same instant).
* **Never re-routed, never re-queued, never revived.** Switching ON again does not restart a stopped job; the person starts it again.
* A job whose submit began a moment before the switch committed is sent and continues.
* **Workflow runs:** each step is an ordinary job. A stopped step fails that step and the run (0083 makes only plan-limit and balance
  refusals wait). Steps already charged stay charged for the output they made.
* **Channel runs:** a run already started (`main.py` running) is never touched; one not yet started is stopped before it spends.
* Before turning OFF, the Switches view asks the database (`owner_model_switch_preview`) how many jobs are *waiting* (would be stopped
  and refunded) and how many are *already with the vendor* (finish as usual), shows both in the confirmation, and sends
  `confirm: true` only from that confirmation. The function itself refuses without `p_confirm` when anything is waiting.

## What a person sees

* A model that is off is missing from every picker. A form that came with it (a retried job, a link from the catalog) says **"This model
  is temporarily unavailable"** and picks nothing: the person chooses another model themselves.
* A page left open gets `503 model_temporarily_off` ("This model is temporarily unavailable. Nothing was charged. Choose another model, or
  try again later.") from the quote and the create.
* **Never the reason.** "Out of funds" is the vendor account's state and belongs to the platform (BR-L-021). The reason and the note are
  read by the owner only (`owner_model_switches()`); `models_switched_off()` returns ids; the refusal text names the model and nothing
  else (a test pins that no user-facing string, API answer or notification mentions it).

## The owner's view (Models, Switches)

Per provider and per model: a status in words ("Not switched off" / "Hidden from users" / "Hidden from users: its provider is off"; never "available", which a switch cannot know),
the sale state beside it, a button that opens a form (reason, optional note), then the confirmation with the counts, last changed by / at,
the open alerts, and the last 50 changes (who, when, what, why, jobs stopped). Phone width, 44 px controls, three languages.
No "switch everything", no timer, no automatic switch-off.

## The alert (optional, separate switch, default OFF; **a follow-up decision**, nothing is auto-hidden)

`model_availability_settings.auto_suggest` (default `false`), `suggest_threshold` (default 3) and `suggest_window_minutes` (default 60).
When on, an AFTER trigger on `creative_jobs` counts jobs that failed with the typed code **`quota`** (a spent vendor balance or quota;
`auth` is a bad key and needs the opposite remedy, so it is not counted) on one provider inside the window, and at the threshold records
**one open alert per provider** ("bytedance (Seedance ...) may be out of funds"). It never changes a switch. The trigger is inert when
the setting is off, fires only on a failure with that code, and is wrapped so that a failure inside it can never undo the job's own
refund. Not counted yet: the failover path (a quota refusal that moved a routed job to another model), channel runs, and `unavailable`
(a 5xx is not proof of an empty wallet). **Decision for the owner:** whether to ever let this switch a provider off by itself.

## Known limits (stated, not hidden)

* The channel pipeline honours **provider** switches only: a run names a provider (`seedance`), not a registry model, and one provider
  can run several registry models, so a model-level switch cannot be matched to a run without guessing. The Switches view says so.
* A pipeline provider with no registry entry (`higgsfield`, `leonardo`, `fal`) has nothing the switch can say about it.
* The pipeline gate fails **open**: if the switch state cannot be read (network, migration missing) the run goes on and the worker logs
  it. The switch only ever removes capacity; an unreadable switch is today's behaviour, not a stopped pipeline. The database-side gates
  are atomic and need no such trade.
* The audit goes to `model_availability_log` and `security_events`. It does **not** write `app_audit_log` (that would redefine
  `audit_action_allowed`, which has been replaced several times); the operator bot's `member.*` alert prefix does not cover
  `model.switch`.
* `start_workflow_run` answers `unpriced` for a workflow with a switched-off step (its quote carries the honest per-step reason).
* A request refused with `model_temporarily_off` is refused for the owner's own Studio too: there is no owner bypass.

## What the independent security review must verify

1. `\i supabase/migrations/0124_model_switch.sql` applies on a copy of production **as one transaction** and **twice** (the replay
   changes nothing and keeps `enforced`). The drift guard refuses if any of the five replaced functions is not the repo's body: compare
   the md5 pairs in the file with `select md5(regexp_replace(prosrc, '\s+', ' ', 'g')) from pg_proc where oid = '<signature>'::regprocedure`
   on production before applying.
2. **Dark:** `select enforced, auto_suggest from public.model_availability_settings` reads `false, false`; with it, every
   `model_is_available(id)` is `true`, and `sellable_models()`, `creative_price()` and `advance_creative_job()` return what they did (the
   diff against the earlier bodies is additions only: `tests/test_model_switch_migration.py`).
3. **Grants:** no API role has any privilege on the four tables; `anon` has `EXECUTE` on nothing new; `service_role` has no `EXECUTE` on
   the `owner_*` functions; `model_switch_state()` is service-role only; the helpers are nobody's. (The verify block at the end of the
   file reads true in every column.)
4. **Owner only:** an organization owner, an admin who is not the platform owner, `anon` and the service key are all refused by every
   `owner_*` function (`tests/security/test_sec_model_switch.py`), and a refused call writes nothing.
5. **Lock order:** `advance_creative_job` runs its gate *before* it locks the job row (`creative_end_locked` takes the account first,
   then the job, as every function of 0036 does); `model_switch_stop_jobs` locks one account at a time in `(org_id, id)` order and
   skips rows a worker holds. Check for a deadlock under concurrent create, claim, advance and switch-off.
6. **The RLS policy** `model_registry_select` now calls `model_is_available(id)` as the reader, which therefore needs `EXECUTE` for
   `authenticated`: confirm that is acceptable (it answers a boolean about a model the reader could already list).
7. **The alert trigger** on `creative_jobs` (`after update of status ... when new.error_code = 'quota'`) cannot make a job's finish fail
   or slow it, and does nothing while `auto_suggest` is false.
8. **Information:** no user-facing path (refusal text, API body, notification, `sellable_models()` rows, `models_switched_off()`)
   carries `reason`, `note`, `changed_by` or the word "funds".

Rollback: `docs/sql/rollback_0124_model_switch.sql` (puts the five bodies and the policy back byte for byte, drops everything new; copy the
log out first).

## Tests

* `tests/security/test_sec_model_switch.py` (real PostgreSQL 16, 60 tests): dark, who may do what, every entry point, the in-flight rule,
  audit, disclosure, the alert, replay, drift guard, rollback.
* `tests/test_model_switch_migration.py` (static): the replaced bodies are the earlier ones plus marked additions, the hashes, the grants.
* `tests/test_model_switch.py`: the pipeline gate (provider mapping, fail-open, no hold, regeneration).
* `command-center/tests/model-switch*.test.ts(x)`: the request, the document, three languages, the route, the owner's board, the page's
  gating, the Studio line.

# S2 — the one live paid test film: a runbook

The owner has approved **one** real paid test film through the whole chain. Its total vendor cost is capped at **USD 15**.
**Atlas runs it** in the owner's own workspace, after S1–S4 are merged. S2 wrote this runbook and never spends.

Everything below is a person's act in the SQL editor, the server's env file or the Command Center. The browser only calls the
database (CLAUDE.md #3), and the upload stays private (#2). No vendor price is written here (project rule). The dollar figures are
the cap and the readings from our own `creative_job_costs` table, never a quote from a price page.

## 0. Preconditions: do not start until every box is ticked

**Merged and applied.** These must be merged, and their migrations applied by hand in this order:

- [ ] #895 (gap list) and #903 (stop spending once a film can no longer be assembled). No migration.
- [ ] #908, **0212**, the sweep. Check with `select public.film_sweep_status();`: a json answer, `overdue_after_minutes = 30`.
- [ ] **0215**, archive and resume, plus the worker-id fix. This one is wanted, not required: without it a paused test film
  cannot be resumed, only left paused.
- [ ] The alerts PR (G3/G4), running in `operator_alerts.yml`. The operator chat must be receiving alerts: send
  `/health` to the bot first.
- [ ] S1's Brain hands the film over through `FilmCreateButton` (#905). S3's live view and S4's assembly are merged.

**Prices exist for every line, or nothing can start (rule 5):**

- [ ] `film_assembly_minute` is set in `credit_prices`. It is not seeded.
  `select unit, credits_per_unit from public.credit_prices where unit = 'film_assembly_minute';`
- [ ] The key-frame, clip and voice models the film will use are on sale (`model_registry.availability`) and probed recently
  (`record_model_probe`). Their adapters must have made a real call before: CLAUDE.md "Definition of Done".

**Workers (deploy env file, `deploy/.env.worker`):**

- [ ] `NIGHTSHIFT_FILM_WORKER=on`, `NIGHTSHIFT_FILM_ASSEMBLY=on`, and `NIGHTSHIFT_WORKER` on. Then redeploy.
- [ ] `docker compose logs --tail 50 film-worker` says `film worker … started (sweep every … s …)`. It must NOT say
  "only the sweep runs", which would mean the assembly cannot run.
- [ ] `worker_status` has a fresh `film-…` row (the alerts PR).
- [ ] The vendor keys are in the worker's env, from GitHub Actions secrets or the server env file. Never paste one anywhere else.

**Sweep, measured:**

- [ ] `select public.film_sweep_status();` shows `runners.pg_cron.last_at` or `runners.server.last_at` (the `film-sweep` service, `NIGHTSHIFT_FILM_SWEEP=on`) within the last 15 minutes. Actions only watches hourly; it never sweeps, `overdue`
  = `false`, and `stuck_segments` = 0.

## 1. Make the test small enough to fit USD 15

The rule is the **smallest film the product allows**:

- 10 seconds (0198's minimum);
- one scene, one shot, a key frame, one clip, the narration;
- `captions_mode` as the product defaults it.

Before going on:

1. Pick the cheapest models that are honestly on sale for each role. Do not pick a model only because it is cheap if it was never
   called for real.
2. Atlas estimates the vendor cost of that exact plan from each vendor's own billing basis. The estimate covers:
   - the key frame;
   - one clip;
   - the narration characters;
   - **plus the one automatic retry per take** (0171), because a failed take may run twice.
3. If the estimate with retries exceeds **USD 10** (two thirds of the cap, leaving room for the vendor's rounding), shrink the plan
   or stop and ask the owner. Do not "try and see".
4. Put the credit cap on the workspace, so that no bigger film can start by mistake. This is done in the SQL editor (no API role
   writes this table):
   ```sql
   insert into public.org_film_settings (org_id, max_credits_per_film, max_active_films)
   values ('<owner org id>', <the quote's total, rounded up>, 1)
   on conflict (org_id) do update set max_credits_per_film = excluded.max_credits_per_film, max_active_films = 1,
     updated_at = now();
   ```
   A start above this cap is refused `cap_exceeded` before any hold is taken.

## 2. Switch on: this workspace only, nothing else

In this order. Each step writes `security_events`.

1. **The platform switch** (SQL editor, or owner_guard with the second factor): `select public.set_film_studio_enabled(true);`
   - While every organization's own switch is off (0198's default), this changes nothing for any customer: the start, the quote and
     the claim all also ask the organization's switch.
   - Before going on, confirm no other org is on:
     `select org_id from public.org_film_settings where film_studio_enabled;` (0198's column). The answer must be empty.
2. **The owner's workspace:** `select public.set_org_film_studio_enabled('<owner org id>', true);`
3. **The Command Center screens for admins only:** `NIGHTSHIFT_FILM_STUDIO=admins` on the app server. **Not `on`.**
4. `select public.film_studio_on_for('<owner org id>');` answers `true`, and for any other org `false`.

## 3. Run it

1. In the Studio, give Nightshift AI the topic. Answer its cards. Check that the plan is exactly the small plan from step 1.
2. **Create shows one price, from the server** (`quote_film`). Write down:
   - the total;
   - `quote_id`;
   - `available`.

   If any line is unpriced the button says why, and nothing can start. Fix the price; do not work around it.
3. Press **Create** once and confirm. Write down the answer: `ok`, the segment id, and whether it was `replayed`. A second press
   must replay, not start a second film.
4. From here, watch. Never press anything in the browser to "help".

## 4. Watch it

| What | Where | What healthy looks like |
| :-- | :-- | :-- |
| The film | the live view (S3), and `select status, pause_reason from public.films where id = '<film>';` | `queued`, then running (S3's words), then `ready` |
| The segment | `select status, attempts, worker_id is not null, deadline_at, credit_ref from public.film_segments where film_id = '<film>';` | claimed within a minute or two; `credit_ref` is `fm-…` |
| The hold | `select status, amount, captured, settled_at from public.credit_reservations where job_id = '<credit_ref>';` (0020) | `open` until the settle, then `captured` (`captured` ≤ `amount`) or `released` |
| The takes | `select kind, attempt, status, charged_credits, error_code from public.film_takes where film_id = '<film>' order by created_at;` | `completed` one by one; a failed attempt 1 is `superseded` at 0, with an attempt 2 |
| **Real vendor money** | `select sum(usd_estimate) from public.creative_job_costs c join public.creative_jobs j on j.id = c.job_id where j.film_take_id in (select id from public.film_takes where film_id = '<film>');` | it grows take by take. **Check it after every take.** |
| The events | `select event, detail - 'worker' as detail, created_at from public.film_events where film_id = '<film>' order by created_at;` | `started`, `segment_claimed`, `take_completed` …, `assembly_completed`, `segment_settled` |
| Alerts | the operator chat | **silence.** Any `not_captured`, `segment_skipped`, `film_stuck` or `film_sweep_overdue` alert means stop (step 6) |
| The worker | `docker compose logs -f film-worker` | one line per take; never a key, a URL with a token, or a prompt |

## 5. What success looks like

All of these, checked and written into the report to the owner:

- [ ] The film is `ready`, and the segment is settled with reason `completed`.
- [ ] **Money adds up**:
  - the hold's captured amount equals the sum of the takes' `charged_credits` plus the assembly's charge;
  - that is ≤ the hold;
  - the rest is released;
  - the workspace balance moved by exactly the captured amount;
  - there is one capture in the ledger.
- [ ] `segment_settled` has **no** `not_captured`.
- [ ] Real vendor cost (`creative_job_costs`, the query above) is ≤ USD 15. Compare it with the estimate from step 1 and give
  both numbers.
- [ ] The master and the 480p review copy exist. The finished video plays at the end of the lane and can be downloaded.
- [ ] **The upload is private** (rule 2). Check it on YouTube Studio itself, not on our screen.
- [ ] No alert fired. `film_sweep_status()` reads `stuck_segments = 0`.
- [ ] Refresh mid-run, done once on purpose during step 4, lost nothing and started nothing.

## 6. Stop, and get the money back, if it goes wrong

**Stop first, then diagnose (rule 8). Never retry a paid step by hand.**

| Trigger | Do this |
| :-- | :-- |
| Real vendor cost reaches **USD 12**, or a take was retried twice | Stop the worker (below). The cap is not "spend up to 15"; it is "never above 15". |
| Any money alert (`not_captured`, `segment_skipped`) | Stop the worker. Read the event's detail. |
| A take fails for good | Nothing to do: since #903, the worker stops by itself and settles `takes_failed`. Check that it did. |
| The film looks stuck (`film_stuck`, or no new take for 20 minutes) | Read the worker log first. Then stop the worker. |
| Anything published, or not private | **Stop everything** (below), and tell the owner at once. This must not happen (rule 2). |

**Stopping, from the least drastic to the most:**

1. **The workspace switch off:** `select public.set_org_film_studio_enabled('<owner org id>', false);`
   - The worker begins no new take. A take already at its vendor is still polled, so it is not paid twice and not lost.
   - The segment then settles with what it has, and what was never begun is skipped at 0.
2. **Cancel the segment** (SQL editor, service role): `select public.film_cancel_segment('<segment id>', 'cancelled');`
   - It releases every take that never began, and settles now, or when the takes in flight end.
3. **The worker off:** `NIGHTSHIFT_FILM_WORKER=` (empty) in the env file, then redeploy.
   - The sweep still runs from pg_cron or the `film-sweep` service (0212), which is independent of the worker switch, so the segment settles by 0171's own rules while its hold is open: a deadline of
     20 h + 2 h grace, or 3 h if it was never claimed.
   - Use this only if steps 1–2 did not stop the spending.

**Getting the money back:**

- **Credits:** 0171 never charges a take that delivered nothing. A take that failed, was cancelled or was never begun is charged 0,
  and the hold's rest is released by the settle. Check the hold (step 4) reads `captured` (`captured` ≤ `amount`), or `released`. If a hold is
  still `open` an hour after the settle, it is a bug: do not release it by hand. Record it and tell S2. The sweep or 0020's
  expiry is the only thing that ends a hold.
- **Vendor money** spent on a failed take is the platform's ("the platform absorbs", FILM_STUDIO.md "What a take costs"). Write it
  down. Ask the vendor for a refund only where the vendor's own terms offer one. Never invent a refund in our ledger.

## 7. Switch off again, and report

1. `select public.set_org_film_studio_enabled('<owner org id>', false);`
2. Leave the platform switch on or off as the owner decides; with every org off, it changes nothing.
3. `NIGHTSHIFT_FILM_STUDIO=off`, or leave it at `admins`, as the owner decides.
4. Remove the test cap, or keep it, as the owner decides.
5. Send the owner a report with:
   - the film id and the quote total;
   - the credits captured and released;
   - the real vendor cost against the estimate;
   - the alerts (expected: none);
   - the private upload's video id;
   - what surprised anyone.

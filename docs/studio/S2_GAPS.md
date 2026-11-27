# S2 — Run & money: the gap list (diagnosis, rule 8)

Stream S2 of the build program (`docs/studio/PROGRAM.md`). This is the measurement, and it comes before any fix. Every line below
is either **met**, with the evidence, or **open**, with the evidence and the PR that closes it. Nothing here is taken on a doc's
word that it is "built".

Measured on 22 Nov 2026 against `main` at `7ef5b38`. The lab is a local Postgres 16 with `supabase/schema.sql` and every
migration through 0209 applied (`tests/security/sec_db.py`).

## How it was measured

1. **The existing film lab suites, all green:** 165 passed in 112 s.
   - `test_sec_films_money.py`, `test_sec_breach_films_money.py`
   - `test_sec_film_worker.py`, `test_sec_film_worker_breach.py`
   - `test_sec_breach_0187_film_edges.py`
   - `test_sec_film_assembly_worker.py`, `test_sec_breach_film_assembly_worker.py`
2. **New in this PR: `tests/security/test_sec_film_e2e_lab.py`.** It runs the real Python worker against the real SQL of 0171,
   0198 and 0200. The pieces are `FilmOrchestrator`, `FilmRest`, `CreativeRest`, the real `fo.Media.copy_input`,
   `ml.store_generated` and `fa.assemble_segment`.
   - Until now, `tests/test_film_orchestrator.py` drove the worker against a fake 0171, and the lab drove only the assembly. So
     `FilmRest`'s parameter names and selects had never met the real signatures.
   - The test puts a strict PostgREST stand-in in place of `requests.Session`. An RPC is called from `jsonb_to_record` as
     `service_role`. A body key that is not a parameter, or a missing required one, is a 404 and fails the test. SQLSTATEs map
     to HTTP status as PostgREST maps them.
   - Only the vendors (fake adapters), ffmpeg, the probe and the render are faked. Every row, charge, capture and release is
     the database's.
   - Result: **18 passed in 24 s.** Every body the worker and the assembly sent matched a real function.

## The money paths

| Path | State | Evidence |
| :-- | :-- | :-- |
| Draft, then `quote_film`, then `start_film` (admin, quote id, key), then claim, then takes, then assembly, then settle; film `ready` | **met** | e2e `test_happy_path_real_worker_…`: 49 held, 49 captured, one ledger capture, balance moved by exactly 49, nothing left reserved, events `started` … `segment_settled` |
| One hold per segment, capture ≤ hold, the rest released | **met** | the same test, plus `test_sec_film_worker.py::test_a_segment_settled_twice_captures_once` |
| Provider outage, then the one retry: the failure is charged 0, the retry charged once | **met** | e2e `test_a_provider_outage_on_one_take_…` (`retried_not_charged`, then `full_line`) |
| Both attempts fail: 0 charged for it, film `paused` (something charged) or `draft` (nothing), hold released | **met** | e2e `test_a_clip_that_fails_twice_…`, `test_both_attempts_failing_…` |
| Timeout (adapter code, or the worker's own poll clock): stored as `timeout`, charged 0, retried once | **met** | e2e `test_a_provider_timeout_…` and `test_a_task_the_provider_never_finishes_…` |
| Insufficient credits at start: `{ok:false, insufficient_credits, NS402}`, nothing held | **met** | e2e `test_insufficient_credits_…` |
| The price moved after the quote: `price_changed` | **met** | e2e `test_a_rate_that_moved_…` |
| Duplicate start: the same key replays, a new key is refused, concurrent starts give one segment and one hold | **met** | e2e `test_a_duplicate_start_…`, `test_two_concurrent_starts_…` |
| Worker restart mid-run (refresh mid-job): no take paid twice, a task at the vendor is polled and not resubmitted | **met** | e2e `test_a_worker_restarted_after_one_take_…`, `test_a_worker_restarted_while_a_clip_is_at_the_vendor_…` |
| Expired hold or lost worker: the sweep settles past deadline + grace while the hold is open | **met** (when a sweep runs; see G2) | e2e `test_a_lost_worker_…` (`expire()` returns 1, captures exactly the made key frame; a second sweep returns 0) |
| Lease and job heartbeat reach the real functions; a foreign worker reads as lost | **met** | e2e `test_the_lease_heartbeat_…` |
| **No spend after the film became unassemblable** | **met (G5)** | e2e `test_a_key_frame_that_fails_twice_stops_the_run_the_narration_is_not_voiced_and_nothing_is_charged`: key frame fails twice, nothing more begins (no clip, no narration), 0 captured, the hold released and the film back in `draft`. Before the fix the narration was voiced and charged (1 credit) and the film paused with a capture. Fixed by `claude/nsai-s2-stop-unassemblable`: the driver begins no further take once one failed for good or cannot begin for a failed input, and settles `takes_failed` (`modules/film_orchestrator.py`, `_unassemblable`). P4a refuses a film with any missing take (`docs/FILM_STUDIO.md`, Assembly). |

## The switch-on gates (`docs/FILM_STUDIO.md`, "Switch-on gates")

| Gate | State | Evidence | Closed by |
| :-- | :-- | :-- | :-- |
| **G1.** Archive and resume exist for `paused` and `cancelled` projects | **met by 0215** (when merged and applied) | Before: `archive_film` refused unless `film_is_editable`, i.e. `draft`/`planned` (0166:560-563, :1416), and no resume function existed. 0215: `archive_film` takes `paused` and `cancelled` too (refused while a segment is open or a refund waits); `quote_film_resume` / `start_film_resume` (admins) price and hold only the lines not completed, carry the completed takes at 0, and the real worker drives the resumed segment unchanged (`tests/security/test_sec_film_resume_0215.py`; e2e `test_a_paused_film_resumed_is_driven_by_the_real_worker_…`). A `cancelled` film is archived, not resumed (0171 never restarts one). Browser routes: follow-up. | `claude/nsai-s2-archive-resume` (0215; contract answered by Atlas) |
| **G2.** `film_expire_segments` runs at least every 15 minutes | **open** | It runs only on a thread inside `tools/film_worker.py:205-207`, and only when `NIGHTSHIFT_FILM_WORKER=on` and the process is alive. A stopped, crashed or redeploying worker means no sweep. pg_cron is **not** installed on the live project (docs/MIGRATIONS.md, 0111 D15), so no database schedule exists. There is no record of when a sweep last ran, so "≤ 15 min" cannot be shown, only assumed (rule 5). | `claude/nsai-s2-sweep`: `film_sweep()` records each run (0212); a pg_cron job where installed; `.github/workflows/film_sweep.yml` every 10 min, independent of the worker; the worker calls the same function. |
| **G3.** Alert on every `segment_settled` with `not_captured`, and on every `segment_skipped` | **built, not live** (`claude/nsai-s2-alerts`: the `film` kind, `tests/test_operator_film_alerts.py`; live when the bot's pass runs against this code). Before it: **open** | Nothing reads them: `grep not_captured` hits only 0171/0198 and tests. `modules/operator_bot/alerts.py` `detect()` has no film source. The `security_events` fallback `film.segment_skipped` (0171 `film_record_skip`) is not read either. | `claude/nsai-s2-alerts`: a `film` alert kind in the operator alert engine (every 10 min, `operator_alerts.yml`): `not_captured` (critical), `segment_skipped` and its security_events fallback (warn), each deduped per event |
| (implied) **G4.** A stuck segment is seen | **built, not live** (`claude/nsai-s2-alerts`: `film_stuck`, `film_sweep_overdue` and the film worker's `worker_status`, `tests/test_operator_film_alerts.py`, `tests/test_film_worker_cli.py`; the overdue alert also needs 0212 applied). Before it: **open** | The film worker never reports `worker_status` (only email/marketing/media workers use `modules/worker_status.py`), so "worker lost" alerts are blind to it. Nothing alerts on a segment `queued` with no claim, a `running` segment whose lease is stale, or a sweep that is overdue (G2). | `claude/nsai-s2-alerts`: the film worker reports `worker_status` (kind `other`, id `film-…`); alerts `film_stuck` (queued > 15 min, stale lease > 20 min) and `film_sweep_overdue` (by 0212's own `overdue`, with its line, `stuck_segments` and `oldest_stuck_minutes`) |

## Create → quote → start in the browser (the money call and its button)

Two places start a film. Both use the member's session (anon key + cookie), never the service key, and both mint the
idempotency key in the browser (`lib/server/films.ts:23`, `app/api/films/[id]/start/route.ts:19-27`). No number is shown for
an unknown price (`lib/studio/timeline.ts:444-457, 486`).

| State | AssemblePanel (`components/studio-timeline/AssemblePanel.tsx`) | Brain Create (`components/brain/NightshiftAiPanel.tsx`) |
| :-- | :-- | :-- |
| loading | met (:239) | met (`disabled={busy}`) |
| insufficient credits with the remedy | met (Add credits, :189, :246-251) | before the press, met (:500-506); **after a refused start, open: reason with no remedy link (:271)** |
| price changed / quote expired → re-quote | met (:160-180) | **open: no re-quote action (:271); the idempotency key is not reset after a refusal (:247, :260), so the next press resends the same key with a new quote and is answered `idempotency_conflict` (FILM_STUDIO.md, "The start"; not yet reproduced in the lab)** |
| disabled with an honest reason | met for switch/cap/limit/slots (:216-217); **open for an unpriced line: shows "Pricing for projects is not live yet" (:141, :215) instead of the line's own reason (`FilmQuote.refusal`, `lib/studio/timeline.ts:431`)** | **open: only the first blocked reason (:496-498); an unpriced quote shows `priceUnpriced`, not the line's reason (:499)** |
| network error → retry with the same key | met (:164-167, :223) | **open: a generic message, no retry (:277)** |
| duplicate press | met (`startOnce`, `noRepeat`, :193-208) | met (`??=` key) |
| en/ru/uz | present (`lib/i18n/studio-timeline/*`, `ai-chat`) | present |

The project canvas (`components/films/FilmCanvas.tsx:318-329`) still draws Start disabled as "not live". That is honest while
the switch is off; it stays so in this stream.

Closed by `claude/nsai-s2-create-button`. S2 owns only the money call and its states. The Brain panel is S1's: the change is
limited to the start call and its result handling, and S1 is told first.

## Decisions taken here, not gaps

- `not_found` (P0002) from 0171 reaches `FilmRest` as HTTP 500, so it is read as `FilmUnavailable` (left for the next claim)
  rather than `FilmRefused`. This is harmless: the segment is retried, and nothing is charged. It is pinned by
  `test_the_stand_in_answers_a_raised_refusal_…`.
- Untested, and why:
  - style kits and @characters, extends, and `end_frame` to the next key frame: no lab film uses them yet (next e2e pass);
  - real ffmpeg and real PostgREST: the stand-in follows PostgREST's documented behaviour, but it is not the binary;
  - the switch going off mid-run, and moderation billing: covered at the SQL level in `test_sec_film_worker.py` and
    `test_sec_films_money.py`.

## The order of the PRs

1. **this PR:** the gap list and the e2e lab test (no product change);
2. `claude/nsai-s2-sweep`: G2;
3. `claude/nsai-s2-alerts`: G3, G4;
4. `claude/nsai-s2-stop-unassemblable`: G5, which flips the pinned e2e assertion to a failing-then-passing regression;
5. `claude/nsai-s2-archive-resume`: G1, archive and resume (0215), the assembly re-run, the member-only spend rule, and the part of the worker-id leak S3 found that
   0215 can close (BR-0036-01/02 and BR-0215-01 stay open in the ledger);
6. `claude/nsai-s2-create-button`: the Brain's start states;
7. `docs/studio/S2_LIVE_TEST.md`: the runbook for the owner-approved single paid test film (Atlas runs it; S2 never spends).

Every money function touched in 2–5 is attacked by Breach (races, replay, negative or oversized amounts, another org's film,
the service key's reach), and each confirmed finding becomes a test in `tests/security/`.

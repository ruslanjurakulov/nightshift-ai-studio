# Film Studio

A person describes a film. It is split into scenes (10 or more, up to 60). Each scene is shot as 1-3 AI video shots of 4-15 s, and
each shot starts from the previous shot's last frame. The shots are assembled into one 3-10 minute video with narration, music and
subtitles. The video then goes to a channel as a **private** upload, behind the existing publish gate and approval
(`modules/publish_gate.py`, migration 0112). Film Studio never adds a publish path. CLAUDE.md rules 2 and 3 apply unchanged.

The work ships in phases, one draft PR each. **P1** (the data) and **P5/P6 for drafts** (the routes and the screens, below) are
merged: drafts, with no spend and no worker. So is **P4a**: `modules/film_timeline.py`, the pure function that turns a film's chosen
takes into the editor's timeline document; nothing calls it yet. The assembly was measured first (P0,
docs/FILM_ASSEMBLY_MEASUREMENT.md), on a development container and not yet on the media-worker. **P2** (money: the quote, the start
and the settle path, migration 0171) is this PR. There is still no worker: a project can be priced and started only once P3 ships
and the switch is on ("Switch-on gates", below).

## The data model (migration 0166)

| Table | What a row is | Who writes it |
| :-- | :-- | :-- |
| `films` | One film of an organization. It holds the source (a `topic` of up to 2,000 or a `script` of up to 40,000 characters) and the format: `language` en/ru/uz, `aspect` 16:9 / 9:16 / 1:1, and `target_seconds` 10-1200 (0166 said 60; 0198 lowered it so a 15-30 s advert is a film). It also holds the look (`style_kit_id`, `keyframe_model`, `clip_model`), the sound settings (`voice`, `music_asset_id`, gains, `captions_mode`), `transition_default`, `status`, and a `version` that goes up on every edit. | `create_film_draft`, `save_film`, `archive_film` |
| `film_scenes` | The storyboard: up to 60 ordered scenes. Each scene has a title, narration, visual and negative prompts, `planned_seconds` (3-30), `shot_count` (1-3), its frame roles, model overrides, `clip_params` (`audio`, `resolution`) and `transition_in`. | `save_film` |
| `film_refs` | The reference set: `character` (a 0047 character), `style` or `location` pictures. Up to 16 for the whole film and up to 8 per scene. | `save_film` |
| `film_takes` | The version history: one row per generated key frame, clip, extend, narration or captions. Each input picture is recorded by its role, the output by `result_asset_id`, and the output's extracted last frame by `result_last_frame_asset_id`. | the orchestrator (P3); nothing writes it in P1 |
| `film_events` | The audit trail, append-only. Each state-changing call writes exactly one row with the auth uid, the caller's role in the organization, the event and its detail. | every write function |

Members read through RLS (`accessible_org_ids('viewer')`). No role writes a table directly: not anon, not authenticated, not the
service key. Another organization's film reads exactly like one that does not exist (P0002).

### Frame roles

Vendors take three different kinds of picture. The schema keeps the three apart:

- **First frame**: the picture a clip starts from. A scene's `first_frame` is one of:
  - `keyframe`: a key frame generated from the prompt and the references;
  - `asset`: a library picture;
  - `previous`: continue from the previous scene's last frame. This is never allowed on the first scene.
- **Last frame**: the picture a clip must end on, for models that take one (MiniMax H3, Kling v3). A scene's `last_frame` is one of:
  - `none`;
  - `asset`;
  - `next_keyframe`. This needs a next scene that has a key frame of its own.

  A take that has a last frame must also have a first frame, as every vendor requires. The table enforces this.
- **Reference**: character, style and location pictures. MiniMax H3 and Seedance 2.x take frames *or* references, never both in
  one task. So references reach a clip through its key frame, and the key-frame models take 10-16 of them. The quote (P2) checks
  which model can take what against the registry.

### Models

- A model a person picks must be on sale on the web for its role at that moment (`sellable_models`):
  - a key-frame model needs `t2i` or `edit`;
  - a clip model needs `i2v`;
  - a voice model needs `tts`.
- A model that is already saved is not checked again on an unrelated edit. The quote checks every model again before anything is held.
- **No Seedance model is accepted, ever**, whether it is matched by id, by provider `bytedance` or by a `video.seedance*` adapter.
  BytePlus's service terms §4.2.3 forbid re-integrating its video API into an AI content-creation tool.
- The primary models are MiniMax H3 and Kling v3.

### The browser's calls

| Function | Role | What it does |
| :-- | :-- | :-- |
| `create_film_draft(org, channel, source_kind, source_text, settings, idempotency_key)` | editor+ | A new `draft`. `settings` needs `title`, `language` and `target_seconds`. A replayed key answers the first film. The same key with another request is `idempotency_conflict`. |
| `save_film(film, version, patch)` | editor+ | Edits a `draft` or `planned` film at its current version. In `scenes` (the whole ordered list), a scene with an `id` keeps it and any fields it does not send, and a scene left out is deleted. `refs` is the whole film-wide list. |
| `archive_film(film)` | editor+ | Puts a draft away so it stops counting toward the 50 open drafts. |
| `film_json(film)` | viewer+ | The read model. It flags `missing` for any reference, frame, kit or track that no longer exists, and includes `limits`, the one list of limits that the app shows. |

Errors are SQLSTATE plus a machine word:

- `42501 forbidden`, `P0002 not_found`;
- `NS400 invalid_params | invalid_idempotency_key | limit_reached | model_not_offered | model_not_available | asset_not_usable`;
- `NS409 film_changed | film_not_editable | idempotency_conflict | scene_has_takes`;
- `NS429 rate_limited`.

A signed-in member reads the tables through **column grants**, not a table grant. A column that a later migration adds, such as
money or a provider's task id, stays invisible to a browser until that migration grants it. `film_json` names its columns for the
same reason. The service key reads whole rows.

## Storage and erasure

The four calls are reachable through PostgREST by any editor, with or without the Command Center. So the database itself bounds
what a scripted editor can store:

| Bound | Value | Where |
| :-- | :-- | :-- |
| Films an organization keeps, archived ones included | 500 | `create_film_draft` (`max_films_total`) |
| Open drafts an organization keeps | 50 | `create_film_draft` (`max_open_drafts`) |
| Recorded changes (events) per film | 5,000 | `save_film` (`max_events_per_film`). Archiving stays possible once, so a full film is never stuck as an open draft. |
| Calls per person per hour | 30 creates, 240 saves, 60 archives | `film_take_rate`, which wraps `take_web_rate` under `db.film.*`. These buckets are separate from the routes' own. |
| One save | 2 MB, 60 scenes, the text limits | `save_film` |

A save **replaces** the storyboard. It never appends to it. So a film's size is bounded by its limits: about 60 × 5,120 characters
of scene text plus a 40,000-character script, roughly 1.4 MB in the worst case. Its events are bounded by 5,000 small rows. The
worst case for one organization is about 500 × (1.4 MB + 1.5 MB). Reaching it takes weeks at the rate limits, and the operator can
see it coming.

**Erasure is the operator's job, and nobody else's.** No role, the service key included, may delete a film row. `film_events`
refuses update and delete even from the database owner, by trigger. To erase films, for example on a customer's request or when
an organization reaches 500, the owner runs this in the Supabase SQL editor as the table owner. It needs no grant:

```sql
begin;
set local lock_timeout = '5s';
-- Name the films first and look at them: select id, org_id, title, status, created_at from public.films where ...;
create temp table erase_films on commit drop as
  select id from public.films where org_id = '<org uuid>' and status = 'archived' and archived_at < now() - interval '90 days';
-- The append-only trigger is lifted inside this one transaction only. ALTER TABLE holds an exclusive lock until commit, so no
-- other session can update or delete an event in between.
alter table public.film_events disable trigger film_events_append_only;
delete from public.film_events where film_id in (select id from erase_films);
alter table public.film_events enable trigger film_events_append_only;
delete from public.film_takes  where film_id in (select id from erase_films);   -- before the scenes: a take restricts its scene
delete from public.film_refs   where film_id in (select id from erase_films);
delete from public.film_scenes where film_id in (select id from erase_films);
delete from public.films       where id      in (select id from erase_films);
-- Check before commit: the trigger is back on, and the counts are what you meant.
select tgenabled from pg_trigger where tgrelid = 'public.film_events'::regclass and tgname = 'film_events_append_only';  -- 'O'
commit;
```

Library files (key frames, clips) are not touched by this. They are ordinary media assets, deleted through the library as usual.

Tests:

- `tests/test_films_core_migration.py` checks the file as text;
- `tests/security/test_sec_films_core.py` attacks a real database;
- `tests/security/sec_films_0166.py` holds the shared lab's contract and seed.

Rollback: `docs/sql/rollback_0166_films_core.sql`. It refuses while films exist, unless its override line is set.

## Money (P2, migration 0171)

### The switch

`film_studio_settings.film_studio_enabled` is **off** by default. While it is off, `start_film` refuses `film_studio_disabled` and
the quote lists it in `blocked_by`. Only a platform owner or admin (through `owner_guard`: second factor, a rate limit) or the SQL
editor changes it, with `set_film_studio_enabled(true|false)`, and every change writes a `security_events` row
(`film_studio.enabled`).

**Switch-on gates.** `film_studio_enabled` stays off until all of these hold:

- archive and resume exist for `paused` and `cancelled` projects, so no project a person paid into is left without a way forward;
- P3 runs `film_expire_segments` at least every 15 minutes, so a segment past its deadline and grace settles while its hold is open;
- P3 alerts on every `segment_settled` event with `not_captured` (charges a hold could no longer pay), and on every
  `segment_skipped` event (a segment the claim or the sweep could not touch).

The Command Center's own switch, `NIGHTSHIFT_FILM_STUDIO`, is separate: it shows the screens, and turns no money on.

### One hold per segment

A started film is paid by one `film_segments` row and one credit hold, `fm-<segment id without dashes>`, taken by 0020's
`reserve_credits` in the admin's own session. It is not one hold per scene or per take:

- 0034 counts every open hold as one parallel run (1 on most plans). A hold per scene would make a 40-scene film run one scene at a
  time and lock the organization out of the Studio for the whole film. 0034 is not changed. Instead the quote's `run_slot` says that
  the film uses one of the plan's runs, and for how long at most: `max_hours`, 3 unclaimed + 20 deadline + 2 grace.
- `capture_credits` settles a hold once, and the segment is the unit that settles.
- One hold checks the whole price before the first paid call.

The hold is started by the worker's first claim, so its 24-hour expiry runs from there, and the segment gets a 20-hour deadline. No
credit function is replaced: the only money calls are `reserve_credits`, `start_credit_reservation`, `capture_credits` and
`release_credits`.

### The quote

`quote_film(film, version)` (editors and above) prices the film as it stands, line by line, and stores the quote
(`film_quotes`: film, version, total, 30 minutes' validity):

| Line | How it is priced |
| :-- | :-- |
| Key frame (a scene with `first_frame = keyframe`) | `creative_price` for the key-frame model (t2i, or edit against a stand-in picture), at the film's aspect and style kit |
| Clip shot 1, extend shots 2-3 | `creative_price` i2v, against a stand-in picture (one of the library's 50 newest), at the shortest length the model lists that covers `ceil(planned_seconds / shot_count)` |
| Narration (one film-level take) | the voice model's rate as charged times every character, and never less than its minimum once per provider call (a call carries 4,000 characters) |
| Assembly, captions included | `film_assembly_minute` (`credit_prices`) times the planned minutes, rounded up. Captions come from our own pipeline (Whisper) and are part of this line, not a separate line or hold. |

Each line keeps exactly what was priced (length, resolution, sound, quality tier, shape, style kit), and each take carries those
`params`. A 0047 character counts as all of its pictures against the key-frame model's reference limit.

The answer also has:

- the total, the per-scene subtotals and `quote_id` (`fq-<version>-<md5 of the priced lines>`);
- `available`: what a start could hold now. With 0094's extra credits off, only credits that are not a top-up pack count.
- the organization's settings, `run_slot`, `film_studio_enabled`;
- `blocked_by` (`film_studio_disabled`, `cap_exceeded`, `insufficient_credits`, `limit_reached`, `run_slots_full`);
- `may_start` and `startable`.

**Where a price is unknown, it is shown as unknown (rule 5).** A line that cannot be priced has `priced: false`, `credits: null`
and a reason. The total and `quote_id` are then `null` and nothing can start. The reasons:

- `unpriced`: no credit price row for the model's unit or setting, or for `film_assembly_minute`. **No assembly price is seeded:
  until a platform admin sets it, every film is unpriced on that line.**
- `model_not_available` (not on sale for its role now), `model_not_offered` (any Seedance model), `model_not_set`;
- `invalid_params` (a shape, a length or a resolution the model does not list), `scene_too_long_for_model`;
- `source_unavailable` (no usable picture to price a clip against), `refs_not_supported` (never handed fewer references),
  `reference_missing`, `asset_not_usable`, `style_unavailable`;
- `prompt_missing`, `voice_not_set`, `channel_voice_not_priced`, `no_scenes`.

### The start

`start_film(film, quote_id, idempotency_key)` (owners and admins; in the exempt organization a platform owner or admin) takes the
organization's start lock, then the film. Some refusals are raised before anything is counted:

- who may call, the key's and the quote id's shape;
- a replay (the same key, film and quote answer the first segment; another one is `idempotency_conflict`);
- a film that is not a draft (`film_not_startable`), an older version (`film_changed`), the switch (`film_studio_disabled`);
- `film_precheck`: a model off sale or turned Seedance, a reference or a frame that is gone. These are raised with their own word, and
  no pricing has run.

Then the start is **counted** (`db.film.start`, 10 an hour). From here every refusal is answered as `{ok: false, reason, code,
detail}`, so the count survives it (BR-0171-01). They come in this order:

1. A quote id that `quote_film` did not store for this version (`price_changed`), or that has expired (`quote_expired`).
2. The stored total against the available credits (`insufficient_credits`, code NS402), `cap_exceeded`, `limit_reached`. No pricing
   has run yet for any of these.
3. The re-pricing at today's rates: an unpriced line's own word, or `price_changed`.
4. `reserve_credits`' own NS402 (`insufficient_credits`) and NS429 (`run_slots_full`), and its 22023 / 23505 (`hold_refused`).

Success is `{ok: true, ...}`: the segment and every planned take with its confirmed line, the film `queued`, and a `started` event.

### What a take costs

The rule is the Studio's: a take that delivers is charged its line, and a take that delivers nothing is charged nothing.

| Outcome | Charge |
| :-- | :-- |
| Key frame or narration made | its line |
| Clip or extend made, with the provider's task id, and its file's recorded length at least 90% of the confirmed seconds | its full line, as the Studio charges a job |
| Clip shorter than that, or with no recorded length | 0: it failed, its file is soft-deleted, and the retry rule applies |
| A failure with its retry left (attempt 1) | 0 (`retried_not_charged`), and an attempt 2 is planned at the same line. A single failure never ends a project. |
| A failure with no retry left: a provider error, a moderated task, a narration that voiced only part of its text (thrown away), a lost worker | 0, whatever the vendor did. **The platform absorbs** what the vendor charged, as it does for a failed Studio job. The basis records what is known: `moderated_vendor_billed` (Runway bills a moderated task like a success), `moderated_vendor_not_billed` (HappyHorse, Seedance), `moderated_vendor_billing_unknown` (MiniMax, Kling, LTX, ...), `partial_not_delivered`, `worker_lost_not_charged`, `failed_not_charged`. |
| Assembly, captions included | its registered file's recorded length, in whole minutes, at the confirmed rate, never above its line; 0 on failure |

"The recorded length" is `media_assets.duration_s`. The service wrote it into `register_asset` from its own probe of the file. It is
not the number handed to `film_take_succeeded`, which is only checked (0.01-600) and logged.

**A result is kept only when it is accepted (P3's contract).** P3 registers every take file through the take's creative job
(`register_asset`, source `generated`, provenance `{"film_take_id": <take>}`), and writes `result_asset_ids` as it registers. It
registers the assembly file with provenance `{"film_segment_id": <segment>}`. Then it hands the file to `film_take_succeeded` or
`film_record_assembly`. The following are soft-deleted in the same transaction:

- a rejected file (too short, no recorded length) and its last frame;
- the files a failed or lost take's job registered, or whose provenance names it;
- an assembly file handed in with a failure.

So a result nobody paid for does not stay in the organization's library. `film_discard_assets` never touches a file that is not
`generated`, that existed before the take began (or the segment was first claimed), or that is named anywhere else, whatever a
caller hands in. "Named" means another take's result or last frame, a take's inputs, a scene's frames, a reference, a film's music,
another assembly, or a character's pictures. An assembly's result must be a file made for that segment: generated after the claim,
and no take's or other assembly's. A failed assembly refuses a file that is not a video.

The same result handed in again answers as its first answer, accepted or rejected, with the retry the rejection planned.

### The settle path (the service role; P3's worker drives it)

| Call | What it does |
| :-- | :-- |
| `film_claim_segment(worker)` | The oldest queued segment, or one whose lease is stale. Every candidate is looked at, each in its own subtransaction, so one bad row is skipped with a WARNING and never blocks other films. The first claim starts the hold, and an expired hold settles the segment instead. A stale segment whose 3 leases are used is not handed out again: what it left in flight fails as `worker_lost` and it settles. |
| `film_heartbeat_segment(segment, worker)` | Keeps the lease |
| `film_begin_take(take, worker)` | Marks a planned take running before the billable call. It is refused once the segment drains or passes its deadline. When the hold is no longer open, or a refund waits on it (an open `credit_refund_recoveries` row of 0167 that lists it), nothing begins: the segment settles with what it has, and the answer says `began: false` and why (`hold_lost`, `refund_pending`). |
| `film_take_succeeded(take, worker, seconds, result, last_frame, provider_task_id)` | See the table above |
| `film_take_failed(take, worker, provider_error / moderated, code, error, units_done)` | See the table above |
| `film_begin_assembly`, `film_record_assembly(segment, worker, ok, result)` | The assembly line, captions included, charged by its registered file's recorded length |
| `film_settle_segment(segment, worker, reason)` | Drains while something is in flight. Then it skips every take that never began, captures the charges once (never above the hold) and releases the rest. |
| `film_cancel_segment(segment, reason)` | Releases every take that never began, and settles now or when the takes in flight end |
| `film_expire_segments()` | Each segment in its own subtransaction. A hold 0020 released, or a segment nobody claimed in 3 hours, settles. Past the deadline the segment drains. Past the deadline plus 2 hours (before 0020's 24) the takes in flight fail as `worker_lost`, a running assembly fails, and it settles while the hold is still open. |

Where a film goes after a settle:

- `completed` → `ready`.
- `cancelled` with a charge → `cancelled`.
- Any other reason with a charge → `paused`, with that reason.
- **Nothing charged and nothing made → `draft`**, storyboard kept, editable and startable again. `pause_reason` says why it stopped.
  Its takes that never began (skipped, at 0, named by no creative job) are removed, so a scene can be deleted again. The `started`
  and `segment_settled` events keep what happened.

A segment the claim or the sweep cannot touch is skipped, never the whole call. It leaves a WARNING and a `film_events` row,
`segment_skipped`, with the segment, the call and the SQLSTATE, at most one an hour.

What a segment captured is the ledger's own answer: a hold that 0020 expired under a half-made film reads as captured 0, and the
`segment_settled` event says how much was not captured.

**Open for later phases.**
- A person's cancel and the organization's settings have no browser function yet.
- A paused film cannot be resumed until a resume quote exists (P7).

**Number.** 0166's header names "0167" for this phase. That was the plan's number; the file is **0171**, and a merged migration is
never edited.

## In the Command Center (P5, P6 for drafts)

A person sees this as **Studio → Projects** ("Проекты", "Loyihalar"; one item is a "project"). The Studio's own name is not written in
the Projects strings: it is read from the app's `nav.hub` key. Code, tables and functions keep the internal name `films`.

| Piece | Where |
| :-- | :-- |
| The switch | `NIGHTSHIFT_FILM_STUDIO` on the Command Center's server, default off. `off`: the pages and `/api/films/**` are a 404 and nothing lists the section. `admins`: only a platform owner/admin sees it. `on`: every member. |
| Pages | `/{channel}/create/projects` (the list and "New project") and `/{channel}/create/projects/{id}` (the canvas), under the Studio's own address |
| Entry points | The Studio's desk bar, the customer sidebar's Create group and the Studio overview's list, each only while the switch lists it for the viewer |
| Routes | `GET/POST /api/films`, `GET/PATCH /api/films/{id}`, `POST /api/films/{id}/archive`. Each is the member's own session (anon key + cookie) calling 0166's functions; the service key is never used. Same origin, a body cap, and a route rate limit per person (`films.create` 60, `films.save` 480, `films.archive` 120 an hour) in front of the database's own `db.film.*` limits. The database writes the audit row (`film_events`). |
| Shared shapes | `command-center/lib/films.ts`: the read model, the refusals as closed words, what a save sends, the checks before a save, and the browser's calls |
| Data and state | `components/films/useFilmProject.ts`: the draft, autosave (4 s after the last edit, at least 20 s apart, so at most 180 saves an hour against the database's 240), the version conflict, undo and redo (50 steps), split, merge, insert, delete and reorder, and a pending-edit buffer in the browser so a refresh or a closed tab loses nothing. It knows nothing about how the board is drawn, so a node canvas can replace the scene grid. |
| Strings | `command-center/lib/i18n/film-studio/{en,ru,uz}.ts` |

What is not available yet, and says so on the screen: writing the storyboard with AI (P3), and Start with a price (P2). Start is
drawn disabled with "Pricing for projects is not live yet"; no number, price or quote is shown. Sound, shooting, assembly and the
handoff are dim stations on the track. Nothing on these screens spends, starts or publishes.

## Assembly (P4a: `modules/film_timeline.py`)

`build_cut(film, scenes, takes, assets, narration, captions)` returns the editor's timeline document, its sha256 (the same
input always gives the same hash), a plan of what it decided, and the `.srt` sidecar. It is pure: P4b reads the rows and
renders the document through `timeline_render`, exactly as an editor export does.

- A scene lasts its `planned_seconds`, and the film their sum, which is what P2 quotes. A cross-fade takes its overlap out of
  the incoming scene's footage. Shots within a scene, and a scene that continues the previous one, are cut, and the
  continuity is checked against `result_last_frame_asset_id`.
- A missing, failed, unfinished or deleted take refuses the whole film with a named reason and the scene. No scene is
  dropped, and no still or other take is put in its place.
- Measured limits it holds a film to (docs/FILM_ASSEMBLY_MEASUREMENT.md): at most 10 minutes, no per-clip `loudnorm`, and at
  most 32 sound clips, because the editor's final pass cannot render more at 1080p under the export's 2 GiB limit.
- What P3 has to deliver for it: the narration take **on the film's clock** (each scene's words start `NARRATION_LEAD_S` into
  the scene, so a 60-scene film is one sound clip rather than 60), its per-scene `segments` in the file's time, its measured
  `loudness_lufs` and `true_peak_db` (one gain brings it to -16 LUFS; without them the plan says "not measured"), and the
  captions timed against the narration file.

## The phases

| PR | Content | Migration | State |
| :-- | :-- | :-- | :-- |
| P0 | Scout and measurement: vendor facts, and a 10-15 minute assembly measured on the media-worker (rule 8) | - | Scout done; assembly measured on a dev container (docs/FILM_ASSEMBLY_MEASUREMENT.md); one timed run on the media-worker owed |
| P1 | Core tables, RLS, `film_events`, `create_film_draft` / `save_film` / `archive_film` / `film_json`. Drafts only, no spend | 0166 | merged |
| **P2** | Money. `quote_film`, `start_film` and `film_segments` (one hold per segment, settle and release). Also: the money columns on `film_takes`, `creative_jobs.film_take_id` with `payer='film'`, `org_film_settings`, and the service functions of the state machine. The `film_assembly_minute` price is read, not seeded: an admin sets it | **0171** (provisional) | this PR |
| P3 | The orchestrator. `tools/film_worker.py` and `modules/film_orchestrator.py` drive 0171's state machine (claim, begin, result, the one retry, the assembly handoff, settle, the sweep). The take's creative job is written by `film_take_job` (0198) already claimed by the film worker, which runs it through the creative adapters itself (the credit-paid creative worker never claims a `payer='film'` job). Last-frame extraction goes through `ffmpeg_limits`. 0198 adds a switch per organization (off) and lets a film target 10 s. The platform switch stays **off**; an owner turns it on once the switch-on gates hold. Status contract: docs/studio/NIGHTSHIFT_AI.md. The plan step (Gemini) is not in this PR. | 0198 (provisional) | built, not switched on |
| P4 | Assembly. **P4a**: `modules/film_timeline.py` (pure, no wiring). **P4b**: `modules/film_assembly.py`, run by the P3 worker on its own segment lease (no second claimer: 0171 has one lease per segment), the free-disk check, the 480p review copy, the WebVTT sidecar, `film_record_assembly`. No new table: the cut is named by the master's id (uuid5 of the segment and the cut's sha256) and its provenance. Contract: docs/studio/NIGHTSHIFT_AI.md, "Assembly handoff". 0200 adds `film_discard_unrecorded_assembly` (a master registered after its segment's assembly ended without it) | 0200 (placeholder) | P4a done; P4b built, behind `NIGHTSHIFT_FILM_ASSEMBLY` and `film_studio_on_for` |
| P5 | `/api/films/**` routes, `lib/films.ts`, rate buckets, geo checks, audit | - | drafts done (no geo check yet: drafts pick no model) |
| P6 | The canvas UI with every state, at mobile width, in en/ru/uz | - | drafts done; Start stays off until P3 and the switch |
| P7 | Re-shoot: angle, light and motion; choosing a take version; re-assembly | 0169 | |
| P8 | Handoff to the channel. This adds the `film` and `film_voice` render-job kinds, `send_film_to_channel` and `main.py --film`. The payment guard is md5-pinned. The upload stays private. | 0170 | |
| P9 | The autopilot `scene_mode = ai_video` setting, locked to admins. Storyboard review is forced. `films.storyboard_id` is added. | 0171 | |
| P10 | Breach and Sentinel regression set across P1-P9 in `tests/security/` | - | |

A column arrives with the migration whose code writes it. That is why P1 has none of these:

- money (segments, `confirmed_credits` / `charged_credits`);
- assembly (`current_cut_id`);
- the autopilot link (`storyboard_id`, `run_slug`).

No seed column is stored either: none of the primary models (MiniMax H3, Kling v3) takes a seed. A stored seed that is never sent
would read as a measurement (rule 5).

# Film Studio

A person describes a film. It is split into scenes (10 or more, up to 60). Each scene is shot as 1-3 AI video shots of 4-15 s, and
each shot starts from the previous shot's last frame. The shots are assembled into one 3-10 minute video with narration, music and
subtitles. The video then goes to a channel as a **private** upload, behind the existing publish gate and approval
(`modules/publish_gate.py`, migration 0112). Film Studio never adds a publish path. CLAUDE.md rules 2 and 3 apply unchanged.

The work ships in phases, one draft PR each. **P1** (drafts) is merged; **P2** (money: the quote, the start and the settle path) is
this PR. There is still no worker and no UI: a film can be priced and started, and nothing runs it until P3.

## The data model (migration 0166)

| Table | What a row is | Who writes it |
| :-- | :-- | :-- |
| `films` | One film of an organization. It holds the source (a `topic` of up to 2,000 or a `script` of up to 40,000 characters) and the format: `language` en/ru/uz, `aspect` 16:9 / 9:16 / 1:1, and `target_seconds` 60-1200. It also holds the look (`style_kit_id`, `keyframe_model`, `clip_model`), the sound settings (`voice`, `music_asset_id`, gains, `captions_mode`), `transition_default`, `status`, and a `version` that goes up on every edit. | `create_film_draft`, `save_film`, `archive_film` |
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

### One hold per segment

A started film is paid by one `film_segments` row and one credit hold, `fm-<segment id without dashes>`, taken by 0020's
`reserve_credits` in the admin's own session. Not one hold per scene or take, because:

- 0034 counts every open hold as one parallel run (1 on most plans). A hold per scene would make a 40-scene film run one scene at a
  time and lock the organization out of the Studio for the whole film.
- `capture_credits` settles a hold once, and the segment is the unit that settles.
- One hold checks the whole price before the first paid call, so a film never runs out of credits half way.

The hold is started by the worker's first claim (its 24-hour expiry runs from there) and the segment gets a 20-hour deadline. No credit
function is replaced; the only money calls are `reserve_credits`, `start_credit_reservation`, `capture_credits` and `release_credits`.

### The quote

`quote_film(film, version)` (editors and above) prices the film as it stands, line by line:

| Line | How it is priced |
| :-- | :-- |
| Key frame (a scene with `first_frame = keyframe`) | `creative_price` for the key-frame model (t2i, or edit against a stand-in picture), at the film's aspect and style kit |
| Clip shot 1, extend shots 2-3 | `creative_price` i2v, against a stand-in picture of the library, at the shortest length the model lists that covers `ceil(planned_seconds / shot_count)` |
| Narration (one film-level take) | the voice model's rate as charged (from `creative_price` tts) times every character of narration, with the job minimum |
| Assembly | `film_assembly_minute` (`credit_prices`) times the planned minutes, rounded up |

It answers the total, the per-scene subtotals, `quote_id` (`fq-<version>-<md5 of the priced lines>`), the available credits, the
organization's settings, the parallel-run slots, `blocked_by` (`cap_exceeded`, `insufficient_credits`, `limit_reached`,
`run_slots_full`), `may_start` and `startable`.

**Where a price is unknown, it is shown as unknown (rule 5).** A line that cannot be priced has `priced: false`, `credits: null`
and a reason; the total and `quote_id` are then `null` and nothing can start. The reasons:

- `unpriced`: no credit price row for the model's unit or setting, or for `film_assembly_minute`. **No assembly price is seeded:
  until a platform admin sets it, every film is unpriced on that line.**
- `model_not_available` (not on sale for its role now), `model_not_offered` (any Seedance model), `model_not_set`;
- `invalid_params` (a shape, a length or a resolution the model does not list), `scene_too_long_for_model` (the model's longest shot
  times the scene's shots is shorter than the scene: the detail says to add shots or cut seconds);
- `source_unavailable` (the library has no usable picture to price a clip against), `refs_not_supported` (the key-frame model takes
  fewer reference pictures than the scene has: never handed fewer), `reference_missing`, `asset_not_usable`, `style_unavailable`;
- `prompt_missing`, `voice_not_set`, `channel_voice_not_priced` (a channel's own voice is not priced here), `no_scenes`.

Captions are not in the price and the quote says so (`excluded: captions, priced_after_narration`): a captions job is priced by the
measured length of a recording that does not exist yet, and nothing can be spent on captions under this hold. There is no
"with retakes" allowance: a retry has no line to be charged to.

### The start

`start_film(film, quote_id, idempotency_key)` (owners and admins) takes the organization's start lock, then the film, and:

- refuses a film that is not a draft (`film_not_startable`), a quote of an older version (`film_changed`), a quote whose re-priced id
  differs (`price_changed`: a rate, a model's sale or a price row moved), an unpriced film (the first line's own word), a total over
  `max_credits_per_film` (`cap_exceeded`) and a second live film over `max_active_films` (`limit_reached`);
- holds the total (`reserve_credits`: NS402 with `available=… needed=…`, NS429 when the plan's parallel runs are in use), before
  anything is created;
- writes the segment and every planned take with its confirmed line, queues the film (`status = 'queued'`) and writes `started`.

The same key with the same film and quote answers the first segment (`replayed: true`); with another, `idempotency_conflict`.

### The settle path (the service role; P3's worker drives it)

| Call | What it does |
| :-- | :-- |
| `film_claim_segment(worker)` | The oldest queued segment, or one whose lease is stale. The first claim starts the hold; an expired hold settles the segment instead |
| `film_heartbeat_segment(segment, worker)` | Keeps the lease |
| `film_begin_take(take, worker)` | Marks a planned take running before the billable call; refused once the segment drains |
| `film_take_succeeded(take, worker, output_seconds, result, last_frame)` | Records the result and its charge: a clip by its measured seconds (capped at its line), a key frame or the narration at its line |
| `film_take_failed(take, worker, provider_error / moderated, code, error)` | Charged 0, except a moderated task on a vendor that bills it (Runway): its line, `moderated_vendor_billed`. HappyHorse and Seedance: 0, `moderated_vendor_not_billed`. Others: 0, `moderated_vendor_billing_unknown` |
| `film_begin_assembly`, `film_record_assembly` | The assembly line, charged by its measured whole minutes |
| `film_settle_segment(segment, worker, reason)` | Drains while something is in flight; then skips every take that never began, captures the charges once (never above the hold) and releases the rest. `completed` makes the film `ready`, `cancelled` cancels it, any other word pauses it with that reason |
| `film_cancel_segment(segment, reason)` | Releases every take that never began, and settles now or when the takes in flight end |
| `film_expire_segments()` | Settles a segment whose hold 0020 expired, one nobody claimed in 3 hours, and one past its deadline |

What a segment captured is the ledger's own answer: a hold that 0020 expired under a half-made film reads as captured 0, and the
`segment_settled` event says how much was not captured.

**Open for later phases.** A person's cancel and the organization's settings have no browser function yet (only the two calls above
are granted); a paused or cancelled film cannot be resumed until a resume quote exists (P7).

## The phases

| PR | Content | Migration | State |
| :-- | :-- | :-- | :-- |
| P0 | Scout and measurement: vendor facts, and a 10-15 minute assembly measured on the media-worker (rule 8) | - | Scout done; measurement owed |
| P1 | Core tables, RLS, `film_events`, `create_film_draft` / `save_film` / `archive_film` / `film_json`. Drafts only, no spend | 0166 | merged |
| **P2** | Money. `quote_film`, `start_film` and `film_segments` (one hold per segment, settle and release). Also: the money columns on `film_takes`, `creative_jobs.film_take_id` with `payer='film'`, `org_film_settings`, and the service functions of the state machine. The `film_assembly_minute` price is read, not seeded: an admin sets it | **0171** (provisional) | this PR |
| P3 | The orchestrator. `tools/film_worker.py` and `modules/film_orchestrator.py` handle the lease, trickle enqueue and retry policy. Last-frame extraction goes through `ffmpeg_limits`. The plan step uses Gemini. The creative worker accepts `payer='film'`. | (0171) | |
| P4 | Assembly on the media-worker: `modules/film_timeline.py`, `film_cuts`, `films.current_cut_id` | 0168 | |
| P5 | `/api/films/**` routes, `lib/films.ts`, rate buckets, geo checks, audit | - | |
| P6 | The canvas UI with every state, at mobile width, in en/ru/uz | - | |
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

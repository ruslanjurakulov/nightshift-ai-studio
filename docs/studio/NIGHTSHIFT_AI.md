# Nightshift AI — the shared contract (BRIEF v1)

Owner: S5. Every stream builds against this file. A change to a field below is announced to Atlas first; it is never silent.

## Names (the owner's decision, 20 Nov)

- **Nightshift AI**: the single assistant a person talks to (chat, research, channel analysis, plan, approval, next action). It is the UI name of the panel.
- **Nightshift Studio**: the one creative workspace (Canvas, Scenes, Timeline, Library).
- **Nightshift Brain**: the server-side layer behind the AI.
  - It holds the owner-chosen LLM adapter, plan, tool choice and project/channel context.
  - Code lives in `command-center/lib/brain/*` and routes under `/api/brain/*`.
  - **A model answer never authorises anything by itself.** The server owns data, actions, prices and permissions.

## What happens, end to end

1. **Prompt.** The person writes a prompt: Home's "Start from idea" box, or the Studio start box. They may attach a reference photo, which becomes a character (see Characters below).
2. **Panel.** The Nightshift AI panel docks on the **left** of the Studio canvas. It is titled with the prompt's first words and has "+ New" and a close button; at 390 px it is a sheet.
3. **Questions.** The Brain asks the questions the brief still needs, as **cards**: a short thread title, a question, 3 numbered options and an "your own answer" field, then Confirm.
   - The first question is always **kind**: a long YouTube video or a short Studio film/ad.
4. **Draft on the canvas.** After each answer the BRIEF below is stored, and the canvas (S6b) draws it as **draft** nodes: idea → story → chapters → characters, locations and props → scenes → visuals/clips → voice → music → assembly. Nothing is spent.
5. **Create.** "Create — N credits" is a person's press, and N is the backend's price.
   - **long** → the existing Run now form, prefilled. The person confirms its own priced button. The pipeline, voice and gates are unchanged.
   - **short** → the BRIEF becomes a **film** through `create_film_draft` / `save_film` (0166), priced by `quote_film` and started by `start_film` (0171).
6. **Live view.** The same canvas lights up from real status (S6) and ends at the assembled video.

The Brain never holds, charges, starts or publishes anything (CLAUDE.md rules 2 and 3). Uploads stay private.

## BRIEF v1 (JSON)

The BRIEF is stored per conversation and returned by `GET /api/brain/session/<session_id>`. All text is plain text, never HTML or markdown, already length-capped by the server. Ids are short and stable within one BRIEF (`c1`, `l1`, `p1`, `s1`) so scenes can point at them.

```jsonc
{
  "version": 1,
  "session_id": "uuid",
  "status": "drafting",            // drafting | ready (every required slot known) | created (handed off; see "handoff")
  "kind": "long",                  // long | short | null (not asked yet)
  "title": "The ship that sailed alone",
  "idea": "one-sentence premise",
  "language": "English",           // Uzbek | Russian | English
  "audience": "history fans",
  "style": "dark documentary, cold blue",
  "aspect": "16:9",                // 16:9 | 9:16 | 1:1   (long: always 16:9)
  "target_seconds": 180,           // long: 60 | 180 | 300 | 600 | 1200 (what Run now takes); short: see the limits below
  "story": { "logline": "", "conflict": "" },
  "chapters": [                    // the script outline: titles with timestamped beats
    { "id": "ch1", "title": "Cold open", "start_s": 0, "beats": [{ "at_s": 0, "text": "An empty deck at dawn" }] }
  ],
  "characters": [
    {
      "id": "c1", "name": "The captain", "description": "",
      "image_prompt": "",          // a reference image is generated from this once and reused in every scene
      "asset_id": null,            // set once a reference image exists (uploaded or generated): media_assets.id
      "character_id": null,        // set when it is a saved Studio character (characters table)
      "source": "prompt"           // prompt | upload | library
    }
  ],
  "locations": [{ "id": "l1", "name": "", "description": "", "image_prompt": "", "asset_id": null }],
  "props":     [{ "id": "p1", "name": "", "description": "" }],   // props are prompt text only (film_refs has no prop kind)
  "scenes": [
    {
      "id": "s1", "n": 1, "title": "",
      "duration_s": 6,             // short: 3..30 (film_limits); long: informational only (Run now cuts its own scenes)
      "visual_prompt": "",
      "dialogue": [{ "character_id": "c1", "line": "" }],   // short only: spoken by the video model inside the clip (see Voice)
      "character_ids": ["c1"], "location_id": "l1", "prop_ids": [],
      "keyframe_model": null,      // short: a model id the server checked is on sale (t2i/edit); null = the film's default
      "clip_model": null           // short: a model id the server checked is on sale (i2v); null = the film's default
    }
  ],
  "voice": { "mode": "off" },      // off | clip_audio (short: the video model speaks `dialogue`) | pipeline (long: Run now's own voice)
  "music": { "mode": "off" },      // off | library (asset_id) — no music generation before the event
  "price": {                       // ATTACHED BY THE SERVER, never by the model; absent until the backend computed it
    "state": "priced",             // priced | unpriced | failed | exempt
    "total_credits": 120,
    "nodes": { "s1": 18, "s2": 18 },   // per scene, when quote_film itemises it; absent otherwise
    "spendable": 300,              // number | "exempt" | "unknown" (a failed read is never 0)
    "fits": true,
    "shorter": null                // { "target_seconds": 60, "credits": 40 } — the longest that fits, from the backend
  },
  "handoff": null                  // see "Handoff" below; set only after the person's Create
}
```

**Validation, server side.**
- Unknown fields are dropped.
- A model id that is not on sale is dropped, and the field stays null: never replaced with another model.
- A length that the target path does not take is refused.
- Counts are capped: scenes ≤ 60 (film_limits), characters ≤ 8, locations ≤ 8, props ≤ 12, chapters ≤ 20, beats ≤ 12 per chapter.
- Text is capped at: title 120, idea 300, visual_prompt 2000 (film_limits.max_prompt_chars), line 300, beat 240.

## Limits that shape the BRIEF (from the database, not this file)

- **Short = a film.**
  - Scenes are 3–30 s, at most 60 per film.
  - **The film's target is 60–1200 s** (`film_limits.target_seconds_min/max`). A 15–30 s ad therefore needs S6 to lower `target_seconds_min`. Until then the Brain offers 60 s as the shortest short and says why. **Open question to S6/Atlas.**
- **Long = Run now.** 60, 180, 300, 600 or 1200 s. A request outside that is offered the nearest lengths, with the reason.
- **Voice.**
  - No TTS model is on sale, so the Brain never proposes a narration model and never accepts a typed voice id.
  - For short films it may offer **clip_audio**: the lines go into each scene's clip prompt, and the video model (MiniMax H3 t2v/i2v, verified 20 Nov) speaks them. The panel labels this "voice is generated by the video model".
  - If `quote_film` refuses a voice line (voice_not_set, channel_voice_not_priced), that reason is shown and nothing is substituted.
- **Characters from a photo.** An uploaded reference photo becomes `characters[].asset_id` with `source: upload`. It passes the existing rights acknowledgement (0174/0187), likeness and 18+ (0192) gates at quote and start. The Brain never bypasses them.

## Question cards

`POST /api/brain/turn` returns, next to the BRIEF, at most one card:

```jsonc
{ "card": { "id": "q-uuid", "slot": "kind", "thread_title": "Ancient desert action", "question": "",
            "options": ["", "", ""], "allow_own": true } }
```

- The slot order and which slot is asked are the **server's** state machine. The option texts come from the model inside strict JSON, are validated and capped (≤ 160 chars each), and are rendered as plain text.
- A confirmed option or own answer comes back as `{ "action": "answer", "session": "...", "card": "q-uuid", "choice": 1 | 2 | 3 | null, "own": "text" | null }`.

## Reading the BRIEF from the canvas (S6b)

- `GET /api/brain/session/<id>` → `{ "brief": BRIEF, "card": card | null, "updated_at": "iso" }`.
  - It is read as the person: a conversation is visible to its author only.
  - Poll after each turn, or listen for the browser event `nightshift:brain-brief` (`detail: { session_id, updated_at }`). The panel dispatches it whenever the BRIEF changes.
- The session id is in the Studio URL while the panel is open: `/studio?brain=<session_id>`.
- A draft node shows its price only from `brief.price.nodes[<id>]`. With no entry it shows no number (rule 5).

## Handoff (after the person's Create)

- `brief.status` becomes `created`, and `brief.handoff` is one of:
  - `{ "kind": "film", "film_id": "uuid" }`. The canvas opens `/studio?view=live&film=<film_id>`.
  - `{ "kind": "run", "channel_id": "...", "dispatched_at": "iso" }` (Actions backend). The canvas opens `/studio?view=live&channel=<channel_id>&since=<dispatched_at>`. The view labels it honestly: "events this channel recorded since this run was started".
  - `{ "kind": "run", "channel_id": "...", "job_id": "..." }` (queue backend). The canvas opens `/studio?view=live&channel=<channel_id>&run=<job_id>`.
- `dispatched_at` is added by S6b to `/api/agent/run`'s answer. That change is additive and alters nothing that is spent or dispatched.

## Research the Brain reads (S10, docs/studio/RESEARCH_TOOLS.md)

- The Brain calls S10's readers server-side, with the person's own session:
  - `research_own_channel`;
  - `research_competitors_view`;
  - `research_topic_channels`;
  - `research_comment_themes`.
- Their `data` goes into the model's data block as **data**, and `untrusted_text` stays labelled as untrusted.
- The Brain repeats only raw numbers, says "Source: YouTube", and computes no ratio, outlier or sentiment score.
- A status other than `ok` (`no_data`, `not_connected`, `refreshing`, `budget_exhausted`, `not_enabled`) is said as such. It is never "no competitors".
- `research_request_refresh` is called only when the person asks for fresh data.

## Who gets it, and what it costs

- **The flag.** `NIGHTSHIFT_AI_CHAT=off|orgs|on` and `NIGHTSHIFT_AI_CHAT_ORGS`, on only for the owner's and the demo workspace until reviewed.
- **Paid plans only** (Plus, Pro, Business). Free sees the panel locked, with "Upgrade plan" (`/credits#plans`).
- **Per-plan daily message caps.** Plus 30, Pro 100 and Business 300, in a rolling 24 h per workspace. The owner adjusts them, and the database enforces them before any LLM call.
- **The model.** The owner chooses it in the owner panel from the text LLMs on sale; the default is Claude Sonnet 5.5. Customers see no picker. If the chosen model is down, the panel says "Nightshift AI is unavailable right now", and no other model is tried.
- **Free to the person within the cap.** Usage (no text) is metered for the owner only.

## Film run status (P3)

The contract between the film worker (P3) and the screens that show a running film. The source of truth is the SQL:
migrations 0166 (the tables), 0171 (the money and the state machine) and 0198 (the switch per organization, the take's creative
job). Where this section and the SQL disagree, the SQL is right and this section is the bug.

A started film is paid by one segment (`film_segments`, one credit hold `fm-<segment id>`). The worker (`tools/film_worker.py`,
`modules/film_orchestrator.py`) claims the segment, makes its takes, hands the assembly to the assembly session, and settles the
segment once. Nothing here is decided in a browser: every transition below is a service-role database function.

### `films.status` (0166's check, with 0171's `queued`)

| Value | Set by | Meaning |
| :-- | :-- | :-- |
| `draft` | `create_film_draft`; `film_settle_segment` / the sweep when a segment charged nothing and made nothing | Editable and startable. After a run that never ran, `pause_reason` says why (`worker_unavailable`, `hold_expired`, `takes_failed`, ...). |
| `queued` | `start_film` | The hold is taken; waiting for a worker (at most 3 hours, then the sweep settles it as `worker_unavailable`). |
| `running` | `film_claim_segment` (first claim) | A worker holds the segment's lease. |
| `draining` | `film_settle_segment` or `film_cancel_segment` while a take or the assembly is in flight; the sweep past the deadline | Nothing new begins; it settles when what is in flight ends. |
| `ready` | settle with reason `completed` | Every take and the assembly completed. |
| `paused` | settle with any other reason after something was charged | `pause_reason` is the reason handed to the settle (see the assembly below). |
| `cancelled` | settle with reason `cancelled` after something was charged | |
| `archived` | `archive_film` | Put away (drafts only). |
| `planning`, `planned`, `assembling`, `failed` | nothing yet | Reserved by 0166. **No function sets them**: a running film is `running`/`draining` during its assembly too; the assembly's own state is on the segment. |

### `film_segments.status` (0171)

| From | To | Function |
| :-- | :-- | :-- |
| (new) | `queued` | `start_film` |
| `queued` | `running` | `film_claim_segment` (starts the hold's 24-hour clock, sets a 20-hour deadline) |
| `running` / `draining` (stale lease) | the same, another worker | `film_claim_segment` (at most 3 leases; after that what is in flight fails as `worker_lost` and it settles) |
| `running` | `draining` | `film_settle_segment` / `film_cancel_segment` with something in flight; `film_expire_segments` past the deadline |
| any live | `settled` (something captured) or `released` (nothing captured) | `film_settle_segment`, `film_cancel_segment`, `film_begin_take` (hold lost, refund pending), `film_claim_segment` (hold expired), `film_expire_segments` (unclaimed 3 h, hold gone, deadline + 2 h grace) |

`film_segments.assembly_status`: `planned` → `running` (`film_begin_assembly`, only when every take is completed or superseded) →
`completed` / `failed` (`film_record_assembly`, called by the assembly session; or `failed` when the sweep or the last lease ends it).
`planned` → `skipped` when the segment settles without an assembly. The assembly itself, its file and its failure words are the
assembly session's: see the assembly section of this file and docs/FILM_STUDIO.md, "Assembly (P4)".

### `film_takes.status` (0166's check) and what a canvas node shows

| Status | Set by | Node shows |
| :-- | :-- | :-- |
| `planned` (and `queued`, which 0171 never writes) | `start_film`; `film_take_failed` / a rejected clip plan attempt 2 | **queued** |
| `running` | `film_begin_take` (before the paid call) | **running** |
| `completed` | `film_take_succeeded` (a clip only when its file measures at least 90% of its seconds) | **done**: `result_asset_id`, and for a clip or extend `result_last_frame_asset_id` |
| `failed` | `film_take_failed` with no retry left; a clip rejected by length with no retry left; the sweep or the last lease (`worker_lost`) | **failed**: `error_code` (below), charged 0 |
| `superseded` with `charge_basis = retried_not_charged` | the first failure of a take | **retried**: point to the attempt-2 take of the same slot (`kind`, `scene_id`, `shot_index`, `version`, `attempt` + 1) |
| `superseded` with any other basis | nothing today (P7's re-shoot) | **superseded** |
| `skipped` | the settle or a cancel, for a take that never began (charged 0) | not shot (the run ended before it) |

The narration is **one film-level take**: `kind = 'narration'`, `scene_id` null, `shot_index` 0. Its file (audio) runs on the film's
clock: each scene's words start 0.25 s into the scene, and the file's provenance carries the per-scene `segments`
`[{scene_id, start_s, end_s}]` and the measured `loudness_lufs` / `true_peak_db` (null when not measured).

The order the worker makes them in: every key frame, then the shots scene by scene (shot 1 from its first frame, shots 2-3 from the
previous shot's last frame), then the narration. A shot whose input failed for good never begins and is `skipped` at the settle.

### Why a take failed: `film_takes.error_code`

The worker writes only these words (`modules/film_orchestrator.FILM_ERROR_CODES`). 0171 itself writes two more when it rejects a
clip by its recorded length, `output_too_short` and `output_length_unknown`; show both as `too_short`. `worker_lost` is also written
by 0171 when a lease or the deadline runs out.

| Code | Customer line | Remedy |
| :-- | :-- | :-- |
| `auth` | The generation service refused our access. | None for the customer; we're notified. |
| `quota` | Out of capacity right now. | Retry later. |
| `plan_required` | Not available on our current service plan. | Pick another voice or model. |
| `rate_limited` | Too many requests at once. | Retry later. |
| `bad_request` | The service refused this shot's settings. | Edit the scene. |
| `voice_not_found` | The voice no longer exists. | Pick another voice. |
| `moderated` | Content declined. | Change the description. |
| `provider_error` | The service failed. | Retry. |
| `timeout` | It didn't finish in time. | Retry. |
| `too_short` | The clip is shorter than planned. | Retry, or lower the seconds. |
| `no_output` | No file was returned. | Retry. |
| `worker_lost` | Our worker stopped; nothing was charged. | Start again. |
| `film_studio_off` | Switched off during the run. | Contact support. |

`film_studio_off` is the settle reason (`films.pause_reason`) when the platform's or the organization's switch went off during the
run: nothing new begins (the database refuses `film_begin_take` and a new `film_take_job` with `film_studio_disabled`), a take that
was about to be sent ends with `error_code = film_studio_off`, and the takes that had not begun are skipped. A task already at the
vendor is still polled to its end, and a running segment may still be re-claimed for that.

A take's creative job (`payer = 'film'`) is never shown in the Studio's job feed, never listed by the credit worker's queue, never
cancellable by a member (`not_found`), notifies nobody, and ends when its take ends.

### Where an assembly failure shows

Only in three places: `film_segments.assembly_status = 'failed'`; `films.pause_reason`, which is exactly the reason the worker handed
to `film_settle_segment` (the assembly session's own word, or `assembly_failed`, or `assembly_unavailable` when the assembly is not
installed on the worker); and the `segment_settled` event's `reason`.

### `film_events.event`

`created`, `saved`, `archived` (0166); `started`, `start_refused`, `segment_claimed`, `take_completed`, `take_failed`, `take_retried`,
`assembly_completed`, `assembly_failed`, `segment_cancel_requested`, `segment_settled` (with `not_captured` when the hold could not
pay everything), `segment_skipped` (a segment the claim or the sweep could not touch, at most one an hour) (0171).

### The assembly handoff

**Both switches, or no claim.** `tools/film_worker.py` claims a segment only while `NIGHTSHIFT_FILM_WORKER=on` **and**
`NIGHTSHIFT_FILM_ASSEMBLY=on` **and** `modules.film_assembly` imports. Otherwise it logs one line naming what is missing and only
runs `film_expire_segments`: a queued film is never claimed, so its hold is never started, and the sweep settles it at 0 after 3
hours (`worker_unavailable`, back to draft). The checks below are the same rule again, for a segment claimed before a switch moved.

1. When every take is completed and at least one clip exists, the worker decides, in this order:
   - `modules.film_assembly` is **not installed** on the worker: it calls `film_begin_assembly`, records the assembly as failed
     (`film_record_assembly(segment, worker, false, null)`) and settles with `assembly_unavailable`.
   - It is installed but **`NIGHTSHIFT_FILM_ASSEMBLY` is not `on`**: nothing is begun, recorded or settled; one log line names the
     switch, and the segment is left to 0171 (the claim after its last lease, or `film_expire_segments` at the deadline plus the
     grace, settles it with the takes that were made).
   - Otherwise it calls `film_begin_assembly(segment, worker)`: `assembly_status` becomes `running`; the segment stays `running`.
2. Under the **same lease** (one lease per segment, no handoff; the worker keeps beating it through the assembly), the worker calls
   `modules.film_assembly.assemble_segment(segment, worker_id=..., db=..., media_root=..., tools=...)`. That code owns everything up to
   and including `film_record_assembly(segment, worker, ok, asset)`, its failure path included.
3. The worker then calls `film_settle_segment(segment, worker, 'completed')` when the assembly succeeded, or with its reason when it
   did not. When `assemble_segment` raises `DbUnavailable` (the database gave no decision) or `AssemblyDisabled` (its switch is
   off), nothing was recorded: the worker settles nothing and stops driving the segment. A worker that dies during the assembly, or
   stops like this, leaves `assembly_status = 'running'`; the next claim runs the assembly again.

## Assembly handoff (P3 worker → P4b assembly)

The plan becomes a film through Film Studio (migrations 0166 and 0171, docs/FILM_STUDIO.md). S6's worker
(`tools/film_worker.py`, `modules/film_orchestrator.py`) shoots the takes. The assembly (`modules/film_assembly.py`) turns
them into one finished mp4 at the film's aspect: the clips in scene order, the narration, the music if there is any, and the
captions (a WebVTT sidecar, and burned in when `captions_mode` is `burn` or `both`). This section is the contract between
the two, and it rests on 0171 as written.

### What 0171 decides

- **There is no segment state called `assembling`.** `film_begin_assembly` moves `film_segments.assembly_status` from
  `planned` to `running`, and the segment itself stays `running`. The canvas reads `assembly_status` and
  `assembly_asset_id`. `films.status = 'assembling'` exists in 0166's check, but nothing sets it.
- **One lease per segment.** Every service call (`film_begin_assembly`, `film_record_assembly`, `film_heartbeat_segment`,
  `film_settle_segment`) checks `film_segments.worker_id`. No function hands a lease over. `film_claim_segment` re-takes a
  segment only after its heartbeat has gone stale, and that costs an attempt (`attempts` + 1, capped by `max_attempts`).
  So a lease *can* move under a running assembly, and the assembly is built for that (below).
- **The assembly has no hold of its own.** It is one line inside the segment's `fm-<id>` hold. `film_record_assembly(ok)`
  charges the file's recorded length in whole minutes at the confirmed `film_assembly_minute` rate, never above its line.
  `film_record_assembly(false)` charges 0. The settle then captures what was charged and releases the rest.
- **`film_begin_assembly` answers as-is only while the assembly is running.** Once the assembly has ended, it refuses
  with `not_running`. `film_record_assembly` happens once: a retry with the same outcome and the same file gets the same
  answer, and anything else is an `idempotency_conflict`.
- **Nothing sets `film_scenes.current_version`** (choosing a version is P7's job). On a first shoot, the assembly cuts the
  version that this segment shot. A version a person has chosen is kept. A scene shot in two versions, with none chosen,
  is refused (`scene_not_shot`) rather than guessed.
- **No service function writes `film_takes.params`.** So the narration's timing goes on the narration *file*.

### The contract

1. **S6 holds the lease for the segment's whole life:** claim, takes, `film_begin_assembly`, the assembly, settle. Its
   heartbeat thread keeps running through the assembly, which can take up to `timeline.render_timeout_s(length)`
   (3 × length + 120 s).
2. **When every take is terminal** and `film_begin_assembly` has returned `assembly_status = 'running'`, S6 calls, in the
   same process and on the same lease:

   ```python
   outcome = film_assembly.assemble_segment(segment_json, worker_id=WORKER, store=film_assembly.AssemblyStore(media_store),
                                            media=media_store, media_root=MEDIA_ROOT, tools=tools)
   ```

3. **From there up to and including `film_record_assembly`, the assembly owns the work.** It reads the rows, builds the
   cut (`film_timeline.build_cut`) and the captions, renders through the editor's path, checks the output, and registers
   the master with provenance `{"film_segment_id", "film_id", "film_version", "cut_sha256", "captions_asset_id"}`. Then
   it calls `film_record_assembly(ok=true)`.
   **Every decision is recorded before the call returns.** A refusal, a bad output, or an unexpected exception (which is
   then re-raised) is recorded as `film_record_assembly(false)`, at 0. `outcome.recorded` says whether this call recorded.
   Four things are not decisions and are not recorded:
   - **The database did not answer.** That covers no answer, a timeout (`requests`' own errors included, during
     `register_asset` too), a 5xx, and a 4xx that is not a database function's refusal (Kong's 429, a JWT 401,
     PostgREST's `PGRST*`). Each raises `DbUnavailable` (a `ConnectionError`) and leaves the assembly `running`, so a
     paid, rendered film is never thrown away over a lost answer. A refusal is only a 4xx whose `code` is the
     database's (`NS…`, `P0001`, `P0002`, `42501`, `22023`) and whose `message` is a machine word.
   - **This worker's kill switch is off** (`AssemblyDisabled`). S6 does not begin an assembly while it is off; if
     one is running, it waits for a worker with the switch on, or 0171's deadline ends it at 0.
   - **The lease was lost** (`outcome.reason = 'lease_lost'`: the new holder records).
   - **The assembly is not running** (`not_running`: there is nothing to record).
   S6 settles a returned outcome. On `DbUnavailable` or `AssemblyDisabled` it settles nothing and lets the next claim
   retry.
4. **S6 then settles** with `film_settle_segment(seg, worker, 'completed' if outcome.ok else outcome.reason)`. The
   assembly never settles.
5. **Crash recovery.** If S6 re-claims a segment whose `assembly_status` is still `running`, it calls `assemble_segment`
   again. The master's asset id is `uuid5(segment, cut sha256)`. Whisper's word timings are cached per narration file
   (at temperature 0), so a retry builds the same cut. A file that a crashed attempt already registered is then recorded
   without rendering again. A segment whose assembly is already `completed` gets back the recorded file, with nothing
   rendered or charged twice. Past `max_attempts`, or past the deadline plus grace, 0171 itself fails a running assembly
   at 0 and settles.
6. **A lease that moves under a running assembly** (Breach BR-P4B-01 and -02):
   - each attempt renders in its own folder (`.film-assembly/<segment>/<attempt>`) and removes only that folder;
   - the lease is checked again (`film_heartbeat_segment`) after the render and before anything is registered;
   - a file registered just before the lease was lost is handed to `film_discard_unrecorded_assembly` (migration 0200,
     service role only). That soft-deletes it only when the segment's assembly is no longer running and did not record
     it, so a re-claimer's legitimate reuse is never touched.

### What S6's takes must carry

- Every clip and extend take is `completed`, with `result_asset_id` set. Every take that continues a shot or a scene has
  `first_frame_asset_id` equal to its predecessor's `result_last_frame_asset_id`, because `film_timeline` checks
  continuity against them.
- Clips in the film's aspect (2 % tolerance), probed (width, height and `duration_s` on the library row), and at least as
  long as their share of the scene.
- **The narration file's provenance**, written with `register_asset` when the file is registered (the take's `params`
  are read first, if a later migration ever writes them):

  ```json
  {"film_take_id": "<take>",
   "segments": [{"scene_id": "<scene>", "start_s": 0.25, "end_s": 9.5}],
   "loudness_lufs": null, "true_peak_db": null}
  ```

  Times are in the file's own time, on the film's clock: each scene's words start `NARRATION_LEAD_S` (0.25 s) into the
  scene, so a 60-scene film is one sound clip, not 60. Loudness that was not measured stays `null`, never a default
  (rule 5). **No `words` in provenance:** 0038 caps provenance at 16 KB, and about 400 words (2.7 minutes of speech)
  already exceed it (Lens L4). The assembly times the captions with Whisper base on the file instead. A word that
  overlaps a segment is kept as it is. A word whose timings fall entirely outside every segment lies in a silence the
  narration never speaks in: a transcription artefact (Whisper invents words in silence), not speech. It is **dropped,
  never failing the paid film** (Atlas's decision for the owner, 21 Nov), and recorded:
  - on the master's provenance, as `captions_dropped_words`: `{count, words: [{word, start_s, end_s}] (at most 50),
    reason}`;
  - in the outcome's `detail` ("N word(s) outside speech dropped from the captions: <times>") and `dropped_words`;
  - in the worker's log.

### What the assembly refuses (no silent fallback, rule 4)

Each of these fails the assembly at 0, by name, with the remedy in `detail`. A shorter film is never rendered:

- every `film_timeline` refusal (`missing_take`, `take_failed`, `asset_unavailable`, `continuity_broken`,
  `aspect_mismatch`, `too_many_audio_clips`, `film_too_long`, …);
- `narration_missing`;
- `captions_failed` (captions were asked for and could not be timed);
- `disk_low`: less free space than the fast intermediates need, which is 8 MB per second of 1080p scaled by pixels, plus
  the output. Below that, the editor's renderer would quietly switch to a second lossy generation;
- `render_timed_out` and `render_failed`;
- `render_degraded`: `render_backend` redid the segments with its compact encode (a second lossy generation) after a
  failure or a full disk, instead of failing. It does that without raising; the assembly reads it off the render's
  timings;
- `output_mismatch`: the length is more than 0.12 s off the sum of the scenes, the frame is not the aspect's, or a film
  with sound came out without it;
- `store_failed`: also a library row whose recorded length is not the film's, since 0171 charges by that length;
- `review_copy_missing` or `review_copy_too_large`. The review copy is the library's 480p proxy of the master, and it must
  fit the 50 MB Supabase object ceiling;
- `assembly_not_enabled`.

### The flag

There is one allowlist, the database's: `public.film_studio_on_for(p_org uuid)` from S6's migration (0198 provisional).
It is true when the global Film Studio switch and the organization's own `film_studio_enabled` are both on. It is STABLE
and granted to service_role only. S6's claim already requires it; the assembly reads the same function again as a
defensive check, before any row is read or anything is rendered.
- **An explicit `false`** is the database's decision. The assembly is recorded as failed at 0
  (`assembly_not_enabled`), so its hold is released at the settle.
- **A missing function** (its migration not applied), a refusal, or an answer that is not a plain boolean is no
  answer. The call raises `DbUnavailable`: nothing is assembled and nothing is recorded (Sentinel R3), because a
  configuration gap must not cost a paid film.
- **`NIGHTSHIFT_FILM_ASSEMBLY=on`** is only the worker's kill switch, off by default. It is read before the database
  (`AssemblyDisabled`, above), and is wired like every other media-worker switch: `deploy/.env.worker.example` and
  `deploy_web.yml`'s worker env, from the repository variable of the same name.

### Money

The assembly never reads or computes a price. 0171 charges the registered file's recorded length at the rate confirmed
when the film started, which `quote_film` and `creative_price` read from the `film_assembly_minute` row of
`credit_prices`. 0171 seeds no such row (a fresh database reads `unpriced`). The live database has one, added by hand
with the owner's approval. The lab, `tests/security/test_sec_film_assembly_worker.py`, drives this module against 0171's
real functions and checks these four things:
- a completed assembly is charged its minutes once;
- a crash leaves it charged 0, and the line is released at the settle;
- a retry after a lost record renders once and captures once;
- an organization that is not flagged pays nothing for an assembly.

`tests/security/test_sec_breach_film_assembly_worker.py` adds Breach's attacks: two lease holders racing, a render that
outlives its segment, a forged worker id or organization, a foreign row at the master's id, and the charge cap.

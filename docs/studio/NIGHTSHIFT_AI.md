# Nightshift AI: the Studio's film runs

Other sections of this file are written by other sessions; this one is the contract between the film worker (P3) and the screens
that show a running film. The source of truth is the SQL: migrations 0166 (the tables), 0171 (the money and the state machine) and
0198 (the switch per organization, the take's creative job). Where this page and the SQL disagree, the SQL is right and this page is
the bug.

## Film run status (P3)

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

`film_studio_off` is the settle reason (`films.pause_reason`) when the platform's or the organization's switch went off between two
takes; the takes that had not begun are skipped.

### Where an assembly failure shows

Only in three places: `film_segments.assembly_status = 'failed'`; `films.pause_reason`, which is exactly the reason the worker handed
to `film_settle_segment` (the assembly session's own word, or `assembly_failed`, or `assembly_unavailable` when the assembly is not
installed on the worker); and the `segment_settled` event's `reason`.

### `film_events.event`

`created`, `saved`, `archived` (0166); `started`, `start_refused`, `segment_claimed`, `take_completed`, `take_failed`, `take_retried`,
`assembly_completed`, `assembly_failed`, `segment_cancel_requested`, `segment_settled` (with `not_captured` when the hold could not
pay everything), `segment_skipped` (a segment the claim or the sweep could not touch, at most one an hour) (0171).

### The assembly handoff

1. When every take is completed and at least one clip exists, the worker calls `film_begin_assembly(segment, worker)`:
   `assembly_status` becomes `running`; the segment stays `running`.
2. Under the **same lease** (one lease per segment, no handoff; the worker keeps beating it through the assembly), the worker calls
   `modules.film_assembly.assemble_segment(segment, worker_id=..., db=..., media_root=..., tools=...)`. That code owns everything up to
   and including `film_record_assembly(segment, worker, ok, asset)`, its failure path included.
3. The worker then calls `film_settle_segment(segment, worker, 'completed')` when the assembly succeeded, or with its reason when it
   did not. A worker that dies during the assembly leaves `assembly_status = 'running'`; the next claim runs the assembly again.

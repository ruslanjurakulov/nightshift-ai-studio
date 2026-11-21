# Nightshift AI

S5 owns the chat and the BRIEF sections of this document. This file starts with the assembly section only, so that the
two branches merge without a conflict: S5's sections go above it.

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
   Three things are not decisions and are not recorded:
   - **The database did not answer.** No answer, a timeout, a 5xx, or a body that is not PostgREST's raises
     `DbUnavailable` (a `ConnectionError`) and leaves the assembly `running`. That applies to the success record too, so
     a paid, rendered film is never thrown away over a 503. Only a 4xx carrying the database's machine word is a refusal.
   - **The lease was lost** (`outcome.reason = 'lease_lost'`: the new holder records).
   - **The assembly is not running** (`not_running`: there is nothing to record).
   S6 settles a returned outcome, and on `DbUnavailable` it settles nothing and lets the next claim retry.
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
  already exceed it (Lens L4). The assembly times the captions with Whisper base on the file instead. Every spoken word
  must fall inside a segment: a word outside every segment fails the captions (`captions_failed`) instead of being left
  out quietly.

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
defensive check.
- If the function is missing (its migration is not applied) or answers anything but `true`, the organization is not
  assembled.
- `NIGHTSHIFT_FILM_ASSEMBLY=on` is only an environment kill-switch on the worker, off by default. It is read before the
  database.
- A segment that either check stops is recorded as failed at 0 (`assembly_not_enabled`), before any row is read or
  anything rendered, so its hold is released at the settle.

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

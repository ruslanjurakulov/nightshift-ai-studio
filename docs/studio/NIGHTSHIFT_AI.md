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
   **Every failure is recorded as `film_record_assembly(false)`, at 0, before the call returns,** an unexpected exception
   included (which is then re-raised). There are three exceptions:
   - the lease was lost (`outcome.reason = 'lease_lost'`: another worker records it);
   - the assembly is not running (`not_running`: there is nothing to record);
   - the film was rendered and registered, but the *success* record did not reach the database. Then the call raises,
     and the assembly stays `running`, so a good film is not thrown away.
4. **S6 then settles** with `film_settle_segment(seg, worker, 'completed' if outcome.ok else outcome.reason)`. The
   assembly never settles.
5. **Crash recovery.** If S6 re-claims a segment whose `assembly_status` is still `running`, it calls `assemble_segment`
   again. The master's asset id is `uuid5(segment, cut sha256)`, so a file that a crashed attempt already registered is
   recorded without rendering again. A segment whose assembly is already `completed` gets back the recorded file, with
   nothing rendered or charged twice. Past `max_attempts`, or past the deadline plus grace, 0171 itself fails a running
   assembly at 0 and settles.

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
   "loudness_lufs": null, "true_peak_db": null,
   "words": [{"word": "It", "start": 0.3, "end": 0.45}]}
  ```

  Times are in the file's own time, on the film's clock: each scene's words start `NARRATION_LEAD_S` (0.25 s) into the
  scene, so a 60-scene film is one sound clip, not 60. Loudness that was not measured stays `null`, never a default
  (rule 5). `words` is optional: without it, the assembly runs Whisper base on the file to time the captions.

### What the assembly refuses (no silent fallback, rule 4)

Each of these fails the assembly at 0, by name, with the remedy in `detail`. A shorter film is never rendered:

- every `film_timeline` refusal (`missing_take`, `take_failed`, `asset_unavailable`, `continuity_broken`,
  `aspect_mismatch`, `too_many_audio_clips`, `film_too_long`, …);
- `narration_missing`;
- `captions_failed` (captions were asked for and could not be timed);
- `disk_low`: less free space than the fast intermediates need, which is 8 MB per second of 1080p scaled by pixels, plus
  the output. Below that, the editor's renderer would quietly switch to a second lossy generation;
- `render_timed_out` and `render_failed`;
- `output_mismatch`: the length is more than 0.12 s off the sum of the scenes, the frame is not the aspect's, or a film
  with sound came out without it;
- `store_failed`;
- `review_copy_missing` or `review_copy_too_large`. The review copy is the library's 480p proxy of the master, and it must
  fit the 50 MB Supabase object ceiling;
- `assembly_not_enabled`.

### The flag

The assembly runs only where `NIGHTSHIFT_FILM_ASSEMBLY=on` is set in the worker's environment, and only for an
organization listed in `NIGHTSHIFT_FILM_ASSEMBLY_ORGS` (comma-separated ids: the owner's and the demo workspaces). Both
fail closed: when they are unset, no organization is assembled. The check comes before any row is read or anything is
rendered. A segment of an organization that is not listed is recorded as failed at 0 (`assembly_not_enabled`), so its
hold is released at the settle.

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

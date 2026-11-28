# S3 — Live canvas & timeline: what exists, what is missing (22 Nov 2026)

Stream S3 of `docs/studio/PROGRAM.md`. Rule 8: evidence first, then the diagnosis, then the change. This file is the evidence and
the diagnosis; each change below is its own draft PR from a `claude/nsai-s3-<topic>` branch.

## The goal (from the program)

The moment a film run starts, the Studio's live view is the reference ("agentcut") editor: canvas cards lit from real status; a
timeline lane under the canvas that fills piece by piece as takes finish (each accepted clip take → a video segment in scene
order, the narration → the audio track); a labelled tag flies to where each piece lands; an activity log with timestamp, a
coloured worker tag and what happened, only from rows the database recorded; a transport row (monospace timecode, ruler,
playhead); the assembled master at the end of the lane (S4). Refresh-safe, realtime or polling with backoff, phone width.

## What the merged live view already does (evidence)

| Piece | Where | What it does today |
| :-- | :-- | :-- |
| Route `?view=live&film=` | `app/(app)/[channel]/studio/page.tsx` | Server only checks the section is open; the browser reads. Also `?run=` and `?channel=&since=` for channel runs, `?brain=` for a draft brief. |
| Read route | `app/api/films/[id]/live/route.ts` | Session (RLS) read of `film_json` + `film_segments` (assembly status, asset, credits) + `film_takes` (error word, money). A failed sub-read is `null` ("not known"), never `[]`. |
| Polling | `components/studio-live/useLiveGraph.ts` | 6 s poll via `startPolling` (backoff on error, pause on hidden tab, stop when the graph is `settled` or the plan is gone). Generation guard against a previous plan's answer. |
| Graph | `lib/studio/liveGraph.ts` (`filmGraph`) | Idea → script → per-scene keyframe/clip → voice/music → assembly → final. Lamps from `film_takes.status` / `assembly_status`; no row = `waiting` or `unknown`, never `done`. |
| Canvas | `components/studio-live/LiveView.tsx` | Read-only React Flow board (≥1280 px) or a list (below), a details panel, failure reason + remedy from `error_code`, downloads of a made file, a link to `?view=timeline`. |
| Activity | `components/studio-live/ActivityPanel.tsx` | `film_events` lines (newest 50 per read, gathered by id across reads so earlier lines stay), time, one sentence per known event word, unknown words shown as their code, "N earlier not shown", "steps that write no event". |
| Timeline page | `components/studio-timeline/StudioTimeline.tsx`, `lib/studio/timeline.ts` | A separate page (`?view=timeline`): V1/A1/A2/A3/A4/C1 lanes from `layoutTimeline`, ruler, playhead, timecode at 25 fps, viewer, mixer. Draft blocks at planned length; measured only when the library recorded the length. Polls `/api/films/{id}` every 6 s. |
| Realtime | migrations 0166/0171 | **No** `film_*` table is in a realtime publication. Realtime would need a migration and an RLS review; polling stays (no migration expected for S3). |

## What is missing for the goal

| # | Gap | Evidence | Plan |
| :-- | :-- | :-- | :-- |
| G1 | **No lane under the canvas.** The live view and the timeline are two pages; a person watching a run sees cards but no piece "falling" into a track. | `LiveView.tsx` renders Board/List + Details + ActivityPanel only; the lane exists only on `?view=timeline`. | Extend the lane that `claude/canvas-timeline-lane` builds (`lib/studio/lane.ts`, the dock) — not a second lane. Until it is pushed: a pure mapping in its own file. |
| G2 | **No per-piece mapping take → segment.** `layoutTimeline` lays out the *plan* (every scene at planned length); it does not say which pieces are *landed* (a completed, accepted take) versus pending, failed, retried. | `layoutTimeline` marks a whole scene `draft` until every shot is done; a single landed shot of a 3-shot scene is invisible. | `lib/studio/liveLane.ts` (pure): each accepted clip take → a V segment in scene/shot order with state `landed / pending / working / failed / retried / skipped / unknown`; the narration take → the A segment; the master (S4's `assembly_asset_id`) → a final segment. Length only from a recorded duration, else the requested/planned length drawn **hatched with "?"**. |
| G3 | **Nothing marks *when* a piece landed**, so there is nothing to animate. | The graph is recomputed from each reading; no diff between readings; a refresh must not replay every landing. | A pure diff between two readings (`landedSince(prev, next)`) → the tags to fly. First reading after mount = restore, no flight. Under `prefers-reduced-motion` the piece appears with no flight. |
| G4 | **Activity is not in the reference style.** No worker tag, no colour per worker, no take name; `detail.take_id` and `shot_index` are dropped. | `filmActivity` keeps only `kind`; `ActivityPanel` prints `HH:MM:SS sentence`. 0171's `take_completed` detail carries `take_id, kind, shot_index, attempt`. | Map each event to a tag from the row itself (`kind` + scene + shot: `clip-03.2`, `key-03`, `voice`, `asm`, `seg`), a tone per worker family, monospace timestamp. Unknown event → its code, tag `log`. Never a simulated worker: one line per recorded row. `segment_claimed` carries the worker id; it is not shown (an internal host name), only that a worker claimed it. |
| G5 | **Transport row on the live view.** Timecode/ruler/playhead exist only on the timeline page. | `tl-tc`, `tl-ruler`, `tl-playhead` in `StudioTimeline.tsx`. | Reuse `timecode()` and the lane's ruler; the live transport shows `landed / planned` and the status word from `films.status`; play only once there is a file to play (no preview of a piece that does not exist). |
| G6 | **Master at the end of the lane.** | `filmGraph` has a `final` node from `assembly_asset_id`; nothing in a lane. | Final segment from S4's recorded asset; `assembly_status = failed` shows `pause_reason` (the three places in the contract), never "done". |
| G7 | **Event window.** `film_json` returns the newest 50 events; a run of >50 events between two polls loses lines, and a refresh shows only the newest 50. | `0166 … order by e.id desc limit 50`. | Acceptable for P1 (the "N earlier not shown" line already says so). A paged `film_events` read (`id > cursor`) on the live route is a later, separate PR; no migration needed (RLS select already applies). |
| G8 | **No browser E2E with a seeded run.** The repo has only the live smoke suite (`command-center/e2e/live`, targets the deployed site). Earlier live-view PRs were tested with vitest + Testing Library. | `playwright.config.ts`: "Only the live smoke suite lives under e2e/". | Probe adds a local Playwright spec that serves the app with the live route intercepted (a recorded `film_json` sequence: queued → takes landing → assembly), at 1440 and 390, light/dark, en/ru/uz. Honest limit: this exercises the UI against recorded answers, not RLS; RLS stays covered by `tests/security/test_sec_studio_live_routes.py`. |

## Rules that bind every PR here

- Read-only: the live view only GETs; no start, retry, render or publish (rules 2, 3). The anon-key session read, never the service key.
- Unknown is unknown (rule 5): an unknown length is hatched with "?"; a missing verdict is "unknown"; no row is `waiting` or `unknown`, never `done`.
- Only recorded events; no invented worker activity.
- Every string in `lib/i18n/{en,ru,uz}.ts` (Uzbek ʻ U+02BB, ʼ U+02BC). Tokens from S5; `prefers-reduced-motion` respected.

## Order of PRs

1. `claude/nsai-s3-data` — `lib/studio/liveLane.ts` (take/event → lane segment, log line with worker tag, landing diff) + unit tests. No UI.
2. `claude/nsai-s3-activity` — the activity log in the reference style, on the existing live view.
3. `claude/nsai-s3-lane` — the live lane under the canvas, the flying tags, the transport row; rebased on `claude/canvas-timeline-lane`.
4. `claude/nsai-s3-master` — the master at the end (after S4 records it).

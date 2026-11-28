# Measurement: Nightshift AI panel → Studio canvas → Create → live view

Measured, not built (CLAUDE.md rule 8). Source: origin/main at `660faeeef` (a read-only checkout in the local lab).
A copy was built against the fake (`tools/visual-qa/fake-supabase.mjs`, `FAKE_ADMIN=1`, `NIGHTSHIFT_AI_CHAT=on`,
`NIGHTSHIFT_FILM_STUDIO=admins`) and driven with Playwright and Chromium at 1440×900 in dark mode. The DOM was sampled every 100 ms and a
screenshot taken every 500 ms. No LLM, vendor or paid provider was called. The film start never reached the server. The fake refused
every write.

Paths are relative to `command-center/` unless they start with `tools/`; short names (`NightshiftAiPanel.tsx`) are under
`components/`, `lib/` or `app/`. Line numbers are those of `660faeeef`.

## 0. Headline: the canvas beside the panel never shows the story

On the default Studio page (`/{channel}/studio`), the panel sits beside **`StudioCanvas`**. That component has no `brain`/brief input
and nothing in `components/studio-canvas/` reads the brief or listens for it (`app/(app)/[channel]/studio/page.tsx:110-147`). The panel
dispatches `nightshift:brain-brief` (`NightshiftAiPanel.tsx:271`). The only listener is `useBrainBrief` (`studio-live/useBrainBrief.ts:80`),
which runs only inside `LiveView`. `LiveView` is mounted only on `?view=live` (`page.tsx:57-79`), and that page has **no panel**.

Measured across all five runs, from Send until Create was confirmed:

- the canvas had 0 nodes;
- the canvas viewport transform never changed;
- `GET /api/brain/session` was read 0 times.

The canvas showed its own empty "What shall we make?" card the whole time. So on this path, "scenes appear on the canvas" never happens.
Scenes show up only as a text line in the panel ("1.3 min · scenes: 23").

The `?view=live&brain=<id>` draft view does draw the brief (measured separately in section 3). Nothing in the panel links to it or
navigates there.

## 1. Static map

### A. Send → (no) scenes on canvas

| # | Step (code) | What the screen shows meanwhile |
|---|---|---|
| 1 | `ChatShell.submit` → `onSend` (`components/chat/ChatShell.tsx:164`) | Typed text **stays in the box** until the turn resolves (`:167` clears only after `await onSend`) |
| 2 | `run()` sets `busy` and `asking` (`NightshiftAiPanel.tsx:615-620`) | Your bubble and the three "thinking" dots appear in about 50–170 ms, plus a glow (`data-state=thinking`) and an sr-only "Thinking…" |
| 3 | `post()`: one `fetch('/api/brain/turn')`, then `await res.json()` (`:595-597`). **No streaming.** | Dots only |
| 4 | Route `start` → `runTurn` (`app/api/brain/turn/route.ts:670`, `:127`). About 8 sequential Supabase round trips before the model: `ai_chat_quota`, chosen model, `chatModelGate`, `filmGate`, `ai_chat_reserve_turn`, channel and history, `readChannelFacts`, `vendorUser` (`:130-192`) | Dots |
| 5 | `callChatModel(..., size:"proposal")` (`route.ts:191`). Output up to 8,000 tokens, timeout 150 s (`lib/server/brain/llm.ts:81-84`). It does not stream: the code reads `res.text()` whole (`llm.ts:214`) | Dots |
| 6 | If the outline breaks the story rules, it is **re-asked once**, which is a second full model call (`route.ts:204-220`) | Dots, for twice as long |
| 7 | `ai_chat_finish_turn`, then the JSON is returned | — |
| 8 | Reply, outline cards and input clear all land in the same render. `announce()` dispatches the event and calls `history.replaceState(?brain=)` with no reload (`:268-276`) | Reply text plus 2–3 outline cards, all at once. **Canvas: nothing** |
| 9 | Person presses "Choose this one" → `choose()` (`:802`) sets `planning` and `asking` | Choice bubble, dots, and the static note "Writing the storyboard … a minute or two" (`:1144`) |
| 10 | Route `choose`. Lease, then `create_film_draft` (`route.ts:473`), then `writeStoryboard` (`:551`) | Same |
| 11 | `writeStoryboard`: windows = ceil(film_s/40), at most 3 in parallel (`lib/brain/plan.ts:54`, `lib/server/brain/plan.ts:211`). Each window is a full model call (`plan.ts:134`, timeout 110 s). A failed window is re-asked once (`plan.ts:177`). **Nothing returns until every window is done** (`plan.ts:214-248`) | Same static note. No count of chapters done |
| 12 | `ai_chat_save_brief`, `save_film`, `quote_film`, `ai_chat_save_brief` again (`route.ts:586-608`) | Same |
| 13 | JSON → `setStep("ready")`, `announce()` (`:842-846`) | The "The plan" card plus Create, all at once. **Canvas: nothing** |

### B. Create confirmed → first lit step

| # | Step (code) | Screen |
|---|---|---|
| 1 | Create → inline confirm (`FilmCreateButton.tsx:330`). Confirm → `POST /api/films/{id}/start` (`lib/studio/useFilmStart.ts:232`) | Confirm block. Its primary key is half under the composer at 1440×900 (frame `L8_w2_r0/f0044`) |
| 2 | `onStarted` → `filmStarted`. It **awaits** the handoff POST (`NightshiftAiPanel.tsx:862-866`), then calls `window.location.assign(?view=live&film=)` (`:867`). **This is a full document reload, not a client transition** | Old page until unload |
| 3 | Server renders `page.tsx:57-79` → `<LiveView>` only. The panel, the Studio top bar (Canvas/Timeline) and the conversation are gone | Page shell; top bar buttons blank during hydration |
| 4 | Hydrate, then `useLiveGraph`'s first read runs immediately (`useLiveGraph.ts:101`) | "Reading the plan…" |
| 5 | `/api/films/{id}/live` → `filmGraph`. Idea and Script are "done" at once; the rest is "waiting" | Board appears, **all cards at once**, fitted at `minZoom 0.72` (`LiveView.tsx:57`) |
| 6 | Polls every **6 s** (`useLiveGraph.ts:21`, `startPolling` in `lib/studio/timeline.ts:507`) | Static board until the next read |
| 7 | Worker pickup: `tools/film_worker.py:61-62,140-154`, idle backoff 5 → 10 → 20 → 40 → 60 s | Not measured. Adds 0–60 s before any step can be "working" |

## 2. Measured timelines

The model is stubbed at the browser boundary (see section 5). `L` is the latency of one model call. In the choose step the stub waits
`ceil(windows/3)·L·(1+reask)`, which is the plan's parallel schedule. The scripted person waits 1 s before Choose and 1 s before Create,
and 0.5 s on the confirm block; those pauses are excluded from the gap list.

### After Send (t = 0 at the Send click)

| Event | L=2 s | L=8 s | L=20 s |
|---|---|---|---|
| Your bubble shown | 0.05 s | 0.08 s | 0.06 s |
| Thinking dots shown | 0.05 s | 0.08 s | 0.06 s |
| Turn answer received | 2.05 s | 8.02 s | 20.04 s |
| **Input box cleared** | 2.07 s | 8.10 s | 20.08 s |
| Reply text shown | 2.07 s | 8.10 s | 20.08 s |
| Outline cards shown (same frame as reply) | 2.07 s | 8.10 s | 20.08 s |
| Canvas nodes (any time before Create) | 0 | 0 | 0 |
| Canvas viewport changes / page scrollY | none / 0 | none / 0 | none / 0 |

The panel thread scrolls smoothly in 5–7 steps (`ChatShell.tsx:156-162`). There are no page-level jumps.

### After Choose (t = 0 at the Choose click)

| Event | L=2 s, 2 win | L=8 s, 2 win | L=20 s, 2 win (75 s film) | L=20 s, 6 win (240 s film) | L=20 s, 6 win, every window re-asked |
|---|---|---|---|---|---|
| Planning note and dots | 0.06 s | 0.13 s | 0.07 s | 0.04 s | 0.06 s |
| Answer received | 2.05 s | 8.07 s | 20.05 s | 40.06 s | 80.06 s |
| "The plan" card and Create shown (all at once) | 2.07 s | 8.17 s | 20.15 s | 40.09 s | 80.13 s |
| Scenes on canvas | never | never | never | never | never |

### After Confirm (t = 0 at the confirm click)

The numbers are nearly identical across all five runs, so a range is shown.

| Event | Measured |
|---|---|
| Start POST answered (stub 300 ms) | 0.34–0.39 s |
| Handoff POST sent, then `location.assign` | 0.34–0.41 s |
| Last frame of the old page (panel present) | 0.27–0.37 s |
| No DOM / document swap | about 0.35–0.55 s |
| Live page first painted ("Reading the plan…") | 0.57–0.68 s |
| First `/live` GET (after hydration) | 1.00–1.26 s |
| **First cards drawn**: 18 at once (2 done, 14 waiting, 2 none) | 1.18–1.55 s |
| Second `/live` GET | 7.00–7.23 s |
| **First "working" card** (worker pickup assumed at 2 s) | 7.09–7.28 s |

Because the first read landed before the stubbed pickup, the first step lit only at the next poll. With a real idle worker
(backoff up to 60 s), expect 0–60 s plus up to 6 s.

### Total from Send to "Create" visible, excluding the person's own pauses

| Setting | Total |
|---|---|
| L=2 s | about 4.1 s |
| L=8 s | about 16.3 s |
| L=20 s, 75 s film | about 40.2 s |
| L=20 s, 240 s film | about 60 s |
| Worst case (re-asks) | about 100 s |

Throughout, the canvas does not change.

### `?view=live&brain=` draft view (the only place a brief is drawn)

`runs/brainview/`, with the session read stubbed at 300 ms:

- 54 draft cards appear in **one frame** at 0.995 s after navigation;
- the board is fitted at zoom 0.72 and the middle of the plan is centred, so Idea and Script are off-screen;
- the panel is never present on this page.

## 3. Gaps over about 1 s with nothing new on screen, ranked

Durations come from the L=20 s worst-case run; the other runs scale with L.

| Rank | Gap | Duration | What is on screen | Cause |
|---|---|---|---|---|
| 1 | **The canvas, from Send through Create** | The whole session: 40–100 s at L=20 | Canvas frozen on its empty "What shall we make?" card | `page.tsx:110-147` mounts `StudioCanvas` with no brief. No canvas code listens to `nightshift:brain-brief` (only `useBrainBrief.ts:80`, inside `LiveView`). `LiveView` with `brain` exists only on `?view=live` (`page.tsx:77-79`), where the panel is not rendered |
| 2 | Storyboard writing after Choose | 20 s (2 windows) / 40 s (6) / 80 s (6, re-asked) | Dots and one static sentence; no chapter progress | One blocking POST: `route.ts:551` → `plan.ts:211` awaits all windows (`plan.ts:214-248`). Windows finish one by one but nothing is emitted. Panel `choose()` awaits the whole JSON (`NightshiftAiPanel.tsx:818`, via `post` `:595-597`) |
| 3 | First answer after Send | 20 s (40 s if the story is re-asked) | Dots; **your text still sits in the input box** next to your bubble | No streaming: `post()` `:596-597` awaits `res.json()`. `callChatModel` reads the body whole (`llm.ts:214`). The input clears only after the answer (`ChatShell.tsx:167`). Re-ask: `route.ts:204-220` |
| 4 | Live view: first read until the first step lights | 5.9 s measured (6 s poll). Plus 0–60 s worker idle backoff, not measured | Static board, all "waiting" | `useLiveGraph.ts:21` `POLL_MS = 6000`. `tools/film_worker.py:61-62,152-154` idle backoff up to 60 s |
| 5 | Confirm → first cards | 1.2–1.5 s, of which about 0.3 s has no DOM, then a "Reading the plan…" page without the panel | Blank, then a loading line | `NightshiftAiPanel.tsx:867` `window.location.assign` (full reload, after awaiting the handoff POST `:864-866`). `page.tsx:57-79` re-renders a different page. The first `/live` read waits for hydration (`useLiveGraph.ts:101`) |
| 6 | Draft view, when reached | Not a time gap: 54 cards appear in one frame and the fit hides both ends | — | `LiveView.tsx:427` `briefGraph` of the whole brief; `FIT.minZoom 0.72` (`:57`) |

## 4. Filmstrips

Frames are named `fNNNN_<ms since script start>ms.jpg`, taken every 500 ms at 1440 dark. Each run also has `final.png`, `raw.json`
(samples, network, marks) and `derived.json`. They were kept in the local lab (not committed), under `runs/`:

- `L2_w2_r0/`
- `L8_w2_r0/`
  - `f0044_022278ms.jpg`: the confirm block, with its key under the composer
  - `f0045_022778ms.jpg`: the live page saying "Reading the plan…", with no panel
- `L20_w2_r0/`
- `L20_w6_r0/`
- `L20_w6_r1/`
- `brainview/brainview.png`: the draft view at fit zoom 0.72

The scripts were run in the local lab: `measure.mjs` (the flow), `analyze.mjs` (the timeline) and `brainview.mjs` (the draft view).
`tools/visual-qa/studio-live-plan.mjs` is the flow script adapted to this PR's change (see "Change" below).

## 5. What could not be measured, and why

- **Real model latency.** `lib/server/brain/llm.ts` has no base-URL or env seam: the vendor URLs are literals at `:169,181,200`, and
  `fetchImpl` is only a call argument. A turn also writes through `ai_chat_reserve_turn` and `ai_chat_finish_turn`, which the fake
  refuses. So `/api/brain/turn` was stubbed in the browser with answers in the route's recorded shape. L is a parameter, not a
  measurement. An 8,000-token non-streamed proposal from a real vendor could take far longer than 20 s.
- **Server-side time before and after the model.** These are the about 8 sequential Supabase calls before the model and the
  draft / save / quote calls after the plan. They were never executed, because the stubbed route never reached the server.
- **Worker pickup after start.** The fake has no running film, and the start was stubbed. The first "working" card was produced by
  rewriting the `/live` answer 2 s after the start, so only the browser's 6 s poll lag was measured. The worker's 5–60 s idle
  backoff is static reading only.
- **Live view content.** It is the fake's fixed film ("Football in 2050", 6 scenes), not the film just planned. Card counts and titles
  therefore do not match the brief.
- **Multi-turn flows.** These are question cards before a proposal, which add one model call each. I measured only the shortest path
  (the first answer proposes).
- **Phone widths, `ru` and `uz`, and reduced motion.** Out of scope for this run.

## 6. Change (this PR)

This PR is step one of `docs/studio/LIVE_CREATION_PLAN.md` item #8 ("`StoryBoard` + `boardModel` beside the panel; position-keyed ids;
performance"). It changes the headline in section 0: the column beside the panel now draws the plan as the conversation builds it.

- **Plan column.** On the default Studio page, `components/studio-live/PlanColumn.tsx` wraps the canvas column, with a "Plan / My canvas"
  switch. Sending a message switches it to Plan, even over a canvas with cards on it. The person's "My canvas" choice is kept in
  localStorage for that conversation only; a new conversation switches to Plan again (`lib/studio/planBoard.ts`). The canvas stays
  mounted under the plan, hidden and `inert`, so nothing on it is lost. Its keyboard shortcuts are ignored while it is hidden.
- **Reads.** The board reads `/api/brain/session/{id}` through the existing `useBrainBrief`: once when a conversation becomes known, then
  once per finished turn (`nightshift:brain-brief`). No timer and no new route. A failed re-read keeps the last board and marks it as the
  last one read.
- **Activity event.** `lib/studio/brainActivity.ts` defines `nightshift:brain-activity` (`{session_id, phase}`, where phase is `thinking`,
  `storyboard` or `idle`). The panel emits it on six lines, where it already sets busy and planning. The board shows "Planning…" while a
  turn is out, and "Writing the storyboard…" with an indeterminate sweep while the storyboard is written. It shows no per-scene count,
  because the server reports none.
- **One board.** `components/studio-live/StoryBoard.tsx` is LiveView's board, moved out, and both LiveView and the Plan column render it.
  `lib/studio/boardModel.ts` turns each reading into a stage: proposing, planning or ready from the brief; making or assembled from the
  film or run. It reuses unchanged node objects and keeps the brief's character, place and prop cards after Create. Updates are applied
  once per animation frame, and React Flow renders only the visible cards above 40.
- **Position-keyed ids (a fix).** Scene cards are now `scene#<n>:keyframe|clip`, in both the brief and the film graphs. Before, they were
  keyed by scene id, and the brief's scene ids are not the film's, so every scene card re-mounted at Create.
  The live lane (#974) finds its card by position as well: `nodeOfPiece` maps a clip piece to `scene#<n>:clip` through the lane's own
  scene order, so its flights and "open this step" still land on the right card.
- **Motion.** New cards enter in reading order, 50 ms apart; the stagger stops growing after 16 cards. Under reduced motion nothing
  enters. The first reading after a load or refresh enters nothing. The viewport moves, smoothly, only when the card count grows.
- **Confirm key.** One CSS rule in `nightshift-ai-panel.css` keeps the confirm key above the composer at 1440×900 (section 1B, step 1).

### Measured after the change

Measured with the same stub as section 2 (`tools/visual-qa/studio-live-plan.mjs`, 1440 dark), on this branch after merging main at `797edc662`. t = 0 is the Send click, and the Choose
click for the second table.

| Event | L=2 s | L=8 s |
|---|---|---|
| Plan column shown, "Planning…" | 0.03 s | 0.05 s |
| First plan cards (one 100 ms sample after the reply) | 2.14 s | 8.19 s |

| Event (after Choose) | L=2 s | L=8 s |
|---|---|---|
| "Writing the storyboard…" shown | 0.06 s | 0.05 s |
| Storyboard's scene cards on the board | 2.17 s | 8.18 s |

- The session was read twice per run: once after the first reply, and once after the storyboard.
- The confirm key was wholly above the composer in both runs.
- The layout pass passed: no horizontal overflow and no page error at 1440 and 390, light and dark, en, ru and uz.

### Review round (Pixel, Lens, React reviewer)

- **The Plan column is a storyboard, not the step graph.** `components/studio-live/PlanBoard.tsx` lays the plan out with
  `lib/studio/planGrid.ts`: one card per scene, wrapped to the board's width at zoom 1, with the idea, the script and the cast above
  the scenes and the assembly and final video below them. A longer plan scrolls down and is never shrunk. React Flow `Controls` are
  available to fit or zoom. 12 scenes fit a 1440×900 window (lab-checked).
- **Cards.** Each scene card carries its title, the first line of its visual, its planned length and its cast; there is no per-card
  "Planned". The card is a placeholder, `PlanSceneCard.tsx`, built to S5's `<LiveNode>` props, which replaces it.
  - Status maps to S5's states; a finished step with no file reads "unknown" (rule 5).
  - The cast is carried on the scene's cards, not drawn as wires.
- **Phones and tablets.** Below 1024 px, Chat and Plan are tabs (`StudioSplit.tsx`). The first send of a conversation opens the
  plan; a chip above the chat opens it afterwards.
- **The hidden canvas.** It stands down through `CanvasActiveContext`: its bar, palette, quick-add, inspector, drawer and keys are
  off while the plan is shown.
- **Escape** closes a step and never leaves the Studio (`SectionShell.tsx`).
- **LiveView.** It no longer re-renders every frame after a handoff, and it rings nothing on the film's first reading.

Measured after this round (same stub, 1440 dark, main merged):

| Event | L=2 s | L=8 s |
|---|---|---|
| Plan column and planning skeleton after Send | 0.09 s | 0.10 s |
| First plan cards after Send | 2.21 s | 8.18 s |
| "Writing the storyboard…" after Choose | 0.12 s | 0.05 s |
| Scene cards after Choose | 2.24 s | 8.13 s |

The page itself still scrolls about 50 px at 1440×900. The cause is on main: the shell's `app-geo-credit` line under the page
(`studio-canvas.css:202`), with the two-step sign-in banner above the bar. The left rail only stretches to the page's height; it
does not set it. This PR touches neither. The Studio column ends inside the window.

### Final round (Lens, Pixel; S1's #989 contract)

- The activity event is S1's contract (#989 @ 13dab36c8), copied into `lib/studio/brainActivity.ts` until #989 lands:
  - the phases are `thinking`, `planning`, `saving`, `pricing` and `end`;
  - `session_id` is null only on a first send's `thinking`;
  - `dispatchBrainCanvas` refuses a detail that breaks the contract.
- A storyboard shows "Writing chapter n of m" only when the server sends its counts; without counts, the row says only that the
  storyboard is being written.
- Only an in-flight storyboard is replayed to a board that mounts late, marked as a replay: a stale send no longer brings another
  conversation into a new column.
- Below 1024 px one tablist (Chat · Plan · My canvas) replaces the two switches. A reply that waits for the person's choice is
  said on the Plan tab, with the way to the chat, and the Chat tab is marked when such a reply lands while the person is elsewhere.
- The project bar stays in the header while the plan is shown; only its search is off.

`tools/visual-qa/timing/brain-flow.mjs` (S3's timing harness, branch `claude/nsai-s3-timing`) on this branch against main's
baseline, same stub:

| Measure | main, L=2 s | this PR, L=2 s | main, L=8 s | this PR, L=8 s |
|---|---|---|---|---|
| First board event after Send | never | 0.44 s (planning skeleton) | never | 0.39 s |
| First plan card after Send | never | 2.55 s | never | 8.52 s |
| First board event after Choose | never | 0.09 s (storyboard row) | never | 0.14 s |
| Longest unchanged stretch, Send → outlines (board) | 2.51 s | 1.10 s | 8.46 s | 1.12 s |
| Longest unchanged stretch overall | 5.67 s (confirm → first lit) | 5.84 s (confirm → first lit) | 8.46 s | 5.83 s (confirm → first lit) |
| Full-page reloads after Create | 1 | 1 | 1 | 1 |

Confirm → first lit and the reload after Create are not this PR's: they are LIVE_CREATION_PLAN items 9 (Create in place) and 12
(Realtime). The skeleton's measured clock ticks once a second, so the planning wait is never a still screen.

## 7. Create in place (LIVE_CREATION_PLAN item 9)

Evidence: section 1B step 2 and the timing harness's "1 reload after Create". Change: after the confirmed start, the panel no longer
calls `window.location.assign(?view=live&film=)`. It sends `nightshift:brain-handoff` (`{session_id, film_id}`, added to the copied
contract in `lib/studio/brainActivity.ts` for #989 to mirror) and adds `&film=` to the URL with `history.replaceState` (`?brain=`
kept). The Plan column finds the film from that event, then the brief's handoff (the server's record), then `&film=`; reads it with
`useLiveGraph`; and folds it into the same board model, so the position-keyed cards change state without remounting. The film's lane
mounts under the board. Below 1024 px the handoff opens the Plan tab. `?view=live` is unchanged. The activity log is not shown in the
column: at 1440×900 the board already shares the column's height with the lane.

`tools/visual-qa/timing/brain-flow.mjs`, same stub, 1440 dark. Before: #993 at `42701eea`.

| Measure | #993 L=2 s | this, L=2 s | #993 L=8 s | this, L=8 s |
|---|---|---|---|---|
| Full-page reloads after Create | 1 | 0 | 1 | 0 |
| Confirm → first live card | 1.35 s | 0.44 s | 1.29 s | 0.48 s |
| Confirm → first working card | 7.26 s | 6.46 s | 7.11 s | 6.53 s |
| Longest unchanged stretch (confirm → first lit) | 5.81 s | 5.32 s | 5.81 s | 5.33 s |

The 0.44–0.48 s includes the stub's 300 ms start answer. The remaining stretch is `useLiveGraph`'s 6 s poll: item 12 (Realtime).
The film read is the fake's fixed film, not the one planned. `ns:` marks now emitted: `ns:plan:first-card`,
`ns:plan:storyboard-start`, `ns:create:confirm`, `ns:live:first-card`, `ns:live:first-lit`.

### Review round (Lens M1–M5, Pixel H1–H4, M1–M5)

- The panel's Create stays on screen after an in-place start with "Started. It is being made on the board beside this chat." and no
  key to the old page; focus goes to the board's title. A recorded handoff closes the conversation as a reload would; one the server
  did not record is said, with a retry.
- The board: one status line under the title in every state ("Started · reading its progress…", the film's own read errors, then
  "Being made…"); the idea and script read "Made", not "Unknown"; scene cards keep the plan's cast and planned length and say their
  state in words; a URL film the brief does not name is never drawn and is taken off the URL; the film is read only while the plan is
  shown; at 1440×900 the lane starts folded, the board is fitted once, and the activity log sits folded under the lane (opening itself
  on a failed step). A refresh on `?brain=&film=` below 1024 px opens on the Plan tab.

Measured again after this round (same stub):

| Measure | #993 L=2 s | this, L=2 s | #993 L=8 s | this, L=8 s |
|---|---|---|---|---|
| Full-page reloads after Create | 1 | 0 | 1 | 0 |
| Confirm → first live card | 1.35 s | 0.53 s | 1.29 s | 0.44 s |
| Confirm → first working card | 7.26 s | 6.46 s | 7.11 s | 6.46 s |
| Longest unchanged stretch (confirm → first lit) | 5.81 s | 5.32 s | 5.81 s | 5.32 s |

Lab: the Create flow and the layout pass at 1440, 768, 390 and 360, light and dark, en, ru and uz, before and after Create (the
footer row wholly in view and at least three card rows at 1440×900) all passed.

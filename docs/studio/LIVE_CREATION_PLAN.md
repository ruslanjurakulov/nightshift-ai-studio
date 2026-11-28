# Live creation: one sentence to a film, live on the canvas

Owner's goal (28 Nov 2026): a person writes one sentence to Nightshift AI. The AI proposes scenarios. After the person picks one,
everything happens **live** on the canvas beside the chat:
- the plan writes itself;
- prompts appear as they are written;
- character sheets, stills and clips arrive with honest progress;
- the film assembles in place.

It must be the best experience on the market, and nothing may be left half done.

This document is the shared plan for S1 (brain), S2 (film run, money, sound), S3 (live canvas), S5 (UI and motion) and S8 (site).
It combines two studies made on 28 Nov:
- a market study of live and agentic creation tools;
- an architecture read of `origin/main` at 660faeeef.

Competitor names and prices are kept out of the repository on purpose.

Rules that do not bend (CLAUDE.md):
- nothing is spent before the person confirms a backend price (rule 3);
- nothing publishes;
- an unknown progress is never a percentage (rule 5);
- a configured model or voice that is unavailable stops the run, and nothing is silently swapped (rule 4).

## 1. What a person sees, second by second

Times are targets for a 9-shot, ~45 s film.

**Act 0: Send (free)**
- **0.0 s.** The message settles. The canvas wakes: the dot grid fades in over 240 ms, and a small "Nightshift is reading" pulse appears.
- **< 1 s.** The first event arrives, a real phase from the server. The chat shows one line, not a wall of text.
- **≤ 6 s.** Three **scenario cards** land on the canvas, 120 ms apart. Each logline is revealed, then its chips fill in: tone, length, cast size and style. Each card has a palette-gradient placeholder, never a fake image. Buttons: Pick / Mix / Rewrite.

**Act 1: The plan (free)**
- **Pick.** The chosen card moves to the left. The others dim and stay available as branches.
- **Script.** The beats arrive chapter by chapter, as each window is written and checked, with a real "Writing chapter 2 of 4".
- **Shot list.** One line per shot: number, duration, shot size, camera move, action and sound (S1's shot grammar, #969). Each finished line drops a ghost card into a storyboard grid, and a connector draws itself to the card.
- **Cast strip.** Character, location and prop cards carry the look sheet text, and each shot shows avatar chips for the characters in it.
- **Plan card**, docked at the bottom of the chat:
  - per-stage lines, each priced **by the backend**: references, stills, clips, voice/music/assembly;
  - the total and the balance after;
  - **Approve stage 1 only** as the default, Approve all, and Edit plan;
  - a line the backend can't price reads "price unavailable", and that stage cannot be approved;
  - when credits are short, the card shows the shortfall and a top-up link, and the button is disabled, never hidden.
- Editing any line is free and re-quotes it.

**Act 2: References (first spend, after Approve)**
- A run bar appears at the top: References ▸ Stills ▸ Clips ▸ Assembly, with **measured** counts such as "Sheets 1 of 4".
- Each reference card goes live. Its real prompt is revealed in mono, and it shows a border light sweep, the model, a phase word (queued, making, storing) and an elapsed timer.
- A queue position or a vendor percentage is shown only when the vendor reports one.
- When the result arrives, it fades in over 400 ms with a de-blur. This is cosmetic, and it happens after arrival.
- Checkpoint in chat, "Cast ready. Look right?", with Keep / Redo this one (priced) per card.

**Act 3: Stills**
- All the stills go live in parallel and land in the order they actually finish.
- Hovering a still shows its prompt, model and references.
- The grid can be played as an animatic, which is free.
- Each shot has a priced retake of that shot only.

**Act 4: Clips (the expensive stage)**
- The total is shown again before approval.
- Each still becomes a clip card. A clip autoplays muted once when it lands, then rests on its last frame.
- A failed clip shows the cause and the remedy in plain words, with a priced retry. The run bar reads "8 of 9 ready, 1 needs you" and **never** "done" while a shot is missing.

**Act 5: Assembly**
- The clips fly into a timeline strip, with voice and music waveforms drawing in beneath and a playhead.
- Assembly progress is a real percentage, because it is our own ffmpeg measured against the known timeline length.
- The final card says "Your film is ready, private." There is no publish button here.
- Pause stops after the in-flight jobs, and only finished jobs are charged.
- A refresh restores the exact canvas from the server.

## 2. Design direction (S5 maps this to our tokens; the brand tokens stay ours)

- **Canvas:** near-black with a fine dot grid that fades as you zoom out, smooth zoom and pan, and a minimap shown while panning. Chat is on the left (360 px, collapsible). The run bar is at the top centre.
- **Node cards:** a 14 px radius, a hairline border and a surface one step above the canvas. Depth comes from an inner top highlight, not a heavy shadow.
  - Each card has a small uppercase type label (SCRIPT · SHOT 04 · CHARACTER · CLIP · VOICE).
  - Machine text (prompts, model names, timers) is set in mono, so the machine's words never look like the person's.
  - The price chip appears only when the backend computed the price.
- **Connectors:** curved, 1.5 px, coloured by data type (text, image, video, audio). A travelling dash runs while data flows.
- **States, each designed and never blank:**
  - ghost: dashed;
  - queued;
  - working: a light sweep and elapsed time, no percentage unless measured;
  - arrived: fade and de-blur;
  - failed: cause, remedy and a priced retry;
  - disabled: with the reason;
  - insufficient credits;
  - empty: one prompt line and three example chips.
- **Motion:** text is revealed (about 25 ms per character, capped at 600 ms per prompt). Cards land with a small spring (96%→100%, 220 ms, staggered 60–120 ms). Connectors draw in over 300 ms. Completion gets one soft glow and never confetti. Everything over 200 ms can be skipped, and reduced motion replaces all of it with fades.
- **Type:** the UI grotesk, the mono for machine text, tabular figures for counters. Every string is in en, ru and uz.
- **Phone (390 px):** "Chat · Film" tabs. The board becomes a grouped vertical list (Story, Cast, Scenes, Sound, Final) with a sticky real status line.

## 3. Architecture (decisions)

1. **Stream units we have checked, never raw tokens.**
   - Units: `phase`, `scenario` (provisional until `end`), `plan.window` (a chapter, final for display once saved), `plan.scene` (later, provisional), `retract`, `ping` (every 10 s) and `end`.
   - `end.body` is **exactly** today's JSON answer.
   - Transport: NDJSON on the same `POST /api/brain/turn`, chosen with `stream:true`, behind `NIGHTSHIFT_AI_STREAM=off|lab|on`. Off is today's behaviour, byte for byte.
   - New files: `lib/server/brain/stream.ts` (server) and `lib/brain/stream-events.ts` (shared event union and reader).
2. **The socket does not own the work.**
   - A dropped stream does not abort the vendor call. The lease, the reservation, the re-ask, `ai_chat_finish_turn` and `ai_chat_plan_end` run exactly as today.
   - Reconnecting uses `duplicate_request`, `plan_running` and `waitForPlan`.
   - Refresh the access token before the first byte.
3. **Save each chapter as it lands, in its own table, never in the BRIEF.** A partial brief would be priced as a whole film.
   - New table `ai_chat_plan_windows`, written by a definer function that checks the 0211 lease attempt.
   - The session and history views return the windows, and a pending-call flag.
   - Order: check the window, finish it, save it, then emit it.
4. **Proxy.** Exclude `/api/brain/turn` from Caddy's `encode`, and send `Cache-Control: no-transform` and `x-accel-buffering: no`. Measure line arrival through Caddy and through `next start` with `curl -N` in the lab before turning the flag on (rule 8).
5. **"Typing" prompts.**
   - Reveal text the server has already checked, labelled "Written". The real "Writing…" signal is per chapter.
   - Never forward raw tokens: they would show prompts that are later refused, cut or asked for again.
   - Later, scenes arrive as each JSON object closes, labelled "Checking" until their window passes.
6. **Live status: broadcast from the database, not `postgres_changes`.**
   - An AFTER-UPDATE trigger on `film_takes`, `film_segments` and `films` calls `realtime.send(...)` on the private topic `film:<id>`.
   - The payload is small: ids, status, progress and vendor state. It carries no prompts, no errors, no task ids and no money.
   - An RLS policy on `realtime.messages` (SELECT only) uses a definer `film_topic_allowed()`. There is no INSERT policy.
   - The client re-reads `/api/films/[id]/live`, debounced, for media and money.
   - Polling stays as the fallback: every 30 s while Realtime is connected, every 6 s otherwise. The header word follows the real mode: "Live" or "Checked every 6 s".
   - Breach target: cross-org topic joins.
7. **Progress honesty.**
   - Only one video adapter reports a vendor percentage today, and `creative_adapters.py:261` drops it. Pass it through.
   - Record the vendor's own status words (queued, processing) per take, throttled.
   - Typical duration: "usually ~N s here (last n takes)" from our own `film_takes` timings, shown only with n ≥ 3. Otherwise elapsed time only.
   - Assembly: a real percentage from ffmpeg `-progress`.
8. **One board that morphs in place.** `StoryBoard` is extracted from `LiveView`, with a pure `boardModel` reducer. Its stages: proposing → planning → ready → making → assembled.
   - It renders beside the panel on the Studio page, with a "Plan / My canvas" switch.
   - The target comes from `useSearchParams`.
   - **Fix:** node ids are keyed by position (`scene#<n>:…`), because the brief's scene ids are not the film's. Keep character, location and prop nodes after Create.
9. **Create in place.** Replace `window.location.assign` with the handoff event plus `history.replaceState(&film=)`. The DB handoff stays the truth after a refresh.
10. **Performance.**
    - Reuse unchanged node objects and memoize the cards.
    - Batch updates per animation frame.
    - Turn on `onlyRenderVisibleElements` above about 40 nodes.
    - The board shows images only; video plays in Details.
    - A batch signed-media route replaces the per-asset requests.
11. **Tests.**
    - A lab-only fake vendor for `llm.ts`, which production refuses.
    - A fake film run in Python on the lab DB.
    - A fake Realtime socket in `fake-supabase.mjs`.
    - Playwright filmstrips with `performance.mark`s. Targets: first event < 1 s, no unchanged stretch > 3 s while work is running, 0 reloads after Create.
    - A parity suite: every existing route test passes in both JSON and stream modes.

## 4. Build order (one owner per PR)

Migration numbers are assigned by Atlas:
- 0245 plan windows
- 0246 take progress and vendor state
- 0247 broadcast and Realtime RLS
- 0248 take-duration medians

| # | Owner | PR | Depends on |
|---|---|---|---|
| 1 | S3 | Timing marks and the filmstrip harness (measurement) | none |
| 2 | S1 | Caddy `encode` exclusion, `no-transform`, `curl -N` lab measurement | #934 |
| 3 | S1 | NDJSON stream: `plan.begun`, `phase`, `plan.window`, `end`; panel reads and re-dispatches events; parity suite | 2 |
| 4 | S5 | Node visuals and states, `RevealText`, entry, edge and transform motion, reduced motion | event schema from 3 |
| 5 | S2 | Vendor state and progress through `PollResult` and take progress; assembly progress (0246) | none |
| 6 | S2 | Broadcast triggers, `realtime.messages` RLS, Breach (0247) | 5 |
| 7 | S1 | Saved plan windows, pending flag, `waitForPlan` draws saved windows (0245) | 3 |
| 8 | S3 | `StoryBoard` + `boardModel` beside the panel; position-keyed ids; performance | 3, 4 (and S3's current live-plan PR) |
| 9 | S3 | Create in place | 8 |
| 10 | S2 | Take-duration medians (0248) | none |
| 11 | S5 | Progress UI, "Live" word, 390 tabs and sticky status, batch media | 5, 10, 8 |
| 12 | S3 | Realtime client with fallback | 6, 9 |
| 13 | S1 | Vendor streaming in `llm.ts` (Scout first) | none |
| 14 | S1 | Streamed scenario cards, `retract` on re-ask | 13, 3 |
| 15 | S1 | Scene-level provisional streaming | 13, 7 |
| 16 | S8 | Landing demo replaying a recorded lab run, labelled as such | 9 |

Critical path to "no blank, no reload": 2 → 3 → 8 → 9. Item 4 runs in parallel.

Already in progress and compatible:
- S3's live-plan PR (the brief drawn beside the chat, plus the `brain-activity` event);
- S1's chapter-streaming plan, which becomes item 3;
- S1's character sheets (PR 2);
- S2's clip sound (#973).

## 5. Risks

| Risk | Mitigation |
|---|---|
| Provisional text read as final | Labelled; Choose only after `end` |
| Lease or turn regressions | Additive callbacks, plus the parity suite |
| Buffering | Measure first; exclude the path from `encode`; pings |
| A deploy kills open streams | The reconnect path |
| Realtime leaks across orgs | Private topics, a definer check, Breach |
| Realtime plan limits | Unverified: Scout confirms them, and polling is the fallback |
| `creative_jobs` column guard (0225) | Side tables, never new columns |
| Many nodes or media | Memo, batching, images only, virtualization |

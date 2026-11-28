# S1 — Brain & plan: what works on `main`, and the gaps (22 Nov 2026)

Stream S1 of `docs/studio/PROGRAM.md`. Rule 8: this is the measurement; the fixes are separate PRs (`claude/nsai-s1-<topic>`).
Audited against `main` at `7ef5b38` and BRIEF v1 (`docs/studio/NIGHTSHIFT_AI.md`).

## How this was measured

- Read: `command-center/lib/brain/*`, `app/api/brain/**`, `components/brain/NightshiftAiPanel.tsx`, `lib/studio/liveGraph.ts`
  (`briefGraph`), `components/studio-live/useBrainBrief.ts`, migrations 0166, 0171, 0199.
- Ran the existing suite: `npx vitest run tests/brain-*.test.ts tests/live-graph.test.ts tests/studio-live-ui.test.tsx` →
  **14 files, 271 tests, all pass**.
- Ran a throwaway probe against `lib/brain/logic.ts` (not committed): a scenario the model returns, read by `readScenario` with the
  person's slots `{kind: short, target_seconds: 180}`. Results are quoted below as **[probe]**.
- `git ls-remote origin`: the two in-flight branches the brief names, `claude/c2-customer-chat-shell` and `claude/chat-gemini-flash`,
  **do not exist on the remote** (nor does `claude/canvas-timeline-lane`). Nothing to build on or to avoid yet; reported to Atlas.

## What already works (do not rebuild)

| Step of the goal | Where | Evidence |
| :-- | :-- | :-- |
| Topic → conversation, flag, paid-plan cap, owner's model, no fallback | `app/api/brain/turn/route.ts` `POST` `start`/`turn`, `runTurn` (reserve → one call → finish) | `brain-turn-route.test.ts` |
| Question cards, server-owned slot order, kind first, options capped, own answer | `lib/brain/logic.ts` `SLOT_ORDER`, `nextSlot`, `card`, `readModelAnswer` | `brain-logic.test.ts` |
| Prompt-injection posture: fixed system text, one JSON data block, vendor names, prices and links stripped, unsafe floor | `lib/brain/prompt.ts`, `logic.ts` `modelText`, `namesVendor`, `unsafeBrief` | `brain-breach*.test.ts`, `brain-identity.test.ts` |
| 2–3 scenarios proposed when every slot is known; choose one | `readModelAnswer` → `scenarios`; route `choose` | `brain-turn-route.test.ts` |
| Short: BRIEF → `create_film_draft` + `save_film`, priced by `quote_film`, price attached by the server | route `choose` (lines ~240–275), `filmFromBrief` | `brain-turn-route.test.ts` |
| Create — N credits → `/api/films/<id>/start` with the quote id and one idempotency key, then `handoff {kind:"film", film_id}` | `NightshiftAiPanel.tsx` `createFilm`; 0199 `ai_chat_record_handoff` | `brain-handoff.test.ts` |
| Canvas draws the BRIEF as draft nodes (idea → script → refs → keyframe/clip per scene → voice/music → assembly → final) | `lib/studio/liveGraph.ts` `briefGraph`; `useBrainBrief` listens for `nightshift:brain-brief` | `live-graph.test.ts`, `studio-live-ui.test.tsx` |
| Panel docked on the Studio canvas | `app/(app)/[channel]/studio/page.tsx:128` | — |

So the chain exists end to end. What does not hold is that the BRIEF it produces is **complete and makeable** for the lengths a film
takes, and that what the panel promises is what the film is asked to do.

## Gaps, by severity

### G1 — The person's length is silently replaced by the sum of whatever scenes the model wrote (high; rules 4 and 5)

`readScenario` (`lib/brain/logic.ts:330-334`) sets a short film's `target_seconds` to the sum of its clamped scene durations; the
length the person chose on the card (`slots.target_seconds`) is used only when there are no scenes.

- **[probe]** asked 180 s, the model wrote 5 scenes × 6 s → BRIEF `target_seconds = 30`, film settings `target_seconds: 30`.
- **[probe]** asked 180 s, 10 scenes × 40 s → each clamped to 30 → `target_seconds = 300`.

Nothing tells the person; the "Create — N credits" price is for a film of a different length from the one they asked for.

**Fix (PR `claude/nsai-s1-plan`):** the scenes must add up to the chosen length within a tolerance; otherwise the plan is refused
by name (`plan_length_mismatch`) and re-planned, never stretched or shrunk in silence.

### G2 — One model call must write 2–3 complete storyboards: impossible past ~1–2 minutes (high; the "plan step is not built")

The proposing turn asks for 2–3 *full* scenarios (chapters, characters, locations, every scene with its visual prompt and dialogue)
in one answer capped at `OUTPUT_TOKENS.proposal = 8000` (`lib/server/brain/llm.ts:55`).

- **[probe]** one 30-scene scenario with only 60-word visual prompts, no dialogue, no characters, is 5,125 characters of JSON; three
  are 15,375 — already near the cap before dialogue, characters and the 2,000-character prompts the contract allows.
- A 1200 s film needs at least 40 scenes (scenes are ≤ 30 s, `FILM.sceneMax`); 60 are allowed. Three of those cannot fit.
- The two outcomes are `output_too_long` (no plan at all) or a model that writes few short scenes, which G1 then turns into a
  shorter film.

This is the known suspect, confirmed: `docs/FILM_STUDIO.md:302` and `FilmCanvas.tsx:492` ("Write the storyboard with AI — comes
with the next release") — **writing the storyboard is not built as its own step.**

**Fix (PR `claude/nsai-s1-plan`):** split proposing from planning.
1. *Propose*: 2–3 scenario **outlines** (title, idea, story, characters, locations, props, chapters with their seconds) — small.
2. *Plan*: on `choose`, the Brain writes the chosen outline's storyboard **chapter by chapter** (one bounded call per chapter
   window, each with the characters/locations by id and its own seconds), validated and merged by code into one BRIEF: ids stable,
   seconds summing to the chapter's, every scene within 3–30 s, at most 60 scenes. Each call is a reserved, metered turn in 0199
   (it is the owner's model, under the same cap and the same no-fallback rule); a failed chapter fails the plan by name with Retry,
   never a plan with a chapter missing.
3. Only a complete plan is priced (`create_film_draft` / `save_film` / `quote_film`). Nothing is spent by the Brain.

### G3 — "Voice is generated by the video model", but the clip is never asked for sound (high; rule 4)

`filmFromBrief` (`logic.ts:463-480`) writes dialogue into the clip prompt and sets `voice.mode = "clip_audio"`, and the panel says
the video model speaks the lines (`clipAudioNote`). It sends no `clip_params`. `quote_film` passes `audio` to the price only when
`clip_params ? 'audio'` (`0171_films_money.sql:760`); otherwise the model's default variant is priced and made, which may be silent.
**[probe]** film scene keys sent: `title, narration, visual_prompt, planned_seconds` — no `clip_params`.

**Fix (same PR):** a scene with dialogue is saved with `clip_params: {audio: true}`; a scene without stays as the film's default.
If the clip model has no sound variant, `quote_film` refuses with its own reason, which the card already shows; nothing is
substituted.

### G4 — Scenes longer than the clip model's longest shot are refused at the quote (medium)

`save_film` defaults `shot_count` to 1 (`0166_films_core.sql:945`); `filmFromBrief` never sets it. `quote_film` refuses a scene whose
`planned_seconds` exceeds the clip model's longest `durations_s` × `shot_count` (`0171_films_money.sql:736-752`). A 30 s scene with a
clip model that makes 10 s shots is a refused quote, and the person sees "cannot start" for a plan the Brain wrote.

**Fix (same PR):** the server reads the film's default clip model's `durations_s` (the catalogue the film route already reads) and
plans within it: `shot_count = ceil(planned / longest)` up to `max_shots` (3), and a scene never longer than `longest × max_shots`.
Unknown durations stay unknown: the scene is not split on a guess, and the quote's own refusal stands.

### G5 — `brief.price.nodes` is never filled, though `quote_film` itemises per scene (medium; contract field)

`quote_film` returns `scenes: [{scene_id, priced, credits}]` (`0171_films_money.sql:778`). The route keeps only the total
(`choose`, `price = {state, total_credits, …}`), so every draft clip node shows no number (correct under rule 5, but the contract's
`nodes` is never set). The scene ids are the film's uuids; the map BRIEF `s1` → film scene is in `save_film`'s answer (ordered).

**Fix (PR `claude/nsai-s1-price-nodes`):** map `save_film`'s scene ids, in order, back to BRIEF ids and attach `price.nodes[sN]`
only for a scene whose subtotal is `priced`. No contract change (the field already exists).

### G6 — A reference photo never becomes a character (medium; contract step 1)

`readScenario` always sets `asset_id: null, source: "prompt"` (`logic.ts:288-292`). The contract's "attach a reference photo →
`characters[].asset_id`, `source: upload`" through the rights/likeness/18+ gates (0174/0187/0192) has no path. Characters and
locations reach the film only as text folded into each prompt (`filmFromBrief`), which is the only option for prompt-only refs
(`film_save_refs` needs an `asset_id`, `0166_films_core.sql:848-859`), and is honest.

**Proposed:** a later PR, after G1–G4: an uploaded library image picked in the panel becomes a film ref `{kind: character, asset_id}`
in `save_film`; the gates stay the film route's. Needs no migration.

### G7 — The panel is not at the design bar (medium; UI)

`NightshiftAiPanel.tsx` is generic `studio-field` blocks: no numbered option chips, no monospace numbers, no per-step progress while a
plan is written (G2 makes planning take 30–90 s — a silent spinner there is a dead end), no reduced-motion handling. S5 tokens exist
in `app/tokens.css`. **Fix (PR `claude/nsai-s1-panel`)**, after the plan step, with Pixel.

### Not gaps (checked)

- Prices: only the server's; none shown until the backend computed one (`ReadyBlock`, `price.state`). ✔
- No browser spends: Create calls the film route's start with the server's quote id; the Brain holds nothing. ✔
- Long videos: a link to Run now, prefilled; its own priced button. ✔ (Out of S1's build scope beyond keeping it working.)

## Plan of PRs

1. `claude/nsai-s1-gaps` — this file.
2. `claude/nsai-s1-plan` — G1, G2, G3, G4: outlines → chapter-by-chapter storyboard → validated, makeable BRIEF. No migration
   expected (each plan call is an ordinary 0199 turn); if 0199's turn accounting cannot carry it, **0211** and a note to Atlas first.
3. `claude/nsai-s1-price-nodes` — G5.
4. `claude/nsai-s1-panel` — G7 (and G6 if it stays small).

Open questions to Atlas: the missing in-flight branches; whether `FilmCanvas`'s "Write the storyboard with AI" button (film editor,
not S1's file) should call the Brain's plan step once it exists.

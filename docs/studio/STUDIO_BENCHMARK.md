# Nightshift Studio: interaction benchmark

Date: 2026-11-14. Desk research on public, signed-out pages only: no accounts, no sign-in, no
generations, no form submits. The only clicks were on composer chips, tabs and FAQ accordions,
never on Generate. Fresh evidence (text dumps `*.txt`, screenshots `*.jpg`, 5.6 MB) is in
`research/studio-bench/`. Earlier work is reused, not redone: `film.md` (the 14-product study),
`higgsfield.md`, `creative.md`, `video-makers.md`, `youtube-auto.md`, `film-design.md` (our
spec) and `film-prototype.html`.

**Hedra is out of scope.** hedra.com now presents itself as "a research and infrastructure
company bringing frontier inference" (inference, model training, GPU sandboxes). Its docs cover
only a developer API, and `/app` goes straight to a sign-in page (`hedra-home.jpg`,
`hedra-docs.txt`, `hedra-app.txt`). There is no public studio to benchmark, so **Luma** takes its
place, as the brief allows.

Labels: **[V]** the vendor's own docs or help centre · **[O]** observed live in a signed-out
page this session (the screenshot is named) · **[B]** vendor marketing or blog · **[R]** third
party (including competitors reviewing each other) · **[P]** earlier study, section given ·
**UNVERIFIED** means we could not confirm it without signing in. Action counts come from the
documented steps; none were carried out end to end.

---

## 1. Interaction table: idea → finished multi-scene video

Sources are coded in square brackets and listed in §1.1.

| | **Higgsfield** (Cinema Studio 4.0, Canvas) | **Krea** (Seedance Studio, Agent, Nodes) | **Runway** (Agent, Final Cut) | **LTX Studio** | **Kling** (3.0 / 3.0 Omni) | **Pika** (Short Film, Video Studio) | **Luma** (Scenes, Agent), standing in for Hedra |
|---|---|---|---|---|---|---|---|
| **Steps from idea to film** | Cinema Studio: one prompt plus 5 chips (References 0/50, Film setup, Camera, Color palette, Lighting) and settings, then **Generate**. One generation is up to 30 s with cuts inside it ("Tempo") [HF-CL Aug 12] [O hf-cinema-app.jpg]. A longer film means repeating that, plus Extend forward or backward. Canvas has 6 documented steps: New canvas → prompt node → generation node → connect → Generate *on each node* → save template [HF-CV]. | Seedance Studio has 6 steps (Image/Video → describe → references → Camera/Scene/Color → Enter → refine) for **one** generation [KR-SS]. For many scenes you use either the Agent (brief → plan → "Approve when it asks before an expensive step" → files) [KR-AG] or Nodes. Neither has a storyboard. | 4 documented steps: one-sentence prompt → the Agent asks questions and plans → you say "proceed" → it generates, and multi-shot output is combined in the **Final Cut** tab [RW-AG]. | Upload a script (.txt) or a concept → **shot-breakdown preview where you merge, split or rewrite shots for free** → storyboard frames → Elements extracted → video per shot → timeline → MP4 or PDF deck [R LU-LTX] [P film.md §2.2]. 4 starting points: script, concept, image, video [B ltx-studio.txt]. | Per generation: the "Multi-Shot" switch → "Custom Multi-Shot" sets the number of shots and their durations; up to 15 s in one generation [KL-V3]. The web app is behind sign-in (`kling-app-video.jpg`). Agent canvas [P film.md §2.8]. | Short Film has 3 steps, "Set the story / Choose the look / Build the film". "The app will build everything else, from the script to storyboards to the final film" [O pika-short-film.jpg, FAQ]. Whether the storyboard can be reviewed before spend is UNVERIFIED. | Brief and/or references → a storyboard of keyframes "generated together" → regenerate, comment on or replace any keyframe → drag it in time → render with Ray 3.2 or Seedance 2 → export. "**Nothing renders before your approval.**" [LU-SC Aug 11] |
| **Where they wait** | Seedance 2.5 runs "in a shared queue, so speed depends on load" [HF-CL]. Unlimited plans: users report waits of minutes to hours [P film.md §2.1, U]. The progress UI is UNVERIFIED. | The Agent "shows its plan and its outputs as it works" [KR-AG]. Hunyuan nodes have "live previews" [KR-NO]. The progress UI is UNVERIFIED. | Everything from a session collects in a "Generations" grid [RW-AG]. The progress UI is UNVERIFIED. | LTX **Desktop**: "queue multiple generations… reorder or cancel jobs at any time", and monitor from a phone [LTX-RN Oct 9]. The web progress UI is UNVERIFIED. | UNVERIFIED (behind sign-in). | Vendor claim for H3 Flex: a 15 s clip "in as little as 7 seconds" [B PK-H3]. Short Film shows a 4-segment step bar [O pika-short-film.jpg]. | UNVERIFIED. |
| **Keeping characters consistent** | `@` Elements and up to 50 references [O hf-cinema-app.jpg]. On Canvas the same wire means different things per model: a Kling node takes a connected image as the **start frame**, and Seedance ignores it unless the prompt states its role [V HF-CV]. | **Elements**: up to 8 images and 400 characters of guidelines under one `@tag`. Per-model limits are listed, and Studio **asks before truncating** ("Remove other references, or truncate this element to X images") [V KR-EL]. A "custom look" turns a reference image into editable notes [KR-SS]. | Brand Kits, character and reference sheets made by the Agent [RW-AG]. | Elements: Character (which can have a voice), Object, Location, Style, Color (HEX); up to 10 references; `@Name`; they cannot be renamed [V LTX-EL]. | Elements from 2–4 images **or a 3–8 s video**, with **the voice bound to the element** [V KL-V3, KL-OM]. | Character Studio: a three-view sheet from one photo on a white background, with a voice field [O pika-character.jpg]. Video Studio takes up to 30 images, 10 videos and 10 audio files, `@`-mentioned [O pika-create-video.jpg]. | Keyframes are generated "in one context, so look, environment and spatial logic hold" [B LU-SC]. Uni-1 keeps brand references [B luma-dm]. |
| **Editing one shot** | Modal **tile pickers** with "Reset all": Lighting (Auto, Silhouette, Practicals, Window, Overhead fall, Contre jour, Soft cross, plus "New lighting preset"), Color palette (named presets), Film setup (Genre, Era, Tempo), Camera (Setup, Movement) [O hf-cs-lighting.jpg, hf-cs-color.txt, hf-cs-filmsetup.txt]. No preview of *your* shot inside the picker (signed out). Relight and Color Palette also work on an existing clip [HF-CL]. Draft mode: 480p first, then 1080p of the chosen draft with the same seed [HF-CL Sep 22]. | Camera → Setup: focal length 8–100 mm and f/1.4–f/11 **snap sliders, with the "preview updating as you adjust"**. Movement tiles **play on hover**. A **3D camera editor** with keyframes (position, aim, focal length, timing, easing) attaches its rendered path as a reference. **Annotate**: draw or comment on a frame [V KR-SS]. Nodes rerun only what is downstream [V KR-NO]. | Text edits that keep "the original motion and framing" (restyle, lighting, environment). **`@Agent` in a comment on an asset** posts the result in the thread [V RW-AG]. | **Retake** regenerates a 2–16 s segment [R LU-LTX]. Camera presets (dolly, pan, tilt, handheld, static); round trip through Gen Space. | Per-shot duration, framing, angle and camera in Custom Multi-Shot, which means regenerating the whole multi-shot clip [V KL-V3]. | An "Edit Video" tab, Swap Anything, Extend, Color Grade; H3 Flex edits by prompt or reference [O pika-create-video.jpg, B PK-H3]. | Regenerate, comment on or replace one keyframe; "the frames you've already approved stay exactly as they are" [B LU-SC]. Ray 3.2: up to 16 keyframes per clip, Reframe [B LU-R32]. |
| **Assembly** | Cinema Studio has no timeline (cuts happen inside one generation). Canvas is a graph [P film.md §2.1]. | A "Stitch Videos" node; the Agent "edit and assemble" step is UNVERIFIED. No timeline documented. | **Final Cut**: split, trim, track volume, add a media track, **undo/redo**; the Agent can also edit by chat [V RW-AG]. | Timeline Editor [B ltx-studio.txt]. Whether it exports XML is disputed: [P film.md] says XML on some workflows, while Luma's review says "no native connections to external editing software" [R LU-LTX]. UNVERIFIED. | None beyond the cuts inside a 15 s generation. | No timeline: apps are "self-contained tools" [B pika-home.txt]. Short Film assembles by itself. | Timing by dragging keyframes; audio is "produced separately" [R LU-FS]. |
| **Seeing the cost** | **Price on the key, re-priced live**: GENERATE 80 at 1080p/5 s became **35** after switching to 720p [O hf-cinema-app.jpg → hf-cs-720p-price.jpg]. No project total. Failed jobs are "refunded automatically" (changelog) [HF-CL Nov 2]. A "60% OFF" badge is permanently in the sidebar [O]. | Image and video tools show an estimate before a run, "stable while you type" [V KR-CL]. Nodes show the cost per node and "**nothing runs until you say go**" [V KR-NO]. MCP `preflight` returns `compute_units`, `is_estimated`, `affordable` [V KR-CL]. Signed out, the Seedance Studio composer shows **no** price [O krea-seedance-app.jpg]. With no compute left, the Agent stops before the next billable turn and keeps the draft [V KR-CR]. | **The default Generation mode is "Automatically generate"**: it spends right after planning. "Ask before generating media" (opt-in) shows model, prompt and estimated credits [V RW-AG]. Its marketing still says "Nothing runs without you" [B runway-product-agent.txt]. Agent messages cost **24–60 credits each**, depending on the chat model [V RW-AG]. Auto-duration jobs **hold the maximum and refund later**, which shows up as two lines in billing history [V RW-RF]. | Partner models "consume significantly more" [R LU-LTX]. Per-action display is UNVERIFIED. | UNVERIFIED (behind sign-in). | Video Studio key: "Start Generating **~122**" (a tilde estimate). H3 Flex shows "~10" with a **Draft Mode** toggle [O pika-create-video.jpg, pika-h3.txt]. **The Short Film key shows no price** [O pika-short-film.jpg]. | "Fix one scene, and it costs one scene" [B LU-SC]. Per-scene display is UNVERIFIED. |
| **Export / publish** | Download per clip. TikTok publishing through its MCP tools [P film.md §2.1]. **No YouTube.** Canvas autosaves "periodically"; its own help page lists "Canvas froze and I lost my work" [V HF-CV]. | Files panel and context library; sessions have no share link [V KR-AG]. No publish. | Upscale to 4K, download [V RW-AG]. No publish documented. | MP4, PDF pitch deck, project sharing [V LTX-SH]. No publish. | Download. No publish. | Download; H3 Flex exports **3 audio stems** (Dialogue, Music, Effect) [B PK-H3]. No publish. | Full clip, separate clips or Ray panels; HDR/EXR. Connectors to Figma, Frame.io and Google Ads [B luma-dm]. No YouTube. |
| **Notable trap** | The same wire means different things on different models (above). | "The agent retries most generation failures on its own" [V KR-AG]: the person never chose those retries. | Auto-spend by default; the agent "will always choose a model capable of fulfilling your request… regardless of your preference" [V RW-AG]. | Elements cannot be renamed, and deleting one is permanent [V LTX-EL]. | Dialogue in a language other than its 5 "**will be translated into English**" [V KL-V3]: a silent fallback that would hit uz and ru. | The one-shot film flow shows no price. | Luma's board organiser does it right: "Offer, then accept… Nothing moves until you say yes. Reverse any organizing run" [B LU-BM Nov 14]. |

**Two patterns where we would be first:** no competitor makes a *private YouTube upload with a
person's approval of the exact cut* the last step of a film flow [P film.md §3, row "Approval
gate"], and none blocks assembly while a scene is unresolved [P film.md §0.10]. Every product
above ends at a download.

### 1.1 Sources (all read on 2026-11-14; files are in `research/studio-bench/`)

| Code | URL | Local file |
|---|---|---|
| HF-CL | higgsfield.ai/creator-hub/changelog (Cinema Studio 4.0 Aug 12 2026; Seedance Draft Mode Sep 22 2026; Kling failures fix Nov 2 2026; Kling 4.0 Flash "exact price is on the Generate button") | `higgsfield-changelog.txt` |
| HF-CV | higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-canvas (Aug 1 2026) | `hf-canvas-help.txt` |
| hf-cs-* | higgsfield.ai/cinema-studio, signed out: chips, panels, resolution menu, price on the key | `hf-cinema-app.jpg`, `hf-cs-lighting.jpg`, `hf-cs-720p-price.jpg`, `hf-cs-*.txt` |
| KR-SS | krea.ai/docs/user-guide/features/seedance-studio | `krea-seedance-guide.txt`, live UI `krea-seedance-app.jpg`, `krea-ss-3dcam.jpg` |
| KR-EL | krea.ai/docs/user-guide/features/elements | `krea-elements-guide.txt` |
| KR-AG / KR-CR | krea.ai/docs/user-guide/agent/overview · /agent/plans-and-credits | `krea-agent.txt`, `krea-agent-credits.txt` |
| KR-NO | krea.ai/docs/user-guide/features/nodes | `krea-nodes.txt` |
| KR-CL | krea.ai/docs/changelog (cost estimate before runs; MCP preflight; Seedance Studio; tools open without a login wall) | `krea-changelog.txt` |
| RW-AG | help.runwayml.com/hc/en-us/articles/51601639579667-Creating-with-Runway-Agent | `runway-agent-doc.txt` |
| RW-RF | help.runwayml.com/…/55412733862675-Why-do-I-see-a-charge-and-a-refund-for-the-same-generation | `runway-refund.txt` |
| RW-CR | help.runwayml.com/…/15124877443219-How-do-credits-work (auto refill "so generation continues without interruption") | `runway-credits.txt` |
| runway-product-agent | runway.com/product/agent | `runway-product-agent.txt/.jpg` |
| LTX-RN | ltx.io/release-notes (LTX Desktop, Oct 9 2026) | `ltx-release.txt` |
| LTX-EL / LTX-SH | help.ltx.io Introduction to Elements · Sharing your project | `ltx-elements.txt`, `ltx-sharing.txt` |
| ltx-studio | ltx.io/studio (signed-out tabs: Dynamic Storyboard, Timeline Editor) | `ltx-studio.txt`, `ltx-tab-*.jpg` |
| LU-LTX | lumalabs.ai/news/ltx-studio-review (Sep 15 2026; a competitor reviewing LTX, so read with care) | `luma-ltx-review.txt` |
| KL-V3 / KL-OM | kling.ai/quickstart/klingai-video-3-model-user-guide · …-video-3-omni-model-user-guide (Feb 6 2026) | `kling-v3.txt`, `kling-omni.txt`; app sign-in wall `kling-app-video.jpg` |
| PK-* | pika.art/apps/short-film · /apps/create-video · /apps/pika-h3-flex · /apps/character-studio | `pika-short-film.jpg`, `pika-create-video.jpg`, `pika-h3.txt`, `pika-character.jpg` |
| LU-SC | lumalabs.ai/news/introducing-luma-scenes (Aug 11 2026) | `luma-scenes.txt` |
| LU-FS | lumalabs.ai/news/google-flow-scenebuilder-vs-luma-scenes | `luma-flow-vs-scenes.txt` |
| LU-BM | lumalabs.ai/news/ai-board-manager (Nov 14 2026) | `luma-board-manager.txt` |
| LU-R32 | lumalabs.ai/news/introducing-ray-3-2 (Jun 9 2026) | `luma-ray32.txt` |
| luma-dm | lumalabs.ai/dream-machine → lumalabs.ai/app | `luma-dm.txt/.jpg` |
| Hedra | hedra.com · hedra.com/docs · hedra.com/app | `hedra-home.jpg`, `hedra-docs.txt`, `hedra-app.txt` |

---

## 2. "Must beat" list (25 testable requirements)

Each requirement is held to our honesty rules: a price appears only when the backend quoted it,
progress comes only from real job events, no model, voice or language is ever substituted
silently, and nothing goes public without a person (CLAUDE.md rules 2–5).

| # | Requirement | Competitor pattern it beats | How we measure it |
|---|---|---|---|
| 1 | **Topic to a visible storyboard in ≤ 2 actions** (type or paste, then "Split into scenes"). The first cell appears ≤ 3 s after the click and the cells stream in reading order. | Runway's Agent asks questions before it plans [RW-AG]; LTX needs a .txt upload, then a breakdown; Pika Short Film builds the film before you see a board. | E2E counts the actions. Time to first cell is the server event timestamp minus the click, p75 under 3 s. |
| 2 | **The board is free and fully editable before any spend**: split, merge, insert, delete, rewrite and retime a scene. | LTX lets you merge or split before generating [R LU-LTX], and Luma approves before rendering [LU-SC]; we match both. We beat Runway's auto-generate default [RW-AG] and Pika Short Film's one-shot flow. | An integration test performs 20 board edits and then asserts **zero** ledger holds or captures. |
| 3 | **Reorder scenes by drag, by keyboard (Alt+↑/↓) and by touch long-press**, with an announcement ("Scene 4 moved to position 2") and undo. | Flow SceneBuilder and Runway Final Cut reorder only *after* generating, and only with a pointer [LU-FS, RW-AG]. | A Playwright test reorders keyboard-only; axe reports no violations; the live region text is asserted. |
| 4 | **A whole-film quote before any spend**: a price per scene, the total, and "with retakes" labelled as an assumption. The Start key carries the total. | Higgsfield prices one generation at a time [O hf-cs-720p-price.jpg]; Runway holds the maximum and refunds later [RW-RF]; Pika shows a "~" estimate per generation and none on Short Film [O]. Krea prices per node only [KR-NO]. | Every rendered price links to a `quote_id`. With no quote, the copy reads "not priced" and the key is disabled (test). |
| 5 | **Every paid key shows its own price and re-prices within 300 ms (p95) of a setting change**, from a backend quote, with the change shown ("+21 cr"). | Higgsfield swaps 80 for 35 without saying what changed [O]; Pika shows a tilde estimate [O]. | A test changes the resolution and asserts that the key value equals the API quote; latency is measured in the browser. |
| 6 | **Spending always waits for a person.** There is no "auto-generate" setting anywhere in the Studio; Start, Retry and Re-shoot are the only things that create a hold. | Runway's default is "Automatically generate" [RW-AG]; Krea's Agent API "approves cost prompts automatically" [KR-CL]; Krea's agent retries failures on its own [KR-AG]. | A code audit plus a test: no client path creates a hold without a Start, Retry or Re-shoot request row signed by the user. |
| 7 | **A budget cap per film**: when the next step would cross it, the run pauses and asks. It never lowers the resolution or switches model to fit. | Runway's auto refill [RW-CR] and Magnific's "41,000 credits without warning" [P film.md §2.4]. | A test crosses the cap: state becomes `paused_budget`, no new hold is made, and the model and resolution are unchanged. |
| 8 | **Live per-scene progress from real state**: queue position, stage (key frame or clip), elapsed time, and an estimate marked "~" with its basis. No indeterminate spinner. | Higgsfield's "speed depends on load" [HF-CL]; the others were UNVERIFIED and show no documented per-scene states. | Every progress value maps to a stored job event. A lint rule bans the spinner component in `studio/`. Progress never moves backwards and never shows 100% before the provider reports done. |
| 9 | **Approve scene 2 while scene 9 renders** (parallel lanes; risky scenes first, as an option). | Pika's Short Film is one block [O]; Runway's Agent works through steps in chat [RW-AG]. | E2E approves a take while another job is running and asserts both states. |
| 10 | **Survives refresh, a closed tab or an expired session**: after reload the same state is back within 1 s, from the server. | Higgsfield Canvas autosaves "periodically", and its help page lists "lost my work" [HF-CV]. | E2E reloads mid-job, closes and reopens the tab, and compares a snapshot of the DOM state. |
| 11 | **Re-shooting one scene never changes its neighbours**: the sha256 of every other take is unchanged. | The "fixing shot three changes the actor's face" leak [P film.md §2.2]; Kling's Custom Multi-Shot regenerates every shot in the clip [KL-V3]. We match Luma's "approved frames stay exactly as they are" [LU-SC]. | Hash test before and after a re-shoot. |
| 12 | **Change camera or light on one shot, with a before/after compare** (a wipe you can drag or move with arrow keys), a framing preview labelled "not a render", and the price on the re-shoot key. Relighting keeps the existing motion. | Higgsfield's tile pickers show no preview of your shot [O hf-cs-lighting.jpg]; we match Krea's focal-length slider preview [KR-SS]. | The compare control works by keyboard (arrows move 5%). The preview updates in one frame. The re-shoot key's price equals the quote. |
| 13 | **A take stack**: every take is kept, any two can be compared, one is approved with one key (`A`), and going back to an earlier take takes one action. | Krea, Pika and Higgsfield show a flat feed of results [KR-SS, O]. | E2E: compare takes 1 and 3, approve 3, revert to 1; assembly then reads the approved take. |
| 14 | **Consistency you can see**: no video spend until the cast is approved. Every reference has a stated role. Model limits are shown *before* attaching, with no silent truncation. Each scene shows "identity: 0.91 measured" or "not checked". | Higgsfield wires mean different things per model [HF-CV]; LTX "compatibility varies by model" [P film.md §2.2]. We match Krea's "asks before truncating" [KR-EL]. | Adapter tests per model; the UI never shows an identity number without a stored measurement. |
| 15 | **A failure shows its class, the remedy and the refunded amount on the scene card**, within 5 s of the provider event, with "Retry \| price". | Runway's refund appears only as a line in billing history [RW-RF]; Higgsfield says "refunded automatically" in its changelog [HF-CL]; Krea retries silently [KR-AG]. | Each failure class maps to its copy (unit test); time from failure event to rendered card; any auto-retry is bounded and named on the card. |
| 16 | **No silent model, voice or language substitution.** If what was chosen is unavailable, the run stops and says what to do. Narration is never translated by the model. | Kling translates unsupported dialogue into English [KL-V3]; Runway's agent picks a model "regardless of your preference" [RW-AG]. | A test makes the provider unavailable: the run reaches `stopped` with a remedy, and there is no take from another model. |
| 17 | **One action to assemble once every scene is approved.** Until then the key is disabled and names the unresolved scenes. A rough cut plays at any time, with placeholders labelled. | Higgsfield, Pika and Kling have no long-form assembly [P film.md §3]; LTX's export goes elsewhere [R LU-LTX]. | E2E with one failed scene: the key is disabled and names it. Placeholders cannot be exported. |
| 18 | **Narration is the clock.** Scene boundaries snap to word gaps in the narration; `J/K/L` and Space scrub and play; a click on a block seeks. | Luma drags keyframes with no audio track [LU-FS]; Runway's Final Cut splits and trims by hand [RW-AG]. | Unit test of snapping to word timings; keyboard E2E on the transport. |
| 19 | **Undo and redo for every board and timeline edit** (Ctrl/Cmd+Z, ≥ 50 steps, saved on the server), never for a spend. | Runway's undo works only in Final Cut [RW-AG]; Luma's organiser is reversible [LU-BM]; LTX element deletion is permanent [LTX-EL]. | E2E: 50 edits, undo all of them, and the result matches the original board. |
| 20 | **Directions in plain language land as visible, undoable diffs** ("make scene 4 warmer" turns into a highlighted change plus a price chip). They never spend on their own. | Runway's `@Agent` in a comment *runs* the edit [RW-AG]; Krea's Agent approves inside chat. | Test: a direction creates a draft diff with zero holds, and spending requires the re-shoot key. |
| 21 | **A draft pass, only where the backend prices one**: draft every scene cheaply, then upgrade the chosen ones, keeping the seed. Both prices are shown. | Higgsfield's Seedance Draft Mode [HF-CL Sep 22] and Pika's Draft Mode [O pika-h3.txt] work one clip at a time. | Shown only when the quote API returns a draft price; the upgrade reuses the stored params and seed (test). |
| 22 | **One flow to a private YouTube upload with approval**: from the assembled cut to "Private on YouTube (read back)" in ≤ 2 actions; "Approve this exact cut" binds to the sha256, and a re-shoot voids it. | Nobody does this. Everyone ends at a download, InVideo publishes publicly [P film.md §2.12], and Higgsfield publishes to TikTok [P film.md §2.1]. | E2E against a mocked YouTube API: privacy read back `private`; the approval row carries the cut's sha256; any re-shoot clears the approval. |
| 23 | **The core loop works on a phone**: board, compare takes, approve, and the approval panel, at 360 px. | Krea's Seedance Studio is "currently available on desktop" [KR-SS]; Kling's recorded elements are "APP only" [KL-V3]. | Playwright at 360 × 800: no horizontal overflow in en/ru/uz × every state, and targets of at least 44 px. |
| 24 | **The film's language is separate from the interface language**; voices that cannot speak the film's language are shown disabled with the reason. | Kling supports 5 dialogue languages and translates the rest [KL-V3]; no competitor separates the two. | A test with film = uz: every voice without uz is `aria-disabled` with a reason. |
| 25 | **Fast on a mid-range phone**: INP < 100 ms with 60 scenes, a 60-scene board scrolls without long tasks over 50 ms, and route JS ≤ 180 KB gz. | Not measured for competitors, so this is a floor, not a comparison. | Lighthouse and WebPageTest on a Moto G-class profile; the Long Animation Frames API in E2E. |

---

## 3. "Feels like the future" interactions (13)

Every one of these has a reduced-motion version (instant, with the state still legible), works
from the keyboard, and costs nothing while idle. None adds a wait.

| # | Interaction | Where | Web tech and budget | Why it beats competitors |
|---|---|---|---|---|
| F1 | **The sentence becomes the card.** As the agent writes the storyboard, each scene's sentence in the composer lifts out and morphs into its film cell. | Idea → Storyboard | View Transitions API (`view-transition-name` per scene), streamed rows over Supabase Realtime. Falls back to a fade. | LTX and Pika show a breakdown only after a wait. Here you watch your own words become the plan, so the link between script and scene is obvious. |
| F2 | **Light-wipe compare.** A draggable seam drawn as a thin beam splits take A from take B (or before and after relight). Arrow keys move it 5%, `\` swaps the sides, and double-click flips between them. | Rig, take stack, relight | CSS `clip-path: inset()` driven by one custom property; no canvas. | Higgsfield's tile modals show no result of your own shot. A wipe is the fastest way to judge a small change. |
| F3 | **Price delta ticker.** When a setting changes, the key's figure rolls to the new quote (tabular figures) and a small "+21 cr" floats off for 1.2 s. The scene chip and the HUD total change in the same frame. | Every paid key, HUD | CSS counter animation on the digits; the value comes only from the quote response. Under reduced motion the figure changes and the delta stays as text. | Higgsfield silently swaps 80 for 35. Seeing the *difference* teaches the cost of each setting. |
| F4 | **Zoom through levels**: film → scene → take. The cell grows into the inspector or screen, and Back shrinks it home. | Board ↔ scene detail ↔ take | A View Transitions shared-element morph; the URL holds the level (`/studio/{film}/scene/{n}`). | Higgsfield and Krea open modals that hide the context. Here you never lose your place in the film. |
| F5 | **Lift and part.** A scene picked up to reorder lifts (scale 1.03, deeper shadow); the others slide apart and an amber insertion beam marks the drop. Alt+↑/↓ plays the same animation. | Board, timeline strip | FLIP with `transform` only; a 10 ms `navigator.vibrate` on pick-up on Android, off with reduced motion. | Competitors reorder only after generating, or not at all. This makes structure feel like a physical thing you hold. |
| F6 | **Magnetic narration.** Dragging a scene boundary snaps to the gaps between words; the word under the boundary lights up and its syllable plays (≤ 300 ms). | Timeline voice track | Precomputed word timings; Web Audio `AudioBufferSourceNode` for the snippet, muted by default. | Luma drags keyframes with no audio. Cutting on the word is what editors do by hand. |
| F7 | **Ignition wave** (in the spec). On Start, a violet wave crosses the queued cells in reading order, then the run begins. It plays once, never loops. | Price HUD → board | Already in the spec. One staggered CSS animation. | Spending is the most important moment and the only one that should feel heavy. Nobody else marks it. |
| F8 | **Queue telemetry on the cell.** A queued cell shows "#3 in queue" counting down from real queue events; a running cell's scanline sits at the real progress (in the spec). | Film cells | Values in CSS custom properties patched by one rAF loop that stops when idle (spec §10). | "Speed depends on load" [HF-CL] is all a competitor tells you. A real position is calmer than any spinner. |
| F9 | **Sonic status (opt-in).** Three short synthesized tones, for scene ready, decision needed and failed. Never for progress ticks. Off by default, and always paired with the polite or assertive live region. | Global | Web Audio oscillators, under 1 KB, no files. | Lets the operator look away during a 20-minute render. No competitor tells you when it needs you. |
| F10 | **The tab works as a monitor.** The title and favicon badge read "3/10 ready · Film". With permission, a system notification arrives only when a decision is needed. | Global | `document.title`, a canvas favicon, the Notifications API; driven by the same events. | The others assume you keep watching the tab. |
| F11 | **Diff halo.** After a direction, bulk edit or undo, the changed fields glow amber for 900 ms, and a "3 changes" pill lists each change with its own undo. | Board, inspector | CSS outline animation; the diff is computed on the server. | Luma's organiser "tells you what changed" [LU-BM]; we do it for every edit, so an agent's work stays visible. |
| F12 | **Hover-scrub filmstrip.** Moving the pointer across a ready cell scrubs its take; `,` and `.` step frames on the focused cell. | Ready cells, take stack | One 480p sprite sheet per take (background-position), no video decode. | Krea's hover-play tiles stream whole videos. A sprite is lighter on a mid-range phone and still lets you inspect motion. |
| F13 | **The cut seal with a validity ring** (in the spec). The sha256 fingerprint ring closes on approval, and an outer amber arc counts down the 24-hour hold. | Approval panel | SVG stroke-dashoffset, updated once a minute. | Nobody else has an approval step. This makes "this exact cut, until then" readable at a glance. |

**Rejected as gimmicks:** a full WebGL 3D scene for the board (it breaks the 180 KB budget and
hurts INP on phones), particles, hover-autoplay of real clips across the board, voice-only
control, and any "AI thinking" animation that is not tied to an event.

---

## 4. Gap check against `film-design.md` and `film-prototype.html`

### 4.1 Already matches or leads

- **Board before burn**, nothing rendered until Start, price on the Start key, and per-scene
  price chips (spec §8.2–8.3; prototype `board-1440-dark.png`). This leads Runway (auto by
  default) and Pika Short Film (no price on the key).
- **A quote with the retake assumption labelled** (§8.3). No competitor quotes a whole project.
- **Progress as position, lamps instead of spinners, `~` estimates with their basis** (§5, §8.2).
- **Failure with class, remedy, refund amount, and Retry with its price** (§8.8). This leads
  everyone.
- **A camera rig with a framing preview labelled "not a render", lens, motion, a light dial,
  A/B and a live re-price** (§8.4). This leads Higgsfield's preset tiles and matches Krea's
  slider preview.
- **A voice picker that disables voices which cannot speak the film's language, with the rule-4
  copy** (§8.5), and film language kept apart from UI language. This leads Kling.
- **The approval moment**: the sha256 seal, private read-back, the "publish when approved"
  switch shown as admin-only and off (§8.6). No competitor has one.
- **Accessibility and phone layout**: the listbox with roving tabindex, reduced motion and
  reduced transparency, checked at 360 px in en/ru/uz.

### 4.2 Missing or weaker (ranked by how much they hurt the "more convenient, more interactive" brief)

| Gap | Where it shows | What to add | Must-beat # |
|---|---|---|---|
| **The board cannot be edited.** There is no split, merge, insert, delete or rewrite of a scene, and **no reorder** (no drag handlers; the prototype's only `data-act`s are rig/quote/play/start/lock/…). The spec never mentions reorder. | Spec §8.2, prototype | Scene actions on each cell and in the inspector; drag, Alt+↑/↓ and long-press reorder; F5 | 2, 3 |
| **No undo or redo**, and no edit history (0 matches in the prototype). | Both | A server-side command log; Ctrl/Cmd+Z; F11 | 19 |
| **No budget cap UI.** The spec only says "in production, add a per-film budget cap" (§8.3). | Spec §8.3 | A cap field in the quote details and a "paused at cap" dialog with the shortfall | 7 |
| **Take stack is thin.** A cell shows "Take 2", and the rig has a side-by-side A/B, but there is no list of takes, no way to compare *any* two, no revert, and no wipe. | §8.2, §8.4 | A take-stack strip in the scene inspector; F2 wipe; F12 scrub | 12, 13 |
| **Consistency is cosmetic.** "Kept consistent: Aziza · Coach Bek · Neon chrome" chips have no cast gate, no reference roles, no per-model limits and no identity badge. | Prototype header, spec | A cast panel (sheet, roles, `@tag`), model-limit warning before attaching, "identity: measured / not checked" | 14 |
| **The timeline is read-mostly.** Clicking a block seeks, but there is no boundary drag, no snapping to narration, and no `J/K/L` (0 matches). | §8.7 | Draggable boundaries snapping to word timings; `J/K/L`; F6 | 18 |
| **Progress is simulated, and the realtime contract is not specified.** No queue position or elapsed time, and nothing shows that state survives a reload (deep links only). | §8.2, prototype | Specify the event schema (`queued{pos}`, `stage`, `elapsed`, `estimate{basis}`) and the reconnect behaviour; F8 | 8, 10 |
| **Step order conflicts with our own blueprint.** `film.md` §6.1 puts **narration first** (audio is the clock), but the flight track goes Idea → Storyboard → **Sound** → Shoot. | Spec §8.1 | Either generate narration timings during Split (cheap) or explain why sound comes later; durations must come from narration before the quote | 18, 4 |
| **No natural-language direction** and no command bar (Ctrl/Cmd+K), unlike `film.md` §6.2 ("Director" side panel). | Both | A command bar that produces priced, undoable diffs | 20 |
| **No attention features.** The tab title, favicon and notifications are unused (0 matches). | Both | F9, F10 | 9 |
| **No motion between levels.** Board, inspector and screen swap rather than morph (no View Transitions). | Both | F1, F4 | 1 |
| **No draft tier.** | Spec | Show it only when the backend prices drafts | 21 |
| **No pre-flight panel.** Only the Start key's disabled reason exists (voice). `film.md` §6.1 step 0 checks keys, models, voice, balance and YouTube connection before anything is spent. | Prototype | A pre-flight strip at the Idea step, with a remedy per check (rule 6) | 16 |
| **Export is YouTube only.** There is no download of the review copy, SRT or per-scene clips. Luma exports separate clips and Pika exports stems [LU-SC, PK-H3]. | §8.6 | "Download review copy / captions (SRT) / scene clips", which spends nothing | (new, low) |
| **No annotate-on-frame or comments.** Krea annotates frames and Runway takes `@Agent` comments [KR-SS, RW-AG]. | Both | Pin a note to a frame or time; it can feed a direction (rule 3: a row, not a run) | 20 |

### 4.3 Things *not* to copy, confirmed again this session

Auto-generate as the default (Runway); agents that retry failures silently (Krea); per-message
chat fees that are not in the quote (Runway, 24–60 credits); hold-the-maximum with the refund
visible only in billing history (Runway); language fallback to English (Kling); a permanent
discount badge in the work surface (Higgsfield "60% OFF"); and periodic autosave (Higgsfield
Canvas).

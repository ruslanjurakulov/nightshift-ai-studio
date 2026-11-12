> Status (2026-11-12): phase 1 merged in PR #690; phases 2 and 4 are in progress.

# Premiere parity plan: Adobe Premiere 27.0 vs the NIGHTSHIFT web editor (2026-11-12)

Research and code audit only. Nothing in the repository was changed and no PR was opened. Nothing was bought, and no
account was logged into. Adobe's pages were read as data.

- **Benchmark.** Adobe Premiere on desktop **27.0** (November 2026). Adobe now calls the product "Adobe Premiere", and its
  help moved from `helpx.adobe.com/premiere-pro/` to `helpx.adobe.com/premiere/desktop/`. The old user-guide URL
  redirects into the new tree.
- **Our editor.** `ruslanjurakulov/nightshift-ai-studio`, `main` at `413432e` (re-fetched 2026-11-12 after #680, #683, #685, #686 and #687 merged). It was a shallow clone, deleted afterwards.
  `cc/` below means `command-center/`.
- **Companion file.** `premiere-parity.json` holds section B in machine-readable form (316 rows) and sits next to this one.

---

## 0. Sources and method

### 0.1 Adobe (official pages only)

| What | URL | Used for |
|---|---|---|
| User guide table of contents | https://helpx.adobe.com/premiere-pro/user-guide.html (redirects into `helpx.adobe.com/premiere/desktop/`) | The full list of ~800 topic pages. Every row in section A links to one of them; a script checked each link against this list. |
| What's new (27.0, 26.5, 26.3, 26.2, 26.0; last updated 2026-11-10) | https://helpx.adobe.com/premiere/desktop/whats-new/whats-new.html | Latest features: Color Mode, AI Assistant, Generative Media Tool (image, music, soundscape), generated music and SFX, Generate Soundscape, Enhance Audio, Separate Crosstalk, auto-updating Auto Ducking, the Effects panel with previews, 8 new effects, Properties panel effect cards, HSL masking, Object Mask improvements, Generative Extend for transitions, live record waveforms, Speed/Duration with audio stretching (27.0); Generative Media Tool, Paper Edit, Object Mask smoothness, Lens Flare, Generative Extend 360p–4K (26.5); Firefly Boards to sequence, single-word captions, Shape Dissolve, Magnify (26.3); Film Impact effects and transitions, Sharp/Smooth object masks, Source Monitor waveforms, Sequence Index, Global Mute, marker search, Content Credentials (26.2); Object Masking, redesigned shape masks, transition handles (26.0) |
| Modern effects list | https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/effects.html | Effects by category: Blur & Sharpen, Color Correction, Distort, Generate, Immersive Video, Keying, Lights & Glows, Noise & Grain, Perspective, Stylize, Time, Transform, Utility, "Surprise Me" |
| Modern transitions list | https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html | Animation, Dissolve, Grunge & Distort, Immersive, Lights & Blurs, Slide, Smart Tools, Text, Transformers, Wipe |
| Modern animations | https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/animations.html | Motion Impacts (Pull, Block, Travel, Spin, Flip, Spring, Pop, Fold), Typewriter |
| Audio effects library | https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html | Amplitude and compression, delay and echo, filter and EQ, modulation, noise reduction and restoration, reverb, special, stereo imagery, time and pitch |
| Default keyboard shortcuts | https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html | I, O, `,` insert, `.` overwrite, `;` lift, `'` extract, M marker, Ctrl+K add edit, E extend edit, S snap, Ctrl+L link, F match frame, Enter render, Ctrl+M export. The tool-letter shortcuts (V, A, B, N, R, C, Y, U) were **not on the pages that were read**, so they are not cited as Adobe-confirmed. |
| AI Assistant overview | https://helpx.adobe.com/premiere/desktop/premiere-ai-assistant/overview.html | Organises bins, labels and renames; transcripts, slate detection, markers; stringouts and rough assemblies; captions, effects, reframes, masks and grades; custom skills; references in prompts; uses Firefly generative credits; does not change the workspace layout |
| Generative Extend overview | https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html | Extends the start or end of a clip, never both, and also fills missing transition frames. 360p to 4K UHD, 12–60 fps sources (above 30 fps it generates at 30). No dialogue, no music clips, mono or stereo only. |
| Media intelligence FAQ | https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/media-intelligence-and-search-panel.html | Local, on-device natural-language visual search. Transcripts are searched as exact text. No OCR and no identification of people. |
| Translate captions | https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/translate-captions.html | Translation uses a cloud service and third-party models (Google Translate, Microsoft Translator) and makes a new caption track. **The page does not say whether Uzbek is supported.** |
| Color Mode basics | https://helpx.adobe.com/premiere/desktop/correct-color/color-mode-fundamentals/color-mode-basics.html | Clip Grid (filter, sort, copy/paste, groups), Color Controls panel, Color Monitor (sequence/clip playback, solo), Auto Color, style modules (Midtones, Variable Vibrance, Film Color, Vignette), tone mapping, HLG/PQ output |
| Available Lumetri Scopes | https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/available-lumetri-scopes.html | Vectorscope YUV, Histogram, Parade, Waveform. This comes from the page description; the scope options were not on the page that was read. |

Each other row in section A cites its own Adobe topic page. The existence of every page was checked against the table of
contents, and the description of each one comes from its title and its place in that table. Fourteen pages were opened in
full or queried, listed above. **No third-party blog was needed.** Every feature here was found in Adobe's own table of
contents or release notes.

### 0.2 Our side (code read)

- `cc/lib/editor.ts`: model, validator, operations.
- Every file in `cc/components/editor/*`.
- `cc/lib/editor-shortcuts.ts`, `editor-timeline-view.ts`, `editorSilence.ts`, `editorSettle.ts`, `editorMotion.ts`, `captions.ts`.
- `modules/timeline.py`, `render_spec.py`, `render_backend.py`, `editor_export.py`, `media_library.py`, `hires_export.py`.
- `schemas/timeline.schema.json`, `schemas/export_presets.json`, `schemas/model_registry.json`.
- Migrations 0049, 0054, 0129, 0132, 0136 and 0137.
- `docs/editor-render-fields.md` §1–16 and `docs/HIRES_EXPORT.md`.
- The earlier CapCut/InShot report: `scratchpad/editor-parity.md`. Since that report, parity 1, 2a, 2b, voice-over, the
  follow-ups and paid export have landed, and its rows were re-checked against `413432e`.

**Merged since the first pass, re-checked before any gap was marked:**

- **#680 editor parity 2b.** The `fx` pack (glitch, shake, rgb_split, flash), `anim_in`/`anim_out` on V clips (fade,
  slides, zoom), "apply this cross-fade to all cuts" and beat markers (drawn and snapped to, not stored). See
  `docs/editor-render-fields.md` §16. Rows TE19, TE20, FX11, FX14, FX16, TR05, TR06, TR09 and AU14 were updated.
- **#679 and #683, the follow-ups.**
  - One-frame split minimum.
  - The two splitters now leave abutting halves.
  - Split fades that both validators accept.
  - Org switch as a form post, and silence cuts made at source times.
- **#685 / migration 0136.** Paid export up to 1080p, and speed curves sold at their rendered length. Together with
  0132 this covers 1440p and 4K (row EX14).
- **#686 / migration 0137, Character Studio.** Swaps the people in a member's video for characters, through Kling or
  BytePlus. It is dark and not on sale. It is used in section C3.
- **#687 / 0138, the operator Customers page.** It has no editor impact.

### 0.3 How to read the matrix

- **Ours:**
  - **have**: seen working in our code. The file and line are cited.
  - **partial**: part of it exists, and the gap is named.
  - **missing**: not found in our code.
  - Nothing is marked "have" without a citation.
- **Feasibility:**
  - **browser**: pure document or UI work, or analysis in the tab (the silence-detection precedent).
  - **server ffmpeg**: a change to the render path under the 2 GiB limit and the render-time budget
    `min(5400, 3 × length + 120)` s.
  - **first-party AI API**: needs a model's own maker's API, with credits by hold and capture.
  - **not for the web**: hardware, VR, camera RAW and the like.
- **Effort:**
  - S: 1–2 days.
  - M: about a week.
  - L: 2–3 weeks.
  - XL: more than 3 weeks, or several PRs.
  - Every size includes the paired Python and TypeScript validators and the tests that the editor's rules require.
- **Priority** is by value to short-form/social and YouTube creators:
  - P0: must have.
  - P1: high.
  - P2: useful.
  - P3: low or out of scope.
- **Duplicate rows.** Rows AI08–AI16 repeat a feature from another area so that the AI view is complete. They are marked
  "See …" and are counted apart.

---

## 1. Summary

### 1.1 Counts (316 rows, 307 unique features)

- **All 316 rows:** have 34, partial 121, missing 161.
- **307 unique features** (leaving out the 9 "See …" rows): have 34, partial 119, missing 154.
- **By priority (all rows):** P0 17, P1 63, P2 108, P3 128.

| Area | Items | have | partial | missing | P0 | P1 |
|---|---|---|---|---|---|---|
| WS Workspaces and panels | 30 | 3 | 14 | 13 | 2 | 6 |
| PM Project and media management | 29 | 2 | 13 | 14 | 0 | 2 |
| SQ Sequences | 19 | 2 | 6 | 11 | 2 | 3 |
| TE Timeline editing | 34 | 9 | 10 | 15 | 0 | 8 |
| TB Text-based editing | 7 | 1 | 1 | 5 | 2 | 0 |
| FX Effects | 19 | 1 | 9 | 9 | 0 | 4 |
| TR Transitions | 14 | 0 | 9 | 5 | 0 | 4 |
| KF Keyframes | 6 | 0 | 1 | 5 | 2 | 1 |
| MK Masks and compositing | 11 | 0 | 3 | 8 | 0 | 4 |
| MO Motion and time | 11 | 4 | 7 | 0 | 2 | 2 |
| GR Graphics and titles | 18 | 1 | 6 | 11 | 0 | 5 |
| CA Captions | 10 | 4 | 4 | 2 | 2 | 3 |
| CO Colour | 18 | 1 | 4 | 13 | 0 | 2 |
| AU Audio | 29 | 4 | 10 | 15 | 0 | 4 |
| AI AI features (Sensei and Firefly) | 18 | 0 | 8 | 10 | 4 | 6 |
| PB Playback and preview | 15 | 0 | 3 | 12 | 1 | 2 |
| EX Export | 15 | 1 | 8 | 6 | 0 | 3 |
| CL Collaboration | 9 | 0 | 4 | 5 | 0 | 3 |
| KS Shortcuts and workspaces | 4 | 1 | 1 | 2 | 0 | 1 |
| **All** | **316** | **34** | **121** | **161** | **17** | **63** |

### 1.2 Where we stand

- **Already at or near Premiere's level.**
  - Ripple, razor, trim and snapping on a magnetic picture lane.
  - Speed from 0.1x to 10x with pitch kept, speed ramps, optical-flow slow motion, freeze and reverse.
  - Warp-style stabilisation.
  - Crop, free angle, flips, Ken Burns.
  - Grade, temperature, tint, hue and tone curves; shape masks.
  - Chroma key on overlays.
  - Captions with 10 animated styles, SRT/VTT import and export.
  - Auto ducking, loudness normalisation, denoise.
  - Voice-over recording and silence removal.
  - The 2b effects pack and clip entrance/exit animations.
  - Multi-ratio and hi-res export.
- **What separates us from Premiere is architecture, not tools.** We have:
  - one picture lane (`modules/timeline.py:59-60, 844`) plus at most 16 silent overlays;
  - two-point, linear keyframes;
  - a fixed effect order with one instance of each effect;
  - no markers stored;
  - an approximate CSS preview (`cc/components/editor/TimelineEditor.tsx:1456-1620`);
  - no Source Monitor or I/O marks;
  - no mixer;
  - H.264 MP4 only.
- **Premiere 27.0 has moved hard into AI.** It now ships an AI Assistant, a Generative Media Tool on the timeline,
  generated music, SFX and soundscapes, object masks with tracking, Generative Extend and caption translation. Our
  first-party model registry and hold-and-capture credits could match most of these. Today none of our AI editing
  operations is sellable (see `editor-parity.md`), and auto-captions, the key to text-based editing, are built but dark.

### 1.3 Top 20 gaps, ranked by user value divided by build effort

Value runs P0 = 4 to P3 = 1, and effort runs S = 1, M = 2, L = 3, XL = 5. Related rows are merged, and ties are broken by
how many later features each gap unblocks. "No migration" means the database's `editor_doc_problem` only checks
`asset_id` and size (0054), so a new optional document field needs no SQL. It still needs both validators, the schema,
and the "worker first, one commit" rollout of `docs/editor-render-fields.md` §12.

| # | Gap (rows) | Sketch: where and how | Migration |
|---|---|---|---|
| 1 | **Put auto-transcription on sale** (TB01, CA02, CA03) | Owner steps from `docs/AUTO_CAPTIONS_SETUP.md`: key, probe and price for `elevenlabs-scribe-v2` or `assemblyai-universal-2` (`schemas/model_registry.json:755, 814`). The code exists (`CaptionsPanel.tsx`, 0072). It unblocks #11, #14 and #20. | none (ops; a `credit_prices` row) |
| 2 | **Paste attributes + effect presets** (TE26, FX02, MK09) | `copyLook(clip)` / `pasteLook(model, ids)` in `cc/lib/editor.ts` over `EFFECT_KEYS`, `grade`, `color`, `mask`, `fx`, `move`, then `settleAll` (`cc/lib/editorSettle.ts`). Presets are the same JSON in localStorage, or per org later. | none |
| 3 | **Rolling and slip edits** (TE04, TE05, TE06) | Pure model ops next to `trimClip` (`cc/lib/editor.ts:3122`): roll moves A.out and B.in together; slip shifts in_s and out_s within the source. Pointer modes in `TimelineStrip.tsx`; property tests against `validateTimeline`. | none |
| 4 | **I/O marks, insert at playhead, range delete** (PB10, TE11, TE14) | Editor state `marks {in, out}`. Insert = `splitClip` + insert; range delete = two splits + `removeClip`. One undo step each. | none |
| 5 | **Premiere-style keys** (KS01, PB07, TE33) | Extend `cc/lib/editor-shortcuts.ts`: J/K/L shuttle (playbackRate steps), I/O, M, Q/W ripple-trim to the playhead, Up/Down to the next/previous edit, Ctrl+K. Same focus rules. | none |
| 6 | **Platform safe zones and guides** (WS28, WS29) | An SVG overlay on the preview box per frame preset (`cc/lib/editorFrame.ts`) showing the TikTok, Reels and Shorts UI areas, plus centre and thirds guides. | none |
| 7 | **One-click J/L cut** (TE15) | Uses `detachClipAudio` (`cc/lib/editor.ts:3410`), then trims the detached sound N frames past the cut. One undo step. | none |
| 8 | **"Clean voice" preset** (AU10, AU21) | A closed `voice: "clean"` flag on A and V clips: highpass + afftdn + deesser + acompressor + loudnorm in `modules/render_spec.py` `audio_track_filter`, with a TS twin. Measure the cost. | none |
| 9 | **Single-word captions** (CA05) | An 11th style in `modules/caption_styles.py:31` and `cc/lib/captionStyleTable.ts`: one cue per word from the word timings. | none |
| 10 | **Stored markers and YouTube chapters** (TE20, TE22, TE21) | Top-level `markers: [{id, t, dur?, label?, color?, kind}]` in both validators and `schemas/timeline.schema.json`. A "Save beats as markers" button (`cc/lib/editorBeats.ts`). `snapTargets` learns them. A chapters .txt download. | none |
| 11 | **Bleep or mute words** (AU26) | `bleeps: [{start_s, end_s, mode: "mute"|"tone"}]` picked in the caption word list. Volume 0 or a 1 kHz sine in the final mix (`render_spec.py`). Both validators. | none |
| 12 | **Sync lock for ripple edits** (SQ13) | Ripple ops (`removeClip`, `trimClip`, the silence `applyCuts` in `cc/lib/editorSilence.ts`) shift the texts, sounds, overlays and shapes that start after the edit point. A per-lane lock toggle. Fixes the "texts keep their times" caveat of §14. | none |
| 13 | **Multi-select** (TE01, TE02, TE25) | `Selection` becomes a set (`TimelineStrip.tsx:24`). Delete, move, paste-attributes and nudge take lists. Shift-click and marquee. | none |
| 14 | **Caption translation + several caption tracks** (CA06, CA09) | A new `caption_translate` capability on a first-party LLM (Google Gemini or OpenAI, original maker only) that keeps cue timings. `captions` becomes a list with `language` and `burn` (both validators; the old single object is read as a one-item list). Credits by hold and capture per 1,000 characters. | **yes**: capability + price row |
| 15 | **Still frame / thumbnail export** (EX09) | A one-frame export (`timeline_render` with a 1-frame range, PNG out) put in the library. | **yes**: an export kind column on `editor_exports` |
| 16 | **Text properties and emoji** (GR02, GR04) | Tracking, italic and alignment as ASS fields (`modules/ass_captions.py` + validators). Emoji drawn to PNG with Pillow and a bundled Noto Color Emoji font, laid like a shape (`render_backend.draw_shapes`). | none |
| 17 | **Scene edit detection** (SQ16) | In the browser: decode the 480p proxy with WebCodecs and compare histogram distance between frames (the silence-detection pattern, `cc/lib/editorSilence.ts`). "Split at scenes" is one undo step. | none |
| 18 | **Versions list and restore** (CL02) | Today only the current document and its `rev` are stored (0054); each export keeps its own document snapshot. Add an `editor_project_revisions` table that `save_editor_project` appends to (keeping the last 50, inside the 256 KiB doc cap), a Versions list and "restore as a new revision". | **yes**: revisions table + save function body |
| 19 | **Generic keyframes with easing** (KF01, KF02, KF04, MO01, CP01) | Section D1. `keys` per property, N points, a closed easing list plus cubic-bezier. Compiled to piecewise ffmpeg expressions (the `speed_ramp.py` pattern) on transform, opacity, volume and grade. Rubber bands in the strip. | none |
| 20 | **Text-based editing v1** (TB02, TB03 fillers, WS18) | A transcript view over the caption words (`wordsOnTimeline`, `cc/lib/captions.ts`). Deleting words becomes cuts at source times through the silence-cut apply path (`splitClipAtSource`). Needs #1. | none |

**Outside the top 20 because of their size, but P0:**

- Stacked V tracks (SQ11; D0).
- The real-time WebCodecs/WebGL preview (PB01, WS05; D9).
- Auto-reframe with subject tracking (SQ17, MO10; D5 tracking).
- "Generate here" in the timeline (AI03; C2).

They are phases 7 to 9 of the roadmap.

---

## A. Premiere inventory, layer by layer

Each row is one feature with a one-line description and the Adobe page that documents it. Every link was checked
against the user guide's table of contents. Only Adobe's own pages are cited.

### A.WS Workspaces and panels

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| WS01 | Workspaces (Editing, Color, Audio, Captions, Effects ...) | Saved panel layouts for each kind of work; switch, reset, save your own. | […/get-started/tour-the-workspace/what-are-workspaces](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/what-are-workspaces.html) |
| WS02 | Dock, group, undock and resize panels | Panels can be docked, grouped, floated and resized. | […/get-started/tour-the-workspace/dock-group-undock-panels](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/dock-group-undock-panels.html) |
| WS03 | Project panel views (list, icon, freeform) | Browse media as a list with columns, as thumbnails, or on a freeform board. | […/get-started/customize-the-project-panel/customization-options-for-the-project-panel](https://helpx.adobe.com/premiere/desktop/get-started/customize-the-project-panel/customization-options-for-the-project-panel.html) |
| WS04 | Source Monitor | Plays a source clip on its own so you can mark In/Out and pick a part before it goes into the sequence. | […/get-started/source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor.html) |
| WS05 | Program Monitor | Plays the sequence with every effect, title and transition. | […/get-started/source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/about-source-monitor-and-program-monitor.html) |
| WS06 | Timeline panel with tracks | Stacked video and audio tracks, track headers, ruler, playhead. | […/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html) |
| WS07 | Effect Controls panel | Every property of the selected clip with stopwatch keyframes and a mini timeline. | […/add-video-effects/apply-video-effects/about-effect-controls-panel](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/about-effect-controls-panel.html) |
| WS08 | Properties panel (cards) | Simple card view of effects, masks and text properties of the selection. | […/edit-projects/intro-to-editing/edit-video-using-the-properties-panel](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/edit-video-using-the-properties-panel.html) |
| WS09 | Effects panel with search, thumbnails and preview videos | Browse all effects/transitions with search, thumbnails and preview on your own footage (27.0). | […/add-video-effects/types-of-effects/about-effects-and-effects-panel](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/about-effects-and-effects-panel.html) |
| WS10 | Essential Sound panel | Tag clips Dialogue / Music / SFX / Ambience and get task-based controls per type. | […/add-audio-effects/adjust-volume-and-levels/audio-editing-with-essential-sound-panel](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/audio-editing-with-essential-sound-panel.html) |
| WS11 | Audio Track Mixer | Per-track faders, pan, mute/solo, track effects, sends, automation, submixes. | […/add-audio-effects/advanced-audio-techniques/about-audio-track-mixer](https://helpx.adobe.com/premiere/desktop/add-audio-effects/advanced-audio-techniques/about-audio-track-mixer.html) |
| WS12 | Audio Clip Mixer | Per-clip faders and pan, with automation keyframes. | […/add-audio-effects/apply-audio-effects/set-automation-modes-for-audio-clip-mixer](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/set-automation-modes-for-audio-clip-mixer.html) |
| WS13 | Lumetri Scopes panel | Waveform, vectorscope, RGB parade and histogram of the current frame. | […/correct-color/add-color-effects/display-lumetri-scopes](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/display-lumetri-scopes.html) |
| WS14 | History panel | List of every change; click to go back to any state. | […/edit-projects/correct-mistakes/view-or-make-changes-in-the-history-panel](https://helpx.adobe.com/premiere/desktop/edit-projects/correct-mistakes/view-or-make-changes-in-the-history-panel.html) |
| WS15 | Info panel | Details of the selected item: in/out, duration, frame size, rate. | […/get-started/tour-the-workspace/clip-details-in-the-info-panel](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/clip-details-in-the-info-panel.html) |
| WS16 | Events panel (warnings and errors) | Collected warnings, errors and information events. | […/edit-projects/correct-mistakes/view-warnings-errors-and-information-events](https://helpx.adobe.com/premiere/desktop/edit-projects/correct-mistakes/view-warnings-errors-and-information-events.html) |
| WS17 | Metadata panel | View and edit clip and XMP metadata. | […/organize-media/edit-metadata/view-clip-data-in-the-metadata-panel](https://helpx.adobe.com/premiere/desktop/organize-media/edit-metadata/view-clip-data-in-the-metadata-panel.html) |
| WS18 | Text panel (Transcript and Captions tabs) | Transcript of the sequence for text-based editing, and the caption list. | […/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/overview-of-text-based-editing.html) |
| WS19 | Sequence Index panel | Searchable spreadsheet of every clip, marker and caption in a sequence (26.2). | […/organize-media/file-organization/navigate-timelines-with-sequence-index](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/navigate-timelines-with-sequence-index.html) |
| WS20 | Search panel | Search media, transcripts, metadata and markers in one place. | […/organize-media/file-organization/media-intelligence-and-search-panel](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/media-intelligence-and-search-panel.html) |
| WS21 | AI Assistant panel | Chat panel that organises bins, makes stringouts and rough cuts, captions, effects, reframes, masks and grades; custom skills (27.0). | […/premiere-ai-assistant/overview](https://helpx.adobe.com/premiere/desktop/premiere-ai-assistant/overview.html) |
| WS22 | Color Mode workspace | Dedicated grading view with clip grid, colour tools, large monitor, scopes and HUDs (27.0). | […/correct-color/color-mode-fundamentals/color-mode-basics](https://helpx.adobe.com/premiere/desktop/correct-color/color-mode-fundamentals/color-mode-basics.html) |
| WS23 | Full-screen panel or monitor | Maximise any panel or play the monitor full screen. | […/get-started/tour-the-workspace/display-any-panel-full-screen](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/display-any-panel-full-screen.html) |
| WS24 | Video on a second monitor | Send playback to a second display. | […/get-started/preferences-and-settings/display-video-on-a-second-monitor](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/display-video-on-a-second-monitor.html) |
| WS25 | Keyboard navigation and accessibility | Use the whole app from the keyboard; screen reader support. | […/get-started/set-up-accessibility-features/navigate-premiere-using-the-keyboard](https://helpx.adobe.com/premiere/desktop/get-started/set-up-accessibility-features/navigate-premiere-using-the-keyboard.html) |
| WS26 | Touch and gesture controls | Touch screens, gestures. | […/get-started/use-touch-and-gesture-controls/control-premiere-through-touch-and-gesture-in-microsoft-surface-pro-and-windows](https://helpx.adobe.com/premiere/desktop/get-started/use-touch-and-gesture-controls/control-premiere-through-touch-and-gesture-in-microsoft-surface-pro-and-windows.html) |
| WS27 | Preferences | Global preferences (timeline, trim, playback, auto-save, memory...). | […/get-started/preferences-and-settings/preferences-overview](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/preferences-overview.html) |
| WS28 | Safe margins (title/action safe) | Overlay safe-area guides on the monitor. | […/get-started/source-and-program-monitor-adjustments/view-safe-zones-in-the-monitors](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/view-safe-zones-in-the-monitors.html) |
| WS29 | Guides and snapping to guides | Custom guides on the monitor, objects snap to them. | […/get-started/source-and-program-monitor-adjustments/snap-objects-to-guides](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/snap-objects-to-guides.html) |
| WS30 | Direct manipulation in the Program Monitor | Drag, scale and rotate clips and graphics in the monitor. | […/get-started/source-and-program-monitor-adjustments/nudge-clips-in-program-monitor](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/nudge-clips-in-program-monitor.html) |

### A.PM Project and media management

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| PM01 | Create and open projects | Projects hold media, sequences and settings. | […/organize-media/create-projects/create-new-project](https://helpx.adobe.com/premiere/desktop/organize-media/create-projects/create-new-project.html) |
| PM02 | Project templates | Start new projects from your own templates. | […/organize-media/create-projects/create-your-own-project-templates](https://helpx.adobe.com/premiere/desktop/organize-media/create-projects/create-your-own-project-templates.html) |
| PM03 | Several projects open; copy between projects | Work in several projects and copy clips between them. | […/organize-media/create-projects/edit-multiple-open-projects](https://helpx.adobe.com/premiere/desktop/organize-media/create-projects/edit-multiple-open-projects.html) |
| PM04 | Auto save | Saves the project automatically at intervals. | […/get-started/preferences-and-settings/auto-save-preferences](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/auto-save-preferences.html) |
| PM05 | Consolidate and archive a project | Copy only the used media (trimmed) into a package. | […/organize-media/create-projects/consolidate-and-archive-projects](https://helpx.adobe.com/premiere/desktop/organize-media/create-projects/consolidate-and-archive-projects.html) |
| PM06 | Import of many file formats | Video, audio, stills, camera formats, RAW. | […/organize-media/import-files/supported-file-formats](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/supported-file-formats.html) |
| PM07 | Image sequence import | Import numbered stills as one clip. | […/organize-media/import-files/import-images-as-image-sequence](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/import-images-as-image-sequence.html) |
| PM08 | Layered Photoshop / Illustrator import | Import PSD layers as a sequence or merged. | […/organize-media/import-files/import-photoshop-and-illustrator-files](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/import-photoshop-and-illustrator-files.html) |
| PM09 | Import media from Firefly Boards as a ready sequence | Send generated media from Firefly Boards straight into a sequence (26.0, 26.3). | […/organize-media/import-files/import-media-from-firefly-boards](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/import-media-from-firefly-boards.html) |
| PM10 | Import other editors' projects (Avid, FCPX, XML) | Bring in projects from other NLEs. | […/organize-media/import-files/migrate-from-final-cut-pro-x](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/migrate-from-final-cut-pro-x.html) |
| PM11 | Camera RAW and pro codecs | BRAW, ProRes RAW, ARRI, Sony X-OCN, Canon RAW. | […/organize-media/import-files/blackmagic-raw-support](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/blackmagic-raw-support.html) |
| PM12 | Ingest and proxy workflow | Copy/transcode on ingest and make low-res proxies. | […/organize-media/ingest-proxy-workflow/ingest-and-proxy-workflow](https://helpx.adobe.com/premiere/desktop/organize-media/ingest-proxy-workflow/ingest-and-proxy-workflow.html) |
| PM13 | Create and attach proxies; toggle proxies | Make proxies with presets, attach them, toggle full-res vs proxy in playback. | […/organize-media/ingest-proxy-workflow/attach-proxies-to-full-resolution-media](https://helpx.adobe.com/premiere/desktop/organize-media/ingest-proxy-workflow/attach-proxies-to-full-resolution-media.html) |
| PM14 | Bins (folders) | Organise media in bins, nested, with their own views. | […/organize-media/file-organization/bins-overview](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/bins-overview.html) |
| PM15 | Find and search media | Find dialog, search by name, metadata, labels. | […/organize-media/file-organization/find-assets-using-the-find-dialog](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/find-assets-using-the-find-dialog.html) |
| PM16 | Labels (colour labels) | Colour labels on clips, bins and sequences. | […/organize-media/apply-labeling/label-colors-in-sequence-tabs](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/label-colors-in-sequence-tabs.html) |
| PM17 | Metadata (XMP, schemas, overlays) | Edit XMP metadata, schemas, show metadata overlays. | […/organize-media/edit-metadata/metadata-in-premiere](https://helpx.adobe.com/premiere/desktop/organize-media/edit-metadata/metadata-in-premiere.html) |
| PM18 | Media Intelligence visual search | Natural-language search of what is in your footage, on device (25.x+). | […/organize-media/file-organization/search-for-media-using-ai-powered-media-intelligence](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/search-for-media-using-ai-powered-media-intelligence.html) |
| PM19 | Similar-visuals and audio search | Find visually similar shots; search audio by description. | […/organize-media/file-organization/search-for-similar-visuals-using-media-intelligence](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/search-for-similar-visuals-using-media-intelligence.html) |
| PM20 | Relink and replace media | Relink offline files; replace footage keeping edits. | […/organize-media/file-organization/relink-offline-media-automatically](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/relink-offline-media-automatically.html) |
| PM21 | Subclips | Named parts of a clip as their own items. | […/edit-projects/intro-to-editing/create-a-subclip-from-the-project-panel](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/create-a-subclip-from-the-project-panel.html) |
| PM22 | Merged clips (separate audio recorder) | Merge video with external audio by timecode or waveform. | […/add-audio-effects/basic-audio-editing/merge-clips-in-the-project-panel](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/merge-clips-in-the-project-panel.html) |
| PM23 | Interpret footage | Override a clip's frame rate, pixel aspect, alpha, field order. | […/edit-projects/modify-clip-properties/modifying-clip-properties-with-interpret-footage](https://helpx.adobe.com/premiere/desktop/edit-projects/modify-clip-properties/modifying-clip-properties-with-interpret-footage.html) |
| PM24 | Productions | Several projects sharing media on shared storage. | […/collaborate-with-others/collaborate-using-productions/about-productions](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/collaborate-using-productions/about-productions.html) |
| PM25 | Creative Cloud Libraries | Shared looks, graphics, colours, MOGRTs across apps and people. | […/collaborate-with-others/collaborate-using-creative-cloud-libraries/about-creative-cloud-libraries](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/collaborate-using-creative-cloud-libraries/about-creative-cloud-libraries.html) |
| PM26 | Built-in stock footage | Search and license Adobe Stock inside the app. | […/edit-projects/intro-to-editing/use-built-in-adobe-stock](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/use-built-in-adobe-stock.html) |
| PM27 | Stock audio | Licensed music and SFX in the app. | […/add-audio-effects/use-adobe-stock-audio/use-adobe-stock-audio-in-your-project](https://helpx.adobe.com/premiere/desktop/add-audio-effects/use-adobe-stock-audio/use-adobe-stock-audio-in-your-project.html) |
| PM28 | Timecode display and entry | Timecode formats, enter timecode to jump. | […/organize-media/apply-labeling/about-timecode](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/about-timecode.html) |
| PM29 | Thumbnails and hover scrub | Scrub through clips by hovering in the bin. | […/get-started/use-touch-and-gesture-controls/use-thumbnail-controls-in-the-project-panel](https://helpx.adobe.com/premiere/desktop/get-started/use-touch-and-gesture-controls/use-thumbnail-controls-in-the-project-panel.html) |

### A.SQ Sequences

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| SQ01 | Create a sequence from a clip or preset | New sequence matching a clip, or from presets. | […/edit-projects/change-clip-sequence/create-a-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/create-a-sequence.html) |
| SQ02 | Sequence settings (frame size, frame rate) | Change frame size, rate, audio settings later. | […/edit-projects/change-clip-sequence/change-sequence-settings](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/change-sequence-settings.html) |
| SQ03 | Custom sequence presets | Save your own sequence presets. | […/edit-projects/change-clip-sequence/create-a-custom-sequence-preset](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/create-a-custom-sequence-preset.html) |
| SQ04 | Sequence aspect ratio (vertical, square) | Any frame aspect, vertical sequences. | […/edit-projects/intro-to-editing/set-the-aspect-ratio-of-a-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/set-the-aspect-ratio-of-a-sequence.html) |
| SQ05 | Several sequences in one project | A project holds many sequences. | […/edit-projects/change-clip-sequence/sequence-presets-and-settings](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sequence-presets-and-settings.html) |
| SQ06 | Nested sequences | Put a sequence inside another as one clip. | […/edit-projects/edit-nested-sequences/about-nested-sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-nested-sequences/about-nested-sequences.html) |
| SQ07 | Multi-camera source sequence | Sync angles by audio, timecode, in/out or markers. | […/edit-projects/set-up-multi-camera-sequences-for-editing/create-a-multi-camera-source-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-a-multi-camera-source-sequence.html) |
| SQ08 | Multi-camera editing | Switch angles live during playback; cut list stays editable. | […/edit-projects/set-up-multi-camera-sequences-for-editing/create-and-edit-a-multi-camera-target-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-and-edit-a-multi-camera-target-sequence.html) |
| SQ09 | Synchronise clips by audio waveform | Line up clips by their sound. | […/add-audio-effects/basic-audio-editing/synchronize-clips-in-the-timeline-panel](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/synchronize-clips-in-the-timeline-panel.html) |
| SQ10 | Add, delete and rename tracks | Manage tracks. | […/edit-projects/change-clip-sequence/add-tracks](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/add-tracks.html) |
| SQ11 | Stacked video tracks (V1, V2, V3 ...) | Unlimited stacked video tracks for B-roll, PiP and layers. | […/edit-projects/change-clip-sequence/add-tracks](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/add-tracks.html) |
| SQ12 | Track lock | Lock a track against changes. | […/edit-projects/change-clip-sequence/track-lock-to-prevent-changes](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/track-lock-to-prevent-changes.html) |
| SQ13 | Sync lock | Keep other tracks in sync when you ripple one. | […/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes.html) |
| SQ14 | Track appearance (height, waveforms, thumbnails) | Change track height, show waveforms and frame thumbnails. | […/edit-projects/change-clip-sequence/edit-track-appearance](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/edit-track-appearance.html) |
| SQ15 | Simplify sequence | Copy a sequence without disabled clips, empty tracks, effects. | […/edit-projects/change-clip-sequence/simplify-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/simplify-sequence.html) |
| SQ16 | Scene edit detection | Find the cuts in a finished video and add edits or markers there. | […/edit-projects/change-clip-sequence/detect-edit-points-using-scene-edit-detection](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/detect-edit-points-using-scene-edit-detection.html) |
| SQ17 | Auto Reframe a whole sequence | Make a new aspect-ratio version that follows the action. | […/add-video-effects/commonly-used-effects/add-auto-reframe-effect-to-a-sequence](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/add-auto-reframe-effect-to-a-sequence.html) |
| SQ18 | Pixel aspect ratio and interlaced footage | Interpret non-square pixels, fields. | […/edit-projects/intro-to-editing/pixel-aspect-ratio](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/pixel-aspect-ratio.html) |
| SQ19 | VR / 360 editing | 360/180 video, VR effects and transitions, ambisonics. | […/edit-projects/edit-vr-content/assign-vr-properties-to-sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-vr-content/assign-vr-properties-to-sequences.html) |

### A.TE Timeline editing

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| TE01 | Selection tool and multi-select | Select one or many clips (Shift/marquee). | […/edit-projects/change-clip-sequence/select-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html) |
| TE02 | Track Select forward/backward | Select everything after a point on one or all tracks. | […/edit-projects/change-clip-sequence/select-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html) |
| TE03 | Ripple edit / ripple trim | Trim an edge and move everything after it. | […/edit-projects/trim-clips/perform-ripple-edits](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-ripple-edits.html) |
| TE04 | Rolling edit | Move a cut point between two clips without changing total length. | […/edit-projects/trim-clips/perform-rolling-edits](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-rolling-edits.html) |
| TE05 | Slip edit | Change a clip's in and out together without moving it. | […/edit-projects/trim-clips/perform-slip-edits](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slip-edits.html) |
| TE06 | Slide edit | Move a clip, trimming its neighbours to keep the gap closed. | […/edit-projects/trim-clips/perform-slide-edits](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-slide-edits.html) |
| TE07 | Rate Stretch tool | Drag an edge to change speed so the clip fills a duration. | […/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-the-rate-stretch-tool](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-the-rate-stretch-tool.html) |
| TE08 | Razor / Add Edit | Cut a clip (or all tracks) at the playhead. | […/edit-projects/trim-clips/cut-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/cut-clips.html) |
| TE09 | Trim mode, dynamic JKL trimming, asymmetrical trim | Dedicated trim monitor, trim while playing. | […/edit-projects/trim-clips/about-trim-mode](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/about-trim-mode.html) |
| TE10 | Trim with handles and numbers | Drag clip edges or type values. | […/edit-projects/trim-clips/trim-a-clip](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/trim-a-clip.html) |
| TE11 | Insert and overwrite edits | Insert at the playhead (ripple) or overwrite. | […/edit-projects/intro-to-editing/add-or-remove-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/add-or-remove-clips.html) |
| TE12 | Three-point editing and source patching | Mark In/Out in source and sequence, target tracks, edit. | […/edit-projects/intro-to-editing/add-media-to-the-timeline-using-source-patching](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/add-media-to-the-timeline-using-source-patching.html) |
| TE13 | Track targeting | Choose which tracks edits and navigation act on. | […/edit-projects/intro-to-editing/work-with-clips-on-the-timeline-using-track-targeting](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/work-with-clips-on-the-timeline-using-track-targeting.html) |
| TE14 | Lift and Extract | Remove a range leaving a gap (lift) or closing it (extract). | […/edit-projects/change-clip-sequence/lift-and-paste-frames](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/lift-and-paste-frames.html) |
| TE15 | J-cuts and L-cuts | Let sound start before or run after the picture cut. | […/edit-projects/trim-clips/perform-j-cuts-and-l-cuts](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-j-cuts-and-l-cuts.html) |
| TE16 | Link / unlink audio and video | Keep A/V moving together, or separate them. | […/add-audio-effects/basic-audio-editing/link-audio-and-video-clips](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/link-audio-and-video-clips.html) |
| TE17 | Group clips | Group items to move them together. | […/edit-projects/change-clip-sequence/group-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/group-clips.html) |
| TE18 | Enable / disable a clip | Hide a clip without deleting it. | […/edit-projects/change-clip-sequence/enable-or-disable-a-clip](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/enable-or-disable-a-clip.html) |
| TE19 | Snapping | Snap edges to edits, playhead, markers. | […/edit-projects/change-clip-sequence/snap-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/snap-clips.html) |
| TE20 | Sequence markers | Markers with names, colours, durations on the sequence. | […/organize-media/apply-labeling/overview-of-markers](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/overview-of-markers.html) |
| TE21 | Clip markers | Markers inside a source clip that travel with it. | […/organize-media/apply-labeling/add-a-marker-to-a-clip](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/add-a-marker-to-a-clip.html) |
| TE22 | Marker comments, colours and chapter markers | Comments, colours, chapter markers for export. | […/organize-media/apply-labeling/view-marker-comments](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/view-marker-comments.html) |
| TE23 | Close gaps | Find and close gaps. | […/edit-projects/change-clip-sequence/remove-clips-from-a-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/remove-clips-from-a-sequence.html) |
| TE24 | Ripple delete | Delete and close the gap. | […/edit-projects/change-clip-sequence/remove-clips-from-a-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/remove-clips-from-a-sequence.html) |
| TE25 | Copy, paste, duplicate clips | Copy/paste clips and attributes. | […/edit-projects/change-clip-sequence/copy-and-paste-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/copy-and-paste-clips.html) |
| TE26 | Paste attributes / copy effects | Copy effects, motion, colour from one clip to others. | […/add-video-effects/apply-video-effects/copy-and-paste-clip-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/copy-and-paste-clip-effects.html) |
| TE27 | Move and rearrange clips | Drag clips; insert-drag to reorder. | […/edit-projects/change-clip-sequence/rearrange-clips-on-the-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/rearrange-clips-on-the-timeline.html) |
| TE28 | Nudge clips by a frame | Move selected clips by frames from the keyboard. | […/edit-projects/change-clip-sequence/different-ways-to-move-clips](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/different-ways-to-move-clips.html) |
| TE29 | Find clips in a sequence / reveal in project | Locate clips and their source. | […/edit-projects/change-clip-sequence/find-clips-in-a-sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/find-clips-in-a-sequence.html) |
| TE30 | Match frame | Open the source frame of the clip at the playhead. | […/render-and-export/render-sequences-for-playback/match-a-frame-with-its-source](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/match-a-frame-with-its-source.html) |
| TE31 | Undo and redo | Undo any change. | […/edit-projects/correct-mistakes/view-or-make-changes-in-the-history-panel](https://helpx.adobe.com/premiere/desktop/edit-projects/correct-mistakes/view-or-make-changes-in-the-history-panel.html) |
| TE32 | Timeline zoom and navigation | Zoom, scroll, zoom to fit. | […/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html) |
| TE33 | Go to next / previous edit point | Jump the playhead between cuts. | […/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html) |
| TE34 | Transition handles on the timeline | Adjust transitions directly on clips with handles (26.0). | […/add-video-effects/apply-video-transitions/video-transitions-using-clip-handles](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/video-transitions-using-clip-handles.html) |

### A.TB Text-based editing

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| TB01 | Transcribe a sequence | Speech to text of the whole sequence for editing. | […/edit-projects/edit-video-using-text-based-editing/transcribe-video](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/transcribe-video.html) |
| TB02 | Edit the video by editing the transcript | Select words and delete, copy, insert them; the cut follows. | […/edit-projects/edit-video-using-text-based-editing/edit-transcripts-using-text-based-editing](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/edit-transcripts-using-text-based-editing.html) |
| TB03 | Detect and delete pauses | Find pauses in the transcript and remove them. | […/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html) |
| TB04 | Speaker labels; remove one speaker | Name speakers, delete every line of one speaker. | […/edit-projects/edit-video-using-text-based-editing/remove-all-instances-of-one-speaker-in-transcript](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/remove-all-instances-of-one-speaker-in-transcript.html) |
| TB05 | Paper edit (sequence from transcript lines) | Build a sequence by selecting transcript lines across clips (26.5). | […/edit-projects/edit-video-using-text-based-editing/create-a-sequence-with-paper-edit](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/create-a-sequence-with-paper-edit.html) |
| TB06 | Transcribe source files | Transcribe clips in the project before editing. | […/edit-projects/edit-video-using-text-based-editing/transcribe-individual-source-files](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/transcribe-individual-source-files.html) |
| TB07 | Find and replace in transcript and captions | Search and replace words. | […/add-text-images/insert-captions/find-and-replace-text-in-transcription](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/find-and-replace-text-in-transcription.html) |

### A.FX Effects

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| FX01 | Apply effects and change the effect stack order | Any number of effects per clip, in any order. | […/add-video-effects/apply-video-effects/apply-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/apply-effects.html) |
| FX02 | Effect presets | Save and apply effect presets (with keyframes). | […/add-video-effects/apply-video-effects/create-effect-presets](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/create-effect-presets.html) |
| FX03 | Adjustment layers | A clip that applies its effects to everything below it. | […/add-video-effects/apply-video-effects/create-adjustment-layers](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/create-adjustment-layers.html) |
| FX04 | Source (master) clip effects | Effects on the source, inherited by every use. | […/add-video-effects/apply-video-effects/apply-effects-to-source-clips](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/apply-effects-to-source-clips.html) |
| FX05 | Fx badges and effect bypass | See which clips have effects; toggle them off. | […/add-video-effects/apply-video-effects/use-fx-badges](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/use-fx-badges.html) |
| FX06 | Blur and Sharpen effects | Gaussian, directional, radial, zoom, bokeh, focus/tilt-shift, channel blur, sharpen, unsharp mask. | […/add-video-effects/effects-and-transitions-library/blur-and-sharpen-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/blur-and-sharpen-effects.html) |
| FX07 | Colour correction effects | Lumetri, Levels, Tint, Color Pass, Color Replace, ProcAmp, ASC CDL, Video Limiter, B&W, Gradient Tint. | […/add-video-effects/effects-and-transitions-library/color-correction-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/color-correction-effects.html) |
| FX08 | Distort effects | Corner Pin, Lens Distortion, Magnify, Mirror, Spherize, Turbulent Displace, Twirl, Wave Warp, Warp Stabilizer. | […/add-video-effects/effects-and-transitions-library/distort-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/distort-effects.html) |
| FX09 | Generate effects | Gradient, 4-colour gradient, Fill. | […/add-video-effects/effects-and-transitions-library/generate-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/generate-effects.html) |
| FX10 | Keying effects | Ultra Key (spill, matte cleanup), Color Key, Luma Key, Track Matte Key. | […/add-video-effects/effects-and-transitions-library/keying-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/keying-effects.html) |
| FX11 | Lights and Glows | Lens Flare, Light Leaks, Glow, Edge Glow, RGB Split, Glint, Volumetric Rays. | […/add-video-effects/types-of-effects/effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/effects.html) |
| FX12 | Noise and Grain | Noise. | […/add-video-effects/effects-and-transitions-library/noise-and-grain-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/noise-and-grain-effects.html) |
| FX13 | Perspective effects | Basic 3D, Drop Shadow, Bevel Alpha, Long Shadow. | […/add-video-effects/effects-and-transitions-library/perspective-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/perspective-effects.html) |
| FX14 | Stylize effects | Mosaic, Posterize, Strobe Light, Find Edges, Emboss, Brush Strokes, Roughen Edges. | […/add-video-effects/effects-and-transitions-library/stylize-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/stylize-effects.html) |
| FX15 | Time effects | Posterize Time, Echo. | […/add-video-effects/effects-and-transitions-library/time-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/time-effects.html) |
| FX16 | Transform effects | Transform, Camera Shake, Wiggle, Spin, Grow, Shrink, Move, Offset, Flips, Auto Reframe. | […/add-video-effects/effects-and-transitions-library/transform-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/transform-effects.html) |
| FX17 | Utility effects | Timecode/metadata burn-in, Motion Tile, Rounded Crop, Stroke, Simple Text, Auto Align. | […/add-video-effects/effects-and-transitions-library/utility-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/utility-effects.html) |
| FX18 | Immersive (VR) effects | VR blur, glow, projection, rotate sphere ... | […/add-video-effects/effects-and-transitions-library/immersive-video-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/immersive-video-effects.html) |
| FX19 | "Surprise Me" random variations | One click for a random variation of an effect or transition. | […/add-video-effects/types-of-effects/effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/effects.html) |

### A.TR Transitions

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| TR01 | Dissolves | Cross Dissolve, Dip to Black/White/Color, Film, Additive, Blur, Luma Fade, Burn Alpha. | […/add-video-effects/effects-and-transitions-library/list-of-video-dissolve-transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/list-of-video-dissolve-transitions.html) |
| TR02 | Wipes | Linear, Clock, Radial, Star, Panel, Soft, Neon, Stretch wipes. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR03 | Slide, push, whip, split, stretch | Slide, Push, Whip (motion blur), Split, Stretch, Roll, Film Roll. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR04 | Lights and blurs transitions | Cross Zoom, Flash, Light Leak, Zoom Blur, Directional Blur, Glow, Lens Blur, Ray. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR05 | Animation transitions | Spin, Flip, Pop, Spring, Fold, Block, Pull, Travel (Motion Impacts). | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR06 | Grunge and distort transitions | Glitch, VHS Damage, Chaos, Earthquake, Kaleidoscope, Liquid, TV Power, Flicker. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR07 | Transformers | Page Peel, Louver, Slice, Wave, Mirror, Frame. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR08 | Smart tool transitions | Shape Dissolve (26.3), Motion Tween, Motion Camera, Shape Flow. | […/add-video-effects/types-of-effects/transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/transitions.html) |
| TR09 | Default transition; apply to all or to a selection | Set a default and apply it to every selected cut. | […/add-video-effects/apply-video-transitions/set-and-apply-default-transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/set-and-apply-default-transitions.html) |
| TR10 | Single-sided transitions and alignment | Transition at start/end of a clip; centre, start or end on cut. | […/add-video-effects/apply-video-transitions/align-transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/align-transitions.html) |
| TR11 | Clip handles for transitions | Transitions use media beyond the in/out points. | […/add-video-effects/apply-video-transitions/clip-handles-settings](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/clip-handles-settings.html) |
| TR12 | Audio crossfades | Constant Power, Constant Gain, Exponential Fade. | […/add-audio-effects/apply-audio-transitions/audio-crossfade-transitions](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-transitions/audio-crossfade-transitions.html) |
| TR13 | Text animation presets | Text Animator, Typewriter. | […/add-video-effects/types-of-effects/animations](https://helpx.adobe.com/premiere/desktop/add-video-effects/types-of-effects/animations.html) |
| TR14 | Copy, paste and replace transitions | Copy a transition to other cuts; replace one with another. | […/add-video-effects/apply-video-transitions/copy-and-paste-transitions](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/copy-and-paste-transitions.html) |

### A.KF Keyframes

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| KF01 | Keyframe any property | Stopwatch on any effect property; add, move, delete keyframes. | […/add-video-effects/control-effects-and-transitions-using-keyframes/about-keyframes](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/about-keyframes.html) |
| KF02 | Interpolation: linear, Bezier, auto/continuous Bezier, hold, ease in/out | Temporal and spatial interpolation per keyframe. | […/add-video-effects/control-effects-and-transitions-using-keyframes/change-keyframe-interpolation-method](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/change-keyframe-interpolation-method.html) |
| KF03 | Keyframe graphs (value and speed) | Edit curves in value and velocity graphs. | […/add-video-effects/control-effects-and-transitions-using-keyframes/edit-keyframes-graphs](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/edit-keyframes-graphs.html) |
| KF04 | Keyframes in the timeline (rubber bands) | Show/edit opacity and volume keyframes on clips. | […/add-video-effects/control-effects-and-transitions-using-keyframes/view-keyframes-and-properties-in-the-timeline-panel](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/view-keyframes-and-properties-in-the-timeline-panel.html) |
| KF05 | Copy, paste, snap keyframes; go to next keyframe | Keyframe clipboard and navigation. | […/add-video-effects/control-effects-and-transitions-using-keyframes/copy-and-paste-keyframes](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/copy-and-paste-keyframes.html) |
| KF06 | Motion path in the monitor | Spatial keyframes edited as a path. | […/add-video-effects/control-effects-and-transitions-using-keyframes/keyframes-and-graphs-in-panels](https://helpx.adobe.com/premiere/desktop/add-video-effects/control-effects-and-transitions-using-keyframes/keyframes-and-graphs-in-panels.html) |

### A.MK Masks and compositing

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| MK01 | Rectangle, ellipse and pen masks | Shape masks incl. rounded corners and free-form Bezier pen. | […/add-video-effects/work-with-masks/rectangle-ellipse-and-pen-masks](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/rectangle-ellipse-and-pen-masks.html) |
| MK02 | Mask feather, expansion, opacity, invert | Mask properties. | […/add-video-effects/work-with-masks/adjust-mask-properties](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/adjust-mask-properties.html) |
| MK03 | Mask tracking | Track a mask forward/backward through the shot. | […/add-video-effects/work-with-masks/track-masks](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/track-masks.html) |
| MK04 | Object masking (AI select and track) | Click an object or person; AI isolates and tracks it (26.0+). | […/add-video-effects/work-with-masks/object-masking](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/object-masking.html) |
| MK05 | HSL and luminance masks | Isolate by hue, saturation, luminance (27.0). | […/add-video-effects/work-with-masks/create-masks-using-hsl-and-luminance](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/create-masks-using-hsl-and-luminance.html) |
| MK06 | Combine and refine masks | Add, subtract, intersect masks. | […/add-video-effects/work-with-masks/refining-and-combining-masks](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/refining-and-combining-masks.html) |
| MK07 | Effects inside a mask | Apply an effect only inside a mask (blur a face, grade a sky). | […/add-video-effects/work-with-masks/apply-effects-to-existing-unassigned-masks](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/apply-effects-to-existing-unassigned-masks.html) |
| MK08 | Reveal animations with masks | Animate masks over time. | […/add-video-effects/create-masks-and-composites/create-reveal-animations-using-masking-techniques](https://helpx.adobe.com/premiere/desktop/add-video-effects/create-masks-and-composites/create-reveal-animations-using-masking-techniques.html) |
| MK09 | Copy and paste masks | Reuse masks. | […/add-video-effects/work-with-masks/copy-and-paste-masks](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/copy-and-paste-masks.html) |
| CP01 | Clip opacity | Opacity of any clip (with keyframes). | […/add-video-effects/work-with-composites/specify-clip-opacity](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-composites/specify-clip-opacity.html) |
| CP02 | Blend modes | Multiply, Screen, Overlay, Add ... between tracks. | […/add-video-effects/work-with-composites/blend-mode-options](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-composites/blend-mode-options.html) |

### A.MO Motion and time

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| MO01 | Motion: position, scale, rotation, anchor point | Position, scale, rotation and anchor of any clip, keyframable. | […/add-video-effects/commonly-used-effects/apply-motion-effect](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/apply-motion-effect.html) |
| MO02 | Crop | Crop edges of a clip. | […/add-video-effects/effects-and-transitions-library/transform-effects](https://helpx.adobe.com/premiere/desktop/add-video-effects/effects-and-transitions-library/transform-effects.html) |
| MO03 | Scale to frame size / set to frame size | Fit clips of other sizes to the sequence. | […/edit-projects/intro-to-editing/aspect-ratio-preservation](https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/aspect-ratio-preservation.html) |
| MO04 | Time remapping (keyframed speed ramps) | Speed keyframes on the clip, smooth ramps, reverse and freeze segments. | […/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-time-remapping](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-time-remapping.html) |
| MO05 | Speed / Duration with audio stretching and pitch | Speed, duration, reverse, ripple; audio stretch modes and pitch controls (27.0). | […/edit-projects/change-clip-speed/change-clip-speed-using-the-speedduration-option](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-using-the-speedduration-option.html) |
| MO06 | Reverse | Play a clip backwards. | […/edit-projects/change-clip-speed/change-clip-speed-using-the-speedduration-option](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-using-the-speedduration-option.html) |
| MO07 | Freeze frame and frame hold segments | Hold a frame for a clip or for part of it. | […/edit-projects/change-clip-speed/freeze-a-video-frame-for-the-duration-of-a-clip](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/freeze-a-video-frame-for-the-duration-of-a-clip.html) |
| MO08 | Frame sampling, frame blending, optical flow | Time interpolation methods for speed changes. | […/edit-projects/change-clip-speed/apply-time-interpolation-methods-to-adjust-clip-speed](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/apply-time-interpolation-methods-to-adjust-clip-speed.html) |
| MO09 | Warp Stabilizer with settings | Stabilise with smoothness, method, framing and crop settings. | […/add-video-effects/commonly-used-effects/warp-stabilizer-settings](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/warp-stabilizer-settings.html) |
| MO10 | Auto Reframe a clip | Keep the subject in frame when the aspect changes. | […/add-video-effects/commonly-used-effects/auto-reframe-overview](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/auto-reframe-overview.html) |
| MO11 | Vector motion | Scale vector graphics without softening. | […/add-video-effects/commonly-used-effects/edit-vector-graphics-using-vector-motion-effect](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/edit-vector-graphics-using-vector-motion-effect.html) |

### A.GR Graphics and titles

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| GR01 | Titles with the Type tool | Text layers on the picture. | […/add-text-images/stylize-text/create-titles](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/create-titles.html) |
| GR02 | Text properties | Font, size, colour, stroke, shadow, background, tracking, leading, alignment, caps, italic. | […/add-text-images/stylize-text/about-properties-panel](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/about-properties-panel.html) |
| GR03 | Fonts (Adobe Fonts, replace fonts) | Any installed or Adobe font; replace missing fonts. | […/add-text-images/stylize-text/replace-fonts](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/replace-fonts.html) |
| GR04 | Colour fonts and emoji | Emoji and colour fonts in titles. | […/add-text-images/stylize-text/use-emojis](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/use-emojis.html) |
| GR05 | Text styles; linked and track styles | Save a style and apply/update it everywhere. | […/add-text-images/stylize-text/create-text-styles](https://helpx.adobe.com/premiere/desktop/add-text-images/stylize-text/create-text-styles.html) |
| GR06 | Shapes (rectangle, ellipse, polygon, pen) | Draw shapes and lines. | […/add-text-images/draw-objects/create-a-shape](https://helpx.adobe.com/premiere/desktop/add-text-images/draw-objects/create-a-shape.html) |
| GR07 | Gradients | Linear/radial gradient fills on text and shapes. | […/add-text-images/insert-images-and-graphics/add-gradients](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/add-gradients.html) |
| GR08 | Align and distribute | Align layers to each other or the frame. | […/add-text-images/align-and-distribute-objects/align-objects](https://helpx.adobe.com/premiere/desktop/add-text-images/align-and-distribute-objects/align-objects.html) |
| GR09 | Responsive design (pinning, intro/outro protection) | Graphics that adapt to size and keep intro/outro timing when stretched. | […/add-text-images/insert-images-and-graphics/create-responsive-graphics](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/create-responsive-graphics.html) |
| GR10 | Credit rolls and crawls | Rolling and crawling titles. | […/add-text-images/insert-images-and-graphics/create-credit-rolls](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/create-credit-rolls.html) |
| GR11 | Group layers, clip layers, mask with text | Group graphic layers; video inside text. | […/add-text-images/insert-images-and-graphics/group-text-and-graphic-layers](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/group-text-and-graphic-layers.html) |
| GR12 | Animate graphic layers | Keyframe position, scale, rotation, opacity of graphics. | […/add-text-images/insert-images-and-graphics/animate-layers-using-properties-panel](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/animate-layers-using-properties-panel.html) |
| GR13 | Motion Graphics templates (MOGRT) | Templates with editable text, colours, media. | […/add-text-images/use-motion-graphics-templates/about-motion-graphics-templates](https://helpx.adobe.com/premiere/desktop/add-text-images/use-motion-graphics-templates/about-motion-graphics-templates.html) |
| GR14 | Media replacement in templates | Drop your media into template slots. | […/add-text-images/use-motion-graphics-templates/media-replacement-in-motion-graphics-templates](https://helpx.adobe.com/premiere/desktop/add-text-images/use-motion-graphics-templates/media-replacement-in-motion-graphics-templates.html) |
| GR15 | Data-driven templates (CSV) | Make many versions from a spreadsheet. | […/add-text-images/use-motion-graphics-templates/use-data-driven-motion-graphics-templates](https://helpx.adobe.com/premiere/desktop/add-text-images/use-motion-graphics-templates/use-data-driven-motion-graphics-templates.html) |
| GR16 | Export a graphic as a template | Author templates from your own work. | […/add-text-images/insert-images-and-graphics/export-graphic-as-a-motion-graphics-template](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/export-graphic-as-a-motion-graphics-template.html) |
| GR17 | Template marketplace (Stock MOGRTs) | Browse and buy templates. | […/add-text-images/use-motion-graphics-templates/use-motion-graphics-templates-from-adobe-stock](https://helpx.adobe.com/premiere/desktop/add-text-images/use-motion-graphics-templates/use-motion-graphics-templates-from-adobe-stock.html) |
| GR18 | Spell check | Check spelling in graphics. | […/add-text-images/insert-images-and-graphics/check-spelling-using-the-graphics-tab](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-images-and-graphics/check-spelling-using-the-graphics-tab.html) |

### A.CA Captions

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| CA01 | Captions track: create and edit | Caption tracks with timed cues. | […/add-text-images/insert-captions/create-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/create-captions.html) |
| CA02 | Auto-transcribe (speech to text) | Automatic captions from speech. | […/add-text-images/insert-captions/auto-transcribe-video-using-speech-to-text](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/auto-transcribe-video-using-speech-to-text.html) |
| CA03 | Speech-to-text languages | Many spoken languages with language packs. | […/add-text-images/insert-captions/languages-supported-by-speech-to-text](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/languages-supported-by-speech-to-text.html) |
| CA04 | Caption styles | Styles for caption tracks. | […/add-text-images/insert-captions/create-styles-for-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/create-styles-for-captions.html) |
| CA05 | Single-word captions | One word at a time for social (26.3). | […/add-text-images/insert-captions/create-single-word-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/create-single-word-captions.html) |
| CA06 | Translate captions | Machine-translate captions into a new track (Google/Microsoft engines). | […/add-text-images/insert-captions/translate-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/translate-captions.html) |
| CA07 | Import caption files | Import SRT/SCC/etc. from services. | […/add-text-images/insert-captions/import-caption-file-from-third-party-service](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/import-caption-file-from-third-party-service.html) |
| CA08 | Caption file formats | SRT, SCC, MCC, STL, DFXP/TTML, WebVTT. | […/add-text-images/insert-captions/supported-file-formats-for-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/supported-file-formats-for-captions.html) |
| CA09 | Several caption tracks (languages) | Keep and export several caption tracks. | […/render-and-export/export-files/export-caption-tracks](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-caption-tracks.html) |
| CA10 | Export captions (sidecar, burned in) | Sidecar files or burned into the video. | […/render-and-export/export-files/export-captions](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-captions.html) |

### A.CO Colour

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| CO01 | Lumetri Basic Correction | White balance, tone (exposure, contrast, highlights, shadows, whites, blacks), saturation, vibrance. | […/correct-color/color-correction-fundamentals/basic-color-correction-options](https://helpx.adobe.com/premiere/desktop/correct-color/color-correction-fundamentals/basic-color-correction-options.html) |
| CO02 | Auto color / auto tone | One click exposure and white balance. | […/correct-color/add-color-effects/use-auto-color](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/use-auto-color.html) |
| CO03 | Creative looks with intensity | Looks (LUTs), intensity, faded film, vibrance, tint balance. | […/correct-color/add-color-effects/apply-lumetri-looks](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/apply-lumetri-looks.html) |
| CO04 | RGB curves | Master and per-channel point curves. | […/correct-color/add-color-effects/correct-color-using-rgb-curves](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/correct-color-using-rgb-curves.html) |
| CO05 | Hue vs Saturation / Hue / Luma, Luma vs Sat, Sat vs Sat curves | Secondary curves by hue or luma. | […/correct-color/add-color-effects/correct-color-using-hue-and-saturation-curves](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/correct-color-using-hue-and-saturation-curves.html) |
| CO06 | Colour wheels (shadows, midtones, highlights) | Lift/gamma/gain wheels. | […/correct-color/add-color-effects/correct-color-using-color-wheel](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/correct-color-using-color-wheel.html) |
| CO07 | Colour Match | Match one shot's colour to a reference (face-aware). | […/correct-color/add-color-effects/match-color-between-shots](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/match-color-between-shots.html) |
| CO08 | HSL Secondary | Qualify a colour range and correct it. | […/correct-color/add-color-effects/correct-color-using-hsl-secondary-controls](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/correct-color-using-hsl-secondary-controls.html) |
| CO09 | Vignette | Amount, midpoint, roundness, feather. | […/add-video-effects/commonly-used-effects/create-vignettes-using-lumetri-color](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/create-vignettes-using-lumetri-color.html) |
| CO10 | LUT import (.cube) | Apply custom input or look LUTs. | […/correct-color/add-color-effects/install-custom-look-up-table-files](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/install-custom-look-up-table-files.html) |
| CO11 | Export a LUT | Save a grade as a LUT. | […/correct-color/add-color-effects/save-or-export-look-up-tables](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/save-or-export-look-up-tables.html) |
| CO12 | Several Lumetri instances per clip | Stack corrections. | […/correct-color/color-correction-fundamentals/create-and-edit-multiple-lumetri-color-effects](https://helpx.adobe.com/premiere/desktop/correct-color/color-correction-fundamentals/create-and-edit-multiple-lumetri-color-effects.html) |
| CO13 | Scopes: waveform, vectorscope, parade, histogram | Lumetri Scopes (Vectorscope YUV, Histogram, Parade, Waveform). | […/correct-color/add-color-effects/available-lumetri-scopes](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/available-lumetri-scopes.html) |
| CO14 | Colour management and working spaces | Rec.709 / Rec.2100 HLG/PQ sequences, source colour spaces. | […/correct-color/set-up-color-management/about-color-management](https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/about-color-management.html) |
| CO15 | Tone mapping HDR sources | Map HDR (iPhone HLG etc.) into SDR sequences. | […/correct-color/set-up-color-management/tone-mapping-in-premiere](https://helpx.adobe.com/premiere/desktop/correct-color/set-up-color-management/tone-mapping-in-premiere.html) |
| CO16 | HDR output | Export HDR for YouTube. | […/render-and-export/export-files/create-and-export-hdr-videos-for-youtube-on-mac](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/create-and-export-hdr-videos-for-youtube-on-mac.html) |
| CO17 | Color Mode clip grid, groups, grade copy/paste | Grade management across a sequence (27.0). | […/correct-color/color-mode-fundamentals/working-with-the-clip-grid](https://helpx.adobe.com/premiere/desktop/correct-color/color-mode-fundamentals/working-with-the-clip-grid.html) |
| CO18 | Before/after comparison | Compare the graded frame with the original or a reference. | […/correct-color/color-mode-fundamentals/about-comparison-view](https://helpx.adobe.com/premiere/desktop/correct-color/color-mode-fundamentals/about-comparison-view.html) |

### A.AU Audio

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| AU01 | Clip volume and gain | Gain and volume of clips. | […/add-audio-effects/adjust-volume-and-levels/adjust-gain-in-audio](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/adjust-gain-in-audio.html) |
| AU02 | Track volume | Track-level volume separate from clips. | […/add-audio-effects/adjust-volume-and-levels/adjust-track-volume](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/adjust-track-volume.html) |
| AU03 | Audio fades | Fade in/out clip audio. | […/add-audio-effects/apply-audio-transitions/fade-in-or-fade-out-clip-audio](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-transitions/fade-in-or-fade-out-clip-audio.html) |
| AU04 | Pan and balance | Pan mono, balance stereo, per clip and track. | […/add-audio-effects/apply-audio-effects/pan-or-balance-a-track-in-timeline](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/pan-or-balance-a-track-in-timeline.html) |
| AU05 | Mute, solo, global mute | Mute or solo tracks; mute all (26.2). | […/add-audio-effects/adjust-volume-and-levels/global-mute](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/global-mute.html) |
| AU06 | Submixes and buses | Route tracks into submixes. | […/add-audio-effects/advanced-audio-techniques/create-a-submix](https://helpx.adobe.com/premiere/desktop/add-audio-effects/advanced-audio-techniques/create-a-submix.html) |
| AU07 | Automation modes | Read, write, touch, latch automation of mixer moves. | […/add-audio-effects/apply-audio-effects/audio-track-mixer-automation-modes](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-track-mixer-automation-modes.html) |
| AU08 | Audio category tagging (auto) | Clips auto-tagged Dialogue/Music/SFX/Ambience. | […/add-audio-effects/adjust-volume-and-levels/audio-category-tagging](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/audio-category-tagging.html) |
| AU09 | Enhance Speech (AI) | Make dialogue sound studio-recorded. | […/add-audio-effects/adjust-volume-and-levels/enhance-speech](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/enhance-speech.html) |
| AU10 | Enhance Audio / repair dialogue / dialogue clarity | Reduce noise, reverb, rumble, hum, sibilance; dynamics, EQ (27.0). | […/add-audio-effects/adjust-volume-and-levels/repair-dialogue](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/repair-dialogue.html) |
| AU11 | Auto ducking | Lower music under dialogue automatically; updates as you edit (27.0). | […/add-audio-effects/adjust-volume-and-levels/automatically-duck-audio](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/automatically-duck-audio.html) |
| AU12 | Auto-match loudness / normalise | Match loudness to a target. | […/add-audio-effects/adjust-volume-and-levels/auto-match-audio-loudness](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/auto-match-audio-loudness.html) |
| AU13 | Loudness meter and audio meters | Meters and LUFS loudness radar. | […/add-audio-effects/apply-audio-effects/about-loudness-meter](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/about-loudness-meter.html) |
| AU14 | Remix (retime music to fit) | Recompose music to any length at musical points. | […/add-audio-effects/apply-audio-effects/remix-audio-in-premiere](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/remix-audio-in-premiere.html) |
| AU15 | Dynamics: compressor, limiter, multiband | Amplitude and compression effects. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU16 | EQ and filters | Parametric/graphic EQ, highpass, lowpass, notch, bass, treble. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU17 | Delay, echo and reverb | Analog/multitap delay, convolution and studio reverb. | […/add-audio-effects/adjust-volume-and-levels/create-reverb-effect](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/create-reverb-effect.html) |
| AU18 | Modulation | Chorus, flanger, phaser. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU19 | Noise reduction and restoration | DeNoise, DeHummer, DeReverb, Automatic Click Remover. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU20 | Pitch shifter and voice effects | Pitch shift, distortion, special effects. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU21 | Vocal enhancer and mastering | Quick voice and master chains. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU22 | Stereo and channel tools | Stereo expander, swap channels, fill left/right, invert. | […/add-audio-effects/apply-audio-effects/audio-effects-library](https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-effects/audio-effects-library.html) |
| AU23 | Audio channel mapping; split stereo to mono | Map source channels; use one channel of a lav mic. | […/add-audio-effects/advanced-audio-techniques/audio-channel-mapping](https://helpx.adobe.com/premiere/desktop/add-audio-effects/advanced-audio-techniques/audio-channel-mapping.html) |
| AU24 | Waveforms | Clip waveforms, live waveform while recording (27.0). | […/add-audio-effects/adjust-volume-and-levels/dynamic-audio-waveforms](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/dynamic-audio-waveforms.html) |
| AU25 | Separate overlapping speakers | Split crosstalk into stems (27.0, Firefly audio). | […/add-audio-effects/basic-audio-editing/separate-overlapping-speakers](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/separate-overlapping-speakers.html) |
| AU26 | Bulk mute or bleep words | Mute or bleep selected words from the transcript. | […/add-audio-effects/advanced-audio-techniques/clean-audio-with-bulk-mute-or-bleep](https://helpx.adobe.com/premiere/desktop/add-audio-effects/advanced-audio-techniques/clean-audio-with-bulk-mute-or-bleep.html) |
| AU27 | Extract audio | Make an audio file from a clip. | […/add-audio-effects/basic-audio-editing/extract-audio-from-clips](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/extract-audio-from-clips.html) |
| AU28 | Record a voice-over | Record on a track from the timeline. | […/organize-media/import-files/record-a-voice-over-on-an-audio-track-from-the-timeline](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/record-a-voice-over-on-an-audio-track-from-the-timeline.html) |
| AU29 | Audio presets | Save audio effect settings. | […/add-audio-effects/adjust-volume-and-levels/create-audio-presets](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/create-audio-presets.html) |

### A.AI AI features (Sensei and Firefly)

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| AI01 | Generative Extend | Add frames (and ambient audio) at the start or end of a clip, also to fill transition handles (Firefly; 360p-4K; no speech). | […/edit-projects/edit-with-generative-ai/generative-extend-overview](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-extend-overview.html) |
| AI02 | Generative Remove | Remove objects from video. | […/edit-projects/edit-with-generative-ai/generative-remove](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generative-remove.html) |
| AI03 | Generative Media Tool | Drag a region on a track, type a prompt: video, image, music, SFX or soundscape appears there (26.5, 27.0). | […/edit-projects/edit-with-generative-ai/generate-media-with-generative-media-tool](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generate-media-with-generative-media-tool.html) |
| AI04 | Generate music | Text-to-music to the timeline. | […/edit-projects/edit-with-generative-ai/generate-music-overview](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/generate-music-overview.html) |
| AI05 | Generate sound effects | Text-to-SFX to the timeline. | […/edit-projects/edit-with-generative-ai/add-generated-sound-effects-to-your-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/add-generated-sound-effects-to-your-timeline.html) |
| AI06 | Generate soundscape from video | Ambience and SFX layers that match the video (27.0). | […/edit-projects/edit-with-generative-ai/add-generated-soundscape-to-your-timeline](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/add-generated-soundscape-to-your-timeline.html) |
| AI07 | Morph Cut | Smooth a jump cut in a talking head. | […/add-video-effects/apply-video-transitions/morph-cut-overview](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/morph-cut-overview.html) |
| AI08 | Auto Reframe (Sensei) | AI subject tracking for new aspect ratios. | […/add-video-effects/commonly-used-effects/auto-reframe-overview](https://helpx.adobe.com/premiere/desktop/add-video-effects/commonly-used-effects/auto-reframe-overview.html) |
| AI09 | Scene Edit Detection (Sensei) | AI cut detection. | […/edit-projects/change-clip-sequence/detect-edit-points-using-scene-edit-detection](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/detect-edit-points-using-scene-edit-detection.html) |
| AI10 | Speech to Text and text-based editing (Sensei) | AI transcription. | […/add-text-images/insert-captions/auto-transcribe-video-using-speech-to-text](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/auto-transcribe-video-using-speech-to-text.html) |
| AI11 | Object Mask (AI) | One-click object isolation and tracking. | […/add-video-effects/work-with-masks/object-masking](https://helpx.adobe.com/premiere/desktop/add-video-effects/work-with-masks/object-masking.html) |
| AI12 | Colour Match (Sensei) | AI shot matching. | […/correct-color/add-color-effects/match-color-between-shots](https://helpx.adobe.com/premiere/desktop/correct-color/add-color-effects/match-color-between-shots.html) |
| AI13 | Enhance Speech (Sensei/Firefly) | AI dialogue enhancement. | […/add-audio-effects/adjust-volume-and-levels/enhance-speech](https://helpx.adobe.com/premiere/desktop/add-audio-effects/adjust-volume-and-levels/enhance-speech.html) |
| AI14 | Media Intelligence (Sensei) | AI visual search. | […/organize-media/file-organization/search-for-media-using-ai-powered-media-intelligence](https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/search-for-media-using-ai-powered-media-intelligence.html) |
| AI15 | AI Assistant with skills and references | Agent that acts on the project; custom skills; references in prompts (27.0). | […/premiere-ai-assistant/customize-ai-assistant-with-skills](https://helpx.adobe.com/premiere/desktop/premiere-ai-assistant/customize-ai-assistant-with-skills.html) |
| AI16 | Caption translation (cloud) | Machine translation of captions. | […/add-text-images/insert-captions/translate-captions](https://helpx.adobe.com/premiere/desktop/add-text-images/insert-captions/translate-captions.html) |
| AI17 | Content Credentials on export | Attach provenance and generative-AI use to exports (26.2). | […/render-and-export/export-files/export-videos-with-content-credentials](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-videos-with-content-credentials.html) |
| AI18 | Cloud AI voice features | Cloud processing for AI voice features. | […/edit-projects/edit-with-generative-ai/about-cloud-based-ai-voice-features](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-with-generative-ai/about-cloud-based-ai-voice-features.html) |

### A.PB Playback and preview

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| PB01 | Real-time GPU playback (Mercury Playback Engine) | GPU-accelerated real-time playback of effects. | […/get-started/download-and-install/mercury-playback-engine-gpu-accelerated-in-premiere](https://helpx.adobe.com/premiere/desktop/get-started/download-and-install/mercury-playback-engine-gpu-accelerated-in-premiere.html) |
| PB02 | Render In to Out / preview files | Render a section for smooth playback. | […/render-and-export/render-sequences-for-playback/use-preview-files-when-rendering](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/use-preview-files-when-rendering.html) |
| PB03 | Render and replace | Flatten a clip with its effects into a new file. | […/render-and-export/render-sequences-for-playback/render-and-replace-media-in-a-sequence](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/render-and-replace-media-in-a-sequence.html) |
| PB04 | Playback resolution | Full, 1/2, 1/4 playback resolution. | […/get-started/source-and-program-monitor-adjustments/set-display-quality-for-the-source-and-program-monitors](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/set-display-quality-for-the-source-and-program-monitors.html) |
| PB05 | High quality playback | Toggle high-quality playback / pause frame. | […/get-started/source-and-program-monitor-adjustments/enable-high-quality-playback](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/enable-high-quality-playback.html) |
| PB06 | Loop, preroll and postroll playback | Loop a range; play around the playhead. | […/render-and-export/render-sequences-for-playback/play-back-in-a-continuous-loop](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/play-back-in-a-continuous-loop.html) |
| PB07 | J / K / L shuttle | Shuttle backwards/forwards at increasing speeds. | […/get-started/keyboard-shortcuts/default-keyboard-shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html) |
| PB08 | Dropped frame indicator | Shows when playback drops frames. | […/get-started/source-and-program-monitor-adjustments/enable-dropped-frame-indicator](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/enable-dropped-frame-indicator.html) |
| PB09 | Compare view in the Program Monitor | Side-by-side or split compare of shots. | […/get-started/source-and-program-monitor-adjustments/compare-edits-to-clips-in-the-program-monitor](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/compare-edits-to-clips-in-the-program-monitor.html) |
| PB10 | In and Out points | Mark In/Out in source and sequence. | […/get-started/source-and-program-monitor-adjustments/set-in-and-out-points-in-the-source-monitor](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/set-in-and-out-points-in-the-source-monitor.html) |
| PB11 | Monitor magnification | Zoom the monitor. | […/get-started/source-and-program-monitor-adjustments/adjust-the-magnification-for-the-source-and-program-monitors](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/adjust-the-magnification-for-the-source-and-program-monitors.html) |
| PB12 | Time controls and timecode entry | Timecode fields, frame step. | […/get-started/source-and-program-monitor-adjustments/time-controls-in-the-source-and-program-monitors](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/time-controls-in-the-source-and-program-monitors.html) |
| PB13 | Smart rendering | Export untouched segments without re-encoding. | […/render-and-export/render-sequences-for-playback/smart-rendering-supported-formats](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/smart-rendering-supported-formats.html) |
| PB14 | Overlays in the monitor (timecode, markers) | Overlay settings in monitors. | […/get-started/source-and-program-monitor-adjustments/set-overlay-settings](https://helpx.adobe.com/premiere/desktop/get-started/source-and-program-monitor-adjustments/set-overlay-settings.html) |
| PB15 | Waveforms in the Source Monitor | Audio waveform with the video (26.2). | […/add-audio-effects/basic-audio-editing/view-audio-and-video-waveforms-in-the-source-monitor](https://helpx.adobe.com/premiere/desktop/add-audio-effects/basic-audio-editing/view-audio-and-video-waveforms-in-the-source-monitor.html) |

### A.EX Export

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| EX01 | Export settings and presets | Export mode with presets and settings. | […/render-and-export/export-files/overview-of-export-settings](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/overview-of-export-settings.html) |
| EX02 | Codecs and formats | H.264, HEVC, AV1, ProRes, DNxHR, GIF, image sequences, WAV/MP3/AAC. | […/render-and-export/export-files/supported-export-file-formats](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/supported-export-file-formats.html) |
| EX03 | Encoding settings | Bitrate (CBR/VBR), profile, level, keyframe distance. | […/render-and-export/export-files/video-encoding-settings](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/video-encoding-settings.html) |
| EX04 | Quick Export | One-click export with a preset. | […/render-and-export/export-files/quickly-export-a-video-file](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/quickly-export-a-video-file.html) |
| EX05 | Media Encoder queue / batch | Queue many exports, watch folders. | […/render-and-export/export-files/export-directly-to-adobe-media-encoder](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-directly-to-adobe-media-encoder.html) |
| EX06 | Social media presets and publishing | Presets for platforms; publish to YouTube, TikTok etc. | […/render-and-export/export-files/export-videos-for-social-media-channels](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-videos-for-social-media-channels.html) |
| EX07 | Custom presets and preset manager | Save export presets. | […/render-and-export/export-files/create-and-save-custom-presets](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/create-and-save-custom-presets.html) |
| EX08 | Transcript export | Export the transcript as text. | […/render-and-export/export-files/export-transcripts](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-transcripts.html) |
| EX09 | Export a still frame | Save the current frame as an image. | […/render-and-export/export-files/export-a-still-frame](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-still-frame.html) |
| EX10 | Visual watermark | Add an image/text watermark at export. | […/render-and-export/export-files/add-a-visual-watermark-during-export](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/add-a-visual-watermark-during-export.html) |
| EX11 | Interchange: EDL, FCP XML, AAF, OMF | Hand edits to other tools. | […/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html) |
| EX12 | Audio-only export | Export WAV/MP3/AAC. | […/render-and-export/export-files/export-video-and-audio-files](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-video-and-audio-files.html) |
| EX13 | Export progress | Progress of encoding. | […/render-and-export/export-files/export-options-in-premiere](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-options-in-premiere.html) |
| EX14 | High resolutions and frame rates | 4K/8K, any rate incl. fractional. | […/render-and-export/export-files/basic-video-settings](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/basic-video-settings.html) |
| EX15 | Live stream output (SRT) | Stream the program output. | […/render-and-export/stream-video/overview-of-secure-reliable-transport](https://helpx.adobe.com/premiere/desktop/render-and-export/stream-video/overview-of-secure-reliable-transport.html) |

### A.CL Collaboration

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| CL01 | Team Projects | Cloud projects several editors share, with sync and conflict handling. | […/collaborate-with-others/collaborate-using-team-projects/about-team-projects](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/collaborate-using-team-projects/about-team-projects.html) |
| CL02 | Versions and auto-saves | Browse and restore earlier versions. | […/collaborate-with-others/collaborate-using-team-projects/view-versions-of-a-team-project](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/collaborate-using-team-projects/view-versions-of-a-team-project.html) |
| CL03 | Sequence locking and online collaborators | See who is in a project; lock sequences. | […/collaborate-with-others/collaborate-using-team-projects/view-online-collaborators](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/collaborate-using-team-projects/view-online-collaborators.html) |
| CL04 | Share for review (Frame.io) | Share a link to a version for review. | […/collaborate-with-others/share-for-review-using-frame-io/share-for-review-with-frame-io](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/share-for-review-with-frame-io.html) |
| CL05 | Time-stamped comments and annotations | Reviewers comment on frames. | […/collaborate-with-others/share-for-review-using-frame-io/add-comments-on-shared-projects](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/add-comments-on-shared-projects.html) |
| CL06 | Import comments as markers | Review comments appear as timeline markers. | […/collaborate-with-others/share-for-review-using-frame-io/import-comments-as-markers](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/import-comments-as-markers.html) |
| CL07 | Invite collaborators to co-edit | Invite people into a project. | […/collaborate-with-others/share-for-review-using-frame-io/invite-collaborators-to-co-edit-a-project](https://helpx.adobe.com/premiere/desktop/collaborate-with-others/share-for-review-using-frame-io/invite-collaborators-to-co-edit-a-project.html) |
| CL08 | Dynamic Link and round trips (After Effects, Audition, Photoshop) | Edit in another Adobe app and come back live. | […/use-premiere-with-other-apps/working-with-other-adobe-applications/share-assets-between-after-effects-and-premiere-using-dynamic-link](https://helpx.adobe.com/premiere/desktop/use-premiere-with-other-apps/working-with-other-adobe-applications/share-assets-between-after-effects-and-premiere-using-dynamic-link.html) |
| CL09 | Plug-ins and extensions | Third-party effects and panels. | […/use-premiere-with-other-apps/plug-ins](https://helpx.adobe.com/premiere/desktop/use-premiere-with-other-apps/plug-ins.html) |

### A.KS Shortcuts and workspaces

| ID | Feature | What it does in Premiere | Adobe page |
|---|---|---|---|
| KS01 | Default keyboard shortcuts | Tools (V, A, B, N, R, C, Y, U), J/K/L, I/O, insert (,), overwrite (.), lift (;), extract ('), marker (M), add edit (Ctrl+K), extend edit (E), ripple delete, link (Ctrl+L), match frame (F), export (Ctrl+M). | […/get-started/keyboard-shortcuts/default-keyboard-shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html) |
| KS02 | Customise shortcuts | Remap keys, several keys per command. | […/get-started/keyboard-shortcuts/customize-keyboard-shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/customize-keyboard-shortcuts.html) |
| KS03 | Find and print shortcuts | Search the shortcut list. | […/get-started/keyboard-shortcuts/find-keyboard-shortcuts](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/find-keyboard-shortcuts.html) |
| KS04 | Import and manage workspaces | Share workspaces. | […/get-started/tour-the-workspace/import-workspaces](https://helpx.adobe.com/premiere/desktop/get-started/tour-the-workspace/import-workspaces.html) |

---

## B. Gap matrix

One row per item in A, in the same order. "Evidence" cites our code at `413432e`.

### B.WS Workspaces and panels

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| WS01 | Workspaces (Editing, Color, Audio, Captions, Effects ...) | **partial** | One fixed editor page: preview, timeline strip, inspector sections (cc/components/editor/TimelineEditor.tsx:1456-1620) | browser | M | none | P3 | Named inspector layouts (Edit / Colour / Audio / Captions tabs) stored per user in localStorage; no document change. |
| WS02 | Dock, group, undock and resize panels | **missing** | Layout is fixed CSS (TimelineEditor.tsx:1451-1460) | browser | M | none | P3 | Resizable split panes (preview / timeline / inspector); keep the phone layout as is. |
| WS03 | Project panel views (list, icon, freeform) | **partial** | Library page with grid/list view, kind filter, sort (cc/components/media/libraryView.ts:22, cc/lib/view-mode.ts:29) | browser | S | none | P3 | Add a library drawer inside the editor (today media is picked through SendToEditor / pickers). |
| WS04 | Source Monitor | **missing** | A file is added whole (appendAssetToDoc, cc/lib/editor.ts:3070) and trimmed on the timeline | browser | M | none | P1 | A second <video> on the proxy with I/O marks; Insert / Overwrite / Append from it (see TE11, TE12). |
| WS05 | Program Monitor | **partial** | <video> on the 480p proxy with CSS/SVG approximations; sharpen, grain, temperature, curves, xfade styles, overlays motion not drawn (TimelineEditor.tsx:1456-1620, ClipPicture.tsx:18-25, docs/editor-render-fields.md "Preview") | browser | XL | none | P0 | Real-time compositor on WebCodecs + WebGL (section D9); the export stays the reference. |
| WS06 | Timeline panel with tracks | **partial** | TimelineStrip lanes for picture, texts, sounds, overlays, shapes (cc/components/editor/TimelineStrip.tsx:24-45); ONE picture lane (modules/timeline.py:59-63, 844) | browser + server ffmpeg | XL | high: each V lane is one more input of the final pass | P0 | Several V tracks (section D1/D2): generalise `overlays` into V tracks with full clip fields. |
| WS07 | Effect Controls panel | **partial** | Inspector sections per clip (cc/components/editor/ClipLookSections.tsx, ClipMotionSections.tsx, FxControls.tsx); no keyframe lane | browser | L | none | P1 | Inspector rows gain a keyframe diamond and a lane once generic keyframes exist (D1). |
| WS08 | Properties panel (cards) | **have** | Our inspector already is a card list of sections (FxControls.tsx:45, ClipLookSections.tsx, ShapePanel.tsx) | browser | S | none | P3 | Keep; add effect reordering once effects become a list (D3). |
| WS09 | Effects panel with search, thumbnails and preview videos | **partial** | Transition picker with glyphs (cc/components/editor/TransitionStylePicker.tsx), text look picker (TextLookPicker.tsx); no searchable effects browser | browser | M | none | P2 | One searchable "Effects" drawer over the closed lists, with small looping preview clips we render once. |
| WS10 | Essential Sound panel | **partial** | Sound role music/speech (cc/lib/editor.ts:113), duck, denoise, loudnorm (ClipSoundTools.tsx, CleanSections.tsx) | browser + server ffmpeg | M | low | P2 | Extend ROLES to sfx/ambience with per-role presets (EQ, loudness target, duck). |
| WS11 | Audio Track Mixer | **missing** | Each sound sits on its own A track, no track level or pan (cc/lib/editor.ts toModel 2551-2600) | browser + server ffmpeg | L | low: amix inputs | P2 | Section D6: track gain/pan/mute/solo and buses in the document; mixer UI over them. |
| WS12 | Audio Clip Mixer | **partial** | Per-clip gain slider only (setClipVolume, cc/lib/editor.ts:3370; ClipSoundTools.tsx) | browser | M | none | P2 | Clip pan + gain keyframes (D1) shown as a mixer strip. |
| WS13 | Lumetri Scopes panel | **missing** | none | browser | M | none | P2 | Section D7: scopes computed in WebGL from the preview frame. |
| WS14 | History panel | **partial** | Undo / redo stack with gesture grouping (TimelineEditor.tsx:520-544) but no visible list | browser | S | none | P2 | Name each history step (we already group them) and show a list. |
| WS15 | Info panel | **partial** | Inspector shows times; asset width/height/duration in EditorAsset (cc/lib/editor.ts:2951) | browser | S | none | P3 | Small info block in the inspector. |
| WS16 | Events panel (warnings and errors) | **partial** | Settle notices and render-budget notice (cc/components/editor/SettleNotice.tsx, cc/lib/editorSettle.ts:122) | browser | S | none | P3 | Keep notices; add a list of the last N. |
| WS17 | Metadata panel | **missing** | Only technical probe data (EditorAsset, cc/lib/editor.ts:2951) | browser | S | none | P3 | Show probe data; editable title/notes on media rows later. |
| WS18 | Text panel (Transcript and Captions tabs) | **partial** | Caption cue list and editor (cc/components/editor/CaptionsPanel.tsx); no transcript editing of the picture | browser | L | none | P1 | See TB rows; transcript view built from caption word timings. |
| WS19 | Sequence Index panel | **missing** | none | browser | S | none | P3 | A table view of the model (clips, texts, sounds, markers) with jump-to. |
| WS20 | Search panel | **partial** | Library search box by name (cc/components/media/MediaLibrary.tsx:1006) | browser + first-party AI API | M | none | P2 | Name + transcript + marker search first (free), visual search later (PM19). |
| WS21 | AI Assistant panel | **missing** | No editor agent (docs/CREATIVE_OS_PLAN.md P3 PR 15 is a job agent) | first-party AI API | XL | low: edits are validated documents | P1 | Prompt-to-edit agent writing document operations (section C1, D-agent), first-party LLM API only. |
| WS22 | Color Mode workspace | **missing** | none | browser | L | none | P2 | A "Colour" layout: clip strip of the project, grade copy/paste, scopes, before/after. |
| WS23 | Full-screen panel or monitor | **missing** | none | browser | S | none | P3 | Fullscreen API on the preview box. |
| WS24 | Video on a second monitor | **missing** | none | browser | M | none | P3 | Pop-out preview window (window.open + BroadcastChannel). |
| WS25 | Keyboard navigation and accessibility | **have** | Focus-aware shortcut model (cc/lib/editor-shortcuts.ts:22-31, 77-103), role=slider controls, polite live regions (docs/editor-render-fields.md "Editor controls") | browser | S | none | P3 | Keep. |
| WS26 | Touch and gesture controls | **have** | Touch snap threshold (cc/lib/editor-timeline-view.ts:31), phone layout (cc/tests/editor-mobile-polish.test.ts) | browser | S | none | P3 | Keep; pinch zoom on the strip. |
| WS27 | Preferences | **missing** | none | browser | S | none | P3 | Per-user editor settings (default transition length, snapping on/off, still length). |
| WS28 | Safe margins (title/action safe) | **missing** | none | browser | S | none | P1 | Safe-area overlays, including the TikTok / Reels / Shorts UI zones per frame preset (better than Premiere's generic margins). |
| WS29 | Guides and snapping to guides | **missing** | none | browser | S | none | P2 | Centre / thirds guides and snapping while dragging overlays and texts. |
| WS30 | Direct manipulation in the Program Monitor | **partial** | Shapes can be dragged and nudged with arrows in the preview (docs/editor-render-fields.md track E, line 768); texts and overlays use sliders | browser | M | none | P1 | Transform handles on every layer in the preview, writing x/y/w/angle. |

### B.PM Project and media management

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| PM01 | Create and open projects | **have** | editor_projects with a revision number for optimistic saves, 200 per org (supabase/migrations/0054_editor_projects.sql:108, 264); EditorHome.tsx | browser | S | none | P3 | Keep. |
| PM02 | Project templates | **missing** | No template documents | browser | M | none | P1 | Section C8: templates are documents with placeholder slots (`slot` ids), starter set shipped. |
| PM03 | Several projects open; copy between projects | **partial** | Copy/paste is within one project, one clip (docs/editor-render-fields.md §12 "Duplicate, copy, paste") | browser | S | none | P3 | Clipboard in localStorage keyed by org, pasting asset ids the org owns. |
| PM04 | Auto save | **have** | Local draft (cc/lib/editor-draft.ts, cc/components/editor/useEditorDraft.ts, DraftBanner.tsx) plus saving to the project row (0054) | browser | S | none | P3 | Keep. |
| PM05 | Consolidate and archive a project | **missing** | none | server ffmpeg | M | low | P3 | Later: "download project package" (document JSON + used files). |
| PM06 | Import of many file formats | **partial** | MP4, MOV, WebM, MKV; JPEG, PNG, WebP, GIF, HEIC; MP3, M4A, WAV, OGG, FLAC, AAC; SRT, VTT (modules/media_library.py:73-93) | server ffmpeg | S | low: decode caps (modules/render_spec.py:131-140) | P3 | Add SVG (rasterised), and ProRes / HEVC 10-bit check in the probe. |
| PM07 | Image sequence import | **missing** | none | server ffmpeg | M | low | P3 | Zip upload converted to a video asset by the worker. |
| PM08 | Layered Photoshop / Illustrator import | **missing** | none | not for the web | L | low | P3 | Not planned; PNG with alpha covers the creator case. |
| PM09 | Import media from Firefly Boards as a ready sequence | **partial** | Studio results go to the editor one at a time ("Add to project", cc/components/editor/SendToEditor.tsx; cc/lib/creative/improve.ts editorAddHref) | browser | S | none | P2 | "Send selection to editor as a sequence" from Studio / library: N assets appended in order. |
| PM10 | Import other editors' projects (Avid, FCPX, XML) | **missing** | none | browser | L | none | P3 | Optional FCPXML / OTIO import mapping to our document. |
| PM11 | Camera RAW and pro codecs | **missing** | none | not for the web | XL | high | P3 | Not for our users. |
| PM12 | Ingest and proxy workflow | **partial** | Every video gets a 480p H.264 proxy and a thumbnail at upload (modules/media_library.py:133-140, 799); the preview plays it | server ffmpeg | M | low | P2 | Section D8: a 720p proxy tier and a preview-quality switch. |
| PM13 | Create and attach proxies; toggle proxies | **partial** | Proxies are automatic; preview is always proxy, export always original (docs/editor-render-fields.md §14 "Silence removal") | browser + server ffmpeg | M | none | P2 | Same as PM12 (D8). |
| PM14 | Bins (folders) | **partial** | Flat media folders, 200 per org (supabase/migrations/0049_media_folders.sql) | browser | S | none | P3 | Nested folders later; smart bins via search. |
| PM15 | Find and search media | **partial** | Name search, kind filter, sort (cc/components/media/libraryView.ts:22, MediaLibrary.tsx:1006) | browser | S | none | P3 | Add duration / size / date filters. |
| PM16 | Labels (colour labels) | **missing** | none | browser | S | none | P3 | Optional `label` on clips (closed colour list). |
| PM17 | Metadata (XMP, schemas, overlays) | **partial** | Technical metadata only (width, height, duration, has_audio; EditorAsset cc/lib/editor.ts:2951) | browser | M | none | P3 | Not a creator need. |
| PM18 | Media Intelligence visual search | **missing** | Registry has Google gemini-3.6-flash for `describe` only (schemas/model_registry.json:696) | first-party AI API | L | low | P2 | Index each upload with a first-party multimodal model (Google Gemini) into text + timestamps; search over it. Credits per indexed minute. |
| PM19 | Similar-visuals and audio search | **missing** | none | first-party AI API | L | low | P3 | After PM18 (embeddings from the same maker). |
| PM20 | Relink and replace media | **partial** | Files are ids, never paths (modules/timeline.py:55-62); a missing file fails the export as asset_unavailable (modules/editor_export.py:156); no "replace footage" | browser | S | none | P2 | "Replace media" keeps in/out and every field, swaps asset_id (validators unchanged). |
| PM21 | Subclips | **missing** | none | browser | S | none | P3 | Saved in/out ranges on a media row. |
| PM22 | Merged clips (separate audio recorder) | **missing** | none | browser + server ffmpeg | M | none | P3 | Comes with waveform sync (SQ09). |
| PM23 | Interpret footage | **missing** | none | server ffmpeg | S | none | P3 | `source_fps` override on a clip (setpts) for slow-motion phone footage (120/240 fps as 30). |
| PM24 | Productions | **partial** | Organization-wide library and projects with RLS (0038, 0054) | browser | S | none | P3 | Keep. |
| PM25 | Creative Cloud Libraries | **partial** | Style kits and characters exist for Studio (supabase/migrations/0047_style_kits_characters.sql), brand kit in Ads Factory (cc/lib/adsFactory/model.ts:492); neither in the editor | browser | M | none | P1 | Brand kit in the editor (section C6). |
| PM26 | Built-in stock footage | **missing** | none | not for the web | L | none | P2 | Replaced by first-party AI b-roll in the timeline (C2); a stock vendor is a licensing decision. |
| PM27 | Stock audio | **missing** | none | not for the web | L | none | P2 | Generated music / SFX (AI04, AI05) plus an owner-licensed catalogue. |
| PM28 | Timecode display and entry | **partial** | Timecode display (cc/components/ui/Timecode, formatTime cc/lib/editor.ts:3790) | browser | S | none | P3 | Typed timecode jump. |
| PM29 | Thumbnails and hover scrub | **partial** | JPEG thumbnail per asset (modules/media_library.py:139) | browser | S | none | P3 | Hover scrub on the proxy. |

### B.SQ Sequences

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| SQ01 | Create a sequence from a clip or preset | **have** | newDocForAsset / frameFor (cc/lib/editor.ts:2963-3009), frame presets (cc/lib/editorFrame.ts) | browser | S | none | P3 | Keep. |
| SQ02 | Sequence settings (frame size, frame rate) | **partial** | width/height/fps fields; fps 24/25/30/50/60 only, no 23.976/29.97 (cc/lib/editor.ts:77) | server ffmpeg | M | low | P2 | Add fractional rates (24000/1001, 30000/1001) as rationals; touches every frame-count rule in both validators. |
| SQ03 | Custom sequence presets | **missing** | Closed preset list (schemas/export_presets.json:4-12) | browser | S | none | P3 | Not needed beyond the closed list. |
| SQ04 | Sequence aspect ratio (vertical, square) | **have** | Frame presets and fit contain/cover/blur (cc/lib/editorFrame.ts, cc/lib/editor.ts:163; docs/editor-render-fields.md §5) | browser | S | none | P3 | Keep. |
| SQ05 | Several sequences in one project | **missing** | One document per project (0054) | browser | M | none | P2 | Comes with nesting (D2): `sequences` map in the document. |
| SQ06 | Nested sequences | **missing** | none | browser + server ffmpeg | L | high: nested render = an extra full decode/encode pass | P2 | Section D2 (compound clips rendered to an intermediate first). |
| SQ07 | Multi-camera source sequence | **missing** | none | browser + server ffmpeg | L | med: N angle decodes in preview only | P2 | Section D4. |
| SQ08 | Multi-camera editing | **missing** | none | browser | L | low: export renders only the chosen angle per cut | P2 | Section D4. |
| SQ09 | Synchronise clips by audio waveform | **missing** | Browser already decodes audio for silence detection (cc/lib/editorSilence.ts:49-104) | browser | M | none | P2 | Cross-correlation of the decoded envelopes in a Web Worker (same decode path as silence detection). |
| SQ10 | Add, delete and rename tracks | **partial** | Every sound gets its own A track; one V track only (cc/lib/editor.ts:2691-2698; modules/timeline.py:844) | browser | M | med | P1 | With D1-style V tracks: explicit tracks in the editor model. |
| SQ11 | Stacked video tracks (V1, V2, V3 ...) | **partial** | `overlays` layer above the picture: max 16 with shapes, 4 videos, silent, no clip fields (modules/timeline.py:221-236; cc/lib/editor.ts:155-159) | server ffmpeg | XL | high: each layer is an input of the final pass under 2 GiB | P0 | Section D1: V tracks with the full clip field set; overlays become a V track kind. |
| SQ12 | Track lock | **missing** | none | browser | S | none | P3 | Editor-only flag (`locked` on the track, ignored by the render). |
| SQ13 | Sync lock | **missing** | Ripple on the V lane leaves texts, sounds and overlays in place (docs/editor-render-fields.md §14 "Silence removal") | browser | M | none | P1 | Ripple-aware operations shift linked items after the edit point; per-track sync-lock flag. |
| SQ14 | Track appearance (height, waveforms, thumbnails) | **partial** | Lanes and waveforms for sound files (cc/components/editor/SoundWave.tsx) | browser | S | none | P3 | Filmstrip thumbnails from the proxy. |
| SQ15 | Simplify sequence | **missing** | none | browser | S | none | P3 | Not needed. |
| SQ16 | Scene edit detection | **missing** | none | server ffmpeg | M | low: one decode pass (scdet) | P1 | Worker probe with ffmpeg `scdet` on the proxy writes cut times; "Split at scenes" applies them as one undo step. |
| SQ17 | Auto Reframe a whole sequence | **partial** | One edit exported in several frames with each clip's fit (modules/editor_export.py:200-256, migration 0129, dark); AI reframe model is a placeholder (schemas/model_registry.json:2867) | server ffmpeg + first-party AI API | L | med | P0 | Subject track (free CPU face/saliency on the worker, or first-party vision API) writes per-clip pan keyframes for each ratio. |
| SQ18 | Pixel aspect ratio and interlaced footage | **partial** | New chains output square pixels (setsar=1, docs/editor-render-fields.md §5); no field handling | not for the web | S | none | P3 | Deinterlace (yadif) when the probe sees interlaced; nothing else. |
| SQ19 | VR / 360 editing | **missing** | none | not for the web | XL | high | P3 | Not planned. |

### B.TE Timeline editing

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| TE01 | Selection tool and multi-select | **partial** | One selected item at a time (Selection type, cc/components/editor/TimelineStrip.tsx:24-27) | browser | M | none | P1 | Selection becomes a set; every operation takes a list (one undo step). |
| TE02 | Track Select forward/backward | **missing** | none | browser | S | none | P2 | After TE01. |
| TE03 | Ripple edit / ripple trim | **have** | The V lane is magnetic: trimClip ripples later clips (cc/lib/editor.ts:3122-3141; layout 2248) | browser | S | none | P3 | Keep; add Q/W "ripple trim to playhead" keys. |
| TE04 | Rolling edit | **missing** | none | browser | S | none | P1 | Pure model op: out of A and in of B move together (both validators unchanged). |
| TE05 | Slip edit | **missing** | none | browser | S | none | P1 | Pure model op on in_s/out_s with source-length bounds; preview shows first/last frame. |
| TE06 | Slide edit | **missing** | none | browser | S | none | P2 | Pure model op on three clips. |
| TE07 | Rate Stretch tool | **partial** | Speed by keys/number 0.1-10 (setSpeed cc/lib/editor.ts:3320) | browser | S | none | P2 | Alt-drag on the trim handle writes `speed`. |
| TE08 | Razor / Add Edit | **have** | splitClip (cc/lib/editor.ts:3193), S key (cc/lib/editor-shortcuts.ts:99); a curved clip cannot be split (docs/editor-render-fields.md §9) | browser | S | none | P3 | Add "split all tracks at playhead" (texts, sounds too). |
| TE09 | Trim mode, dynamic JKL trimming, asymmetrical trim | **missing** | none | browser | M | none | P3 | Not a creator priority. |
| TE10 | Trim with handles and numbers | **have** | Trim handles with snapping (snapTrimValue, cc/lib/editor-timeline-view.ts:203; TimelineStrip.tsx) | browser | S | none | P3 | Keep. |
| TE11 | Insert and overwrite edits | **partial** | Append (appendAssetToDoc cc/lib/editor.ts:3070), paste after a clip (insertClipCopy 3287), reorder (moveClip 3321); no insert at playhead, no overwrite | browser | S | none | P1 | Insert at playhead = split + insert; overwrite on V2+ tracks once they exist. |
| TE12 | Three-point editing and source patching | **missing** | none | browser | M | none | P2 | After WS04 and SQ11. |
| TE13 | Track targeting | **missing** | none | browser | S | none | P3 | After SQ11. |
| TE14 | Lift and Extract | **partial** | Delete ripples (removeClip cc/lib/editor.ts:3488) = extract; no range delete; no gap on the V lane by design | browser | S | none | P2 | Range delete by I/O marks (split, split, remove). |
| TE15 | J-cuts and L-cuts | **partial** | Possible by hand after "Detach audio" (detachClipAudio cc/lib/editor.ts:3410) | browser | S | none | P1 | One-click "extend sound under next clip" by N frames (detached sound trimmed past the cut). |
| TE16 | Link / unlink audio and video | **partial** | A V clip carries its own sound (`audio`); detach unlinks; no relink (cc/lib/editor.ts:3389-3448) | browser | S | none | P2 | `link` id on a detached A clip so moves and trims follow. |
| TE17 | Group clips | **missing** | none | browser | S | none | P2 | `group` id on items; editor-only behaviour. |
| TE18 | Enable / disable a clip | **missing** | none | browser + server ffmpeg | S | none | P3 | `enabled:false` skipped by the layout and render (both validators). |
| TE19 | Snapping | **have** | snapTargets / snapTime incl. beats, 8 px (12 on touch) (cc/lib/editor-timeline-view.ts:29-33, 144-229) | browser | S | none | P3 | Add an on/off toggle and stored-marker targets. |
| TE20 | Sequence markers | **partial** | Beat markers from a sound are drawn and snapped to, but not stored (cc/lib/editorBeats.ts:48-106; docs/editor-render-fields.md §16 "Beat markers"); no user markers | browser | M | none | P1 | Top-level `markers` list (time, duration, label, colour, kind: note/chapter/beat) in both validators; beats can be saved as markers; no render change. |
| TE21 | Clip markers | **missing** | none | browser | S | none | P2 | `markers` on a clip in source time. |
| TE22 | Marker comments, colours and chapter markers | **missing** | none | browser | S | none | P1 | Chapter markers exported as a YouTube chapter list (text) with the video. |
| TE23 | Close gaps | **have** | The V lane has no gaps by construction (layout, cc/lib/editor.ts:2325-2361) | browser | S | none | P3 | Keep; needs revisiting on V2+ tracks. |
| TE24 | Ripple delete | **have** | removeClip on the magnetic lane (cc/lib/editor.ts:3488) | browser | S | none | P3 | Keep (with sync lock SQ13). |
| TE25 | Copy, paste, duplicate clips | **partial** | One V clip, within the project; Ctrl+D/C/V (cc/lib/editor.ts:3460-3486; cc/lib/editor-shortcuts.ts:110-124) | browser | S | none | P2 | Extend to texts, sounds, overlays, shapes and to a multi-selection. |
| TE26 | Paste attributes / copy effects | **missing** | none | browser | S | none | P1 | Copy the clip's look fields (EFFECT_KEYS, grade, color, mask, move) and paste to a selection; then settleAll. |
| TE27 | Move and rearrange clips | **have** | moveClip (cc/lib/editor.ts:3494), magnetic layout | browser | S | none | P3 | Keep. |
| TE28 | Nudge clips by a frame | **partial** | Playhead nudge (cc/lib/editor-timeline-view.ts:120); shapes nudge in the preview | browser | S | none | P3 | Alt+arrow nudges texts, sounds, overlays by one frame. |
| TE29 | Find clips in a sequence / reveal in project | **missing** | none | browser | S | none | P3 | With WS19. |
| TE30 | Match frame | **missing** | none | browser | S | none | P3 | After WS04. |
| TE31 | Undo and redo | **have** | Undo stack, one step per gesture; Ctrl+Z / Ctrl+Shift+Z (TimelineEditor.tsx:520-544, 770-791) | browser | S | none | P3 | Keep. |
| TE32 | Timeline zoom and navigation | **have** | Zoom 1-64x, Ctrl+wheel, fit, anchored scroll (cc/lib/editor-timeline-view.ts:17-118) | browser | S | none | P3 | Keep. |
| TE33 | Go to next / previous edit point | **missing** | Not in the key map (cc/lib/editor-shortcuts.ts:89-103) | browser | S | none | P2 | Up/Down arrows to the next/previous edit. |
| TE34 | Transition handles on the timeline | **partial** | Cross-fade length is set in the inspector (setCrossfade cc/lib/editor.ts:2381) | browser | S | none | P3 | Drag handle on the overlap in TimelineStrip. |

### B.TB Text-based editing

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| TB01 | Transcribe a sequence | **partial** | Auto captions built but dark: registry gate on both models (schemas/model_registry.json:755 plan_required:scale, 814 terms_review_required); uz/ru/en (cc/lib/creative/operations.ts:136) | first-party AI API | S | none | P0 | Owner unblocks a model (docs/AUTO_CAPTIONS_SETUP.md); credits by hold and capture per minute. |
| TB02 | Edit the video by editing the transcript | **missing** | Word timings exist and are mapped to the timeline (wordsOnTimeline cc/lib/captions.ts:359) but nothing cuts from them | browser | L | none | P0 | Transcript view over the caption track's words; a deletion becomes split + ripple delete on the V lane (the silence-cut apply path, cc/lib/editorSilence.ts:153), one undo step. |
| TB03 | Detect and delete pauses | **have** | Silence removal by audio level in the browser (cc/lib/editorSilence.ts:80-195; docs/editor-render-fields.md §14) | browser | S | none | P3 | Add filler-word cuts from word timings (needs TB01). |
| TB04 | Speaker labels; remove one speaker | **missing** | none | first-party AI API | M | none | P2 | Use the transcription model's diarisation where its maker documents it. |
| TB05 | Paper edit (sequence from transcript lines) | **missing** | none | browser | M | none | P2 | Select lines across transcribed library files; build a document from the ranges. |
| TB06 | Transcribe source files | **missing** | Captions are per project timeline (CaptionsPanel.tsx) | first-party AI API | M | none | P2 | Transcript per media asset (cached), reused by every project. |
| TB07 | Find and replace in transcript and captions | **missing** | Cues are edited one by one (CaptionsPanel.tsx) | browser | S | none | P2 | Find/replace over cues. |

### B.FX Effects

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| FX01 | Apply effects and change the effect stack order | **partial** | Fixed fields in a fixed order (docs/editor-render-fields.md §3 "Order of operations"); one of each | browser + server ffmpeg | L | med | P2 | Section D3: an ordered `effects` list per clip/track, closed names, old fields read as a fixed prefix. |
| FX02 | Effect presets | **missing** | none | browser | S | none | P1 | Presets = saved JSON of look fields, applied through the same paste path as TE26. |
| FX03 | Adjustment layers | **missing** | none | server ffmpeg | L | med: one extra filter chain over the composite span | P1 | Section D3. |
| FX04 | Source (master) clip effects | **missing** | none | browser | S | none | P3 | Not needed. |
| FX05 | Fx badges and effect bypass | **missing** | none | browser | S | none | P3 | Badge on clips with look fields; bypass = editor-only toggle. |
| FX06 | Blur and Sharpen effects | **partial** | Gaussian blur 0-30 and sharpen (cc/lib/editor.ts:243-245; modules/render_backend.py:251) | server ffmpeg | M | med: blur off on cross-fades above 1440p (cc/lib/editor.ts:248-251) | P2 | dblur (directional), masked gblur for tilt-shift, zoom blur via several scaled blends (charged per pixel rate). |
| FX07 | Colour correction effects | **partial** | grade (eq), temperature/tint/hue/curve, 7 looks with strength (cc/lib/editor.ts:233-242, 340-351; modules/render_backend.py:150-250) | server ffmpeg | M | low | P1 | Color Pass (keep one hue, rest grey) and Tint as lutyuv/geq-free filters; costs charged like section 14. |
| FX08 | Distort effects | **missing** | none | server ffmpeg | M | med | P2 | perspective (corner pin), lenscorrection, Magnify = cropped scaled copy overlaid in a circle mask; skip turbulent displace. |
| FX09 | Generate effects | **missing** | none | server ffmpeg | S | low | P3 | gradients source / colour fill layer. |
| FX10 | Keying effects | **partial** | Chroma key on overlays only, no despill (modules/render_spec.py:1680; docs/editor-render-fields.md §7) | server ffmpeg | M | low | P1 | Key on any V-track clip; despill (`despill` filter); luma key (lumakey); track matte via alphamerge. |
| FX11 | Lights and Glows | **partial** | RGB split and a flash pulse in the effects pack (`fx`, cc/lib/editor.ts:371-377; modules/render_backend.py:472-497; docs §16); no glow, flare or light leaks | server ffmpeg | M | med: one effect max on cross-fades above 1440p (FX_LARGE_XFADE_MAX) | P2 | Glow = blurred screen blend; light leaks as our own rendered overlay clips; add to FX_NAMES with measured costs. |
| FX12 | Noise and Grain | **have** | grain 0-1, fixed seed (cc/lib/editor.ts:243; docs/editor-render-fields.md §3) | server ffmpeg | S | med: grainy intermediates 13x bigger (docs §3) | P3 | Keep. |
| FX13 | Perspective effects | **partial** | Text drop shadow only (cc/lib/editor.ts:395) | server ffmpeg | M | low | P2 | Drop shadow on overlays/shapes (blurred alpha copy); Basic 3D via perspective. |
| FX14 | Stylize effects | **partial** | Glitch bursts and flash pulse (a strobe) in the effects pack (cc/lib/editor.ts:371; docs §16); no mosaic, posterize, edges | server ffmpeg | S | low | P2 | Add closed names onto pixelize, lut posterize, edgedetect, convolution (same FX_NAMES path). |
| FX15 | Time effects | **missing** | none | server ffmpeg | S | low | P3 | fps (posterize time), lagfun / tmix (echo). |
| FX16 | Transform effects | **partial** | Flips, quarter turns, free angle, Ken Burns move, camera shake (`fx.shake`) (cc/lib/editor.ts:252-256, 371; docs §16); no wiggle/spin/grow as keyable presets | server ffmpeg | M | med: zoom caps (cc/lib/editor.ts:251) | P2 | Grow/spin/wiggle become keyframe presets on D1 transform. |
| FX17 | Utility effects | **partial** | Rounded mask (cc/lib/editor.ts:355), text clips | server ffmpeg | S | low | P3 | Stroke on overlays (dilated alpha); motion tile via tile/loop. |
| FX18 | Immersive (VR) effects | **missing** | none | not for the web | L | high | P3 | Not planned. |
| FX19 | "Surprise Me" random variations | **missing** | none | browser | S | none | P3 | Random within the closed ranges, seeded. |

### B.TR Transitions

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| TR01 | Dissolves | **partial** | fade, dissolve, fadeblack, fadewhite, hblur, plus dip_to_black (cc/lib/editor.ts:164-210) | server ffmpeg | S | low | P2 | Dip to colour (fadecolor), luma fade (xfade fadegrays). |
| TR02 | Wipes | **partial** | wipe*, diag*, circleopen/close, radial, vert/horz open-close (cc/lib/editor.ts:170-208) | server ffmpeg | S | low | P3 | Clock/star via xfade custom expression from a closed list we write (never user text). |
| TR03 | Slide, push, whip, split, stretch | **partial** | slide*, smooth*, squeeze* (cc/lib/editor.ts:170-208) | server ffmpeg | M | med | P1 | Whip = slide + directional blur over the overlap (budgeted like blur). |
| TR04 | Lights and blurs transitions | **partial** | zoomin, hblur, fadewhite (cc/lib/editor.ts:170-208) | server ffmpeg | M | med | P1 | Flash (exposure spike), cross zoom (scale both sides + blend). |
| TR05 | Animation transitions | **partial** | A V clip's entrance/exit: fade, 4 slides, zoom, linear (V_ANIMS cc/lib/editor.ts:379; modules/render_backend.py:498; docs §16); not a two-sided transition, no spring/spin/flip | server ffmpeg | M | med | P1 | Two-sided motion transitions = both clips' anim curves on the overlap, with eased curves (D1 easing) from a closed list. |
| TR06 | Grunge and distort transitions | **missing** | Glitch and shake exist as clip effects (docs §16), not as transitions | server ffmpeg | M | med | P2 | Reuse fx_filters on the overlap only (enable= on the cross-fade span). |
| TR07 | Transformers | **missing** | none | server ffmpeg | M | low | P3 | Louver/slice via custom expressions from a closed list. |
| TR08 | Smart tool transitions | **missing** | none | server ffmpeg | L | med | P3 | Later. |
| TR09 | Default transition; apply to all or to a selection | **partial** | "Apply this cross-fade to all cuts" (applyCrossfadeToAll cc/lib/editorFxPack.ts:106; docs §16); no default for new cuts, no apply to a selection | browser | S | none | P2 | Default transition preference used by append/insert; apply to the selection after TE01. |
| TR10 | Single-sided transitions and alignment | **partial** | Cross-fade overlaps the clips (no handles); fades in/out per clip act single-sided (modules/timeline.py:63-69; cc/lib/editor.ts:642-643) | server ffmpeg | M | low | P2 | Alignment needs handles (TR11). |
| TR11 | Clip handles for transitions | **missing** | By design no hidden handles: the incoming clip moves earlier (modules/timeline.py:63-69) | server ffmpeg | M | low | P2 | Optional `handle` use when the source has material; the overlap no longer shortens the timeline. |
| TR12 | Audio crossfades | **partial** | Equal-gain blend under a picture cross-fade; linear fades on sounds (modules/timeline.py docstring lines 70-78; cc/lib/editor.ts:130) | server ffmpeg | S | none | P2 | `curve` on fades (afade curve=qsin/exp). |
| TR13 | Text animation presets | **partial** | anim_in/out: fade, 4 slides, pop, typewriter (cc/lib/editor.ts:214-230) | server ffmpeg | M | low | P1 | Per-word / per-line animators and loop animations (bounce, wave) through ASS override tags. |
| TR14 | Copy, paste and replace transitions | **missing** | none | browser | S | none | P2 | With TR09. |

### B.KF Keyframes

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| KF01 | Keyframe any property | **partial** | Two points only: clip move (zoom/x/y) and overlay/shape move.to (x/y/w/opacity), linear (cc/lib/editor.ts:521-539; docs/editor-render-fields.md §4) | browser + server ffmpeg | XL | med: per-frame expressions; opacity uses geq (MAX_PARTIAL_OPACITY_MOVES 2) | P0 | Section D1: `keys` per property with N points and easing, expressions generated piecewise (the speed_ramp.py pattern). |
| KF02 | Interpolation: linear, Bezier, auto/continuous Bezier, hold, ease in/out | **missing** | Linear only (docs/editor-render-fields.md §2, §4) | browser + server ffmpeg | L | low | P0 | Closed easing list plus cubic-bezier(x1,y1,x2,y2) per segment (D1). |
| KF03 | Keyframe graphs (value and speed) | **missing** | Speed curve plot exists for speed_curve only (ClipMotionSections.tsx) | browser | M | none | P2 | Curve editor on the D1 data. |
| KF04 | Keyframes in the timeline (rubber bands) | **missing** | none | browser | M | none | P1 | Volume and opacity lines drawn on clips in TimelineStrip. |
| KF05 | Copy, paste, snap keyframes; go to next keyframe | **missing** | none | browser | S | none | P2 | With D1. |
| KF06 | Motion path in the monitor | **missing** | Overlay end position is set by sliders/map (OverlayPanel.tsx) | browser | M | none | P2 | Path drawn in the preview over D1 position keys. |

### B.MK Masks and compositing

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| MK01 | Rectangle, ellipse and pen masks | **partial** | rect / ellipse / rounded on V clips, fixed in the frame (cc/lib/editor.ts:355-361; modules/render_backend.py:594-670) | server ffmpeg | M | med: mask refused on cross-fades above 1440p (docs §14) | P2 | Pen = polygon/Bezier points drawn by Pillow into the same mask PNG. |
| MK02 | Mask feather, expansion, opacity, invert | **partial** | feather, invert (cc/lib/editor.ts:562-573) | server ffmpeg | S | low | P3 | expansion (dilate in Pillow), opacity (mask levels). |
| MK03 | Mask tracking | **missing** | none | server ffmpeg | L | med: per-frame mask instead of a still PNG | P1 | Section D5: OpenCV tracker on the worker writes mask keyframes; render a mask video (or per-frame geometry). |
| MK04 | Object masking (AI select and track) | **missing** | No segmentation model in the registry (schemas/model_registry.json) | first-party AI API | XL | high: per-frame alpha masks | P1 | Section D5: first-party segmentation API when one exists; until then person segmentation via a vendor that makes the model. |
| MK05 | HSL and luminance masks | **missing** | none | server ffmpeg | M | med | P2 | Qualifier computed with lutyuv into an alpha, then the masked-effect path (MK07). |
| MK06 | Combine and refine masks | **missing** | One mask per clip | server ffmpeg | S | low | P3 | Pillow composes several shapes into one PNG. |
| MK07 | Effects inside a mask | **missing** | Our mask blacks out outside the shape (docs/editor-render-fields.md §14 `mask`) | server ffmpeg | M | med | P1 | Mask `mode: "effect"`: split, apply the effect chain to one copy, alphamerge, overlay back. |
| MK08 | Reveal animations with masks | **missing** | none | server ffmpeg | M | med | P2 | Mask keys via D1. |
| MK09 | Copy and paste masks | **missing** | none | browser | S | none | P3 | Part of paste attributes (TE26). |
| CP01 | Clip opacity | **partial** | Overlays and shapes have opacity (cc/lib/editor.ts:716-724); the main clip only fades | server ffmpeg | M | med: partial opacity is geq-expensive (docs §4) | P1 | Opacity on V-track clips via colorchannelmixer aa (constant) or fade; animated through D1 with the cheap path. |
| CP02 | Blend modes | **missing** | none | server ffmpeg | M | med: blend filter needs equal formats; cost per pixel | P2 | `blend` on V2+ clips using ffmpeg blend modes from a closed list. |

### B.MO Motion and time

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| MO01 | Motion: position, scale, rotation, anchor point | **partial** | Zoom/pan window (zoom 1-4) and free angle on V clips; overlays x/y/w (cc/lib/editor.ts:521-539, 618-620, 716-723); no scale below frame, no anchor | server ffmpeg | L | med: scale-up caps at large frames (cc/lib/editor.ts:251) | P0 | `transform` {x, y, scale, rotation, anchor} on every V-track clip, keyframable (D1); picture-in-picture becomes scale < 1. |
| MO02 | Crop | **have** | crop rectangle (cc/lib/editor.ts:546-553; docs/editor-render-fields.md §8) | server ffmpeg | S | none | P3 | Keep; keyframable later. |
| MO03 | Scale to frame size / set to frame size | **have** | fit contain / cover / blur (cc/lib/editor.ts:163; docs §5) | server ffmpeg | S | none | P3 | Keep. |
| MO04 | Time remapping (keyframed speed ramps) | **partial** | speed_curve 2-6 points 0.25-4, linear between points, not splittable, sound in sync only at slice boundaries (cc/lib/editor.ts:540-546; docs §9) | server ffmpeg | M | med: slices, interpolation budget | P1 | Eased ramps (D1 easing on speed points), up to 12 points, curve-aware captions. |
| MO05 | Speed / Duration with audio stretching and pitch | **have** | 0.1-10, pitch kept with chained atempo (modules/render_spec.py:1428; docs §6, §12) | server ffmpeg | S | low | P3 | Add "change pitch" option (rubberband) later. |
| MO06 | Reverse | **partial** | reverse capped by memory: 5.75 s at 1080p30, 0.7 s at 4K60 (cc/lib/editor.ts:316-334) | server ffmpeg | M | high: ffmpeg reverse holds the range in RAM | P1 | Reverse in chunks (reverse each 2 s piece, concat in reverse order) to lift the cap. |
| MO07 | Freeze frame and frame hold segments | **have** | freeze, "Freeze the frame at the playhead" (cc/lib/editor.ts:612; docs §6) | server ffmpeg | S | none | P3 | Keep. |
| MO08 | Frame sampling, frame blending, optical flow | **partial** | Motion interpolation (minterpolate) with frame budgets, not above 1440p (cc/lib/editor.ts:262-293; docs §9); no frame blending | server ffmpeg | S | high: minterpolate is slow (0.4 s per 1080p frame) | P2 | Add `frame_blend` (tmix), cheap; keep optical flow budgeted. |
| MO09 | Warp Stabilizer with settings | **partial** | vidstab two passes, on/off only, budgets 120 s / 300 s (modules/render_backend.py:772-820; docs §10) | server ffmpeg | S | med | P2 | Expose smoothing (vidstab smoothing) and "no crop" from a closed set; re-measure budget. |
| MO10 | Auto Reframe a clip | **partial** | Manual cover/crop/move only; AI reframe model placeholder (schemas/model_registry.json:2867) | server ffmpeg + first-party AI API | L | med | P0 | As SQ17 per clip; writes keyframed position (D1). |
| MO11 | Vector motion | **partial** | Shapes are drawn at their largest size into a PNG (docs §11) | server ffmpeg | S | none | P3 | Keep. |

### B.GR Graphics and titles

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| GR01 | Titles with the Type tool | **have** | T clips, 24 per project, addText (cc/lib/editor.ts:147, 677-675, 3522) | server ffmpeg | S | none | P3 | Keep; raise the cap with measurement. |
| GR02 | Text properties | **partial** | 4 fonts, size, colour, outline, shadow, box, bold, 9 anchors (cc/lib/editor.ts:395-414, 677-702); no tracking, leading, italic, alignment | server ffmpeg | S | none | P1 | ASS supports spacing, italics, alignment; add fields to both validators. |
| GR03 | Fonts (Adobe Fonts, replace fonts) | **missing** | Closed list of 4 fonts (cc/lib/editor.ts:409) | server ffmpeg | M | low: font parsing is an attack surface | P1 | Font asset type with strict sfnt validation, copied into the render's fontsdir; a curated open-licence set first. |
| GR04 | Colour fonts and emoji | **missing** | Shape labels refuse emoji (docs §11); libass has no colour emoji font | server ffmpeg | M | low | P1 | Render emoji text to PNG with Pillow + Noto Color Emoji and lay it as an overlay. |
| GR05 | Text styles; linked and track styles | **partial** | 8 built-in text looks (cc/lib/editorTextLook.ts; TextLookPicker.tsx), not user-saved | browser | S | none | P2 | User styles stored per org; a `style` ref on texts resolved at save. |
| GR06 | Shapes (rectangle, ellipse, polygon, pen) | **partial** | 7 kinds: arrow, circle, rect, star, pill, line, progress (docs §11; cc/lib/editorShapes.ts) | server ffmpeg | S | low | P3 | Polygon/pen later. |
| GR07 | Gradients | **missing** | none | server ffmpeg | S | low | P3 | Pillow gradient fills. |
| GR08 | Align and distribute | **partial** | 9 anchors for texts; centre-based overlays (cc/lib/editor.ts:398-408) | browser | S | none | P3 | Align buttons in the inspector. |
| GR09 | Responsive design (pinning, intro/outro protection) | **partial** | Positions and sizes are fractions of the frame, so they follow frame changes and multi-ratio export (docs §4, §11; modules/editor_export.py:200) | browser | S | none | P2 | Keep anim_in/out lengths fixed when an item is stretched (already true) and add edge pinning for safe zones. |
| GR10 | Credit rolls and crawls | **missing** | none | server ffmpeg | S | none | P3 | ASS move over the span. |
| GR11 | Group layers, clip layers, mask with text | **missing** | none | server ffmpeg | M | med | P3 | Text-as-mask via the mask PNG path. |
| GR12 | Animate graphic layers | **partial** | Overlay/shape move.to (two points) and anim_in/out (cc/lib/editor.ts:531-539) | server ffmpeg | M | med | P1 | Through D1. |
| GR13 | Motion Graphics templates (MOGRT) | **missing** | none | browser + server ffmpeg | L | low | P1 | Section C8: a template is a document fragment with exposed fields. |
| GR14 | Media replacement in templates | **missing** | none | browser | M | none | P2 | Slot asset ids replaced on apply. |
| GR15 | Data-driven templates (CSV) | **missing** | none | browser + server ffmpeg | M | low: N exports | P2 | Batch: N documents from rows, each exported (Ads Factory variants). |
| GR16 | Export a graphic as a template | **missing** | none | browser | M | none | P2 | "Save as template" from a selection (C8). |
| GR17 | Template marketplace (Stock MOGRTs) | **missing** | none | browser | L | none | P2 | Our own starter library; marketplace later. |
| GR18 | Spell check | **missing** | none | browser | S | none | P3 | spellcheck attribute on text inputs (browser). |

### B.CA Captions

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| CA01 | Captions track: create and edit | **have** | captions cues in the document (modules/timeline.py:15-17; cc/components/editor/CaptionsPanel.tsx; cc/lib/captions.ts) | browser | S | none | P3 | Keep. |
| CA02 | Auto-transcribe (speech to text) | **partial** | Built, dark: registry gates (schemas/model_registry.json:755, 814; supabase/migrations/0072_captions.sql) | first-party AI API | S | none | P0 | Owner: key + probe + price (docs/AUTO_CAPTIONS_SETUP.md). |
| CA03 | Speech-to-text languages | **partial** | uz, ru, en only (cc/lib/creative/operations.ts:136) | first-party AI API | S | none | P1 | Widen CAPTION_LANGUAGES to what the chosen model was probed for. |
| CA04 | Caption styles | **have** | 10 animated styles with highlight colour (modules/caption_styles.py:31) | server ffmpeg | S | none | P3 | Keep; brand-kit styles (C6). |
| CA05 | Single-word captions | **partial** | Word-highlight styles (karaoke, pop_in) (modules/caption_styles.py:31; modules/ass_captions.py) | server ffmpeg | S | none | P1 | A "one word" style: cues split per word from word timings. |
| CA06 | Translate captions | **missing** | No translation capability (docs: editor-parity.md X10) | first-party AI API | M | none | P0 | New `caption_translate` capability on a first-party LLM (Google Gemini or OpenAI), timings kept, uz/ru/en first. |
| CA07 | Import caption files | **have** | SRT/VTT parse (cc/lib/captionCues.ts:75) | browser | S | none | P3 | Keep. |
| CA08 | Caption file formats | **partial** | SRT and VTT (cc/lib/captions.ts:672-696) | browser | S | none | P3 | TTML/ASS export if asked. |
| CA09 | Several caption tracks (languages) | **missing** | One `captions` object per document (modules/timeline.py:15-17) | browser + server ffmpeg | M | none | P1 | `captions` becomes a list of tracks with `language` and `burn` flag; one burned in, others sidecar. |
| CA10 | Export captions (sidecar, burned in) | **have** | SRT/VTT download, burn-in through ASS (cc/lib/captions.ts:672-696; modules/render_backend.py:1406-1412) | server ffmpeg | S | none | P3 | Add embedded mov_text track in MP4. |

### B.CO Colour

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| CO01 | Lumetri Basic Correction | **partial** | brightness/contrast/saturation (cc/lib/editorGrade.ts), temperature/tint (cc/lib/editor.ts:340-341) | server ffmpeg | M | low | P1 | Highlights/shadows/whites/blacks via a generated 1D curve (`curves` with computed points), vibrance via `vibrance` filter; charged per section 14 rules. |
| CO02 | Auto color / auto tone | **missing** | none | browser | M | none | P2 | Frame statistics from the proxy in the browser set grade/temperature values (no AI). |
| CO03 | Creative looks with intensity | **partial** | 7 named looks with strength (cc/lib/editor.ts:233-242; modules/render_backend.py:174-216) | server ffmpeg | S | low | P2 | More looks as our own .cube files (lut3d). |
| CO04 | RGB curves | **partial** | 6 preset tone curves (cc/lib/editor.ts:343-350) | server ffmpeg | M | low | P2 | Custom points (up to 8 per channel) passed as numbers to `curves`. |
| CO05 | Hue vs Saturation / Hue / Luma, Luma vs Sat, Sat vs Sat curves | **missing** | none | server ffmpeg | M | med | P2 | Bake into a 3D LUT on the worker (numpy) and apply with lut3d (one cost). |
| CO06 | Colour wheels (shadows, midtones, highlights) | **missing** | colorbalance measured too slow (docs §14: 1.3 s/s at 1080p30) | server ffmpeg | M | med | P2 | Bake wheels into the same 3D LUT as CO05. |
| CO07 | Colour Match | **missing** | none | browser | M | none | P2 | Histogram / mean-std match in the browser from two proxy frames; writes grade + temperature values. |
| CO08 | HSL Secondary | **missing** | none | server ffmpeg | M | med | P2 | Via MK05 qualifier + MK07 masked effect. |
| CO09 | Vignette | **have** | vignette 0-1 (cc/lib/editor.ts:243); no midpoint/roundness | server ffmpeg | S | none | P3 | Keep. |
| CO10 | LUT import (.cube) | **missing** | none | server ffmpeg | M | low: parser hardening | P2 | LUT asset type (validated .cube, size cap), lut3d by asset id. |
| CO11 | Export a LUT | **missing** | none | server ffmpeg | S | none | P3 | From the baked LUT (CO05). |
| CO12 | Several Lumetri instances per clip | **missing** | One grade per clip | browser + server ffmpeg | M | med | P3 | Via the effects list (D3). |
| CO13 | Scopes: waveform, vectorscope, parade, histogram | **missing** | none | browser | M | none | P2 | D7. |
| CO14 | Colour management and working spaces | **partial** | Output is yuv420p H.264 (modules/render_spec.py:1395); no explicit colour tags | server ffmpeg | M | low | P2 | Tag BT.709 explicitly in the final pass (new chains only). |
| CO15 | Tone mapping HDR sources | **missing** | Not seen in the render path | server ffmpeg | M | med: zscale/tonemap per frame | P1 | Probe colour transfer at upload; HLG/PQ clips get zscale+tonemap in their segment chain. |
| CO16 | HDR output | **missing** | 8-bit H.264 only (modules/render_spec.py:1395) | server ffmpeg | L | high: 10-bit HEVC at 4K under 2 GiB | P3 | Paid tier later. |
| CO17 | Color Mode clip grid, groups, grade copy/paste | **missing** | none | browser | M | none | P2 | With WS22 and TE26. |
| CO18 | Before/after comparison | **missing** | none | browser | S | none | P2 | Split view in the preview (look off on one side). |

### B.AU Audio

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| AU01 | Clip volume and gain | **have** | gain_db on A clips (-60..+12) and on a V clip's own sound (-60..+6) (cc/lib/editor.ts:104-109; docs §12) | server ffmpeg | S | none | P3 | Keep. |
| AU02 | Track volume | **partial** | Each sound has its own track; no track fader (cc/lib/editor.ts:704-711) | server ffmpeg | S | none | P2 | D6 `gain_db` on tracks. |
| AU03 | Audio fades | **have** | fade_in_s / fade_out_s up to 10 s (cc/lib/editor.ts:130) | server ffmpeg | S | none | P3 | Keep. |
| AU04 | Pan and balance | **missing** | none | server ffmpeg | S | none | P2 | `pan` -1..1 on clips/tracks (ffmpeg pan / stereotools). |
| AU05 | Mute, solo, global mute | **partial** | A V clip's sound switch (`audio:false`); no solo or track mute | browser + server ffmpeg | S | none | P2 | Track `mute` (render), solo (preview only). |
| AU06 | Submixes and buses | **missing** | none | server ffmpeg | M | low | P3 | D6 buses (dialogue / music / sfx). |
| AU07 | Automation modes | **missing** | none | browser | M | none | P3 | Record fader moves into D1 gain keys. |
| AU08 | Audio category tagging (auto) | **partial** | Manual music/speech role (cc/lib/editor.ts:113) | browser | S | none | P2 | Speech detected from the transcript or voice activity; recorded voice-over is speech by default. |
| AU09 | Enhance Speech (AI) | **missing** | No voice_enhance model in the registry (schemas/model_registry.json) | first-party AI API | M | none | P1 | First-party speech-enhancement API (e.g. the maker of a model we register); credits per minute. |
| AU10 | Enhance Audio / repair dialogue / dialogue clarity | **partial** | FFT denoise only (modules/render_spec.py:1424) | server ffmpeg | S | low | P1 | Closed preset "voice clean": highpass + afftdn + deesser + acompressor + loudnorm. |
| AU11 | Auto ducking | **have** | Track duck computed at render from speech positions (modules/render_spec.py:1496-1525; cc/lib/editor.ts:651-656, 3711) | server ffmpeg | S | none | P3 | Keep; duck under SFX optional. |
| AU12 | Auto-match loudness / normalise | **partial** | Single-pass loudnorm to -16 LUFS per clip (modules/render_spec.py:1425) | server ffmpeg | S | low | P2 | Master-bus loudness target per platform (-14 YouTube/Spotify-like) in the final mix, two-pass. |
| AU13 | Loudness meter and audio meters | **partial** | Level meter only while recording (cc/components/editor/VoiceOverRecorder.tsx) | browser | S | none | P2 | WebAudio meter on preview playback. |
| AU14 | Remix (retime music to fit) | **partial** | "Fit to the picture" trims the sound (fitSoundToPicture cc/lib/editor.ts:3739); beat detection exists (cc/lib/editorBeats.ts:48) | browser + server ffmpeg | M | none | P1 | Use detected beats to pick bar-length loop points; the sound becomes 2-3 A clips with short crossfades, one undo step. |
| AU15 | Dynamics: compressor, limiter, multiband | **missing** | none | server ffmpeg | S | low | P2 | acompressor, alimiter, mcompand from a closed preset list. |
| AU16 | EQ and filters | **missing** | none | server ffmpeg | S | low | P2 | equalizer, highpass, lowpass, bass, treble as closed fields. |
| AU17 | Delay, echo and reverb | **missing** | none | server ffmpeg | S | low | P3 | aecho presets; afir with our own impulse responses. |
| AU18 | Modulation | **missing** | none | server ffmpeg | S | none | P3 | chorus, flanger, aphaser presets. |
| AU19 | Noise reduction and restoration | **partial** | afftdn (modules/render_spec.py:1424) | server ffmpeg | S | low | P2 | Hum notch (bandreject 50/60 Hz), adeclick. |
| AU20 | Pitch shifter and voice effects | **missing** | none | server ffmpeg | S | none | P2 | asetrate+atempo or rubberband; "robot/chipmunk/deep" presets. |
| AU21 | Vocal enhancer and mastering | **missing** | none | server ffmpeg | S | none | P2 | Same as AU10 preset; master bus preset. |
| AU22 | Stereo and channel tools | **missing** | none | server ffmpeg | S | none | P3 | pan/stereotools closed options. |
| AU23 | Audio channel mapping; split stereo to mono | **missing** | none | server ffmpeg | S | none | P2 | `channel: "left"\|"right"\|"mix"` on a clip's sound (pan filter). |
| AU24 | Waveforms | **partial** | Waveform for sound files; not for a video's sound (cc/components/editor/SoundWave.tsx; docs §12) | browser | S | none | P2 | Peaks from the proxy's audio, cached per asset. |
| AU25 | Separate overlapping speakers | **missing** | none | first-party AI API | L | none | P3 | Only with a first-party separation API. |
| AU26 | Bulk mute or bleep words | **missing** | Word timings exist (cc/lib/captions.ts:359) | browser + server ffmpeg | S | none | P1 | `bleeps` list of spans: volume=0 or a sine at render; pick words in the transcript. |
| AU27 | Extract audio | **partial** | Detach to an A track (cc/lib/editor.ts:3410); no file | server ffmpeg | S | none | P3 | Audio-only export (EX13). |
| AU28 | Record a voice-over | **have** | VoiceOverRecorder (cc/components/editor/VoiceOverRecorder.tsx; docs §13) | browser | S | none | P3 | Add punch-in at the playhead with a live waveform. |
| AU29 | Audio presets | **missing** | none | browser | S | none | P3 | With FX02. |

### B.AI AI features (Sensei and Firefly)

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| AI01 | Generative Extend | **missing** | i2v models from their makers are registered (Google veo-3.1 schemas/model_registry.json:1760; Runway gen4.5 2592) | first-party AI API | L | low | P2 | Last frame -> first-party image-to-video (Veo / Runway) -> new clip butted to the end; honest label "continue", credits by hold/capture. |
| AI02 | Generative Remove | **missing** | Picture erase only, dark (gemini-2.5-flash-image-erase schemas/model_registry.json:632); video edit is a placeholder (2812) | first-party AI API | XL | med | P2 | Only with a first-party video-inpainting API; none registered. |
| AI03 | Generative Media Tool | **partial** | Generation happens in Studio; results come in with "Add to project" (cc/components/editor/SendToEditor.tsx) | first-party AI API | L | none | P0 | Section C2: a "Generate here" region on the timeline creates a pending clip; the job runs on the maker's API with hold/capture; the clip fills in when done. |
| AI04 | Generate music | **partial** | sonilo-music registered, terms-gated, no UI (schemas/model_registry.json:6033) | first-party AI API | M | none | P1 | Editor panel on the registered maker's API; lands on a music track. |
| AI05 | Generate sound effects | **partial** | elevenlabs-sfx registered, plan gate, no UI (schemas/model_registry.json:4410) | first-party AI API | M | none | P1 | Same panel; lands at the playhead. |
| AI06 | Generate soundscape from video | **partial** | Video-to-music model registered (editor-parity.md A3), no DB capability or UI | first-party AI API | M | none | P2 | Needs `video_music` capability migration first. |
| AI07 | Morph Cut | **missing** | none | first-party AI API | L | med | P2 | First-party frame-interpolation (i2v with first+last frame) between the two frames; or a short zoom-punch-in as the free alternative. |
| AI08 | Auto Reframe (Sensei) | **partial** | See SQ17 / MO10 | server ffmpeg + first-party AI API | L | med | P0 | See SQ17. |
| AI09 | Scene Edit Detection (Sensei) | **missing** | See SQ16 | server ffmpeg | M | low | P1 | See SQ16. |
| AI10 | Speech to Text and text-based editing (Sensei) | **partial** | See CA02 / TB01 | first-party AI API | S | none | P0 | See TB01. |
| AI11 | Object Mask (AI) | **missing** | See MK04 | first-party AI API | XL | high | P1 | See MK04. |
| AI12 | Colour Match (Sensei) | **missing** | See CO07 | browser | M | none | P2 | See CO07. |
| AI13 | Enhance Speech (Sensei/Firefly) | **missing** | See AU09 | first-party AI API | M | none | P1 | See AU09. |
| AI14 | Media Intelligence (Sensei) | **missing** | See PM18 | first-party AI API | L | low | P2 | See PM18. |
| AI15 | AI Assistant with skills and references | **missing** | See WS21 | first-party AI API | XL | low | P1 | See C1. |
| AI16 | Caption translation (cloud) | **missing** | See CA06 | first-party AI API | M | none | P0 | See CA06. |
| AI17 | Content Credentials on export | **partial** | Pipeline records an AI-disclosure event per published video (cc/lib/aiDisclosure.ts:1-25); editor exports carry nothing | server ffmpeg | M | none | P2 | C2PA manifest on editor exports listing first-party generated clips used. |
| AI18 | Cloud AI voice features | **partial** | Voice change and dubbing reached from "Improve with AI" to Studio (cc/lib/creative/improve.ts:30-37) | first-party AI API | M | none | P2 | In-editor TTS / voice change / dub panels on ElevenLabs entries (registry 4197, 4474, 4529) once sellable. |

### B.PB Playback and preview

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| PB01 | Real-time GPU playback (Mercury Playback Engine) | **partial** | Approximate CSS preview; reversed / ramped clips stepped frame by frame without sound (docs/editor-render-fields.md "C2 guard rails", line 706) | browser | XL | none | P0 | D9: WebCodecs decode of proxies + WebGL shaders mirroring the closed effect list. |
| PB02 | Render In to Out / preview files | **missing** | Only full exports exist (modules/editor_export.py:351) | server ffmpeg | M | med: uses the export worker | P1 | "Preview this part": a 480p, ≤30 s low-priority render of a range, free, cached by document hash. |
| PB03 | Render and replace | **missing** | none | server ffmpeg | M | low | P3 | Later; useful for nested sequences (D2). |
| PB04 | Playback resolution | **partial** | Preview always plays the 480p proxy (docs §14) | browser | S | none | P2 | D8 quality switch. |
| PB05 | High quality playback | **missing** | none | browser | S | none | P3 | Original-file frame when paused (signed URL, range request). |
| PB06 | Loop, preroll and postroll playback | **missing** | none | browser | S | none | P3 | Loop between I/O marks. |
| PB07 | J / K / L shuttle | **missing** | Space only (cc/lib/editor-shortcuts.ts:89) | browser | S | none | P2 | J/K/L with playbackRate steps. |
| PB08 | Dropped frame indicator | **missing** | none | browser | S | none | P3 | requestVideoFrameCallback counters. |
| PB09 | Compare view in the Program Monitor | **missing** | none | browser | S | none | P2 | With CO18. |
| PB10 | In and Out points | **missing** | No I/O marks | browser | S | none | P1 | Sequence I/O for range delete, loop, preview render, partial export. |
| PB11 | Monitor magnification | **missing** | none | browser | S | none | P3 | CSS zoom on the preview box. |
| PB12 | Time controls and timecode entry | **partial** | Timecode display, playhead slider, arrow nudges (cc/lib/editor-timeline-view.ts:120) | browser | S | none | P3 | Frame step with , and . |
| PB13 | Smart rendering | **missing** | Every segment is re-encoded (modules/render_backend.py:1209-1284) | server ffmpeg | L | low | P3 | Stream-copy only for exact-codec cuts on keyframes; small gain for our sources. |
| PB14 | Overlays in the monitor (timecode, markers) | **missing** | none | browser | S | none | P3 | Marker names over the preview. |
| PB15 | Waveforms in the Source Monitor | **missing** | none | browser | S | none | P3 | With WS04 and AU24. |

### B.EX Export

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| EX01 | Export settings and presets | **partial** | 5 free formats + 4 paid hi-res frames, fps 24/25/30/60 (schemas/export_presets.json:4-12; cc/components/editor/ExportPresetPicker.tsx) | server ffmpeg | S | none | P3 | Keep. |
| EX02 | Codecs and formats | **partial** | H.264 MP4 yuv420p only (modules/render_spec.py:1395, 1789) | server ffmpeg | M | med: HEVC/ProRes encode cost and size | P1 | Closed `container/codec` choice: MP4 H.264, MP4 HEVC, MOV ProRes 422 Proxy/LT (≤1080p), WebM VP9, GIF (palettegen), MP3/WAV. |
| EX03 | Encoding settings | **missing** | Fixed medium / CRF 23 (modules/render_spec.py:105) | server ffmpeg | S | low | P2 | Closed quality steps (CRF 18/20/23) and a "small file" target bitrate. |
| EX04 | Quick Export | **have** | Export button, free, no watermark (modules/editor_export.py:1-30; ExportPresetPicker.tsx) | server ffmpeg | S | none | P3 | Keep. |
| EX05 | Media Encoder queue / batch | **partial** | Server queue; 3 in flight and 20 a day per org (0054); several sizes at once behind NIGHTSHIFT_MULTI_RATIO_EXPORT (0129) | server ffmpeg | S | med: one export worker | P2 | Keep; turn multi-ratio on. |
| EX06 | Social media presets and publishing | **partial** | YouTube, vertical, square, 4:5 presets (schemas/export_presets.json:4-8); publish planned (docs/CREATIVE_OS_PLAN.md PR 13) | browser | M | none | P1 | Export becomes a videos row behind the existing publish gate (approvals). |
| EX07 | Custom presets and preset manager | **missing** | Closed list by design (modules/export_presets.py) | browser | S | none | P3 | Not needed. |
| EX08 | Transcript export | **partial** | Caption SRT/VTT download (cc/lib/captions.ts:672-696) | browser | S | none | P3 | .txt with speaker names. |
| EX09 | Export a still frame | **missing** | none | server ffmpeg | S | low | P1 | Worker renders one frame of the document at full size (a 1-frame export) -> library image; thumbnails for YouTube. |
| EX10 | Visual watermark | **partial** | A logo can be added as an overlay by hand (OverlayPanel.tsx) | server ffmpeg | S | low | P3 | Brand-kit logo toggle at export (C6). |
| EX11 | Interchange: EDL, FCP XML, AAF, OMF | **missing** | none | browser | M | none | P3 | FCPXML/OTIO export from the document (cuts, texts as markers). |
| EX12 | Audio-only export | **missing** | none | server ffmpeg | S | none | P2 | Final pass with -vn (podcast clips). |
| EX13 | Export progress | **partial** | State and elapsed time, no percentage (cc/components/editor/ExportStatusPanel.tsx:39) | server ffmpeg | S | none | P2 | ffmpeg -progress through the heartbeat (modules/editor_export.py:326). |
| EX14 | High resolutions and frame rates | **partial** | Paid export by the started minute: up to 1080p (0136), 1440p and 4K (0132; modules/hires_export.py:37-57; docs/HIRES_EXPORT.md); 4K ≤30 fps and ≤180 s, 1440p ≤300 s; speed curves sold at rendered length (0136) | server ffmpeg | M | high: 4K under 2 GiB | P2 | Chunked 4K renders (segment groups concatenated) to lift the 180 s cap and allow 4K60. |
| EX15 | Live stream output (SRT) | **missing** | none | not for the web | L | none | P3 | Not planned. |

### B.CL Collaboration

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| CL01 | Team Projects | **partial** | Org-shared projects with optimistic concurrency (stale_revision, supabase/migrations/0054_editor_projects.sql:275-296) | browser | XL | none | P2 | Presence + soft locks first; operational merge of document edits later. |
| CL02 | Versions and auto-saves | **partial** | Only the current document and its `rev` are kept (editor_projects, supabase/migrations/0054_editor_projects.sql:107-108); each export keeps the document it rendered (editor_exports.doc, 0054:128); no history table, no restore UI | browser | M | none | P1 | New `editor_project_revisions` table written by save_editor_project (keep the last N), a Versions list and restore-as-new-revision (migration). |
| CL03 | Sequence locking and online collaborators | **missing** | none | browser | M | none | P3 | Supabase realtime presence per project. |
| CL04 | Share for review (Frame.io) | **missing** | none | browser | M | none | P1 | C7: signed review link to an export (no login), expiring. |
| CL05 | Time-stamped comments and annotations | **missing** | none | browser | M | none | P1 | Comments with time and optional rectangle, stored per export. |
| CL06 | Import comments as markers | **missing** | none | browser | S | none | P2 | Comments map to TE20 markers (kind "review"). |
| CL07 | Invite collaborators to co-edit | **partial** | Organization members share every project (members page; RLS 0054) | browser | S | none | P3 | Keep. |
| CL08 | Dynamic Link and round trips (After Effects, Audition, Photoshop) | **partial** | "Improve with AI" sends a file to Studio tools; image editor is dark (cc/lib/creative/improve.ts:30-37; docs/IMAGE_EDITOR.md) | browser | M | none | P3 | "Edit picture" round trip to the image editor returning a new asset id. |
| CL09 | Plug-ins and extensions | **missing** | Closed lists by design (no free text reaches ffmpeg) | not for the web | XL | high | P3 | Not planned (security model). |

### B.KS Shortcuts and workspaces

| ID | Feature | Ours | Evidence | Feasibility | Effort | Render / memory risk | Pri | How we build it |
|---|---|---|---|---|---|---|---|---|
| KS01 | Default keyboard shortcuts | **partial** | Space, S, Delete, arrows, Shift+arrows, +/-, 0, Ctrl+Z/S/D/C/V (cc/lib/editor-shortcuts.ts:134-144) | browser | S | none | P1 | Add I, O, M, J/K/L, Q/W (ripple trim to playhead), Up/Down (edits), Ctrl+K; keep the focus rules. |
| KS02 | Customise shortcuts | **missing** | none | browser | S | none | P3 | Map stored per user; "Premiere" and "CapCut" presets. |
| KS03 | Find and print shortcuts | **have** | Shortcut help table (cc/lib/editor-shortcuts.ts:127-147) | browser | S | none | P3 | Keep. |
| KS04 | Import and manage workspaces | **missing** | none | browser | S | none | P3 | With WS01. |

---

## C. "Better than Premiere": where a web, AI-native studio can win

Premiere is a desktop app built for professional editors, and its AI runs on Adobe's own Firefly credits. Our users
are short-form and YouTube creators who work in uz, ru and en, often on a phone. Each idea below names the first-party
API it needs. The rule is the model's original maker's own API, with credits charged by hold and capture.

| # | Idea | Why it beats Premiere | First-party API needed | Builds on |
|---|---|---|---|---|
| C1 | **Prompt-to-edit agent.** Examples: "cut the pauses, add captions in Uzbek, make a 9:16 version, put the logo top right". The agent plans, shows a diff of the document, and the person confirms with one undo step. | Premiere's AI Assistant (27.0) organises bins and builds rough cuts, but it changes a desktop project. Ours writes **validated documents**: both validators run on every step, so the agent cannot make a video the worker refuses. It also works on a phone. | An LLM with tool use from its maker: Anthropic Claude API, OpenAI or Google Gemini. No editor-agent capability is registered today, so it needs a new capability, price and probe. | Every operation in `cc/lib/editor.ts`, `settleAll`, the markers (#10) and the transcript (#1). Skills, like Premiere's, are org presets of prompts. |
| C2 | **AI b-roll inside the timeline ("Generate here").** Drag over a range of V2, type a prompt, or let the agent write the prompt from the transcript words under that range. A pending clip appears and fills in when the job finishes. | Premiere's Generative Media Tool (26.5/27.0) uses Firefly only. We can offer the person's choice of maker models, and **the character studio's characters** keep a consistent person across shots. | Text-to-video and image-to-video from their makers: Google Veo 3.1 (`schemas/model_registry.json:1760`), Runway Gen-4.5 (2592), and others once their terms gates clear. Images from OpenAI gpt-image-2 or Ideogram. | V tracks (D0), the creative-jobs pipeline, hold and capture. |
| C3 | **Character Studio in the edit.** Swap the person in a clip for a saved character, or generate b-roll of that character, without leaving the timeline. The result replaces the clip's `asset_id` and keeps its trims and effects. | Premiere has nothing like it. Firefly does not do person replacement with your own characters. | Kling 4.0 Omni or BytePlus Seedance 2.5 through each maker's own API (0137, `docs/CHARACTER_STUDIO.md`). It is dark and not on sale until the vendors answer in writing. | 0137 jobs plus "replace media" (PM20). |
| C4 | **Captions and dubbing in many languages, Uzbek first.** Auto-captions in uz, ru and en today, translation into more, and a burned-in style per language with one export per language. | Adobe's translate page does not say Uzbek is supported, and it uses Google and Microsoft translation engines. We can prove and price Uzbek end to end, including the apostrophe letters the worker font already draws (`TEXT_RANGES`, §11). | Transcription: ElevenLabs Scribe v2 or AssemblyAI (755, 814). Translation: Google Gemini or OpenAI (new capability). Dubbing: ElevenLabs Dubbing v2 (4529). | #1, #14, multi-ratio export. |
| C5 | **One-click multi-ratio export that follows the subject.** One edit gives 16:9, 9:16, 1:1 and 4:5, with per-ratio overrides of text and overlay positions and auto-reframe pan keys. | Premiere's Auto Reframe makes a **new sequence per ratio**, which then drifts from the master. Ours is one document with a frame override (0129, `modules/editor_export.py:200`), so a fix to the master fixes every ratio. | None for the free version: face and saliency tracking on the worker with OpenCV, which is already a dependency. A vision API from its maker only if quality needs it. | D5 tracking, D1 keys, `frame_overrides` per ratio. |
| C6 | **Brand kit in the editor.** Logo, colours, fonts, caption style, intro and outro, applied with one click or by default on new projects. "Scan my site" (0133) fills it. | Premiere needs Creative Cloud Libraries and manual MOGRT work. | None. Ads Factory `BrandKit` (`cc/lib/adsFactory/model.ts:492`) and brand scan (0133/0134) already exist. | Custom fonts (GR03), templates (C8). |
| C7 | **Review links.** A no-login, expiring link to an export with time-stamped comments and approve/reject. An approval can move the video into the existing publish gate. | Frame.io is a separate product that needs accounts. Ours sits inside the workspace's approvals. | None. | Comments table (migration), markers (#10). |
| C8 | **Templates from successful edits.** "Save as template" turns a finished edit into slots (media, words) plus everything else. The library is ranked by how the published videos made with it performed (the app's analytics). Data-driven batches make N variants from rows (Ads Factory). | MOGRTs are graphics-only and need After Effects to author. Ours are whole edits, authored in the editor. | None. An LLM can fill text slots: Claude, OpenAI or Gemini from their makers. | Document `slots`, V tracks optional. |
| C9 | **"Clean up talking head" in one pass.** Cut silences and fillers, bleep profanity, clean the voice, add single-word captions, punch in on emphasis. | Premiere has each piece in a different panel. | Transcription (#1) only. Voice enhance needs a maker's speech-enhancement API (none registered). | #1, #8, #9, #11, #20. |
| C10 | **Cut to the beat.** Detected beats (#680) become markers; "split the b-roll on every 2nd beat"; music remixed to the video length. | Premiere's Remix retimes music but does not cut picture to beats. | None. | #10, AU14. |
| C11 | **Free 1080p export, no watermark, in a browser at phone width.** | Premiere is a desktop subscription. | None. | Already true. Keep it while paid sizes grow (0132/0136). |
| C12 | **Publish and schedule from the editor with the AI-disclosure label and Content Credentials.** | Premiere exports a file; posting is a separate step. | None (C2PA signing is ours). | The publish gate, `cc/lib/aiDisclosure.ts`. |

---

## D. Architecture changes for the big items

**Shared rules for every change below:**

1. Every new field is **optional** and absent means today's behaviour. A document without it must build byte-for-byte the
   same ffmpeg argv: extend the golden files `samples/parity2_argv_golden.json` and `parity2b_argv_golden.json`.
2. **Validator parity.** `modules/timeline.py` and `cc/lib/editor.ts` `validateTimeline` change together, with
   `schemas/timeline.schema.json`. Shared cases go into `tests/test_editor_doc_cases.py` and
   `cc/tests/editor-timeline.test.ts`.
3. **No migration** for document fields, as long as no new media reference uses a name other than `asset_id`.
   `editor_doc_problem` (0054) checks only `asset_id` at any depth and the 256 KiB size cap (0054:179;
   `MAX_DOC_BYTES`, `cc/lib/editor.ts:151`). **The 256 KiB cap is the binding limit for keyframes and tracking data.**
4. **Rollout** follows §12: older validators refuse unknown fields, so merge as one commit and use the controls only
   after the worker image is rebuilt.
5. **Budgets.** Every cost goes into `work = length + interpolation + steadying + fast + look + shapes`, checked against
   `render_timeout_s = min(5400, 3 × length + 120)` and the 2 GiB address-space limit. It is also measured under that
   limit at 1080p60 and at 4K30, which the paid 4K tier allows. `settleAll` learns any new settle step.
6. `editor_doc_duration` (0054) and `editor_doc_rendered_length` (0136) must learn any field that changes a clip's
   length, or the 30-minute check and the paid quote will disagree with the worker.

### D0. Stacked video tracks (prerequisite for D2, D3, D4, C2 and picture-in-picture)

- **Document.**
  - `tracks` may hold up to 4 V tracks. V1 stays the magnetic lane: its no-gap and cross-fade rules apply as they do now.
  - V2–V4 are free lanes. Gaps are allowed, nothing overlaps within a lane, and no cross-fades in v1.
  - Their clips take the V-clip field set plus `transform` (D1) and `blend` (CP02).
  - `overlays` stays readable. The editor converts an overlay to a V2+ clip on edit, and the worker renders both.
  - `MAX_TRACKS` (32) is shared with up to 24 texts and 6 sounds, so either raise it or put the texts on one T track.
    `1 + 24 + 6` is the documented sum (`cc/lib/editor.ts:149`).
- **Validators.** Remove the "only one video track" rule (`modules/timeline.py:844`). Add a per-lane overlap check.
  Count `MAX_OVERLAY_VIDEOS` + V2+ video clips against one layer cap.
- **Render.**
  - Today V1 is normalised segment by segment and concatenated; overlays and shapes are inputs of one final pass
    (`render_spec.picture_overlay_filters`).
  - V2+ clips render like video overlays, but each is first **normalised to its own intermediate** with its full chain
    (speed, colour, mask, fx). The final pass then only overlays pre-rendered streams, scaled and positioned by
    `transform`.
  - A V2+ clip's own sound is mixed (`audio_track_filter`). Today overlay video is silent.
- **Memory and budget.**
  - Each layer is one more decoder in the final pass. Reuse the shapes memory model (`shape_art.memory_estimate_bytes`,
    measured per layer) and keep threads pinned (§11).
  - First cap: 4 video layers at ≤1080p, 2 at 4K; measure before raising.
  - Each V2+ clip also costs its own normalisation (charge its length × pixel rate).
- **Migration and back-compat.** No SQL. Documents with one V track and `overlays` render unchanged (golden test).
  `toModel` (`cc/lib/editor.ts:2649`) still picks V1 as the magnetic lane.

### D1. Generic keyframes with easing curves

- **Document.** An optional `keys` object on V clips, V2+ clips, overlays, shapes, texts and A clips:
  ```json
  "keys": { "transform.scale": [ {"t": 0, "v": 1, "ease": "out-cubic"}, {"t": 1.2, "v": 1.15} ],
            "opacity": [...], "volume_db": [...], "grade.saturation": [...] }
  ```
  - `t` is in seconds from the item's start, in timeline time, so a speed change does not move keys.
  - `ease` is one of a closed list: `linear`, `hold`, `in`, `out`, `in-out`, the cubic in/out/in-out pair, `back`,
    `spring`. Or `bezier: [x1, y1, x2, y2]`, held to x ∈ [0, 1].
  - The keyable properties are a closed list, `KEYABLE`: `transform.{x, y, scale, rotation, anchor_x, anchor_y}`,
    `opacity`, `volume_db`, `pan`, `grade.*`, `color.{temperature, tint, hue}`, `mask.{x, y, w, h, feather}`, `blur`.
  - Limits: at most 32 keys per property and 400 per document (the 256 KiB cap). A property with keys must not also
    carry a different static value.
  - The existing `move`, overlay `move.to` and `speed_curve` stay valid. `normalise` may later rewrite `move` as keys,
    but only behind a version bump. For now both forms live side by side, and a property cannot be set both ways.
- **Evaluation.** One pure evaluator shared in spirit by both languages: `modules/keyframes.py` and `cc/lib/editorKeys.ts`.
  - Pinned by `samples/keyframe_cases.json`: values at sampled frames, compared to 1e-6.
  - Bezier easing is solved by Newton iteration in both languages and sampled at frame times. Both must give the same
    frame values.
- **Render.**
  - Compile each property into a **piecewise ffmpeg expression in `t`**, the `speed_ramp.py` pattern (9-decimal printing).
  - Eased segments are approximated by ≤8 linear sub-segments, or by an exact polynomial for the cubic eases. Keys
    therefore become a bounded expression length.
  - Transform: `scale=w=...:h=...:eval=frame`, then `overlay=x=...:y=...` (V2+), or the existing move window (V1).
    Rotation: `rotate=a=...`. Opacity: the cheap `fade`/alpha multiply where it goes 0↔1, else the existing `geq` path
    under `MAX_PARTIAL_OPACITY_MOVES`. Volume: `volume=...:eval=frame`, the ducking pattern. Grade: `eq` with
    `eval=frame`. Hue: `hue=h=` expression. Mask: an overlay of the mask PNG with expression x/y.
- **Memory and budget.**
  - Expressions are evaluated per frame, so the cost is small per property but adds up. Charge a measured
    `KEY_SECONDS_PER_S` per animated property × pixel rate.
  - Animated scale keeps the existing zoom caps (`XFADE_LARGE_ZOOM_MAX` above 1440p on cross-faded clips).
  - The `geq` opacity cap stays.
- **Migration and back-compat.** No SQL. Absent `keys` means no change. The browser preview interpolates with the same
  evaluator.

### D2. Nested sequences / compound clips

- **Document.**
  - A top-level `sequences: { "<id>": {width?, height?, tracks, captions?, overlays?, shapes?} }`, depth 1 in v1 (a
    nested sequence cannot contain another).
  - A V clip may name `sequence: "<id>"` instead of `asset_id`. Exactly one of the two.
  - `in_s`/`out_s` are times inside the nested sequence.
  - Nested `asset_id`s are still found at any depth by `editor_doc_problem`, so the org check holds.
- **Validators.**
  - Validate each nested sequence as a document with the parent's fps.
  - The clip's range must be inside the nested duration.
  - Budgets are summed: the nested work counts once per use.
- **Render.**
  - Render each used nested sequence **first**, with the same `timeline_render` path, into an intermediate at the
    parent's frame and fps, in the render's temp directory, then use it as a video file.
  - Only the used range is rendered, and the render is cached by a hash of the nested document within one export.
  - Renders run sequentially, so peak memory is the max of the two passes, not their sum.
- **Memory and budget.** Time is roughly the nested length × its factor, added to `work`. The disk guard counts the
  intermediate. Limit: total nested length ≤ the parent length × 2.
- **Migration and back-compat.** No SQL, but `editor_doc_duration` and the paid quote's length (0136) must resolve a
  `sequence` clip's length. That is a **migration** of those two SQL functions, with the same "pin test strips the
  marked lines" discipline as 0132.

### D3. Adjustment layers (and the ordered effects list they need)

- **Document.**
  - A V2+ clip with `kind: "adjustment"` and no `asset_id`. It carries look fields and, later, `effects`.
  - An optional `effects: [{name, ...params}]` ordered list on clips and on adjustment clips. Names come from the closed
    registry of `grade`, `color`, `filter`, `blur`, `sharpen`, `grain`, `vignette`, `fx.*` and the future ones.
  - The old fixed fields are read as a fixed prefix in today's order (§3), so an old document is a list in the old order.
- **Render.** The adjustment applies to the **composite of everything below it**, over its span.
  - With only V1 below, split V1's segments at the adjustment's edges and append its chain to those pieces. That costs
    nothing extra, like a per-clip effect.
  - With V2+ layers or shapes below, apply the chain in the final pass on the composed stream with ffmpeg timeline
    editing (`enable='between(t,a,b)'`). `eq`, `hue`, `gblur`, `vignette`, `rgbashift` and `noise` support it. Filters
    that do not are refused on adjustment layers.
  - Texts and captions stay above, as now: the ASS burn is last.
- **Memory and budget.** One more filter over the span at the output size. Charge it like section 14's look cost for the
  span. Above 1440p, blur on an adjustment over a cross-fade is refused (the measured `XFADE_LARGE_BLUR_MAX` rule).
- **Migration and back-compat.** No SQL. Absent means unchanged.

### D4. Multicam

- **Document.**
  - A top-level `multicam: { "<id>": { angles: [{asset_id, offset_s, label?}], audio: <angle index> } }`, made by
    syncing.
  - A V1 clip may carry `multicam: "<id>", angle: n`. Its `asset_id` must equal that angle's asset, so the existing
    resolver and `editor_doc_problem` need no change.
  - `in_s` is computed as the timeline time plus the angle's offset.
- **Sync.** In the browser, cross-correlate the decoded audio envelopes (the `editorSilence.analyseFile` decode path and
  caps) of up to 4 angles. Offsets are found to 10 ms and refined to the sample.
- **Editing.** A 2×2 angle grid in the preview, decoding 4 proxies at 480p. With WebCodecs (D9) the grid is synced; until
  then four `<video>` elements are kept in sync by currentTime correction. Keys 1–4 cut to an angle at the playhead
  (split + change asset and in_s). The audio stays the chosen angle's, as one long A clip.
- **Render.** No new path. Every cut is an ordinary V1 clip of one file, and the audio is an ordinary A clip. The
  multicam fields are metadata.
- **Memory and budget.** None at export. Preview only.
- **Migration and back-compat.** No SQL. A worker that ignores `multicam` would still need to accept the field, so it
  follows the one-commit rollout.

### D5. Masks with tracking (and the same tracker for auto-reframe)

- **Document.** Masks become keyable (D1 `mask.*`). A tracked mask is simply keys: one per frame at most, thinned by
  Ramer–Douglas–Peucker to stay within 32–200 keys, inside the 256 KiB cap. Add `mask.mode: "hide" | "effect"`, where
  `effect` applies the clip's effect list only inside the mask (MK07). Add more shapes (polygon points ≤ 32).
- **Tracking.**
  - **v1 runs in the browser**, the precedent of silence and beat analysis. Decode the proxy with WebCodecs and run a
    template-matching tracker (normalised cross-correlation on a 64–128 px patch) in a Web Worker, forward and back from
    the playhead. It is free, needs no queue, and the person corrects drift by moving a key.
  - **v2 runs on the worker:** an OpenCV CSRT tracker with face detection for reframe. That needs a job table, which is
    a migration, because the web image has no ffmpeg (§14).
- **AI object masks.** These need per-frame alpha. They come from a first-party segmentation API when one is registered
  (none is today) and are stored as a **mask video asset** (gray, lossless or near-lossless H.264 at the proxy's size).
  The clip names it as `mask.asset_id`, so the org check covers it.
- **Render.**
  - Shape masks with keys: the static PNG from `draw_mask` is overlaid with expression x/y and `scale ... eval=frame`
    onto a black canvas, then `alphamerge`. This avoids a per-frame Pillow drawing.
  - Mask videos: a second input, then `alphamerge`.
  - `mode: effect`: `split`, the chain on one branch, `alphamerge`, then `overlay` onto the untouched branch.
- **Memory and budget.** A keyed mask costs about the static mask (0.3 s/s, §14) plus the expression overlay; measure it.
  A mask video is one more decoder. Above 1440p, today's rule stays: no mask on a cross-faded clip.
- **Auto-reframe.** The same tracker output, a subject centre per frame, is written as `transform.x/y` (V2+) or `move`
  keys (V1) per export ratio. That makes C5.

### D6. Audio mixer and buses

- **Document.**
  - A tracks: `gain_db`, `pan` (-1..1), `mute`, and `bus` (an id).
  - A top-level `buses: [{id, name, gain_db?, voice?, eq?, comp?}]`, closed presets only, plus an optional
    `master: {loudness: "-14" | "-16" | "off", limiter: bool}`.
  - V clips' own sound go to a `dialogue` bus by default.
  - Clip and track `volume_db` / `pan` keys come from D1.
  - `solo` is editor-only and never stored.
- **Validators.** Bus ids must exist, each track is routed to one bus, no bus feeds a bus (v1), and closed preset names
  only.
- **Render.**
  - Today each track is filtered (`audio_track_filter`), ducked (`audio_duck_filter`), then `amix`ed without
    normalisation and cut to length.
  - New: tracks are mixed per bus (`amix` per bus), the bus chain is applied, buses are mixed into the master, then the
    master chain runs. The master loudness is **two-pass** `loudnorm`: measure, then apply. That is one extra audio-only
    decode of the mix, cheap next to video.
  - Ducking still reads speech positions, so a bus does not change who ducks whom.
- **Memory and budget.** Negligible memory. Time: the two-pass master adds about the audio decode time; charge 0.05 s per
  second.
- **Migration and back-compat.** No SQL. No `buses` means today's single `amix` and the same argv.

### D7. Scopes

- **Document.** None.
- **Path.** In the browser only.
  - Each displayed frame (a `<video>` frame drawn to an OffscreenCanvas, or a WebCodecs `VideoFrame`) is downsampled to
    about 480 px wide.
  - A WebGL2 fragment pass, or a Web Worker with typed arrays, computes the luma waveform, the RGB parade, a YUV
    vectorscope (BT.709 matrix) and a histogram. It updates at up to 15 Hz while playing and on every seek.
- **Honesty.** Until D9 the preview is approximate, so scopes describe the preview. Offer "scope the exported frame" by
  sampling a still export (EX09) at full quality.
- **Budget.** None on the server.

### D8. Proxies

- **Today.** Every uploaded video gets a 480p H.264 proxy and a thumbnail (`modules/media_library.py:133-140, 799`). The
  preview, silence and beat analysis use it, and the export always uses the original.
- **Change.**
  - Add a 720p proxy variant with a **short GOP** (keyframe every 0.5–1 s) for fast seeking under WebCodecs. Generate it
    lazily on first editor open, through the worker's existing variant path, with `proxy_timeout_s` scaled.
  - Add a "Preview quality: 480p / 720p / original (paused frame)" switch.
  - A proxy-only "Render preview" of a range (PB02): ≤30 s at 480p, free, cached by document hash. It is a low-priority
    export kind, which needs a migration (a kind column) and its own daily limit.
- **Memory and budget.** One-time proxy encode per asset, already budgeted by decode work. Storage grows by about 1.5×
  the 480p proxy.
- **Migration and back-compat.** A media variant row or column, if variants are tracked in SQL (check
  `VARIANT_FILES`). Assets without the 720p variant fall back to 480p.

### D9. Real-time preview (WebCodecs + WebGL)

- **Goal.** The preview should show what the export shows, and play through cross-fades, reverse, ramps and effects.
  Today these are CSS approximations or frame-stepped, and the ramped and reversed parts play without sound.
- **Pipeline.**
  1. Demux the proxy MP4 in a Worker with a bundled MP4 parser.
  2. Decode with `VideoDecoder`, one decoder per active layer, at most 4 plus the outgoing side of a cross-fade.
  3. Keep a frame cache around the playhead.
  4. A clock driven by the AudioContext.
  5. A WebGL2 compositor draws each layer through **shaders that mirror our closed lists**:
     - `eq` grade, colour lutyuv offsets, hue;
     - curves and looks as 1D LUT textures from the same tables (`samples/clip_look_curves.json`);
     - blur and sharpen as separable kernels, vignette, grain with the same seed;
     - masks from the same mask PNGs;
     - `fx` (rgbashift, glitch bursts on the same 0.9 s clock, flash, shake);
     - the 37 xfade styles ported from ffmpeg's `xfade` formulas;
     - transforms and D1 keys from the shared evaluator.
  6. Texts and captions are drawn by a canvas layer, or by libass compiled to wasm for exact match. The current CSS text
     preview stays the fallback.
  7. Audio is a WebAudio graph mirroring gain, fades, ducking and buses.
- **Parity tests.** For every fixture document in the golden sets, render 5 frames with ffmpeg and with the WebGL path in
  headless Chromium. Require PSNR ≥ 35 dB per effect, so a drift shows up as a test failure. Effects without a faithful
  shader keep the "approximate" label per effect.
- **Fallback.** No WebCodecs, or a failed decoder: today's `<video>` preview, unchanged.
- **Budget.** Client-only. Worker render cost is unchanged.
- **Migration.** None. D8's short-GOP proxy is strongly recommended for scrubbing.

---

## E. Phased roadmap

Each phase is a batch of 1–2 weeks for one builder plus an independent review. Phases 1–6 are the **PR-sized batches
proposed for now**, in dependency order. Phases 7–12 are the large foundations. Every PR keeps:

- both validators and the schema in parity;
- the argv golden files;
- the settle fuzz test (`cc/lib/editorSettle.ts`);
- en, ru and uz strings;
- a mutation check of its new rules.

| Phase | PRs (scope) | Migration | Tests |
|---|---|---|---|
| **1. Editing core, no render change** (top-20 #3, #4, #5, #7, #6) | 1a Rolling, slip and slide edits; rate-stretch by drag. 1b I/O marks, insert at playhead, range delete (lift/extract), one-click J/L cut. 1c Premiere key map (J/K/L, I/O, M, Q/W, Up/Down, Ctrl+K) plus safe-zone overlays and guides. | none | Property tests (5,000 seeded edits) that every op keeps `validateTimeline` clean; key-map focus tests; Playwright smoke at phone width |
| **2. Reuse a look** (#2, #13, #12) | 2a Multi-select (selection set; delete, move, nudge on lists). 2b Paste attributes + effect presets (localStorage) + paste masks. 2c Sync lock: ripple ops and silence cuts shift later texts, sounds, overlays and shapes; lane lock. | none | Settle fuzz with multi-edits; silence-cut tests updated (texts now move with sync lock on) |
| **3. Markers, chapters, scenes** (#10, #17) | 3a `markers` field (both validators + schema), "save beats as markers", snapping, chapter .txt download. 3b Browser scene detection on the proxy (WebCodecs + histogram), "split at scenes". | none | Shared doc cases for markers; scene detector held to a fixture set (`samples/scene_cases.json` measured against ffmpeg `scdet` on the worker, as silence is) |
| **4. Talking-head pack** (#1 ops, #8, #9, #11, #16 text fields) | 4a "Clean voice" preset (closed `voice` field; render chain; measured cost). 4b Single-word caption style. 4c `bleeps` (mute or tone) picked from caption words. 4d Text tracking, italic and alignment. The owner puts auto-captions on sale in parallel (`docs/AUTO_CAPTIONS_SETUP.md`). | none (a price row for captions is ops) | Audio filter argv goldens; loudness and bleep sample tests through the real export path; caption style golden ASS |
| **5. Keyframes v1** (#19; D1) | 5a `keys` model + evaluator twins + `samples/keyframe_cases.json` + validators. 5b Render: transform/opacity/volume/grade keys on V1 clips, overlays and A clips; budget constants measured at 1080p60 and 4K30. 5c UI: keyframe diamonds in inspector rows, volume and opacity rubber bands in the strip, ease picker. | none | Evaluator parity (Python vs TS to 1e-6); argv goldens unchanged without keys; memory tests under 2 GiB; render-time calibration |
| **6. Captions everywhere + versions + stills** (#14, #18, #15, #20) | 6a `caption_translate` capability (first-party LLM), price, probe; captions as a list of tracks with `language`/`burn`. 6b `editor_project_revisions` + Versions list/restore. 6c One-frame still export to the library. 6d Text-based editing v1: transcript view, delete words, then cuts (needs 4's captions on sale). | **yes**: 6a capability and price; 6b revisions table and `save_editor_project` body; 6c export kind column | Security tests for each new RPC (RLS, org, roles), as the 0132 suite does; hold/capture settle tests; doc cases for caption lists (old single object still valid) |
| 7. Stacked V tracks (D0) | 7a Document and validators (V2–V4, lane rules, overlays still valid). 7b Render: per-clip intermediates, layered final pass with own sound, memory model. 7c Editor model and multi-lane UI; overlay→V2 conversion. | none | Golden argv for single-lane docs; layer memory sweep (as shapes'); settle fuzz with layers |
| 8. Real-time preview (D9, D8) | 8a 720p short-GOP proxy variant and quality switch. 8b WebCodecs decode + clock + WebGL compositor for grade, looks, masks, transforms. 8c xfade and `fx` shaders; WebAudio mix. 8d Scopes (D7) on the same frames. | maybe (variant tracking) | Headless-Chromium PSNR parity vs ffmpeg frames per effect |
| 9. Tracking and reframe (D5) | 9a Browser tracker writes mask and transform keys. 9b Auto-reframe per export ratio (C5) with per-ratio overrides. 9c Effects inside masks (MK07). | none (browser) / yes (worker jobs, later) | Tracker fixture drift bounds; mask render memory at 4K30 |
| 10. Effects list and adjustment layers (D3) | 10a Ordered `effects` list with old fields as prefix. 10b Adjustment clips on V2+. 10c More looks (LUT asset type, validated .cube), Color Pass, glow. | 10c: LUT asset type (media kind) | Argv goldens; LUT parser fuzz; enable= cost measurements |
| 11. Mixer and export formats (D6, EX02, EX12, EX13) | 11a Track gain/pan/mute, buses, master loudness (two-pass). 11b Codecs: HEVC, ProRes LT (≤1080p), WebM, GIF, audio-only; progress %. | 11b: library MIME allow-list if new output types | Audio graph goldens; codec memory tests at 4K30 |
| 12. AI in the timeline (C1, C2, AI04, AI05) | 12a "Generate here" pending clips on V2 (needs 7). 12b Music and SFX panels. 12c Prompt-to-edit agent v1 (plan, diff, confirm, one undo). 12d Nested sequences (D2) and multicam (D4) after 7. | **yes**: agent capability and prices; D2's SQL length functions | Agent output always validated; hold/capture; nested length parity with SQL |

**Order rationale.**

- Phases 1–3 are browser-only and unblock everything that needs selection, marks and markers.
- Phase 4 makes the product sell for talking heads while transcription goes on sale.
- Phase 5 (keyframes) is the base that V tracks, reframe and masks build on.
- Phase 6 has the first migrations, grouped so that one review covers the security model.
- V tracks (7) and the real preview (8) are each the largest single risk, so they come once the smaller pieces have
  settled the document model.

---

## F. Notes and surprises

1. **There is no revision history.** `editor_projects` keeps only the current document and a `rev` number for optimistic
   saves (0054:107-108). Old versions survive only as the document snapshot of an export (`editor_exports.doc`).
   Premiere's versions and auto-saves, and any agent "undo across sessions", need a table.
2. **The 256 KiB document cap** (0054:179, `cc/lib/editor.ts:151`) is much smaller than Python's own 2,000,000-byte
   `MAX_DOC_BYTES` (`modules/timeline.py:323`). Keyframes, tracking and transcripts must be budgeted against the
   database's number, not Python's.
3. **Beat markers are not stored** (#680). They are recomputed per page and drawn on the sound's lane, so a reload or
   another member loses them. Phase 3 stores them.
4. **Premiere's AI Assistant spends Firefly generative credits.** Its caption translation uses Google and Microsoft
   engines. Adobe's own pages do not state Uzbek support for transcription or translation, which is our opening (C4).
5. **Generative Extend never extends speech or music,** and works on one end of a clip only (Adobe's page). An honest
   "continue this shot" through image-to-video from Veo or Runway is comparable for b-roll, not for talking heads.
6. **The tool-letter shortcuts** (V, A, B, N, R, C, Y, U) could not be confirmed on the Adobe pages that were read, so
   they are not cited as Adobe's.

---


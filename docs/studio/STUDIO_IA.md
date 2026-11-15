# Nightshift Studio: information architecture

Status: proposal, 2026-11-14. Prototype: the prototype (kept outside the repo) (one file, mock data).
Screenshots: `research/studio-canvas/`. Builds on `research/film-design.md` ("2200": violet is the machine,
amber is a person's mark, light only from real state, the dock never covers content), `docs/FILM_STUDIO.md`
and migration `0166_films_core.sql`. The competitor benchmark (`studio-benchmark.md`) did not exist when this
landed while this was being written and is folded in: §7a maps its 25 must-beat items onto the canvas. Also
used: `studio-bench/` (Krea Nodes and Higgsfield Canvas help pages) and the buzzy.now ad frames
(`buzzy/frame_01..18.png`).

The owner's complaint: *"buni qara hammasi hozir har joyda ular bitta joyda umuman bir biriga aloqasi yo'qdek"*.
Everything is in a different place, and nothing looks related to anything else.

The answer: **one workspace, one project, one graph.** Every creative tool becomes a node, a panel or an
inspector tab on the same canvas. The edges between nodes are real stored relations, not decoration.

---

## 1. What exists today (read from the routes, not the labels)

These are the routes under `command-center/app/(app)/[channel]/`, read on the newest branch
(`claude/film-p2-money`, bea475ce). The owner's sidebar screenshot shows the same labels.

| Sidebar label (uz) | Route | What the page really does | Data |
| :-- | :-- | :-- | :-- |
| Yaratish | `/create` | The composer, plus "desks" (`overview`, `video`, `effects`, `image`, `enhance`, `voice`, `youtube`). It holds 11+ single-shot tools (`t2i`, `t2v`, `i2v`, `edit`, `tts`, `upscale`, `remove_bg`, `voice_change`, `dub`, `describe`, `video_upscale`, plus `expand`, `relight`, `erase`, `video_edit`, `video_reframe`, `video_remove_bg`). Each job is priced, held and captured. The `youtube` desk starts a channel run (Run now, admin+). It is prefilled from `?tool=`, `?desk=`, `?model=`, `?style=`, `?effect=`, improve links and pending attachments. | `creative_jobs`, credits |
| Videos | `/videos`, `/videos/[id]`, `/videos/storyboard/[id]` | Finished and held videos with metrics. Runs stopped at "Storyboard ready" (0057), with scene cards and the one render price; editable before approval (0058). | `videos`, `metrics_snapshots`, storyboards |
| Brand look | `/studio`, `/studio/regions` | The channel's visual identity: style presets that the bot expands (`modules/style_presets.py`; applying one writes the channel's base visual style), the autopilot's latest auto-picked topic, and the org's style kits and characters (0047). `regions` is the region editor (flag, default off). | channel style, `style_kits`, characters |
| Styles | `/styles` | The Style Library: built-in art directions to browse and add as style kits (0065). | style library |
| Media library | `/library` | The org's media library (0038): uploads, made assets, folders, storage quota. | `media_assets` |
| Editor | `/editor`, `/editor/[id]`, `/editor/image/[assetId]` | Video editor projects (0054). Editing and export are free; an export lands in the library and is never published. Also a single-image editor. | editor projects |
| Ssenariylar | `/workflows`, `/workflows/[id]`, `/workflows/runs/[id]` | **Not scripts.** The org's saved multi-step *workflows* (0073): steps whose inputs are typed words, a library picture, or an earlier step's output. A run starts only from its page, after one total price is shown and confirmed. The Uzbek label hides that this is already a node graph. | `workflows`, workflow runs |
| Pipeline | `/pipeline` | The autopilot run as nine stages read from `system_events`: topic, research, script, voice, media, thumbnail, render, upload, publish. Read-only. | `system_events` |

Also in this family: `/presets` (one gallery of formats, looks, templates and voices; no rail entry),
`/character-studio` (flag), `/ads` (flag), `/series` (recurring content lines, 0006).

**Why it feels scattered.** The same objects show up in four places under four names: a "look" is a
preset on Brand look, a kit on Styles, a Style chip in Create, and a card in Presets. A picture made in
Create lives in the Library, is edited in the Editor's image tool, and is fed to a Workflow, and no screen
shows that path. The autopilot's run (Pipeline) and its storyboard (Videos) are two pages about one thing.

---

## 2. The model: one project, one graph, two views

```
                       Nightshift Studio  /{channel}/studio/{kind}/{id}
┌ Rail ┬─ Project bar: project ▾ · Canvas | Timeline · run state · ⌘K · credits · theme ──────────────┐
│ 76px │┌ Asset drawer ┐┌──────────────── Canvas (infinite, pan/zoom) ──────────────┐┌ Inspector ┐│
│      ││ Media        ││  [Idea]─▶[Script]──▶┌ Scenes frame ───────────────┐     ││ the        ││
│ Cmd  ││ Looks        ││     [Narration]────▶│ [S1]→[S2]→[S3]→[S4]  timing  │──▶[Cut]──▶[Send]
│ Stu  ││ Characters   ││  [Aziza]───────────▶│ [S5]→[S6]→[S7]→[S8]          │  ▲  ││ selected   ││
│ Inb  ││ Recipes      ││  [Neon kit]────────▶└──────────────────────────────┘  │  ││ node's     ││
│ Ana  ││ Effects      ││  [Channel look]────────────────────[Narration][Music]─┘  ││ controls   ││
│ ──── │└──────────────┘│                                              [minimap]   │└────────────┘│
│ Adm  │                ├─ Deck: + Add · Hand/Select · zoom · Fit · Timeline · Quote ────────────┤
│      │                │  Timeline (toggle, T): picture / voice / music / captions, same nodes   │
└──────┴────────────────┴─────────────────────────────────────────────────────────────────────────┘
```

- A **project** is the unit of work. It has a kind, and every kind opens on the same canvas:

  | Kind | Backed by | Who draws the graph |
  | :-- | :-- | :-- |
  | `film` | `films` / `film_scenes` / `film_refs` / `film_takes` (0166) | the person, with Gemini's scene split |
  | `run` | an autopilot run: `videos` + `system_events` + storyboard (0057/0058) | the bot, from its stage events |
  | `edit` | an editor project (0054) | the person; it opens on the timeline view |
  | `sketch` | the person's scratchpad per channel: `creative_jobs` from today's Create | the person |
  | `recipe` | a saved workflow (0073) | the person; its steps are the nodes |

- **Canvas and Timeline are two views of the same project.** Selecting a block on the timeline selects
  the same node, and the same inspector opens. Toggling never reloads or loses the selection. (Buzzy
  shows canvas and timeline as separate screens; we keep them one object.)
- **Edges are data, not drawing.** Every line is a stored input relation, as below. Drawing a line
  writes that relation, and it is free and rate-limited like any save. A line never starts a job.

  | Line | Where it is stored |
  | :-- | :-- |
  | a reference into a scene | `film_refs` |
  | "continue from the previous shot" | `first_frame = previous` |
  | a library picture as the first frame | `first_frame = asset` |
  | a step's input | a workflow binding |
  | a job's input picture | `creative_jobs` input asset |

  A layout table (`studio_layouts`: node positions, frames, notes; jsonb; no money) is the only new state
  that the canvas itself needs.
- **Nothing on the canvas spends without its quote.** Every generating node and the project have a
  `Get quote` → `Start | N cr` pair. The number comes from the backend's quote function (`quote_film` in
  P2, the creative quote today, the workflow total for recipes). The key is disabled until a quote exists
  for the exact inputs shown, and editing any input voids the quote.

---

## 3. Every current page, mapped into the workspace

| Today | Becomes in Nightshift Studio | Type |
| :-- | :-- | :-- |
| **Create**: composer and desks | **Add node** (the `+` key, `N`, ⌘K "Add …") and the **Sketch** project. Each tool is a node type: Image (`t2i`, `edit`, `describe`), Clip (`t2v`, `i2v`), Voice (`tts`, `voice_change`, `dub`), Enhance (`upscale`, `remove_bg`, `expand`, `relight`, `erase`, `video_upscale`, `video_reframe`, `video_remove_bg`, `video_edit`). A node's inspector is the old composer form for that tool, with the same model list, the same quote and the same hold. The `youtube` desk becomes **New project → From a topic** (a `film`), or **Run autopilot now** (admin+, unchanged backend). The `effects` desk becomes the **Effects** tab of the asset drawer. | node types + drawer tab |
| **Videos**: list | The Studio home **shelf**, tab "Videos" (finished, held, uploaded), beside "Projects" (in progress). A video card opens the project that made it. | shelf tab |
| **Videos**: storyboard `[id]` | The `run` project's **Checkpoint: Storyboard ready** node (amber: it waits for a person), with the scenes beside it on the canvas. "Approve storyboard" is the existing 0057/0058 route, with its one price on the key. | node |
| **Brand look** (`/studio`) | The **Channel look** reference node, pinned to every project of the channel: palette, presets, logo, intro and outro. Its inspector is today's Brand look page. "Apply to channel" still writes the channel's base visual style, which the bot reads. It is also the **Looks → Channel** tab of the drawer. | reference node + drawer tab |
| **Brand look → regions** | The Image node's inspector tab **Regions** (same flag, same quote). | inspector tab |
| **Styles** | The drawer tab **Looks**: the Style Library to browse. Dragging a look onto the canvas makes a **Style kit** reference node (add-to-kit is the same 0065 call). Wiring it into a scene or the Scenes frame sets `style_kit_id` and `film_refs(style)`. | drawer tab + reference node |
| **Presets** | The same **Looks** tab (formats, looks, templates, voices) and the ⌘K "Start from a preset" group. A preset only fills a node's form and never spends, as today. | drawer tab |
| **Media library** | The **asset drawer** (left, part of the layout). Tabs: Media (folders, upload, quota), Looks, Characters, Recipes, Effects. Dragging an asset onto the canvas makes an Image/Clip/Audio node that holds that asset; dropping it on a scene's first-frame port sets `first_frame = asset`. The full library screen stays reachable as the drawer's "Open full library" view. | panel |
| **Editor**: projects and `[id]` | An `edit` project opens on the **Timeline** view, the same bottom panel a film uses. The editor's tracks are the timeline's tracks, and its clips are nodes on the canvas view. Export still ends in the library and never publishes. | project kind + view |
| **Editor → image** | The Image node's inspector tab **Edit**. | inspector tab |
| **Ssenariylar** (`/workflows`) | **Recipes**: a saved workflow is a reusable subgraph. In the drawer it is a card; dropped on the canvas it is one **Recipe node** with typed inputs and outputs, and it expands into its steps. "Save selection as recipe" turns selected nodes into a workflow. A run keeps 0073's rule: one total price, confirmed. | drawer tab + group node + project kind |
| **Workflow run** `[id]` | The Recipe node's **Runs** inspector tab. Each step lights on the canvas from its real status. | inspector tab |
| **Pipeline** | The `run` project. The nine stages are nodes (Topic → Research → Script → Checkpoint → Scenes → Voice → Media → Thumbnail → Render → Upload → Approval). Their lamps come from `system_events` (unknown when no event; rule 5). The Studio home shows "Autopilot: today's run" as the first card. | project kind |
| **Character Studio** (flag) | A **Swap** node (Clip in, pictures in, consent in the inspector). Flag off: no node type and no route, as today. | node type |
| **Ads** (flag) | Open decision (§9): a project kind `ad` on the same canvas, or a separate area. | — |
| **Series** | Stays in Admin. A `run` project shows its series as a read-only source chip on the Topic node. | — |

### Node catalogue (what the canvas is made of)

Port types are told apart by **shape**, never by colour alone, and none of them uses violet or amber. The
type's name and letter appear in the port's label on hover and focus, and in the inspector's Inputs list:

| Port | Shape | Letter | Colour |
| :-- | :-- | :-- | :-- |
| text | square | T | slate |
| image | circle | I | cyan |
| video | diamond | V | rose |
| audio | triangle | A | green |
| reference | ring | R | blue |

| Group | Node | Inputs → outputs | Its inspector holds |
| :-- | :-- | :-- | :-- |
| Story | Idea | → T | the topic, language, length and format (`films.topic`, `language`, `aspect`, `target_seconds`) |
| Story | Script | T → T | the script or narration; the fact-check state ("did not run" when it did not) |
| Story | Checkpoint (`run` only) | any → same | waits for a person (amber); the decision is a stored row |
| Shots | Scenes frame | T, R → V (clips in order) | a group: a reference wired into the frame applies to every scene in it |
| Shots | Scene | T, R, I (first frame) → V, I (last frame) | Shot · Angle & light · Takes · Clip model |
| Shots | Image (key frame / still) | T, R, I → I | the model picker (`t2i` / `edit`), Edit, Regions, Takes |
| Shots | Clip | I (first), I (last) → V | the model picker (`i2v` / `t2v`), duration, audio, Takes |
| Shots | Enhance | I or V → same | the tool (upscale, relight, …) |
| Shots | Swap (flag) | V, I → V | consent, model |
| Look | Character | → R | a 0047 character, used in N scenes |
| Look | Style kit | → R | a kit (0047/0065) |
| Look | Channel look | → R | Brand look: presets, palette, logo; applies to the channel |
| Look | Location | → R | a picture |
| Sound | Narration (Voice) | T → A | the voice picker; rule 4 copy: "if this voice is unavailable, the run stops". **Narration comes first**: its word timings feed the Scenes frame's timing port, so they set every scene's length (film.md §6.1). Scene boundaries snap to word gaps on the timeline |
| Sound | Music | → A | a track from the library, gain |
| Sound | Captions | T → T | languages; the film language cannot be unticked |
| Output | Cut | V, A, T → V | assembly; disabled with the count of unresolved scenes; sha256 of the cut |
| Output | Thumbnail | I, T → I | variants |
| Output | Send to channel | V, I → | private upload, gate verdict, approval (§7) |
| Output | Recipe | its inputs → its outputs | steps, Runs |
| Notes | Note | — | a person's sticky note (amber) |

---

## 4. Navigation: the new left rail

### Operator (owner) rail, first group: 13 → 4 entries

| Before (first group) | After |
| :-- | :-- |
| Boshqaruv markazi | **Boshqaruv markazi** (Command center) |
| Yaratish, Videolar, Brend koʻrinishi, Uslublar, Mediateka, Muharrir, Ssenariylar, Konveyer (+ Ads and Character Studio when flagged on) | **Nightshift Studio** (one entry) |
| Kiruvchi xabarlar | **Kiruvchi xabarlar** (Inbox) |
| Tahlil | **Tahlil** (Analytics) |

The Studio entry expands, in the sidebar only, into its three most recent projects. The first of these
is always "Autopilot: today's run" while a run exists. These are shortcuts; there are no more sections.

**Boshqaruv (Admin)** stays as it is: Kanallar (Channels), Portfel (Portfolio), Provayderlar (Providers),
Modellar (Models), then the rest of today's `gManage` group (Accounts, Margin, Customers, Billing,
Credits, Usage, Series, Agents, Jobs). The `gIntel` and `gSystem` groups are unchanged. Those are
operator consoles, not creative tools.

### Customer rail (`CUSTOMER_RAIL`)

Home · **Studio** · Channels · Credits · Settings. "Videos" leaves the rail because it is a shelf tab of
Studio. The `SECTION_TABS.hub` tab bar (Create, Library, Editor, Workflows, Studio, Styles, …) is removed.
Those are now drawer tabs and node types, so the "wall of tools" that `navigation.ts` warns about is gone
for good. `CUSTOMER_SIDEBAR.tools` (the 11 tool links) becomes the **Add node** menu. Its links still work
through the redirects below.

### Phone (≤ 760 px)

The bottom bar is Home · Studio · Inbox · More. Inside Studio, the canvas becomes a **vertical flow**:
nodes are stacked in graph order, grouped Story → Look → Shots → Sound → Output. Each card lists its
inputs as chips ("from Script · Aziza · Neon kit"), with a rail line between connected cards. The
inspector is a **bottom sheet**, and the timeline is a horizontally scrolling strip inside its own panel,
so the page never scrolls sideways.

---

## 5. URLs and redirects (no link breaks)

### The new URLs

| URL | What it opens |
| :-- | :-- |
| `/{channel}/studio` | Studio home: the shelf (Projects · Videos), "New project", "Autopilot: today's run" |
| `/{channel}/studio/{kind}/{id}` | a project on the canvas; `kind` ∈ `film`, `run`, `edit`, `sketch`, `recipe` |
| … `?view=timeline` | the same project, with the timeline open |
| … `?node={nodeId}` | selects a node and opens the inspector; deep links are shareable |
| … `?tab=angle\|takes\|edit\|regions\|runs` | an inspector tab |
| … `?drawer=media\|looks\|characters\|recipes\|effects` | the asset drawer on a tab |
| … `?add={tool}` | arms Add node with that tool; it fills a form and never prices or spends |
| `/{channel}/studio/video/{videoId}` | resolves to the project that made the video, with `node=send` |

`all-channels` works like everywhere else (`middleware.ts` puts the channel into the request headers).
Creating on `all-channels` asks which channel first, as Create does today.

### Redirects

Each old `page.tsx` becomes a **server-side shim** that calls `redirect()`, and `next.config` redirects
are not used. The reason: the target depends on the query (for example `tool`) and on a lookup (for
example video → its run). A pure `lib/studioRoutes.ts` maps old → new, and a unit test feeds it every
old URL shape below plus every link the app still prints (`toolHref`, `deskHref`, palette entries,
notification `section`s, e-mails, the public site's prompt links). The test fails if any of them maps to
nothing. Temporary (307) for one release, then permanent (308).

| Old URL | New URL |
| :-- | :-- |
| `/{c}/create` | `/{c}/studio/sketch/me` |
| `/{c}/create?tool=t2v` (any of `STUDIO_TOOLS`) | `/{c}/studio/sketch/me?add=t2v` |
| `/{c}/create?desk=image\|video\|enhance\|voice` | `/{c}/studio/sketch/me?add={first tool of that desk}` |
| `/{c}/create?desk=effects&effect=…` | `/{c}/studio/sketch/me?drawer=effects&effect=…` |
| `/{c}/create?desk=youtube` (and run prefill params) | `/{c}/studio?new=topic&…` (the same prefill keys pass through) |
| `/{c}/create?model=…&style=…&prompt=…&improve=…&{PENDING_PARAM}=…` | the same keys, appended unchanged to the target above |
| `/{c}/videos` | `/{c}/studio?shelf=videos` |
| `/{c}/videos/{id}` | `/{c}/studio/video/{id}` (→ its project, `node=send`). A legacy video with no project opens a read-only one-node canvas. |
| `/{c}/videos/storyboard/{id}` | `/{c}/studio/run/{id}?node=checkpoint` |
| `/{c}/studio` (Brand look) | `/{c}/studio`: Studio home, whose header holds the **Channel look** chip (one click). See §9.1. |
| `/{c}/studio/regions` | `/{c}/studio/sketch/me?add=edit&tab=regions` (still 404 while its flag is off) |
| `/{c}/styles` | `/{c}/studio?drawer=looks` |
| `/{c}/styles?style={id}` | `/{c}/studio?drawer=looks&look={id}` |
| `/{c}/presets` | `/{c}/studio?drawer=looks&tab=presets` |
| `/{c}/library` | `/{c}/studio?drawer=media` (folder params kept) |
| `/{c}/editor` | `/{c}/studio?shelf=projects&kind=edit` |
| `/{c}/editor/{id}` | `/{c}/studio/edit/{id}?view=timeline` |
| `/{c}/editor/image/{assetId}` | `/{c}/studio/sketch/me?node=asset:{assetId}&tab=edit` |
| `/{c}/workflows` | `/{c}/studio?drawer=recipes` |
| `/{c}/workflows/{id}` | `/{c}/studio/recipe/{id}` |
| `/{c}/workflows/runs/{id}` | `/{c}/studio/recipe/{workflowId}?node=recipe&tab=runs&run={id}` |
| `/{c}/pipeline` | `/{c}/studio/run/latest` (no run yet: Studio home with "Autopilot has not run on this channel") |
| `/{c}/character-studio` | `/{c}/studio/sketch/me?add=swap` (flag off: 404, as today) |

When a redirect lands on a drawer or tab, the place shows a one-line, dismissible notice. For example:
"Styles now lives in the Looks drawer." It shows for one release only.

The breadcrumbs, tab title and palette read the same `SECTION_ITEMS`. `studio` is renamed in the
dictionary to "Nightshift Studio" in all three languages: it is a brand name, so it is not translated.
The old keys stay as hidden aliases, so `RAIL_HIDDEN_KEYS` and `CUSTOMER_NAV_KEYS` tests keep passing.

---

## 6. Autopilot and a manual project share one canvas

The same canvas, the same node types and the same inspector are used for both. Only **who drives** differs,
and that is shown, never implied:

| | Manual project (`film`, `sketch`, `edit`) | Autopilot (`run`) |
| :-- | :-- | :-- |
| Who adds nodes | the person | the bot, from its stage events: one node per stage, plus scene nodes once the storyboard exists |
| Badge | none | a small "Autopilot" chip on each node the bot made, and a project-bar chip "Autopilot · run 06:00" |
| Node lamps | job status (`creative_jobs`, `film_takes`) | `system_events`: `.started` → working (violet), `.completed` → done, `.failed` → failed with its remedy, no event → **unknown** (never "passed") |
| Editing | everything | locked, except at a **Checkpoint** (Storyboard ready, 0057/0058). There the scenes become editable and the amber "Approve storyboard \| price" key is the existing route. |
| Spending | per node or per project, after its quote | the run's own budget; the browser starts nothing except "Run now" (admin+, unchanged) |
| Publish | private upload + approval | the same Send node, the same gate and the same approval |

Two bridges make it one product instead of two:

1. **"Open as project"** on a run: it copies the run's storyboard into a new `film` draft
   (`create_film_draft` with `source=script`), so a person can take over a bot video and re-shoot scenes.
   The run itself is not changed.
2. **"Make this the channel's recipe"**: from a manual project, save the graph shape (refs, models, voice,
   look) as the channel's autopilot defaults. This is P9's `scene_mode = ai_video`, admin-locked. It
   writes settings only, so nothing starts.

---

## 7. Honesty rules, as the canvas enforces them (CLAUDE.md)

| Rule | On the canvas |
| :-- | :-- |
| **3. Nothing in the browser spends without a priced quote** | Generating nodes show `Get quote`. The quote is the backend's number for exactly these inputs. Then `Start \| N cr`. Changing an input voids the quote and greys the key with "Inputs changed, get a new quote". No model row and no node shows a price of its own: the model picker says "price: from quote". Drawing lines, moving nodes, adding nodes and applying looks are free saves. The two re-render buttons stay disabled until a priced consumer exists. |
| **5. No fake progress** | A working node shows a lamp, the stage word and, only when the backend gives one, `~46%` with "estimate from this model's recent jobs". Edges animate (light flowing toward a node) only while that node is actually working. An idle canvas is still, and an unknown is the word "unknown". |
| **4. No silent model substitution** | A model that is not available is listed as disabled, with its reason. Under the picker: "If this model is unavailable when the job starts, the job stops. Nothing is substituted." A failed node offers Retry (same model, new quote), or the person picks another model, which is their act and is labelled. No Seedance model is offered, ever (FILM_STUDIO.md, BytePlus terms §4.2.3). The models are only those `sellable_models` lists for that role. |
| **2/3. Every upload is private, with approval** | The Send to channel node reads: "Uploads as Private". Below that: "Publish gate: unknown" until an event exists. Then "Approve this exact cut" (amber, sha256 shown), which records a decision and does not change privacy. "Publish when approved" appears as a switch only an admin can turn on, and it is off. The key reads "Approve and publish" only on such a channel. "Published" appears only after YouTube's read-back says public. |
| **6. Fail early, say the fix** | Missing inputs are shown on the node before any quote: "Choose a voice that speaks Oʻzbekcha", "Scene 7 has no key frame". The quote refuses with the remedy, not the symptom. |
| **Prototype** | Every number, price, model list, still and status is mock and labelled "mock" or "simulated". |

## 7a. How the canvas meets the benchmark (`studio-benchmark.md` §2 and §4.2)

The prototype demonstrates each row marked **proto**. The rest are spec, and the build order (§8) puts
each one with its phase.

| # | Must-beat item | On the canvas | |
| :-- | :-- | :-- | :-- |
| 2, 3 | Edit and reorder the board before any spend | The Scenes frame lays its scenes out in order. Drag a scene to reorder it (an amber insertion beam marks the drop; the others reflow). Alt+arrows do the same, with a live-region announcement. On a phone, long-press opens Move earlier / later. Split, Insert after and Delete are in the scene inspector. The continuity lines are *derived* from `first_frame = previous`, so they stay true after a reorder. A first scene cannot "continue previous" and is fixed with a notice. | proto |
| 4–7 | Quote before spend; re-price on change; a person starts every spend; budget cap | Every generating node has `Get quote` and then `Start \| N cr`. Changing any input clears the quote. When a re-quote differs, the key shows the difference (+/− cr). The project's Quote opens pre-flight, the line items, "with retakes (an assumption)" and an editable **budget cap**. A Start that would cross the cap pauses with the shortfall ("never lowers quality to fit"). There is no auto-generate anywhere. | proto |
| 8, 10 | Live progress from real state; survive a reload | A node shows its lamp, stage, `~%` with its basis, elapsed time and queue position. In production these are patched from the event contract below. The canvas state is server-side (films tables plus `studio_layouts`), so a reload is the same view. | proto (simulated, labelled) |
| 9, 11 | Approve one scene while another renders; a re-shoot never touches neighbours | The lanes are independent. The inspector of a running scene says "Neighbouring scenes are not touched". | proto |
| 12, 13 | Camera and light with a before/after wipe; a take stack | Angle & light: the sphere, sliders, presets, time of day, and a draggable or keyboard (5%) wipe, with `\` to swap sides. Takes: every take is kept, any two can be compared, one is approved (`A`), and Revert takes one action. | proto |
| 14 | Visible consistency | A Character node carries a stated role and "cast approved by you". A scene shows "identity 0.91 (measured)" or "identity: not checked", never an unmeasured number. Wiring a character shows the model's reference limit *before* the save (toast). | proto |
| 15–16 | A failure shows its class, remedy and refund; no silent substitution | Scene 7 is `provider_timeout`, refunded 52 cr, Retry on the same model. The picker lists unavailable models disabled with the reason, and its footer gives the rule-4 sentence. | proto |
| 17, 18 | One assemble action; narration is the clock | The Cut node names the scenes that block it. The timeline: boundary handles snap to word gaps (the word pair is shown while dragging), arrow keys move a boundary one word at a time, `J/K/L` and Space scrub and play, and clicking a block selects the node. | proto |
| 19 | Undo and redo for every edit, never for a spend | Ctrl/Cmd+Z and Shift+Z, 100 steps. A restore keeps runtime state (jobs, holds, takes made) and restores only a person's edits, including which take is approved. | proto |
| 20 | Plain-language directions as undoable diffs | The command bar parses "make scene 4 warmer, low angle" into a draft change: an amber halo on the node, the quote cleared, and Undo in the toast. It never spends. | proto |
| 22 | Private upload with approval of the exact cut | The Send node (§7). | proto (copy only) |
| 23 | The core loop on a phone | A vertical flow, an inspector sheet, the timeline strip and a drawer sheet; no horizontal overflow at 390. | proto |
| F10 | The tab works as a monitor | The tab title reads "4/8 ready · Football in 2050". The bell lists only decisions (a failed scene, a take to approve, a waiting checkpoint), never progress ticks. | proto |
| 1, 21, 24, 25 | Two actions to a board, draft tier, film vs. interface language, performance | Spec. The Idea node keeps the film language apart from the interface language. The draft tier is shown only when the backend prices one. Performance: one rAF loop that stops when idle, art drawn once per scene as an SVG `<symbol>`, and a semantic-zoom overview (below 87% zoom, nodes show their art and a title scaled by 1/zoom, so no text renders under 13 px). | spec |

**Event contract (production, replaces the simulation).** Each job event is one row the canvas
subscribes to (Supabase Realtime), and the node reads only these fields:

```
{ node_id, take_id, kind: 'queued'|'started'|'stage'|'progress'|'done'|'failed'|'refunded'|'paused_budget',
  queue_pos?, stage?: 'key'|'clip'|'narration'|'assembly', elapsed_s?, estimate?: { pct, basis: 'model_recent_jobs' },
  error_class?, remedy_key?, credits?: { held?, captured?, refunded? }, at }
```

Progress never moves backwards and never shows 100% before `done`. On reconnect, the canvas re-reads
the latest row per node, so state is never assumed.

---

## 8. Build order (fits the Film Studio phases)

1. **IA shell, no new behaviour.** Add `studio/[kind]/[id]` with the `sketch` kind over today's
   `creative_jobs`, the asset drawer over `/library`, the shims and `lib/studioRoutes.ts` with its
   redirect test, and the new rail. Old pages keep working through the redirects. This adds the
   `studio_layouts` migration (positions only).
2. **`run` kind** from `system_events` plus the storyboard checkpoint. It replaces Pipeline and the
   storyboard page.
3. **`film` kind** on P5's `/api/films/**`. This is the canvas UI that P6 already plans (FILM_STUDIO.md).
   The multi-angle editor is P7.
4. **`recipe` kind** over 0073, and "Save selection as recipe".
5. **`edit` kind**: the editor's timeline becomes the shared timeline.

Each step is its own draft PR, through Scout → Forge → Lens → Probe → Breach → Sentinel → Pixel.

---

## 9. Open decisions for the owner

1. **`/{channel}/studio` changes meaning.** Today it is Brand look; tomorrow it is Nightshift Studio
   (brand name = URL). An old bookmark to Brand look lands on Studio home, where Brand is one click (the
   Channel look chip). Alternative: put the Studio under a new path (`/{channel}/make`), so that `/studio`
   can redirect exactly to the Channel look panel. **Recommendation:** `/studio`. It is the brand, and the
   loss is one click on an old bookmark.
2. **Ads** (flag): a project kind `ad` on the same canvas (brand kit = Channel look node, concept = Idea
   node), or keep it apart. Recommendation: a project kind, once the flag turns on for customers.
3. **Is Sketch per person or shared per channel?** Recommendation: per person (`sketch/me`), with
   "Move to project" to share.
4. **Inbox and Analytics** stay outside the Studio. Alternatively, Analytics could appear as a read-only
   "Performance" chip on the Send node of a published video. Recommendation: the chip, linking to
   Analytics.
5. **Edge semantics for scenes.** A reference wired into the Scenes frame applies to all scenes in it.
   This needs `film_refs` (film-wide) versus per-scene refs to stay distinct in the UI. It is proposed
   here and needs a yes before P6.
6. **Mobile scope.** The phone gets the vertical flow and the inspector, but no free-form wiring (drawing
   lines with a finger on 390 px is a trap). Connections on the phone are made from the inspector's
   "Inputs" list. Recommendation: yes.

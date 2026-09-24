# video-engine — Remotion scene renderer

One **Video IR scene** in, one `.mp4` out. This is the motion-graphics render
backend from the Video OS roadmap (PR 3.2): title/chapter/quote cards, stat
counters, Ken Burns / parallax / archival stills, word-level captions. B-roll
footage stays on the ffmpeg backend.

It is **off by default** in the pipeline and not wired into `main.py` yet —
`modules/remotion_renderer.py` only runs it when `CHRONOS_REMOTION=1`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point (`registerRoot`) |
| `src/Root.tsx` | Registers the `Scene` composition; `calculateMetadata` sets duration from `scene.end_s - scene.start_s`, plus `width`/`height`/`fps` from props |
| `src/SceneComposition.tsx` | Picks the component from `scene.shot.recipe` (a `modules/shot_recipes.py` id), then scene type, then assets |
| `src/components/ImageScene.tsx` | `slow_push`, `slow_pull`, `lateral_pan`, `parallax`, `archival_reveal`, `map_zoom` |
| `src/components/VideoScene.tsx` | `broll_cut` / any scene whose asset is a video |
| `src/components/TitleCard.tsx` | `title_card`, `chapter_card`, `quote_card` |
| `src/components/StatCard.tsx` | `stat_counter` |
| `src/components/Captions.tsx` | Word-level captions from the optional `words` prop |
| `src/components/Transition.tsx` | Transition into the scene (`crossfade`, `dip_to_black`, `hard_cut`) |
| `src/types.ts` | The props contract |
| `fixtures/title-card.json` | A 2 s, 640×360 title card used by the CI smoke render |

Every component is a pure function of the frame (`useCurrentFrame` +
`interpolate`): no network, no randomness, no `Date`. A graphic recipe whose
content cannot be derived (no number for `stat_counter`, no quotation for
`quote_card`) falls back to `slow_push`, the same as the recipe catalogue.

## Props

```jsonc
{
  "scene": { "id": "s003", "index": 3, "name": "...", "type": "story", "narration": "...",
             "start_s": 42.0, "end_s": 47.5,
             "shot": { "recipe": "stat_counter", "camera": "...", "lighting": "...", "mood": "..." },
             "element_ids": [], "asset_ids": [], "claim_ids": [] },
  "width": 1920, "height": 1080, "fps": 30,
  "assetsBaseDir": "/abs/path/output/<slug>",          // served as --public-dir
  "style": { /* modules/style_presets.StyleBible.to_dict() */ },   // optional
  "words": [{ "text": "Revenue", "start_s": 42.1, "end_s": 42.5 }], // optional, project clock
  "assets": [{ "id": "a1", "kind": "image", "path": "images/a1.jpg" }], // optional, relative to assetsBaseDir
  "transition": "crossfade"                              // optional
}
```

`start_s`/`end_s` must both be known: a scene with unknown timing fails to
render rather than getting a guessed length (the audio is the master clock).

## Preview and render

```bash
cd video-engine
npm ci
npx remotion studio                       # preview in the browser (uses the default props)
npx tsc --noEmit                          # typecheck

# Render one scene
npx remotion render src/index.ts Scene out/scene.mp4 \
  --props=fixtures/title-card.json --concurrency=1

# With local assets and a local Chromium (headless shell)
npx remotion render src/index.ts Scene out/scene.mp4 \
  --props=props.json --public-dir=/abs/path/to/assets \
  --browser-executable=/path/to/headless_shell --concurrency=1
```

Without `--browser-executable` Remotion downloads its own headless Chromium on
first use (`npx remotion browser ensure`).

From Python (`modules/remotion_renderer.py`):

```bash
CHRONOS_REMOTION=1 \
CHRONOS_REMOTION_BROWSER=/path/to/headless_shell \   # optional
CHRONOS_REMOTION_TIMEOUT=600 \                       # optional, seconds
python -c "from modules.remotion_renderer import render_scene; ..."
```

`render_scene` never raises: on any failure it logs a warning and returns
`None` so the caller can fall back to another backend. It never runs
`npm install`; `video-engine/node_modules` must already exist.

## License — read before commercial scale-up

Remotion is **not** MIT/Apache. Its license (see
`node_modules/remotion/LICENSE.md`, and remotion.dev/license) has two tiers:

- **Free License** — for an individual; a for-profit organization with **up to
  3 employees**; a non-profit or not-for-profit organization; or anyone
  evaluating whether Remotion fits and not yet using it commercially. Eligible
  users may use it commercially to create videos.
- **Company License** — required for every other entity (for-profit
  organizations with more than 3 employees). Pricing: remotion.pro/license.

The license text also notes that it will change slightly in Remotion 5.0. This
project pins Remotion 4.0.527. Check eligibility again before the operating
entity grows past the free tier or before upgrading to 5.x.

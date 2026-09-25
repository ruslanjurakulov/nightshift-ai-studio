# video-engine — Remotion scene renderer

One **Video IR scene** in, one `.mp4` out. This is the motion-graphics render
backend from the Video OS roadmap (PR 3.2, 3.3): title/chapter/quote cards,
stat counters, timelines, evidence cards, map zooms, Ken Burns / parallax /
archival stills, lower thirds and word-level captions. B-roll footage stays on
the ffmpeg backend.

It is **off by default** in the pipeline and not wired into `main.py` yet —
`modules/remotion_renderer.py` only runs it when `CHRONOS_REMOTION=1`.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Entry point (`registerRoot`) |
| `src/Root.tsx` | Registers the `Scene` composition; `calculateMetadata` sets duration from `scene.end_s - scene.start_s`, plus `width`/`height`/`fps` from props |
| `src/SceneComposition.tsx` | Picks the component from `scene.shot.recipe` (a `modules/shot_recipes.py` id), then scene type, then assets |
| `src/components/ImageScene.tsx` | `slow_push`, `slow_pull`, `lateral_pan`, `parallax`, `archival_reveal` |
| `src/components/MapScene.tsx` | `map_zoom`: slow zoom on a static map **image** toward `map.focus`, pin + label |
| `src/components/VideoScene.tsx` | `broll_cut` / any scene whose asset is a video |
| `src/components/TitleCard.tsx` | `title_card`, `chapter_card` |
| `src/components/QuoteCard.tsx` | `quote_card`: the quotation revealed word by word, attribution when the narration names the speaker |
| `src/components/StatCard.tsx` | `stat_counter` |
| `src/components/Timeline.tsx` | `timeline`: years (1000–2099, "Dec 1900", "1950s") from the narration, oldest first, max 5 |
| `src/components/EvidenceCard.tsx` | `evidence_card`: up to 3 claims with their advisory fact-check status |
| `src/components/LowerThird.tsx` | Name/label strip from the optional `lowerThird` prop, over image/video/map scenes only |
| `src/components/Captions.tsx` | Word-level captions from the optional `words` prop |
| `src/components/Transition.tsx` | Transition into the scene (`crossfade`, `dip_to_black`, `hard_cut`) |
| `src/types.ts` | The props contract |
| `fixtures/*.json` | 2 s, 640×360 props for the CI smoke render: title card, map zoom, timeline (clips); quote card, evidence card, lower third (stills) |
| `fixtures/public/map.svg` | A made-up archipelago: the local map image the map fixtures use (`--public-dir=fixtures/public`) |

Every component is a pure function of the frame (`useCurrentFrame` +
`interpolate`): no network, no randomness, no `Date`. A recipe whose content
cannot be derived (no number for `stat_counter`, no quotation for
`quote_card`, no year for `timeline`, no image asset for `map_zoom`) falls back
to `slow_push` (footage, when the scene has a video asset), the same as the
recipe catalogue.

Honesty rules the components keep:

* `map_zoom` draws a pin only at a supplied `map.focus`. Without one it zooms
  on the centre and shows the label (if any) as a tag, not pointing anywhere.
* `evidence_card` shows the status it was given. No status, or one it does not
  know, reads "Status unknown" — never a verdict and never "Not checked". With
  no claims at all it shows the narration's first sentence as a neutral card.
* `quote_card` names a speaker only when the narration does, next to the
  quotation; a pronoun ("He wrote …") is not a speaker.
* `timeline` markers are evenly spaced: the order is real, the spacing is not
  to scale.

`timeline` and `evidence_card` are `auto_select=False` in
`modules/shot_recipes.py`: valid, executable ids that the chooser never picks
on its own; they are set explicitly — by `modules/graphic_recipes.py` in the
IR compiler when `CHRONOS_GRAPHIC_RECIPES=1` (default off), only for scenes
whose data supports them (>= 2 distinct years; a fact-checked claim; a map
image plus a named place for `map_zoom`). Its year reader is the Python twin of
`extractTimeline`; both are checked against `samples/timeline_year_cases.json`
(`node --experimental-strip-types --no-warnings --test tests/text-cases.test.mts`).

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
  "transition": "crossfade",                             // optional
  "claims": [{ "id": "c1", "text": "...", "status": "likely_accurate" }], // optional, evidence_card
  "map": { "focus": { "x": 0.45, "y": 0.46 }, "label": "Eilean Mòr" },   // optional, map_zoom; focus = fraction of the wide frame
  "lowerThird": { "name": "Joseph Moore", "label": "Relief keeper" }    // optional
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

# Several renders: bundle once, render from the bundle (what CI does)
npx remotion bundle src/index.ts --out-dir=out/bundle --public-dir=fixtures/public
npx remotion render out/bundle Scene out/map.mp4 --props=fixtures/map-zoom.json --concurrency=1
npx remotion still out/bundle Scene out/quote.png --props=fixtures/quote-card.json --frame=45

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

# S8 — Media-first gallery & Studio handoff: diagnosis (22 Nov 2026)

Measured on `origin/vera/landing-models-ribbon-font` at `ce310b4` (PR #889), before any S8 change. Evidence first, then what it
means for the build (CLAUDE.md rule 8). Paths are under `command-center/` unless they start with `docs/` or `supabase/`.

## The owner's requests (22 Nov), restated

1. Every picture or clip shows only the media until hovered; the name and prompt appear on hover. Model names invisible.
2. A click opens the Studio with that prompt and the model it was made with preselected (sign-up first when signed out). The
   model becomes known only in the Studio.
3. Below the fold of the Studio: trends, samples, topic videos, brand-style image variants, all media-first.
4. Kling-style captions: bold ~22 px white title and a ~16 px grey one-line description; section headings bold ~48 px.

## Which page is the homepage

`app/page.tsx` renders **`components/landing/Landing.tsx`** (owner's choice of 22 Nov: "the homepage as it was before 20 Nov").
`components/landing/home/HomePage.tsx` (its reel `Reel`, which credits models under each clip) is **not mounted** on any route
today; only its first screen `HomeHero` is reused by `Landing`. A signed-in visitor is redirected away from `/`, so every card on
the landing is seen signed out.

## Every card type, where it renders, what it shows now

| # | Card | Component | Route(s) | At rest | On hover / focus | Click | Model named? |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | Explore gallery card | `components/site/ShowcaseGallery.tsx` (`.nx-gallery-card`) | `/` (Landing) | media + "AI-generated" badge | first two lines of the prompt + "Use this prompt" (fine pointer ≥ 1024 px dims the others, `explore-hover.css`) | opens **`SampleDetail` dialog** (whole prompt, **model name**, date, source picture, "Try this prompt") | **Yes**: `data-model={modelId}` on the `<li>`, the dialog's model line, the dialog's `alt` ("AI-generated clip made by {model}"), the source picture's alt |
| 2 | Phone shorts feed slide | `components/site/ShortsFeed.tsx` (inside #1, phones only) | `/` | full-screen clip, AI label, prompt, **"Made by {model}"**, Try/Use | — | Try/Use link | **Yes**: visible text and `aria-label` "Try this prompt with {model}" |
| 3 | Effect card | `components/site/EffectsGallery.tsx` (`.efx-card`) | `/` | media **plus** kind · seconds, effect name, line, "needs", "Use this effect" button, always visible | none | "Use this effect" → `publicEffectHref` (sign-up → Studio video form with `effect=`) | No (already pinned by `tests/helpers/brands.ts`) |
| 4 | Model tile | `Landing.tsx` `ModelTiles` (`.nx-model`) | `/` | media, AI badge, **model name as `<h3>`**, quoted prompt, sample count, "See it" | — | `#sample-<job>` anchor (scrolls to #1) | **Yes**: heading, `data-model` |
| 5 | Model ribbon | `components/site/motion/ModelMarquee.tsx` | `/` | moving text row of model names (no picture) | stops | none | Yes, but it is text, not tied to any picture; `aria-hidden` |
| 6 | Reel card | `components/landing/home/HomePage.tsx` `Reel` | **not mounted** | media + AI badge + title + "Made with {model}" | — | none | Yes (dormant) |
| 7 | Studio home example | `components/studio/StudioHome.tsx` `ExampleCard` (`.sh-ex`) | `/{channel}/create` overview | 11 examples (`lib/creative/examples.ts`); most have **no media** (the prompt set in type over two colours); mode label | — | fills the composer above; keeps the example's model only if offered (`pickExample`) | No |
| 8 | Trend card | `components/trends/TrendCard.tsx` | `/{channel}/trends` | poster + meta + title + description + "Use template", always visible | muted preview plays | `?template=<slug>` → Create | No (honest "model not on sale" note when measured so) |
| 9 | Trends strip | `components/trends/TrendsStrip.tsx` | **not mounted anywhere** | first 6 templates (`/api/templates?limit=6`) | as #8 | as #8 | No |

Real media that exists for the Studio home (request 3), nothing invented:

- **Samples**: `lib/site/showcase.json`: 51 real Studio jobs (job id, sha256, model id, prompt, capability, size), files under
  `public/showcase/samples/` via `components/site/showcase-assets.ts`.
- **Studio pieces**: `lib/showcase/items.ts`: 9 items (7 clips, 2 pictures, `ikat-poster` and `isometric-studio` are brand-style
  pictures) with a localised title and the models that made them; no prompt stored, so they cannot open the form with words.
- **Trends**: `creative_templates` (migration 0183, read by `/api/templates`), 20 slugs with a preview and a poster committed
  (`lib/templates/media-manifest.json`), categories `viral | business | story | lifestyle | text`, kinds `video | image`. The
  `business` image templates are the brand-style variants.

## What the Studio reads from a link today

`app/(app)/[channel]/create/page.tsx`:

- `tool` → `prefillFromQuery(q.tool, q.source) ?? toolPrefill(q.tool)`, which picks the desk (`deskFromQuery`): `t2v` → the
  video desk, `t2i` → the image desk.
- `model` → **`prefillModel(initial, q.model)`** (`lib/models-discovery.ts`): shape-checked against `MODEL_ID_RE` only, then put
  into the prefill.
- `prompt` → `prefillFromImprove` (`lib/creative/improve.ts`): cleaned (`cleanLinkPrompt`, controls/bidi removed) and bounded to
  `IMPROVE_PROMPT_MAX` = 1000, for `LINK_PROMPT_TOOLS` (`t2i`, `t2v`) and the improve tools.
- Also `template`, `kind`, `effect`, `style`, `attach`, `idea`, `desk`, `project`, each shape-checked.

The public link builder already exists: `lib/site/showcase-link.ts` `tryHref(sample, signedIn)` →
`/all-channels/create?tool=<cap>&model=<id>&prompt=<words>`, and signed out `/signup?next=<that>` cut to fit
`fitsAfterSignup` (`lib/safe-redirect.ts`, which keeps only a same-origin Studio path through the callback and `/welcome`). It
leaves `model` out when the sample's model is an operator preview or past its shutdown day (`modelLeftOut`). Today it is used
only by the gallery's hover link and the dialog, **not by the card itself** (the card opens the dialog).

## Whether `model` preselect exists, and how it fails

It exists and is half-honest. In `components/studio/GeneratePanel.tsx`:

```ts
const pickedOff = model !== "" && unavailable.includes(model) && !available.some((m) => m.id === model);
const effectiveModel = pickedOff ? "" : available.some((m) => m.id === model) ? model : ((usable[0] ?? available[0])?.id ?? "");
```

- A linked model the owner **switched off** (0124) is said: the panel shows "this model is switched off" and picks nothing.
- A linked model that is **not offered for this tool** to this workspace (not in the registry, not sold to this org, an operator
  preview for a customer, wrong capability) is **silently swapped** for the first usable model. The only trace is the model card
  showing a different name. **This is the rule-4 gap S8 must close**: the person clicked a sample made with model X and gets a
  quote for model Y without being told.
- No price is shown before the quote route answers (the panel's existing behaviour), and that does not change.

## Decisions S8 needs confirmed (sent to Atlas)

1. **The AI-generated mark.** Each card keeps one small "AI" mark in a corner at all times, and the media's `alt` says
   "AI-generated clip/picture". Generated media must be labelled (EU AI Act art. 50 transparency for synthetic media, and the
   platforms' own rules); the mark is not a model name, so it does not undo request 1.
2. **The sample dialog goes.** Request 2 says the click goes to the Studio and the model is known only there, so the card stops
   opening `SampleDetail` (the dialog names the model). The card becomes one link to `tryHref`.
3. **The model tiles (#4).** Without the model name, a tile is a second copy of a gallery card (it already shows a sample the
   grid holds). S8 makes them media-first like every other card, captioned with the sample's own words, linked to the Studio,
   with no model name. **Recommendation:** drop the section later if the owner agrees it now repeats the gallery.
4. **The model ribbon (#5)** is a text list with no picture attached, so a visitor cannot tie a name to a sample. S8 leaves it
   alone. Removing it is one line if the owner wants no model names on the landing at all.
5. **The phone shorts feed (#2)** drops "Made by {model}" and the model from its `aria-label`, like the cards.

## What S8 builds (one draft PR each)

- **PR 1 `claude/nsai-s8-media-cards`**: a shared media-first card (CSS + a tiny client hook for touch: first tap shows the
  caption, second opens) applied to #1, #2, #3, #4; Kling caption scale on S5's values; the model name gone from text, alt and
  `data-*` on public cards (still server-side in the link); tests that pinned the model on a card updated to pin "owner decision
  22 Nov".
- **PR 2 `claude/nsai-s8-model-handoff`**: the Studio's honest handling of a linked model that is not on sale for the tool
  (default model + one-line note naming why; never a silent swap); Breach on `model` / `prompt` / `next`.
- **PR 3 `claude/nsai-s8-studio-explore`**: the Studio home's below-the-fold media grid from samples, Studio pieces and trend
  templates (business/image ones as brand-style variants); same card, same handoff.

No migration is needed.

## Follow-ups (open)

- **Real-device sound check** (from #937, merged 27 Nov): unmuting a clip after it swaps from its 640 to its 1280 file is untested on
  iOS Safari and Android Chrome hardware. If a browser refuses, the toggle turns itself off and the clip plays on muted. Check it once
  the first H3 clip with audio is exported.
- **Model tiles** (#918, owner-approved 27 Nov) still name models and repeat gallery samples. A media-first version without names
  would be a separate small PR, put to the owner by Atlas.
- **i2v option (a)**: a server-side allow-list so a sample's own picture is the job's source with no per-workspace copy (needs a
  migration; see docs/studio/S8_I2V_LATER_OPTION_A.md once the i2v PR lands).
- A person's own model pick followed by a switch to a tool that model can't do still falls back quietly (pre-existing, from #922).
- A hand-made `?desk=overview&tool=…&model=…` link lands a customer on CreateScreen, which ignores `tool`/`model`.
- **Owner mode: `?template=<slug>` fills nothing** (pre-existing; found in PR 3, left as is by Atlas 27 Nov). Only CreateScreen reads
  `template`; the platform operator in Owner mode lands on StudioHome, which ignores it. So in Owner mode StartBox's template cards and
  the Trends page's "Use template" open an unfilled Studio home. Customers are unaffected.
- **StudioHome gets the explore grid once it reads `?template=`.** PR 3 mounts the grid on the customer's Create screen only (Atlas,
  27 Nov): on StudioHome every template card would be a dead link, StudioHome already reads the same templates for its start box (a
  second identical fetch), and its "nothing on sale yet" line would sit under its own "Start from an example".
- **The explore grid (PR 3) shows only its one-line empty state today.** It counts only models on sale, priced and buyable (no
  operator preview, even for the operator), and every shipped sample and every template is made with a model the registry still marks
  `operator_preview`. Each row fills in by itself as its models go live; nothing to change in the grid then.

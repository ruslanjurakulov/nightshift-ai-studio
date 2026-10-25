# Region editor (dark, `NIGHTSHIFT_REGION_EDITOR`, default off)

Draw 1 to 5 rectangles on a library picture, give each its own name and words, see the price, and (when the run
step exists) have an existing edit model change only those rectangles. Provider-independent by construction: the
**pixel lock** decides what may change, not the model.

This page says exactly what is built, what is guaranteed and what is not, and what is still missing. Nothing here is
switched on: the page is a 404 and the routes answer `not_found` until the owner sets `NIGHTSHIFT_REGION_EDITOR=on`
on the Command Center's server. No migration is added.

## What is built in this change

| Piece | Where | State |
| :-- | :-- | :-- |
| Pixel lock, crop planner, region runner, model resolver, adapter seam | `modules/region_edit.py`, `tests/test_region_edit.py` | built, tested with a loopback fake model that changes everything |
| Editor UI (Konva canvas, region list, model pick, price, versions, before/after) | `command-center/components/regionEdit/*`, `app/(app)/[channel]/studio/regions/page.tsx` | built, behind the switch |
| Price before running | `POST /api/region-edit/quote` | built: one ordinary `edit` quote per region with words, summed |
| Version history | `GET /api/region-edit/versions` | built; reads `media_assets.parent_asset_id` (written by the worker, never by the browser) |
| Running the edits (hold, call the model per region, composite, store a new version, charge or refund) | none | **not built, needs a migration. See "What is missing".** The Run button is disabled and says so. |

New dependency: `konva` (MIT). No canvas library was present in `command-center` (the video editor draws with the
DOM and CSS). `react-konva` was not added; Konva is imported on the client after mount and never on the server.

## Which existing models back the operation

Only models that are already integrated, not behind a terms gate, and (at run time) sellable per the database
(`sellable_models()`, migration 0035: probed, priced, no open gate). There is no `model_is_available` / model on-off
switch on `main` yet, so `sellable_models()` is the filter. Registry models with the `edit` capability today:

| Model id | Adapter | Notes |
| :-- | :-- | :-- |
| `openai-gpt-image-2`, `openai-gpt-image-2.5-flare`, `openai-gpt-image-2.5-sunburst` | `image.openai` (`POST /images/edits`, multipart `image[]`) | quality tiers; the vendor documents an optional `mask`, **this repository does not send one** |
| `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` | `image.gemini` (`generateContent`, inline image) | sized by aspect ratio and image size |

Not used: `gemini-2.5-flash-image-{expand,relight,erase}` (`terms_review_required`, no price, and they re-render the
whole picture); every `t2i`-only model. **No wired adapter takes a mask** (`CapabilityRequest` has no such field), so
the operation is "crop region plus context, edit, paste back": the crop does the work, the lock does the safety. If an
adapter that takes a real mask is added later it plugs in behind the same `edit_fn` seam. Krea (shipped "regional
edit") is **not** added: its resale terms are unread. It is a possible future adapter only.

There is no default and no second choice (CLAUDE.md rule 4): `resolve_edit_model` refuses an empty, unknown,
non-editing, terms-gated or not-currently-available model, and a region whose call fails is `failed`; it is never
retried on another model.

## How a region is edited

1. The region's rectangle plus context (a quarter of its longer side, at least 32 px) is grown to the nearest aspect
   ratio the model offers and cut out of the **original** (`plan_crop`). Each region is cut from the original, so a
   region does not see another region's edit; where two regions overlap, the later is blended over the earlier.
2. One call per region, in order (every adapter here takes one prompt per call, so nothing is batched).
3. The answer must be the crop's shape within 5 percent. Another shape is refused (`bad_response`), never stretched.
   A right-shaped answer is resized to the crop's size with Lanczos: **the model's output is resized to the original's
   grid, never the other way.**
4. Only the region's masked pixels are blended into the original, then the result is re-checked (`verify_pixel_lock`).

## The pixel-lock guarantee (verbatim contract)

Guaranteed, whatever the model returns (the tests use a fake that returns noise, a flat colour, another size):

* Every pixel **outside the union of the regions' masks** has, in all four channels, the same 8-bit RGBA value as the
  original's decoded pixel. The mask is the rectangle (or the rectangle intersected with a brush bitmap).
* The feather band lies **inside** the mask. With feather `F` (2 to 8 px, default 4) a mask pixel at depth `d` from
  its edge has weight `(min(d, F) + 1) / (F + 1)`: the outermost mask pixel is mostly original, a pixel `F` or more
  inside is entirely the model's. A mask side that lies on the picture's own edge does not feather (nothing beyond it).
* The alpha channel is never taken from the model; it is identical to the original's everywhere.
* The original's size and pixel grid never change.
* The check runs on the finished picture before it is returned (`pixel_lock_failed` stops a violating result).

Not guaranteed:

* Anything **inside** the mask. Those are the model's pixels (AI-generated), blended at the feather band. Nothing
  here says an edit is good, accurate or what it shows.
* Byte identity of the **file**. The result is a new lossless PNG; a JPEG source is identical after decoding, not as a
  file. The grid is the picture after EXIF orientation is applied (what a browser shows).
* Colour management. Values are never converted. The source's ICC profile (if any) is copied to the result; the model's
  pixels are assumed to be in the same space as the crop it received, which is not verified. 16-bit and CMYK sources
  are refused rather than converted.
* A model that ignores the crop and returns something unrelated inside the region: the lock still holds outside, but
  the region then holds whatever it returned.

## Credits

Per region that has words = one generation unit of the chosen model, regions summed. The quote is an ordinary `edit`
quote asked of the database (`quote_creative_job`) per region; a region without words is skipped and costs nothing; if
any single price cannot be worked out the whole quote is refused with that region's reason, never a guessed total.
Nothing is held in this change. When the run step is built it must use one creative job per region (or equivalent) so a
refused or failed region releases its own hold and charges nothing, exactly like the AI-edit desk.

## Honest labels

The screen says the changed parts are AI-generated and that the tool does not judge quality. The provenance helper
(`provenance()`) marks the stored result `ai_generated`, `rights: generated_for_org`, with the model, the source asset,
the feather and each applied region's rectangle (not the person's words). A result must be registered as
`source='generated'` (never `upload`) so the existing AI-disclosure logic that reads generated stills still sees it.

## What is missing (needs a migration, so it was not written)

The run step cannot be built without changing the database:

1. **Geometry cannot reach the worker.** `creative_params_problem` (0036/0046/0099) refuses any parameter key it does
   not know, so an `edit` job cannot carry regions, a feather or a crop. The same allow-list exists in
   `lib/creative/operations.ts` (`PARAM_KEYS`).
2. **The composite cannot be registered from the web.** `register_asset` is service-role only. The only write path
   from the browser is an upload ticket, which registers the file as `source='upload'` with no parent: that would
   launder AI-generated pixels as an upload and lose the version link. The worker must store the composite with
   `source='generated'`, `parent_asset_id` = the picture it came from, and the provenance above.

Smallest honest change (a proposal for Scout/Lens, not code): allow `params.regions` (at most 5 rectangles) and
`params.region_feather` on `edit`, price by the number of regions with words, and have `creative_worker._to_library`
call `modules.region_edit.run_region_edit` instead of storing the model's whole picture. Partial results (some regions
failed) need a settlement rule the owner must decide: charge only the regions that were applied.

The simplest worker design chains versions: each applied region produces a version whose parent is the previous one,
so every step is an immutable version and undo is moving to the parent (the version panel already reads that chain).

## Doubts

* Konva on touch: dragging uses `touch-action: none` only while a region is selected or drawing is on; the page can
  still be scrolled past the canvas otherwise. Not measured on a real phone.
* `GET /api/region-edit/versions` reads `media_assets.parent_asset_id` through RLS; the column exists since 0038 but no
  database was available to confirm the member policy returns it.
* The prompt wrapper in `adapter_edit_fn` ("Change this picture as described...") is untested against a live model:
  no live or paid call was made.

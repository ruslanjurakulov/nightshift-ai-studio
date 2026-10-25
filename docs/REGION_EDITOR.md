# Region editor (dark, `NIGHTSHIFT_REGION_EDITOR`, default off)

Draw 1 to 5 rectangles on a library picture, give each its own name and words, see the price, and (when the run
step exists) have an existing edit model change only those rectangles. Provider-independent by construction: the
**pixel lock** decides what may change, not the model.

This page says exactly what is built, what is guaranteed and what is not. Nothing here is switched on: the page is a
404 and the routes answer `not_found` until the owner sets `NIGHTSHIFT_REGION_EDITOR=on` on the Command Center's server,
and the creative worker refuses a region job (`region_editor_off`, the whole hold released) unless the same variable is on
in ITS environment. The run step added migration 0126 (see "The run step").

## What is built in this change

| Piece | Where | State |
| :-- | :-- | :-- |
| Pixel lock, crop planner, region runner, model resolver, adapter seam | `modules/region_edit.py`, `tests/test_region_edit.py` | built, tested with a loopback fake model that changes everything |
| Editor UI (Konva canvas, region list, model pick, price, versions, before/after) | `command-center/components/regionEdit/*`, `app/(app)/[channel]/studio/regions/page.tsx` | built, behind the switch |
| Price before running | `POST /api/region-edit/quote` | built: one ordinary `edit` quote per region with words, summed |
| Version history | `GET /api/region-edit/versions` | built; reads `media_assets.parent_asset_id` (written by the worker, never by the browser) |
| Running the edits (hold, call the model per region, composite, store a new version, charge or refund) | `supabase/migrations/0126_region_edit_run.sql`, `POST /api/region-edit/run`, `modules/creative_worker.py` (`_process_region`), `modules/region_edit.py` (`run_job_regions`), `components/regionEdit/RunPanel.tsx` | built, behind the same switch on the web and on the worker. See "The run step". |

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

A region edit is ONE ordinary `edit` creative job whose params are the picture, the model's own tier and the regions. The
price is asked of the database for those very params (`POST /api/region-edit/quote` is one `quote_creative_job` call, not a
sum): n regions with words are n units of the model's `edit` price, rounded up once to the cent, never below the job
minimum. A region without words is skipped and costs nothing. If the price cannot be worked out the quote is refused with
the database's reason, never a guessed total. See "The run step" for the hold, the charge and the release.

## Honest labels

The screen says the changed parts are AI-generated and that the tool does not judge quality. The provenance helper
(`provenance()`) marks the stored result `ai_generated`, `rights: generated_for_org`, with the model, the source asset,
the feather and each applied region's rectangle (not the person's words). A result must be registered as
`source='generated'` (never `upload`) so the existing AI-disclosure logic that reads generated stills still sees it.

## The run step (migration 0126)

`create_creative_job` accepts `params.regions` (1 to 5 of `{id, name, rect {x,y,w,h}, prompt}`) and `params.region_feather`
(2 to 8) on `edit` jobs only, and refuses every other key next to them (no prompt of its own, no seed, no shape, no style
kit). The closed shape is `creative_regions_problem`; the count prices the job (`creative_quantity`); the settlement is
`finish_creative_job`. The three replaced functions and the two new ones are md5-pinned in the migration header.

Money, as implemented:

* Hold: the quote of n units, held by `create_creative_job` as for any job. A request refused before it holds nothing.
* Each region's share of the hold is `quoted_credits / n`. The worker reports the outcome of every region (`applied`,
  `failed`, `refused`, a failed or refused one with a code from a closed list); the database counts the applied ones and
  charges `quoted * applied / n` rounded UP to the cent (never above the hold); `capture_credits` releases the rest in the
  same transaction, once.
* All applied: the whole hold. None applied: the job ends `failed` (`no_region_applied`), the per-region outcomes stay in
  `result`, the whole hold is released, nothing is charged. Nothing is refused or charged for a request refused up front.
* Nothing is charged for pixels that were not stored: a completed region edit must have exactly one attached result.
* Finishing twice, an expiry or a cancel afterwards, and a retried call move no credit a second time.

The worker (`NIGHTSHIFT_REGION_EDITOR` on): exact mode only; the model must be in `sellable_models('edit')` at that moment
(no default, no second choice, no retry on another model); one call per region through the model's own image adapter
(`image.openai` / `image.gemini`); a region outside the real picture or too small is refused without a call; every answer is
pasted back through the pixel lock and the finished picture is verified again, a region that would break the lock is failed
(not charged) and the others stand; the result is one new library picture, `source='generated'`, `parent_asset_id` = the
source, provenance `ai_generated` written by the worker. A worker that dies after the last call and before the result is
stored leaves a job that is failed (`output_lost`) and released, never polled or paid twice.

Limits (review): a source picture of more than 16 megapixels (`REGION_MAX_SOURCE_PIXELS`, `MAX_SOURCE_PIXELS`) is refused before
anything is held or asked of a model, in the web routes (`source_too_large`) and in the worker (`source_too_large`, the header is
read without decoding): measured, a region edit needs about 50 MB of RAM per megapixel at 16 MP (0.8 GB, about 23 s with five large
regions) and about 100 MB per megapixel at 47.6 MP (4.9 GB, about 95 s). Words whose JSON passes the database's 16 KB of params
(five regions of 1000 characters in a 3-byte script) are refused by the routes (`params_too_large`) with a sentence. Only the
`image.openai` and `image.gemini` adapters run a region edit (their edit call is synchronous); any other adapter ends the job
before a vendor is called. An unexpected error in one region fails that region (`provider_error`) and the others stand; the cost of
every call made is recorded once on every path. The stored result is built from an allow-list of keys.

Not built: a brush bitmap per region (it needs the bitmap's ownership checked in `creative_source_problem` and
`creative_job_source`, and the editor has no brush), and a per-region version chain (one run = one new version of the source).

## Doubts

* Konva on touch: dragging uses `touch-action: none` only while a region is selected or drawing is on; the page can
  still be scrolled past the canvas otherwise. Not measured on a real phone.
* `GET /api/region-edit/versions` reads `media_assets.parent_asset_id` through RLS; the column exists since 0038 but no
  database was available to confirm the member policy returns it.
* The prompt wrapper in `adapter_edit_fn` ("Change this picture as described...") is untested against a live model:
  no live or paid call was made.
* Several regions are priced as one quote of n units, so n regions can cost a few cents less than n separate quotes would
  (one rounding instead of n, and one job minimum instead of n). The owner should confirm that is the intended price.
* The database does not read the picture's size into the shape check; a region outside the real picture is refused by the
  web route before a hold and, for a direct call, by the worker without a charge.
* A member can call `create_creative_job` with regions directly even while the switch is off. The job is priced and held like
  any other and the worker (switch off) fails it with the whole hold released.

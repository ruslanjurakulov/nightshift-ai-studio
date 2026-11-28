# S9: adapter rules the quote does not know (measurement, 2026-11-28)

Rule 8: this is the measurement, and the fix is a separate PR. Owner's goal, relayed by Atlas: a Studio request must not fail after
it was accepted. A refusal belongs at the quote, before Create, with a sentence that names the fix. Better still, the form does not
offer the option at all.

## 1. What failed live (30 days to 2026-11-28)

The query was read-only, on `public.creative_jobs`, `status = 'failed'`: 141 jobs, 10 failed, and every one was charged 0 credits.
Prompts are not reproduced here, only their length.

| Job | Created (UTC) | Model / capability | Params (no text) | Code | Adapter's message | Root cause | Today |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| b861f22a, 7f8c2e3c | 11-13 17:44 | ideogram-4 / t2i | `aspect_ratio 16:9` | bad_request | "…not offered for t2i by ideogram-4; Ideogram 4.0 aspect ratios are not wired yet" | the registry then listed `aspect_ratios: []` and the quote did not check the shape | **closed** by 0155 (the quote checks the model's shape list) and by the registry now listing 15 shapes |
| 9aae1815, a8f5121b | 11-13 17:44 | ideogram-4.5 / t2i | `aspect_ratio 16:9`, `quality` | bad_request | same, 4.5 | same | **closed** (same) |
| 68b4954e | 11-20 13:53 | minimax-h3 / i2v | `duration_s 5, resolution 768p`, **no prompt** | bad_request | "MiniMax H3 needs words for every mode, image-to-video included" | gap **G3** below | **open** |
| 26c86c62 | 11-20 16:36 | minimax-h3 / i2v | `aspect_ratio 9:16, duration_s 10, 768p` | bad_request | "image-to-video keeps the picture's own shape: an aspect ratio does not apply to i2v" | gap **G2** below | **open** |
| 87fdf2a8, ff1e6f8a, 311e5ff5, 1d937f4b | 11-20 15:31 | minimax-h3, -highspeed / t2v | t2v, valid | quota | HTTP 402 `insufficient_balance` on our vendor account | vendor balance (S10's item B) | not a parameter rule |

Of the 6 parameter failures, 4 are already closed and 2 are still open. Both open ones are on minimax-h3, which is on sale. The
measurement below finds 7 more gaps of the same kind, all on models that are hidden today. Through 0227, though, the owner can open
any of them with one checkbox, and each would then fail the same way.

## 2. How a parameter is refused after Create

- **Worker, before the vendor call:** `RegistryAdapter.submit` (`modules/creative_adapters.py:240-289`) refuses `bad_request`:
  - on its own checks (a missing priced variant, references, the end frame);
  - then on `adapter.problems(req, entry)`. That is `HttpAdapter.problems` (`capabilities/base.py:514`): the adapter-class checks
    plus `ModelEntry.problems` (`model_registry.py:308`), the registry-driven rules, plus each adapter's own `_spec_problems`
    (vendor rules written in code).
- **Quote:** `creative_params_problem` (the shape of the params, per capability) and `creative_price` (against the model's synced
  `spec`). The latest bodies are 0228's.
- **Inventory:** every `bad_request` raise in `modules/capabilities/*.py`, `creative_adapters.py`, `creative_worker.py`,
  `region_edit.py` and `character_swap.py` was read and classified. There are about 166 sites. They are pure parameter rules,
  rules that depend on a fetched file, or internal invariants. Each pure rule was then checked against the registry and the quote.

## 3. Measured parity (lab, real PostgreSQL 16, real registry rows)

**Method.** A scratch harness ran in the security lab. It is the prototype of the parity test in the fix PR.

- Every registry model was included, except those not synced, shut down or ByteDance: 54 models across `t2i`, `t2v`, `i2v` and
  `edit`.
- The real rows were synced, probed and priced the ordinary way. The lab org had attested adult and had credits.
- Each model and capability got a grid of params:
  - a valid base request;
  - no prompt;
  - 8 shapes;
  - every listed duration, plus 4, 5, 6, 8 and 10;
  - each listed resolution, plus 480p, 720p, 768p and 1080p;
  - no resolution;
  - `audio: true`;
  - an end frame (i2v);
  - a negative prompt;
  - a 2500-character prompt;
  - no `image_size`.
- Each case was put to two sides:
  - the database's `quote_creative_job`, then `create_creative_job`;
  - the worker's real pre-submit path, `RegistryAdapter.submit` with the vendor call replaced by a sentinel. It ran on the params
    as the database stored them on the job, so it saw the defaults the database fills in, with a 1280×720 PNG as the picture.

**Result: 1817 cases.**

| Quote | Worker | Cases | Meaning |
| :-- | :-- | --: | :-- |
| accepts | accepts | 855 | fine |
| refuses | refuses | 675 | fine. The words often differ; that is not measured here |
| refuses | accepts | 178 | the quote is stricter. No job fails; at worst an option is refused that would have worked (not in scope) |
| **accepts** | **refuses** | **109** | **a job that is created and then fails: the defect class** |

Not measured: 80 cases on the four Gemini image models stopped at `country_unverified` (0208's country gate, by design for a
request with no country), and 22 on Runway at `acknowledgement_required`. Capabilities other than generation (upscale, voice, music,
describe, relight and so on) were read in the inventory but not run in the grid.

**The 109 cases, by rule:**

| Gap | Rule the worker applies (where) | Models | On sale? | What the quote does today |
| :-- | :-- | :-- | :-- | :-- |
| **G1** | `image_size` is required ("image size (none) is not offered … never defaulted"): `bfl.py:104-106`, `google_interactions.py:441-443` | flux-3-image, flux-3-image-klein, gemini-nano-banana-2.1 | hidden | **requires and stores** `image_size` (0208). The worker never passes it: `creative_adapters.capability_request` has no `image_size`, so **every** Studio job on these models fails. This is a worker bug, not a missing quote rule. (Gemini nano could not be run in the grid because of the country gate; the inventory confirms it reads the same field.) |
| **G2** | No `aspect_ratio` for `i2v`: the clip keeps the picture's shape. `minimax.py:197`, `alibaba.py:201`, `xai.py:157`, `vidu.py:258`, `video.py:2130` (seedance-2.5) | minimax-h3 ×4, happyhorse-1.1, vidu-q3-pro/turbo, grok-imagine-video-1.5 (+lite) | **minimax-h3 ×4 on sale** | accepts any listed shape. The registry has no way to say "no shape for i2v": `aspect_ratios_by_capability` lists need `minItems: 1` in the schema, and both `aspects_for` and 0155's CASE fall back to `aspect_ratios` when the per-capability list is empty |
| **G3** | Words required for `i2v`: `minimax.py:179-181`, `ltx.py:152-153` | minimax-h3 ×4, ltx-2.3/2.5 pro/fast | **minimax-h3 ×4 on sale** | `creative_params_problem` makes the prompt optional for `i2v`. The registry already says it for MiniMax (`inputs.prompt_required: ["t2v","i2v"]`, synced into `spec.inputs`), but only the web form and route read it (`studio.ts:266`, `route.ts:59`); no SQL does. So MCP, `/v1/creative`, Film and any other path skip it. LTX's entries do not state it at all |
| **G4** | i2v clips of 5 s only: `video.py:1922-1928` | luma-ray-3.2 | hidden | accepts any of `durations_s` (one list for every capability) |
| **G5** | An end frame is required: `pika.py:211-212` | pika-pikaframes | hidden | accepts an i2v with no `end_asset_id` (`end_frame` only allows one) |
| **G6** | The first frame must be an https URL: `video.py:2250-2261` | wan-2.7 | hidden | the worker hands over local files, so **every** i2v job fails. The model cannot be served from the Studio until the adapter uploads the file; no quote rule can fix this |
| **G7** | Durations allowed only at some resolutions (LTX fast: 12-20 s only at 720p/1080p): `ltx.py:121-149` | ltx-2.5-fast, ltx-2.3-fast | hidden | not reached in the grid (the base resolution is 1080p). Read in the code and not stated in the registry: a cross-field rule |

**Other rules not run in the grid**, from the inventory. They are pure parameter rules that the registry does not state:

- Krea's negative prompt limit of 1024 characters (`krea.py:128`): the quote does check it (0218).
- Character swap: `@Image n` references, and the resolution required with no default (`character_swap.py:72-92`).
- relight and erase: exactly one of a look or words (`image_ops.py:191`).
- Lyria: no section labels in the prompt (`google_interactions.py:688`).
- `meta` grounded-image: a prompt heuristic for real or famous people (`meta.py:284`). That is a content policy, not a parameter.
- `duration_s` required on several video adapters: already covered, because the quote requires it on `t2v` and `i2v`.

## 4. The form

The Studio form reads the model's synced spec: `lib/creative/studio.ts` and `lib/creative/registry.ts`.

- **Shapes:** `studio.ts:458` mirrors 0155 exactly, so for G2 it offers minimax-h3's six shapes on i2v.
- **Words:** it already reads `inputs.prompt_required` (`studio.ts:266`, `:704`), and the web route refuses a job without them
  (`route.ts:59`). So today G3 bites only through the paths that do not use that route: MCP, `/v1/creative` and Film. Whether
  the check already existed when job 68b4954e was created (11-20 13:53 UTC) cannot be told: this repository's history starts at
  11-20 19:59 UTC (`33c37db82`), and no audit row names the job.
- **Durations:** it offers every listed duration for every capability, which covers G4.

When the spec states a rule and the quote reads it, the form follows through the same field. The fix PR checks each one, and
Pixel audits it.

## 5. Proposed fix (next PR; needs a migration number)

1. **The registry states each rule as data:**
   - `aspect_ratios_by_capability.i2v: []` means "no shape". This lifts the schema's `minItems` for that case, and `aspects_for`
     and SQL both read an explicit empty list as "none".
   - `inputs.prompt_required`, added for LTX.
   - `durations_s_by_capability` for Luma's i2v.
   - `end_frame_required` for Pikaframes.
   - For LTX's cross-field rule: either `durations_s_by_resolution`, or narrow the fast models to the lengths valid at every
     resolution they offer. Simpler, and it loses nothing that is on sale.
2. **`ModelEntry.problems` and the quote both read those fields.** `creative_price` refuses with `invalid_params` and a sentence
   that names the fix, before anything is held.
3. **The worker fixes:** `capability_request` passes `image_size` (G1). wan-2.7 stops listing i2v until its adapter uploads the
   picture (G6).
4. **Parity test** (`tests/security/test_sec_param_parity.py`): the harness above, kept. Across the whole registry, no case may be
   accepted by the quote and refused by the worker. A new adapter rule without a registry field and a quote twin fails CI.
5. Each adapter's `_spec_problems` stays as the worker's backstop (rule 4): it must never be reached, and the parity test pins that.

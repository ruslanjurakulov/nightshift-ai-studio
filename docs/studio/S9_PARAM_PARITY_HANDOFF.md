# S9 PR B handoff: parameter parity (migration 0251), for Vera

Status: **not started**. The owner's budget order stopped it before any code was written. The measurement is
`S9_PARAM_PARITY.md`, and G1 is fixed separately in #999.

## Base and numbers

- **Migration 0251** (assigned by Atlas). It replaces `creative_price(uuid,text,text,jsonb)` and `creative_params_problem(text,jsonb)`.
- **Build on #988** (S10's 0243, branch `claude/nsai-s10-preview-image-size`, head `511871dc3`). It reaches the owner's batch
  before 0251. S6's Lyria price is renumbered 0253 and builds on 0251.
- **Drift guard md5s** (white space folded, `md5(regexp_replace(prosrc, '[[:space:]]+', ' ', 'g'))`):
  - `creative_price` before: `9268c201fd930c1f7519cc601118661e` (0243's after).
  - `creative_params_problem` before: `0570bb5a1f749b7e3d556c87443bf17b` (0228's after).
- **No backslash** anywhere in the migration or the rollback. 0218's regexes go back in through `chr(92)`, as 0228 and 0243 do.
- A worktree was prepared at `claude/nsai-s9-param-parity` from #988's head, with nothing committed. Recreate it if it is gone.

## What to build (Atlas's decisions)

1. **The registry states each rule as data.** `ModelEntry.problems` (Python) and the quote (SQL) both read it, and so does the
   Studio form (`command-center/lib/creative/studio.ts`, which mirrors 0155 at about line 458), so the form does not offer the
   option.
   - **G2: no shape on i2v.** Models: minimax-h3 ×4 (on sale), happyhorse-1.1, vidu-q3-pro/turbo, grok-imagine-video-1.5/-lite,
     and seedance-2.5 if its adapter refuses.
     - Allow an explicit `aspect_ratios_by_capability.i2v: []` in the schema (today it needs `minItems: 1`).
     - `aspects_for` and 0155's CASE must read an explicit `[]` as "no shape accepted". Today both fall back to `aspect_ratios`.
     - The refusal names the fix: "<model> keeps the picture's own shape; remove the shape".
   - **G3: words required.** `spec.inputs.prompt_required` is already synced for minimax-h3, but no SQL reads it.
     - Add it for LTX (ltx-2.3/2.5 pro/fast), and declare the LTX adapter's `prompt_required_capabilities` so the load-time
       validator enforces agreement.
     - Use the same blank test as the adapter (strip zero-width characters).
     - The TS word `prompt_required` already exists (`lib/creative/operations.ts:306`); keep en/ru/uz complete.
   - **G4:** luma-ray-3.2 i2v takes 5 s only. Add `durations_s_by_capability`.
   - **G5:** pika-pikaframes needs an end frame. Add `end_frame_required`.
   - **G7:** the LTX fast models allow 12-20 s only at 720p/1080p (`ltx.py:121-149`). Either add `durations_s_by_resolution`, or
     narrow the lists; say why in a comment.
   - **G6:** wan-2.7 drops `i2v` from its capabilities until its adapter uploads the picture (it needs an https URL; the worker
     gives a local file).
2. **Each adapter's `_spec_problems` stays** as the worker's backstop (rule 4).
3. **A permanent `tests/security/test_sec_param_parity.py`**, built from `S9_PARAM_PARITY_HARNESS.py` (in this folder, so CI
   does not collect it).
   - **Scope:** the whole registry, hidden models included, because 0227's checkbox can expose any of them. Extend it to every
     capability the quote sells; list anything not exercisable in an EXEMPT dict with its reason.
   - **Gates that hide cases:** get the lab org past the country gate (`country_unverified` hid the 4 Gemini image models) and
     past Runway's `acknowledgement_required`.
   - **Assertion:** zero cases where the quote accepts and the worker refuses. Mark the G1 cases `xfail(strict=True)` only until
     #999 is in the base.
4. **Housekeeping:**
   - `tests/security/sec_db.py`: 0251 after 0243, with take-off and put-back helpers.
   - The numbering lists (`tests/test_ads_factory_migration.py`, `test_brand_scan_migration.py`,
     `test_series_plan_caps_migration.py`), each with a review comment.
   - `docs/MIGRATIONS.md`: apply order 0228 → 0243 → 0251, then the registry `--sync`. State what a person sees in each order.
   - `docs/sql/rollback_0251_*.sql`, and a unit test pinning the guard md5s, the marked hunks and that there is no backslash.
5. **Review:** Lens plus database-reviewer, Breach (money path: the quote), and Pixel (the form change).

## Tests to run

- `python3 -m pytest -q` on the touched tests, plus `tests/test_model_registry*`, `tests/test_creative_*`, `tests/test_registry_*`,
  `tests/test_krea_ltx_luma.py`, `tests/test_geoip_build.py` and `tests/test_terms_gate_exposure.py`.
- **Lab** (`NIGHTSHIFT_SECURITY_PG`): param_parity, preview_price_by_image_size_0243, creative_prompt_limits, geo_gate_0208,
  mcp_oauth_creative, oauth_creative_operator, shape_offered_by_model (0155), duration_offered_by_model and films_money.
- **Dashboard:** `cd command-center && npx tsc --noEmit && npx next lint && npx vitest run && npx next build`.

## Open decisions

- **G7:** a data field, or narrowing the lists.
- **The 178 cases where the quote is stricter than the worker** (it refuses what would have worked): out of scope here, but
  worth a look later.

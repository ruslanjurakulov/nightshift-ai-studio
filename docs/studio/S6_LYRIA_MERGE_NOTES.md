# S6 Lyria: merging after #945 (0224)

0228 is written on 0224's `creative_price` (`ea2b58e88fe34ae18b261e5a0fbef435`) and refuses any other body. Until #945 is on main,
this branch's security lab cannot build, and `tests/test_migration_prerequisites.py` is red: the guard names 0224's
`credits_per_unit_now`. Merge #945 first, then merge main into this branch, and resolve the conflicts as below. This resolution was
built in a scratch tree (this branch plus #945's tip e3e36b359, with main) and the whole lab was run there.

Warning: a resolution that simply takes #945's side of these files drops this branch's 0228 lines. Done that way, 45 tests fail
with "rollback 0224: ... a later file sits on 0224". Every file below must keep both sides.

## sec_db.py (combine both sides)

- **`rollback_0224_body()`** starts with `rollback_0228_body()`. Three tests call `rollback_0224_body()` without taking 0228 off
  first, and 0224's rollback refuses a later body: `test_sec_dated_price_0224.py::test_a_replay_that_would_keep_a_list_rate_below_a_tenth_says_so_in_its_own_words`,
  and `test_sec_breach_0224_dated_price.py::test_breach_0224_reapplying_after_the_rollback_changes_no_quote` and `::test_breach_0224_a_tiny_dated_row_written_while_0224_was_off_never_quotes_zero`.
  Doing it inside the helper covers every caller:
  ```python
  return rollback_0228_body() + "\n" + "\n".join(ln for ln in text.splitlines() if ln.strip() not in ("begin;", "commit;"))
  ```
- **`rollback_0208_body()`** stays as #945 writes it, `return rollback_0224_body() + "\n" + rollback_0218_if_on() + ...`. 0228's rollback
  arrives through 0224's. `tests/test_music_per_request_migration.py` accepts either form.
- **`take_off_0224`** calls `take_off_0228(conn)` first. **`put_back_0224`** calls `put_back_0228(conn)` last. `take_off_0218` keeps
  `take_off_0228(conn)` before `take_off_0224(conn)`, and `put_back_0218` ends with `put_back_0224(conn)` then `put_back_0228(conn)`.
- **`has_0159`, `has_0208` and `has_0218`** list `CREATIVE_PRICE_0228` beside `CREATIVE_PRICE_0218_0224`.
- **Lists:** `ON_0156` and `ON_0139` get 0228 after 0224. `ON_0124` ends `..., "0218_...", "0224_...", "0219_...", "0228_..."`.
- **Constants:** `CREATIVE_PRICE_0228 = "33bb0ea77aedd1ffc3df339034adc6d3"`, `CREATIVE_PARAMS_PROBLEM_0228 = "0570bb5a1f749b7e3d556c87443bf17b"`.

## Seven lab files (combine both sides)

| File | Resolution |
|---|---|
| `test_sec_creative_prompt_limits.py` | The full chain ends at 0228: `after = {**AFTER, "creative_price": CREATIVE_PRICE_0228, "creative_params_problem": CREATIVE_PARAMS_PROBLEM_0228}`. The two "build without 0218" sequences leave out 0218, 0219, 0224 and 0228. |
| `test_sec_mcp_free_tier.py` | `LATER` starts with `(MIGRATION_0228, ROLLBACK_0228)`, then #945's `(MIGRATION_0219, ROLLBACK_0219)` and `(MIGRATION_0224, ROLLBACK_0224)`. |
| `test_sec_mcp_oauth.py` | The rollback list starts `ROLLBACK_0228, ROLLBACK_0219, ROLLBACK_0224, ROLLBACK_0218, ...`, and the apply list ends `..., MIGRATION_0224, MIGRATION_0219, MIGRATION_0228`. |
| `test_sec_named_resolution_params.py` | Both pins of `creative_params_problem` and `creative_price` are 0228's. |
| `test_sec_preview_price_by_quality.py` | The chain-end pin is `CREATIVE_PRICE_0228`. |
| `test_sec_geo_gate_0208.py` | `len(GOOGLE) == 13`. In `test_rollback_and_replay`, after `put_back_0218` the pin is `CREATIVE_PRICE_0228`. |
| `sec_expectations.py` | Keep both hooks at the bottom: #945's `credit_price_schedule` / `credits_per_unit_now`, then 0228's module. |

## Also

- `test_sec_dated_price_0224.py::test_rollback_and_replay`:
  - it starts with `take_off_0228(c)`, and the md5 pin is 0228's before that call and 0224's after it;
  - after `put_back_0224` and after `put_back_0218`, the pin is `CREATIVE_PRICE_0228`.
- **Numbering allow-lists** (`test_ads_factory_migration.py`, `test_brand_scan_migration.py`, `test_series_plan_caps_migration.py`):
  keep main's numbers, #945's `"0224"` and this branch's `"0228"`.
- **`tests/test_creative_prompt_limits_migration.py`**: take #945's `ON_0124` checks, extended so that `"0228_music_per_request_price.sql"`
  may follow 0219. Keep this branch's `REVIEWED_REPLACERS` (0228 replaces two 0218 bodies on purpose).
- **`docs/MIGRATIONS.md`**: keep both sections.
- **Done (branch `claude/nsai-s6-music-on`)**: once Atlas confirmed 0228 live, `MUSIC` left `REGISTRY_ONLY_CAPABILITIES` and
  `tests/test_sonilo.py` lost its `| {MUSIC}`. `google-lyria-3.5` and `sonilo-music` are synced dark after 0228; not on sale until a
  real probe, the vocal-activity check (Lyria) and a credit price. `video_music` and `video_character_swap` stay registry-only.
- **If #0230 (geo allow-list, `claude/nsai-s6-geo-trigger`) merges first**: the `google-lyria-3.5` row must get the same
  `available_countries` list as every other `provider: google` row, or the 0230 validator fails the registry and the 0230
  trigger refuses every Lyria job as `country_unverified`. If this PR merges first, 0230's branch adds it instead.

# Editor exports sold by the started minute: up to 1080p, 1440p and 4K

Owner decisions (2026-11-11): offer 1440p and 4K; give the worker more render time for them; charge credits in proportion to render
time; **nothing above 1080p is free** (a project whose own frame is bigger is exported in a paid size). Later the same day: **exports
at 1080p and below are no longer free either**: 1 credit per started minute, the same money as the paid tiers (migration 0136,
section "Up to 1080p" below). Until the owner sets that price (NULL), they stay free and unchanged.

Behind `NIGHTSHIFT_HIRES_EXPORT` (web and media worker, one repository variable), **default off**, on top of
`NIGHTSHIFT_MULTI_RATIO_EXPORT` (`docs/MULTI_RATIO_EXPORT.md`: a paid size is one of the "Sizes to export"). Migration
`0132_editor_hires_export.sql`. **Nothing is sold until the owner sets a price**: the migration seeds both prices as NULL, and NULL
means "not on sale".

## What a person sees (both switches on, 0132 applied)

Under "Sizes to export", four more sizes, each marked "paid": YouTube wide 16:9 1440p (2560 × 1440), Vertical 9:16 1440p
(1440 × 2560), YouTube wide 16:9 4K (3840 × 2160), Vertical 9:16 4K (2160 × 3840). Ticking one asks the server for its price
(`GET /api/editor/projects/<id>/exports/quote`, the database's `quote_editor_export`) and shows, under the sizes:

* "YouTube wide 16:9, 4K: 1 min × 5 credits = 5 credits charged, 30 held while it renders", the workspace's available credits, and
  what the export holds and charges in all. The hold is the charge raised to the platform's `job_minimum` (`reserve_credits` refuses
  less); the rest is given back when the video is ready, all of it if the export fails;
* a confirmation box, "Spend up to N credits on this export" (N is the CHARGE). **Export stays disabled until it is ticked.** Ticking
  another size, saving a new version or a new price takes the confirmation back;
* or, instead of a price, why it cannot be bought: not on sale yet; the video has a speed curve (its length cannot be priced: the
  chips are disabled with that sentence); the video is longer than the size allows (5:00 at 1440p, 3:00 at 4K: the chip is disabled
  with that sentence); 4K of a project faster than 30 fps; only an editor, admin or owner may spend the workspace's credits; not
  enough credits for the HOLD; the price could not be read ("Get the price again"); unsaved changes ("Save first").

The paid sizes are never in "Export format" (the project's own frame). **A project whose own frame is above 1080p** (another tool can
save one; saving it stays allowed) is not exported in its own size for free: the database refuses that request
(`hires_needs_paid_export`), and the worker refuses a row without a paid frame above 1080p. In the editor "This project's size" is
then disabled with a sentence that says what to do: tick the paid 1440p / 4K size (offered even when it is the project's own size)
and confirm the price, tick a free size of 1080p or smaller, or set the project to 1080p or smaller under "Export format". Without the
size picker, Export is disabled with the last of those.

## The rules

| Rule | Where |
| :-- | :-- |
| Tiers by **pixels**, so a frame and its 9:16 twin are one tier: up to 1920 × 1080 free; up to 2560 × 1440 `1440p`; up to 3840 × 2160 `4K` | 0132 `editor_export_hires_terms`, `modules/hires_export.py`, `lib/hiresExport/limits.ts` (pinned equal) |
| **Charge** = credits per **started** output minute of the tier × the minutes (61 s = 2 minutes), rounded up to the cent, **not** raised to `credit_prices.job_minimum`. **Hold** = the charge raised to `job_minimum` (0133's rule: `reserve_credits` refuses a hold below it). Both on the row (`quoted_credits`, `held_credits`) and in the quote (`credits`, `hold`) | `editor_export_hires_terms` |
| The price is read from **one owner-edited row** (`editor_export_hires_prices`: `credits_per_minute_1440p`, `credits_per_minute_2160p`). NULL = not on sale (`not_on_sale`, NS403). RLS on, no policy, no privilege for anon / authenticated / service_role; a change leaves a `security_events` row (`editor.export.hires_price`); the row cannot be deleted or emptied | 0132 |
| The request takes the number the person confirmed and compares it with the **charge**; a higher charge, no number, NaN or an infinity is refused (`price_changed`, NS409), a lower charge holds the lower one. The browser never sends a price of its own | `request_editor_export(project, rev, frame, max_credits)` |
| A document with a **speed curve** is not sold (`hires_speed_curve`): `editor_doc_duration` does not integrate a curve and the renderer does (a 45 s range at 0.25 × is 180 s on screen), so the price would be for the wrong length. The worker also refuses a paid row whose rendered length starts more minutes than the row's `duration_s` was priced at (`hires_length_mismatch`) | the overload, `quote_editor_export`, `editor_export.run_export` |
| **Above 1080p is never free**: the two-argument request refuses a project whose own frame is above 1920 × 1080 pixels, the three-argument one a paid frame of the list (`hires_needs_paid_export`, NS400, before the organization's lock) | 0132's bodies of both (0054's / 0129's plus the marked lines), `editor_export.run_export` |
| **One lock order** in all three overloads, 0054's: the project's row `FOR UPDATE` (the revision is checked under it), then the organization's advisory lock. A paid and a free request of one project (two tabs, a double click with two sizes, two members) wait for each other and never deadlock | the overload; `tests/security/test_sec_editor_hires_export.py` races them |
| Longest paid export: **300 s at 1440p, 180 s at 4K** (`hires_too_long`). Also a CHECK on `editor_exports` and the worker | 0132, `hires_export.MAX_S`, `HIRES_MAX_S` |
| 4K is **at most 30 fps** (`hires_fps`). A 60 fps project is refused for 4K, never rendered at 30 in its place (CLAUDE.md rule 4). 1440p takes any rate | 0132, `hires_export.MAX_FPS`, `HIRES_MAX_FPS` |
| Paying is an **editor's** (a viewer may still export free sizes). In the operator's exempt organization a platform admin's, and nothing is held | the four-argument overload |
| A held paid export is a **run in progress**: it takes one of the plan's parallel runs while it waits and renders (`parallel_runs`, NS429) | 0034 `credit_reservations_concurrency` |
| Each paid size is still **one export**: one of the three in flight, one of the twenty a day; one at a time per project per size | 0054 / 0129 lines, unchanged |
| Hold at request time (after every limit, so a refused request holds nothing), **started** at once (a started hold lives 24 h; an unstarted one would be swept after 3 h while the export waits in the shared queue). Too few credits for the HOLD roll the whole request back (`insufficient_credits`, NS402, the hold and the charge in the detail) | the overload, `creative_platform_reserve` (0036) |
| **Capture** the charge when the export is done (never an amount from the worker; `capture_credits` gives the rest of the hold back); **release** everything when it fails (render failed, timed out, worker off, lost worker, deleted project). Once: a second finish changes nothing. A done export marked failed by hand keeps what it was charged | the BEFORE UPDATE OF status trigger `editor_export_settle` |
| A hold that is gone when the worker takes the export (released, expired) ends it as `credits_released`; the worker renders nothing | the trigger, and `editor_export.run_export` (a claimed row that is not `rendering` is not rendered) |
| Exports up to 1080p: the two- and three-argument `request_editor_export` are 0054's / 0129's bodies plus only the refusal above 1080p (a pin test strips the marked lines and compares); the CHECK also refuses a frame row above 1080p without a quote | 0132 end-state asserts |
| The worker renders a paid size only with its switch on (`hires_off`), only from a row with a quote, within the tier's length and rate, and with the **tier's time budget** | `modules/editor_export.py`, `modules/hires_export.py` |

## Time budget per tier

The free exports get `min(5400, 3 × L + 120)` s. A paid export gets `min(5400, F × L + 120)` s, where `F` is **7 at 1440p and 12 at
4K**, about 1.3 × the dearest render of the tier measured below on a box that was not swamped (1440p: 5.34 s per output second;
4K at 30 fps: 9.82). Only a row with a paid frame gets it; a row without one is never rendered above 1080p (`hires_needs_paid_export`).

**The one export worker.** `ExportService` renders one export at a time for every organization. At the caps a paid export may hold it
for up to 37 minutes (1440p, 300 s) or 38 minutes (4K, 180 s) before it is stopped; typically about 23 (1440p60, 300 s) and 22 minutes
(4K30, 180 s). If that is too long a wait for the free exports behind it, lower the caps (each is three numbers: the migration's
function and CHECK, `hires_export.MAX_S`, `HIRES_MAX_S`; a new migration), or give hi-res its own worker.

## Measurements

The bundled ffmpeg 7.0.2 (`render_backend.resolve_ffmpeg`, imageio-ffmpeg 0.6.0) through `editor_export.run_export` with the
worker's limits (2 GiB address space, decoder and encoder thread caps, the large-frame rules), on a 4-core Intel Xeon VM with 15 GB,
2026-11-11. Source: a phone-like 60 fps H.264 clip with grain (lavfi `testsrc2` + `noise=alls=30:allf=t+u`; 15 / 25 / 45 Mb/s at
1080p / 1440p / 4K), 10 s, with sound; timeline 10 s (2 clips, a cue, a music bed), fit `cover` unless said. One process per case.
**The box was shared** with other work: the 1-minute load average is in the last column, and wall time grows with it (CPU time
does not), so read the rows at a low load. The 1080p30 row at load 3.94 (1.38 s per second) agrees with the 1.37 that section 12 of
`docs/editor-render-fields.md` measured for the same kind of source.

| Frame | fps | Source | Cross-fade | Fit | Result | Wall s / s | CPU s / s | Peak RSS MiB | Load |
| :-- | --: | :-- | :-- | :-- | :-- | --: | --: | --: | --: |
| 1920x1080 | 30 | 1920x1080 | no | cover | done | 1.38 | 4.21 | 599 | 3.94 |
| 1920x1080 | 60 | 1920x1080 | no | cover | done | 2.29 | 6.19 | 603 | 4.19 |
| 2560x1440 | 30 | 2560x1440 | no | cover | done | 3.47 | 7.65 | 977 | 5.32 |
| 2560x1440 | 60 | 2560x1440 | no | cover | done | 4.56 | 11.01 | 969 | 5.50 |
| 2560x1440 | 60 | 2560x1440 | yes | cover | done | 4.62 | 11.88 | 974 | 4.55 |
| 1440x2560 | 60 | 2560x1440 | yes | cover | done | 5.34 | 12.21 | 1034 | 7.08 |
| 3840x2160 | 30 | 3840x2160 | yes | cover | done | 7.24 | 15.90 | 1456 | 3.91 |
| 3840x2160 | 30 | 3840x2160 | no | cover | done | 9.09 | 14.96 | 1423 | 7.54 |
| 2160x3840 | 30 | 3840x2160 | yes | cover | done | 9.82 | 16.32 | 1468 | 8.38 |
| 3840x2160 | 60 | 1920x1080 | no | cover | done | 11.25 | 22.31 | 1439 | 4.07 |
| 3840x2160 | 60 | 3840x2160 | no | cover | done | 11.79 | 22.98 | 1449 | 5.85 |
| 3840x2160 | 60 | 3840x2160 | yes | cover | done | 12.75 | 23.41 | 1448 | 5.42 |
| 2160x3840 | 60 | 3840x2160 | no | cover | done | 14.93 | 21.79 | 1487 | 10.13 |
| 2160x3840 | 60 | 3840x2160 | yes | contain | done | 11.19 | 11.79 | 1495 | 11.02 |
| 2160x3840 | 60 | 2160x3840 | yes | cover | done | 17.85 | 21.81 | 1479 | 10.50 |
| **2160x3840** | **60** | **3840x2160** | **yes** | **cover** | **failed: out of memory (RenderRefused)**, 3 runs of 3 | | | 1680-1692 | 5.4-12.8 |
| **3840x2160** | **60** | **2160x3840** | **yes** | **cover** | **failed: out of memory (RenderRefused)** | | | 1692 | 8.50 |

Rows measured again at a high load (9-16) took 1.6-2.2 × as long and are not used for the budget (two 4K60 rows of that second pass
also ran into the FREE exports' 150 s budget before the measurement gave them more). Peak RSS is the largest decoder process as the
supervisor reports it (`ffmpeg_limits.Outcome.peak_rss_bytes`); the hard limit is the 2 GiB of address space, not RSS.

### Memory: why 4K is capped to 30 fps

A 4K60 render stays under the 2 GiB limit with the large-frame rules for a single clip of either orientation, and for a cross-fade
whose clips keep their shape (`contain`, or a source of the frame's own orientation). It does **not** for a cross-fade in which a
clip of the OTHER orientation fills the frame (`cover`): 9:16 4K60 from a 16:9 4K60 source failed three runs of three, and 16:9 from
9:16 failed too ("out of memory" under the limit). The same cases passed at **30 fps** (peak 1468 MiB). The validator cannot see a
source's shape (the document names files, not sizes), so the rule is on the rate: a paid 4K export is at most 30 fps. 1440p passed
every case at 60.

## Prices (owner-approved 2026-11-11; NOT applied by the migrations, whose seeds stay NULL)

**Approved by the owner on 2026-11-11, credits per started minute of video: up to 1080p 1, 1440p 3, 4K 5.** The migrations seed all
three as NULL (up to 1080p: free; 1440p and 4K: not on sale): they go live when the owner writes them into the price row, in the order
in "The switch and the roll-out". **The 1080p price and the 1440p / 4K prices are independent**: each can be set, changed or put back
to NULL on its own (one row, three columns). The reasoning the 1440p and 4K prices came from (1 credit up to 1080p is the owner's
round number for the cheapest tier):

* **Server cost.** The owner's figure (2026-11-11): the server costs **$69 a month**.
  $69 / (30 × 86 400 s) = **$0.0000266 per second of the whole server**. Charging the whole server for every second the export
  worker spends is conservative: the export worker is one process on an 8-core box that also serves the site and the other workers.
* **Credit value.** About **$0.01 per credit** retail (`docs/API.md`: Starter is 1,000 credits for $10).
* **Worker seconds per output minute** (the dearest measured render of the tier above, on a 4-core box; the AX42 has 8 cores of a
  newer generation, so this overstates its time): 1440p 5.34 × 60 = **320 s**, 4K (30 fps) 9.82 × 60 = **589 s**.

| Tier | Worker s per output min | Server cost per output min | In credits ($0.01) | × 3 (the site's margin on a finished minute: ~60 credits retail for ~$0.20 of cost) | Approved price per started minute | A video at the cap |
| :-- | --: | --: | --: | --: | --: | :-- |
| 1440p | 320 | $0.0085 | 0.85 | 2.56 | **3 credits** | 5:00 → 15 credits ($0.15) |
| 4K (≤ 30 fps) | 589 | $0.0157 | 1.57 | 4.70 | **5 credits** | 3:00 → 15 credits ($0.15) |

Each price is the × 3 column rounded up to a whole credit, so both stay in proportion to render time (589 / 320 = 1.84; 5 / 3 =
1.67, the rounding), and a video at either cap costs the same 15 credits.
For comparison: a 1080p HD download is 1.25 credits a minute (`credit_prices.download_1080p_minute`). The platform's `job_minimum`
(30 credits on the live price list) raises only the HOLD: a 1-minute 4K export at 5 credits a minute holds 30 while it renders and
is charged 5 (the other 25 go back when it is done). So a workspace needs 30 credits available to start any paid export. The price
does not include the cost of the queue: a 4K export at its cap holds the one export worker for about 22 minutes. A higher price (for
example 6 and 10) would also make that rarer.

To make them live: after the merge (0132 applied) and **only once `NIGHTSHIFT_HIRES_EXPORT` is on in the media worker AND the web**
(the order in "The switch and the roll-out" below), the owner writes them into the price row. 0132 adds no function for this, on
purpose: the row is closed to every API role, so it is the SQL editor's statement below, and it leaves a `security_events` row
(`editor.export.hires_price`). A price set while the worker's switch is off would sell exports that the worker then refuses as
`hires_off` (the hold goes back):

```sql
update public.editor_export_hires_prices set credits_per_minute_1440p = 3, credits_per_minute_2160p = 5;   -- 1440p and 4K (0132)
update public.editor_export_hires_prices set credits_per_minute_1080p = 1;                                -- up to 1080p (0136)
```

To stop selling at once: set them to `null` (1440p / 4K: every request is refused `not_on_sale`; up to 1080p: free again, exactly as
before 0136; exports already queued keep their hold and settle as usual).

## Up to 1080p (migration 0136)

0136 adds `credits_per_minute_1080p` to the same row, seeded NULL. **NULL = free and unchanged**: the two- and three-argument
`request_editor_export` queue the export and touch no credit, the paid overload refuses a frame up to 1080p (`invalid_frame`), the quote
says `paid=false`, the editor never asks a price. Once the owner sets it (approved: 1):

* every export up to 1080p runs the paid tiers' flow: the quote (`credits` = the charge = credits_round_up(price × started minutes),
  `hold` = greatest(charge, round_up(job_minimum)): "1 credit charged, 30 held while it renders" with the live job_minimum of 30),
  the person's yes, the four-argument request (a free id of the list, or `project` for the project's own frame up to 1920 × 1080),
  which compares the confirmed number with the CHARGE, holds the hold, and the settling trigger captures exactly the charge (29 of 30
  go back) or releases all of it on a failure, a deleted project or a hold that is gone;
* the two- and three-argument calls are **refused** (`export_needs_quote`, NS409) after every older gate and before anything is
  locked or written. They hold nothing, so routing them into a sale would charge a number nobody confirmed; the editor reads the word
  and moves to the quoted path (every ticked size is priced, the project's own included);
* who: an editor or above. **A viewer can no longer export at all** while the price is set (a viewer may not spend the
  organization's credits). In the operator's exempt organization only a platform admin, and nothing is held;
* **a document with a speed curve cannot be exported at any size** while the price is set (`hires_speed_curve`, as for 1440p and
  4K: `editor_doc_duration` does not integrate a curve, so its price would be for the wrong length). Integrating the curve in SQL
  (exactly as `speed_ramp.out_length`) is a follow-up; until it lands, setting the 1080p price takes speed-curve exports away;
* the worker charges nothing itself: a row up to 1080p with a quote gets the same two refusals as a paid one (a speed curve, more
  minutes than priced) and keeps the free exports' time budget and caps.

## The switch and the roll-out

* **Command Center** (`lib/hiresExport/flag.ts`): off = no paid size in the picker, the quote route is a 404, and the export route
  refuses a paid id as an unknown one (`bad_request`). A paid id needs `maxCredits[id]` in the body or the route answers
  `quote_required` before the database is asked.
* **Media worker** (`modules/hires_export.py` `FLAG`): off = a paid frame row fails at once with `hires_off`, before any file is read,
  and the database gives its credits back.
* **Not behind the switch:** from the moment 0132 is applied, a project whose own frame is above 1080p is not exported free by the plain
  request (`hires_needs_paid_export`), whatever the switches say. Before applying, check that no project depends on it
  (`select count(*) from public.editor_projects where deleted_at is null and (doc ->> 'width')::numeric * (doc ->> 'height')::numeric > 2073600;`
  read 0 on 2026-11-11, with one editor project in all).
* Before 0132 the quote answers "not available" and nothing paid can be confirmed. A worker older than this change refuses a paid row
  (`invalid_frame`: its presets file has no such id) and the hold is released.
* **Order of switching on (go-live: deploy → flags → UPDATE prices):** (1) merge, so 0132 and 0136 are applied (all three prices
  NULL: nothing is sold, everything up to 1080p is free as before); (2) deploy the web and the worker with this version; (3) turn
  `NIGHTSHIFT_MULTI_RATIO_EXPORT` and `NIGHTSHIFT_HIRES_EXPORT` on for the worker; (4) turn them on for the web (the paid sizes appear
  and say "not on sale yet"; the editor can now show a price for every size); (5) only then write the approved prices (the statements
  in "Prices"): 3 and 5 for 1440p / 4K, and 1 up to 1080p, together or one after the other. **Never set the 1080p price while
  either switch is off on the web**: the editor then cannot show a price, and every export is refused (`export_needs_quote`, the
  page says the price cannot be shown yet). Stopping goes the other way: prices to null first, then the switches off.

## Undo

Set the prices to null (stops sales; up to 1080p is free again) and turn the switch off. To take 0136 out:
`docs/sql/rollback_0136_editor_export_paid_1080p.sql` (owner-applied; run it BEFORE 0132's rollback): it puts 0132's bodies back byte
for byte and drops the 1080p price; a sold 1080p export still in flight settles through 0132's trigger as usual. To take 0132 out:
`docs/sql/rollback_0132_editor_hires_export.sql` (owner-applied; run it before 0129's rollback). It refuses while a paid export is
queued or rendering. Finished 1440p / 4K videos stay in the library, their rows keep their frame (0129's frame check is put back
NOT VALID when such a row exists), and the credit ledger keeps every hold, charge and release.

## Not done here

* Speed curves are refused for paid sizes rather than priced: pricing them would need the renderer's integration of a curve
  (`speed_ramp.out_length`) in SQL, exactly equal to Python's at every millisecond and minute boundary. Refusing is exact; the worker's
  `hires_length_mismatch` check is the second line if the two lengths ever disagree for another reason.
* The render-time estimate of the validator (`timeline.py` `render_timeout_s`) is still the free exports' 3 × L + 120 for every frame:
  a document that just fits that at 1080p can time out at 4K (the hold is then released in full).
* Not measured on the AX42 itself. The factors are the number to raise if a legitimate paid export is cut off (`timed_out`).

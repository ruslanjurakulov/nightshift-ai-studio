# 1440p and 4K editor exports, sold by the started minute

Owner decision (2026-11-11): offer 1440p and 4K; give the worker more render time for them; charge credits in proportion to render
time. Exports up to 1080p stay free.

Behind `NIGHTSHIFT_HIRES_EXPORT` (web and media worker, one repository variable), **default off**, on top of
`NIGHTSHIFT_MULTI_RATIO_EXPORT` (`docs/MULTI_RATIO_EXPORT.md`: a paid size is one of the "Sizes to export"). Migration
`0132_editor_hires_export.sql`. **Nothing is sold until the owner sets a price**: the migration seeds both prices as NULL, and NULL
means "not on sale".

## What a person sees (both switches on, 0132 applied)

Under "Sizes to export", four more sizes, each marked "paid": YouTube wide 16:9 1440p (2560 × 1440), Vertical 9:16 1440p
(1440 × 2560), YouTube wide 16:9 4K (3840 × 2160), Vertical 9:16 4K (2160 × 3840). Ticking one asks the server for its price
(`GET /api/editor/projects/<id>/exports/quote`, the database's `quote_editor_export`) and shows, under the sizes:

* "YouTube wide 16:9, 4K: 1 min × 4 credits = 4 credits", the workspace's available credits, and the total the export holds now;
* a confirmation box, "Spend up to N credits on this export". **Export stays disabled until it is ticked.** Ticking another size,
  saving a new version or a new price takes the confirmation back;
* or, instead of a price, why it cannot be bought: not on sale yet; the video is longer than the size allows (5:00 at 1440p, 3:00 at
  4K: the chip is disabled with that sentence); 4K of a project faster than 30 fps; only an editor, admin or owner may spend the
  workspace's credits; not enough credits; the price could not be read ("Get the price again"); unsaved changes ("Save first").

The paid sizes are never in "Export format" (the project's own frame): a project's own frame is exported free, so a 4K project frame
would be a free 4K export.

## The rules

| Rule | Where |
| :-- | :-- |
| Tiers by **pixels**, so a frame and its 9:16 twin are one tier: up to 1920 × 1080 free; up to 2560 × 1440 `1440p`; up to 3840 × 2160 `4K` | 0132 `editor_export_hires_terms`, `modules/hires_export.py`, `lib/hiresExport/limits.ts` (pinned equal) |
| Price = credits per **started** output minute of the tier × the minutes (61 s = 2 minutes), never below `credit_prices.job_minimum`, rounded up to the cent | `editor_export_hires_terms` |
| The price is read from **one owner-edited row** (`editor_export_hires_prices`: `credits_per_minute_1440p`, `credits_per_minute_2160p`). NULL = not on sale (`not_on_sale`, NS403). RLS on, no policy, no privilege for anon / authenticated / service_role; a change leaves a `security_events` row (`editor.export.hires_price`); the row cannot be deleted or emptied | 0132 |
| The request takes the number the person confirmed; a higher price is refused (`price_changed`, NS409), a lower one holds the lower one. The browser never sends a price of its own | `request_editor_export(project, rev, frame, max_credits)` |
| Longest paid export: **300 s at 1440p, 180 s at 4K** (`hires_too_long`). Also a CHECK on `editor_exports` and the worker | 0132, `hires_export.MAX_S`, `HIRES_MAX_S` |
| 4K is **at most 30 fps** (`hires_fps`). A 60 fps project is refused for 4K, never rendered at 30 in its place (CLAUDE.md rule 4). 1440p takes any rate | 0132, `hires_export.MAX_FPS`, `HIRES_MAX_FPS` |
| Paying is an **editor's** (a viewer may still export free sizes). In the operator's exempt organization a platform admin's, and nothing is held | the four-argument overload |
| A held paid export is a **run in progress**: it takes one of the plan's parallel runs while it waits and renders (`parallel_runs`, NS429) | 0034 `credit_reservations_concurrency` |
| Each paid size is still **one export**: one of the three in flight, one of the twenty a day; one at a time per project per size | 0054 / 0129 lines, unchanged |
| Hold at request time (after every limit, so a refused request holds nothing), **started** at once (a started hold lives 24 h; an unstarted one would be swept after 3 h while the export waits in the shared queue). Too few credits roll the whole request back (`insufficient_credits`, NS402) | the overload, `creative_platform_reserve` (0036) |
| **Capture** the quote when the export is done; **release** everything when it fails (render failed, timed out, worker off, lost worker, deleted project). Once: a second finish changes nothing | the BEFORE UPDATE OF status trigger `editor_export_settle` |
| A hold that is gone when the worker takes the export (released, expired) ends it as `credits_released`; the worker renders nothing | the trigger, and `editor_export.run_export` (a claimed row that is not `rendering` is not rendered) |
| Exports up to 1080p: the two- and three-argument `request_editor_export` keep their bodies (md5 `6d37b4d7…` and `83456b3c…`); the three-argument one cannot queue a paid size (the CHECK refuses a row above 1080p without a quote) | 0132 end-state asserts |
| The worker renders a paid size only with its switch on (`hires_off`), only from a row with a quote, within the tier's length and rate, and with the **tier's time budget** | `modules/editor_export.py`, `modules/hires_export.py` |

## Time budget per tier

The free exports get `min(5400, 3 × L + 120)` s. A paid export gets `min(5400, F × L + 120)` s, where `F` is **7 at 1440p and 12 at
4K**, about 1.3 × the dearest render of the tier measured below on a box that was not swamped (1440p: 5.34 s per output second;
4K at 30 fps: 9.82). Only a row with a paid frame gets it: a project whose OWN frame is 4K (another tool can save one) keeps the free
budget, as before.

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

## Pricing proposal (NOT applied: the owner sets the numbers)

* **Server cost.** `docs/DEPLOY_AX42.md` gives no monthly figure. ASSUMPTION: the Hetzner AX42 costs about **$55 a month** (a list
  price of roughly €46-49 a month before VAT, converted and rounded up). Owner: put the real invoice figure in the table below.
  $55 / (30 × 86 400 s) = **$0.0000212 per second of the whole server**. Charging the whole server for every second the export
  worker spends is conservative: the export worker is one process on an 8-core box that also serves the site and the other workers.
* **Credit value.** About **$0.01 per credit** retail (`docs/API.md`: Starter is 1,000 credits for $10).
* **Worker seconds per output minute** (the dearest measured render of the tier above, on a 4-core box; the AX42 has 8 cores of a
  newer generation, so this overstates its time): 1440p 5.34 × 60 = **320 s**, 4K (30 fps) 9.82 × 60 = **589 s**.

| Tier | Worker s per output min | Server cost per output min | In credits ($0.01) | × 3 (the site's margin on a finished minute: ~60 credits retail for ~$0.20 of cost) | Proposed price per started minute | A video at the cap |
| :-- | --: | --: | --: | --: | --: | :-- |
| 1440p | 320 | $0.0068 | 0.68 | 2.04 | **2 credits** | 5:00 → 10 credits ($0.10) |
| 4K (≤ 30 fps) | 589 | $0.0125 | 1.25 | 3.75 | **4 credits** | 3:00 → 12 credits ($0.12) |

The two prices keep the ratio of the render times (589 / 320 = 1.84; 4 / 2 = 2), which is what "in proportion to render time" asks.
For comparison: a 1080p HD download is 1.25 credits a minute (`credit_prices.download_1080p_minute`). If the platform has a
`job_minimum` price, every paid export holds and charges at least that. The price does not include the cost of the queue: a 4K export
at its cap holds the one export worker for about 22 minutes. A higher price (for example 5 and 10) would also make that rarer.

To apply (SQL editor; leaves a security event):

```sql
update public.editor_export_hires_prices set credits_per_minute_1440p = 2, credits_per_minute_2160p = 4;
```

To stop selling at once: set both to `null` (every request is then refused `not_on_sale`; exports already queued keep their hold and
settle as usual).

## The switch and the roll-out

* **Command Center** (`lib/hiresExport/flag.ts`): off = no paid size in the picker, the quote route is a 404, and the export route
  refuses a paid id as an unknown one (`bad_request`). A paid id needs `maxCredits[id]` in the body or the route answers
  `quote_required` before the database is asked.
* **Media worker** (`modules/hires_export.py` `FLAG`): off = a paid frame row fails at once with `hires_off`, before any file is read,
  and the database gives its credits back.
* Order does not matter. Before 0132 the quote answers "not available" and nothing paid can be confirmed. A worker older than this
  change refuses a paid row (`invalid_frame`: its presets file has no such id) and the hold is released. Turn the switch on only when
  the web and the worker both run this version, after setting the prices.

## Undo

Set the prices to null (stops sales) and turn the switch off. To take the migration out:
`docs/sql/rollback_0132_editor_hires_export.sql` (owner-applied; run it before 0129's rollback). It refuses while a paid export is
queued or rendering. Finished 1440p / 4K videos stay in the library, their rows keep their frame (0129's frame check is put back
NOT VALID when such a row exists), and the credit ledger keeps every hold, charge and release.

## Not done here

* A project whose own frame is above 1080p (another tool can save one) is still exported free through the plain export, with the free
  time budget (unchanged from before 0132). Making that paid would change what existing documents do; a separate decision.
* The render-time estimate of the validator (`timeline.py` `render_timeout_s`) is still the free exports' 3 × L + 120 for every frame:
  a document that just fits that at 1080p can time out at 4K (the hold is then released in full).
* Not measured on the AX42 itself. The factors are the number to raise if a legitimate paid export is cut off (`timed_out`).

# App redesign, G4: insight and operations

Pages: analytics, measurement, intelligence (advisory), intelligence map, learning, feedback loop, usage, margin, logs,
audit, alerts, autonomy, agents.

Screenshots (made offline with `tools/visual-qa/visual-qa.mjs` and `tools/visual-qa/fake-insight.mjs`, a wrapper that
adds made-up rows to the fake backend; nothing real, nothing written). They are WebP contact sheets, the top of each page,
in this order: analytics, measurement, intelligence, intelligence map, learning, feedback loop, usage (account state
sub62), margin, logs, audit, alerts, autonomy, agents.

- `sheets/before-<width>-<theme>.webp` the pages as they were on the Foundation commit (en, with made-up data).
- `sheets/after-<width>-<theme>.webp` the same set after this branch.
- `sheets/after-ru-*` (light) and `sheets/after-uz-*` (dark): same pages in Russian and Uzbek; no overflow at 390.
- `sheets/after-empty-*` the empty states (a new account with no rows): what each page says when it has nothing.
- `detail/` a few full-length pages, before and after (analytics, measurement, usage, autonomy on a phone).

What changed: every page root is `ns-open`; one lit desk per page (the headline figures, the allowance, the loop, the
posture, the logs, Run now, the alert channels); `StatusLamp` for every status; dense tables are `DataList` (a ruled
table on desktop, a stack of `label  value` lines on a phone, same markup); the retention curve has real text labels;
unknown values stay words (N/A, unpriced) and never become a 0 or a bar. Page rules: `app/(app)/app-pages-g4.css`
(all scoped under `.g4`). Shared bits: `components/g4/{DataList,Section}.tsx`.

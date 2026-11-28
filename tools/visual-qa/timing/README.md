# Timing harness: filmstrips, `ns:` marks and the live-creation targets

Measurement tooling for `docs/studio/LIVE_CREATION_PLAN.md` §3.11 (build order item 1). It answers "what does a person see,
and when" with numbers, before and after each live-creation PR (CLAUDE.md rule 8: the measurement is its own deliverable).

| File | What it is |
| :-- | :-- |
| `harness.mjs` | Starts the stand-in Supabase and `next start`, records a page (filmstrip, DOM sampler, marks, navigations), writes `raw.json` and `REPORT.md` |
| `analysis.mjs` | Pure functions over the samples: event table, unchanged stretches, reload counter, the targets, the report. No browser, no I/O |
| `brain-flow.mjs` | Scenario: one sentence in the Nightshift AI panel → Choose → Create → confirm → the live view |

Unit tests: `command-center/tests/visual-qa-timing.test.ts` (vitest imports `analysis.mjs` directly; it runs with `npx vitest run`).

## Running it

Nothing here calls a model, a vendor or a paid provider, and nothing is spent. `brain-flow.mjs` answers `/api/brain/turn` and
`/api/films/{id}/start` in the browser; the fake Supabase refuses every write.

```bash
cd command-center && npm ci
# The Supabase URL is inlined into the client at build time, so build against the fake's port once:
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54531 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build
cd ..
node tools/visual-qa/timing/brain-flow.mjs --L 2 --out /tmp/timing/L2
node tools/visual-qa/timing/brain-flow.mjs --L 8 --out /tmp/timing/L8
```

The harness reads the fake's port from the build, refuses to start if that port is taken (the browser would otherwise measure
whatever answers there), picks a free port for `next start` (a listen test; the container has no `ss`), and stops only the
processes it started. With a stack you already run, pass `--base http://localhost:3517 --fake http://127.0.0.1:54499`.

`brain-flow.mjs` options:

| Option | Default | Meaning |
| :-- | :-- | :-- |
| `--L` | `8` | Seconds per stubbed model call. A parameter, not a measured vendor latency |
| `--windows` | `2` | Plan windows; Choose waits `ceil(windows/3)·L·(1+reask)`, the plan's parallel schedule |
| `--reask` | `0` | `1` = every window asked again once (worst case) |
| `--worker` | `2000` | ms after the start until the stubbed first step reads as "working" |
| `--selectors` | – | JSON file merged over `DEFAULT_SELECTORS` (e.g. a branch's own `data-testid`s) |
| `--shots` | `1` | `0` = no filmstrip |
| `--keep` | `0` | `1` = leave the stack running |

Output in `--out`: `fNNNN_<ms>ms.jpg` (a frame every 500 ms), `final.png`, `raw.json` (every sample, mark, navigation, request),
`REPORT.md`, and `logs/` (the fake's and the app's output).

The defaults cover today's main (the panel beside `StudioCanvas`) and the live-plan branch (`studio-plan-column`, `plan-card-*`,
`plan-planning`, `plan-storyboard`). A selector that matches nothing reads as 0 or "never"; it is not an error.

## What the report measures

- **Work windows**: intervals in which the person waits on the app (Send → outlines, Choose → the plan, confirm → the first lit
  step). The scripted person's own pauses sit between windows and are never counted.
- **Events (first seen)**: the first sample at which a DOM event held, each `ns:*` mark, each new document, and the script's
  steps, on one clock. An event that never happened reads "never", never 0 (rule 5).
- **Unchanged stretches**: intervals longer than 1 s inside a window in which nothing sampled changed, longest first. `screen`
  compares everything sampled; `board` only the hash of the board beside the panel (canvas, Plan column or live view), which is
  how "the panel's dots moved" is told apart from "the board stayed frozen". A same-document URL change is not a change on screen;
  a new document is.

The three targets from plan §3.11:

| Target | Pass when |
| :-- | :-- |
| First event < 1 s | For each window, the earliest of its expected events (a plan card, a plan "thinking" state, an `ns:` mark…) lands within 1 s. The report also shows the first change anywhere, for contrast |
| No unchanged stretch > 3 s while work runs | The longest stretch, per region, is at most 3 s |
| 0 full-page reloads after Create | No main-frame navigation that loaded a new document after the confirm click. `history.replaceState` does not count. Create never reached reads as unknown and fails |

A reload is counted from Playwright's `framenavigated` on the main frame when a main-frame navigation request preceded it. As a
cross-check, an init script sets an id on every new document and the report notes how often the sampler saw it change; the two
numbers should tell the same story (the first load is a navigation but not a change between samples).

## Adding an `ns:` mark in app code

Name: `ns:<area>:<event>`, lower-case, kebab-case event, for example `ns:plan:first-card`, `ns:plan:storyboard-start`,
`ns:live:first-lit`. Mark the moment the thing becomes visible (after the state that renders it is committed), not when the
request was sent. A mark must never throw, never carry data (no ids, prompts or numbers in the name), and costs nothing when no
one reads it:

```ts
function nsMark(name: `ns:${string}:${string}`) {
  try {
    if (typeof performance !== "undefined" && typeof performance.mark === "function") performance.mark(name);
  } catch {
    /* timing only: never break the page for a measurement */
  }
}

const hasCard = cards.length > 0;
useEffect(() => {
  if (hasCard) nsMark("ns:plan:first-card");
}, [hasCard]);
```

In app code use the one helper, `nsMarkOnce` (`command-center/lib/studio/nsMark.ts`): each name fires **at most once per document**
(a mark repeated on every re-render would only move "first seen" to whichever render the sampler caught), and it never throws.

The harness collects them with `performance.getEntriesByType("mark")` every 100 ms and converts `timeOrigin + startTime` to its
own clock, so marks from the page before and after a reload line up. It works with zero marks (today) and lists every mark it
sees; to make a mark count towards a target, add its name to the window's `expect` list in the scenario.

## Writing another scenario

```js
import { finish, loadPlaywright, record, startStack, chromiumPath } from "./harness.mjs";
const stack = await startStack({ appEnv: { NIGHTSHIFT_AI_CHAT: "on" }, fakeEnv: { FAKE_ADMIN: "1" } });
const page = await (await (await loadPlaywright().chromium.launch({ executablePath: chromiumPath() })).newContext()).newPage();
const rec = await record(page, { out, watch: { counts: { cards: ".lv-card" }, regions: { board: "[data-testid=live-view]" } } });
rec.start(); /* drive the page, rec.mark("step") at each step */ await rec.stop();
finish({ out, title, rec, windows, defs, createAt, stretchRegions: [null, "board"] });
await stack.stop();
```

Screenshots use `caret: "initial"`: Playwright's default hides the caret by touching the DOM on every shot, which the sampler then
reads as the page changing every 500 ms.

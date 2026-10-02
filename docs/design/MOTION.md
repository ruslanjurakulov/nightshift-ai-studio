# Nightshift motion: "Master control, 03:00" in time

Status: v1, 2026-10-02. Companion to `IDENTITY.md` (§5 Motion is the short
version). Tokens: `command-center/lib/motion/tokens.ts` (mirrors `--ns-ease`
and `--ns-dur-1..3` in `globals.css`; a test holds them together). Kit:
`command-center/components/motion/`. Behaviour as data:
`command-center/lib/motion/presets.ts`. Contract tests:
`command-center/tests/motion-kit.test.tsx`.

## 1. The language

The room is a broadcast console at three in the morning. Its parts move the
way console parts move, and only when something happened.

| Principle | What it means on screen | Token |
| :-- | :-- | :-- |
| **A relay switches, it does not float** | A state change lands fast and stops dead: no drift, no overshoot, no bounce. | `EASE.standard` = `--ns-ease`; springs are all `bounce: 0` |
| **The plate slides on its rail** | Selection is one lit plate that travels along its row of keys to the one you chose (sidebar, phone tab bar). | `SPRING.plate` (0.24 s) |
| **A lamp strikes, then holds** | A lamp whose state changed gives one short beat (scale 1→1.35→1, light 0.4→1) and holds. Only *running* breathes, because running is a process. | `LAMP_STRIKE`, `DURATION.state` |
| **Proofs print in order** | Content that arrives prints top-to-bottom in reading order, 40 ms apart, capped at six so a long list never drags. | `STAGGER`, `DISTANCE.rise` (8 px) |
| **Sheets come up from their edge and leave faster** | Popovers drop 4 px from the bar that opened them; sheets and toasts rise from their edge. Exits take the tap duration and accelerate away. | `DURATION.enter` / `.tap`, `EASE.exit` |
| **Reduced is instant** | With `prefers-reduced-motion: reduce`, every state is reached in one frame. Nothing moves, nothing fades. | presets return `{}` |

Durations: `tap` 120 ms · `state` 200 ms · `enter` 320 ms · `scene` 560 ms (the
one public hero entrance, per item). Distances: nudge 4 · rise 8 · sheet 16 px,
never more.

What motion is **not** allowed to do (IDENTITY §8 applies): run constantly
(the one exception is a lamp on a genuinely running job), parallax, glow,
blur, decorate, compensate for a weak layout, animate every card on a screen,
hide a page's first paint, animate width/height/top/left/margin (layout), or
make a reduced-motion reader wait.

## 2. Engineering rules

- **Motion for React is the default UI animation system** (`motion`, MIT;
  imports from `motion/react` and named imports from `motion/react-m`). Only
  through `LazyMotion` + `m.*` (`strict`, so `motion.*` throws in
  development). Never `framer-motion`, never `import * as m` (a dynamic
  `m[tag]` keeps ~170 element components in the bundle). Tests enforce all
  three.
- **CSS for simple micro-states** (`:hover`, `:active`, focus rings): `.ns-press`
  in `motion.css`, the existing `.btn-*` rules. One tool per interaction;
  Motion only where an element is already an `m.*` element or the interaction
  needs presence, layout or orchestration.
- **GPU-only:** opacity and transforms. Layout animation exists only as
  Motion's projection (`layoutId`), which is itself a transform.
- **No entrance over the server-rendered first paint.** `useFreshMount()`
  tells a client mount from hydration; `PageTransition`, `LoadingGrace` and
  `trigger="mount"` reveals do nothing on the first paint, so LCP never waits
  for JavaScript. The single exception is `firstPaint` on a public hero's
  secondary items (never the H1, never the primary action).
- **Reduced motion, three layers:** the presets hand out no props;
  `useReducedMotionSafe()` is hydration-safe (server and hydrating render read
  `false`, the real answer follows in the next render); and `motion.css`
  pins every `[data-ns-motion]` element at `opacity: 1; transform: none`
  with `!important` under the media query, so even the frame before hydration
  or a stale inline style cannot move. `[data-ns-reveal]` is also shown under
  `@media (scripting: none)`.
- **No engine means no motion.** The kit animates only when Motion's engine
  (the feature chunk `MotionProvider` fetches after hydration) is actually
  there (`components/motion/engine.ts`, `useStill()`):
  - Outside any `MotionProvider`, every kit element renders at rest.
  - Something that mounts on the client before the chunk has arrived renders
    at rest too, instead of waiting at opacity 0.
  - If the chunk fails to load (one retry, then a 4 s timeout), the kit stops
    animating for the rest of the page. `<html data-ns-motion-engine="failed">`
    makes `motion.css` pin every `[data-ns-motion]` element at rest, so a
    server-rendered start state is shown rather than left invisible.

  A failed engine therefore looks exactly like reduced motion: never a blank
  page, never an invisible dialog holding focus. The layout chunk (the
  plate's slide) failing costs only the slide.
- **Exits never trap focus:** a leaving `PresenceItem` is `inert`, and
  `useOverlay` returns focus to the opener when focus is still inside an
  overlay that is animating out.

## 3. The kit

| Piece | Use | Reduced motion |
| :-- | :-- | :-- |
| `MotionProvider` (`app/(app)/layout.tsx`; a public layout adds its own when a page there animates) | `LazyMotion strict` with the `domAnimation` features fetched after hydration; `MotionConfig reducedMotion="user"`. Kit elements outside any provider, or under one whose engine failed to load, render at rest (no start state, no animation). | — |
| `Reveal` | One block arriving: `trigger="inView"` (once, 20 % visible) or `"mount"`. | rendered in place |
| `Stagger` + `StaggerItem index` | A group printing in reading order. | in place |
| `RevealText` | A heading below the fold, word by word; sr-only full sentence. Never the LCP heading. | plain text |
| `Presence` + `PresenceItem kind` | Mount/unmount with exit: `popover`, `sheet`, `toast`, `fade`. `mode="popLayout"` for lists. | appears/disappears at once |
| `SharedLayout id` + `Plate id` | One travelling selection plate per rail; any `layoutId` morph. Loads the layout features (`domMax`) only where mounted. Pinned rails need `layoutRoot`, scrolling ones `layoutScroll`. | plate drawn in place |
| `PageTransition` | For a route `template.tsx`: client navigations rise 8 px and fade in 320 ms. Enter only (the App Router unmounts the old screen first). Children stay Server Components and keep streaming. | nothing |
| `LoadingGrace` | Holds a skeleton back 150 ms after a click so fast routes never flash it. Opacity only, space reserved. | no delay |
| `LiveLamp` | `StatusLamp` for a state that changes while watched: strikes once on change. Identical markup at rest. | instant |
| `pressProps`, `.ns-press` | A key that gives 3 % when pressed. | no movement |

## 4. Where it runs now

Applied only to files no open PR owns (as of 2026-10-02: #351 public site,
design-adopt-c Studio workspaces, model-discovery):

- **Root layout**: `motion.css` only. **App layout** (`(app)/layout.tsx`): `MotionProvider`.
- **Section template** (`SectionShell`): `PageTransition` replaces the CSS
  `page-rise` (which played on every hard load too, 440 ms, 22 px + scale).
- **Customer sidebar and phone tab bar**: the current row's backplate is one
  `Plate` that slides to the row you open.
- **Credit menu and notification panel**: `PresenceItem kind="popover"`
  (they had `sheet-enter` 30 px + scale and a `drawer-enter` that slid in from
  the left of a top-right panel) — now 4 px drop in, 120 ms out, inert while
  leaving, focus back on the opener.
- **Toasts**: left on their CSS entrance. The toast viewport lives in the root
  layout, so giving it an exit would put Motion's core on every public page
  (§7). Recipe once the public pages carry the engine anyway:
  `<Presence mode="popLayout">` around the list and `PresenceItem as="li"
  kind="toast"` per toast.
- **Route loading** (`PageSkeleton`): `LoadingGrace`.
- `LiveLamp` is built and tested but not applied. The jobs list has no live
  source (it is a server page with no refresh), so a lamp there never changes
  while watched. Apply it with the Studio feed's live status (§5.2).

Measured in Chromium (tools/visual-qa probes): a sidebar click mounts one
template wrapper that rises and fades in ~330 ms while the plate travels on
its spring; the content then streams into the same wrapper (no remount, no
second fade). Reduced motion: every step lands in one frame. The credit
popover fades/drops in ~210 ms and is gone ~130 ms after Escape, with focus
on the credit pill. CLS 0 and zero settled animations before and after, on
home, videos, credits and login at 1440/390, light/dark, reduced on/off.

## 5. Recipes (apply after #351 / adopt-c / model-discovery merge)

### 5.1 Public landing hero — the one orchestrated entrance

The hero's H1, lead and primary key stay static: they are the LCP and the
action, and must be on screen in the HTML. The entrance belongs to the
picture: the rundown monitor powers on and replays the night's log — rows
print in order, each done row's lamp lit as it lands, then the "your approval"
row stands lit and breathing. One second, once, on first load.

```tsx
// components/site/Rundown.tsx (stays a Server Component; the kit pieces are
// client components that take server-rendered children)
import { Stagger, StaggerItem } from "@/components/motion/Reveal";

<Stagger as="ol" trigger="mount" firstPaint className="st-rows">
  {r.rows.map((row, i) => (
    <StaggerItem as="li" index={i} key={row.id} className="st-row" data-state={rowState(row.id)}>
      …unchanged row…
    </StaggerItem>
  ))}
</Stagger>
```

The public layout has no `MotionProvider` today (§7): wrap the landing page
(or `PublicShell`) in `<MotionProvider>` in the same change. That costs the
landing ~22 kB gz of first-load JavaScript, and the hero entrance alone does
not justify it: the CSS `lp-in` keyframes already in globals.css do a
stagger for 0 kB. Add the provider when the landing also gets the
interactive previews of §5.2; until then do the entrance in CSS with the same
tokens (`--ns-dur-3`, `--ns-ease`, 40 ms steps, 8 px) and keep the kit for
the app.

Rows below the fold of a long page (Rules, How, Desk) use `trigger="inView"`
on their *section group*, not on every card. Section headings further down
may use `RevealText`. Never wrap the hero `<h1>`.

### 5.2 Model and tool previews (models page, Studio)

- Grid of models as a `ContactSheet`: `Stagger trigger="inView"` on the
  sheet, `StaggerItem` per `Frame` (capped at six steps).
- Hover/focus on a frame: CSS only — the edge print lifts 2 px and the lamp
  lights (`transition: transform, opacity` on `--ns-dur-1`); `.ns-press` on
  the frame's key. No Motion for a hover.
- Opening a model's sheet: `SharedLayout id="models"`, the frame's thumbnail
  and the sheet's hero image share `layoutId={"model-" + id}` (an `m.img` or
  `m.div`), the sheet itself is a `PresenceItem kind="sheet"`. The thumbnail
  morphs into place; reduced motion, the sheet is simply there.
- A tool or model sample video plays only on hover/focus (`play()` on
  `pointerenter`/`focus`, `pause()` on leave), poster frame otherwise, and
  never autoplays under reduced motion. No looping previews at rest.
- Live job status in the Studio feed: `LiveLamp` instead of `StatusLamp`.

### 5.3 A cinematic scroll scene (only if the page earns one)

Candidate: the landing's "How a night runs" — pinned for ~1.5 viewports
while the night's clock scrubs from 22:00 to 07:00 and each stage's row
prints and its lamp lights. Desktop only (≥ 768 px), below the first
viewport, static and complete without it.

GSAP is not a dependency today (§6). When a scene like this is approved:

- Add `gsap` at an exact version.
- Build a small `ScrollScene` client component that `import()`s `gsap` and
  `gsap/ScrollTrigger` inside an effect, and only when all of these hold:
  - not reduced motion;
  - `matchMedia("(min-width: 768px)")` matches;
  - the engine has not failed.

  React to that media query changing, too.
- Run the timeline in a `gsap.context()` scoped to the scene root, with
  `ctx.revert()` on unmount.
- Make the timeline: `scrollTrigger: { trigger, start: "top top", end:
  "+=150%", pin: true, scrub: 0.4 }`, transforms and opacity only.
- Render the static, complete scene as the children.
- Pin a test that GSAP is reached only through that dynamic import.

Do not use two libraries for one interaction: a reveal, a stagger or a
hover is Motion or CSS; GSAP only for the pinned, scrubbed sequence.

## 6. GSAP — evaluation and owner note

**Verdict:** not needed for the product, and **not installed**. Motion covers
every UI need: presence, layout, gestures, in-view, and scroll-linked values
via `useScroll`. GSAP + ScrollTrigger is justified only for a pinned,
scrubbed, multi-step marketing scene. No page has one, so there is no `gsap`
dependency and no `ScrollScene`; §5.3 says how to add both when a scene is
approved.

What it would cost: **~44 kB gz** for `gsap` + `ScrollTrigger` (measured with
esbuild), as a separate chunk fetched only by that route and only on screens
≥ 768 px, never under reduced motion. A test fails if anything imports
`gsap`.

**Licence (read 2026-10-02 at gsap.com/standard-license; npm `gsap@3.15.0`
declares "Standard 'no charge' license").** GSAP is owned by Webflow and is
free, including all plugins (ScrollTrigger, SplitText, MorphSVG…), for
"implementation and/or use of GSAP Products on any website, web application,
or digital interface by any person or entity", commercial SaaS included. The
one prohibited use: "any implementation and/or use of GSAP Products in tools
that allow users to build visual animations without code that … competes
with Webflow's visual animation building capabilities". No attribution
required; proprietary notices must not be removed. The older "end users may
not be charged" clause is no longer in force (it survives only as an HTML
comment on that page).

**Owner note:** using GSAP on Nightshift's marketing pages is clearly a
permitted use. Keep it **out of the Studio, the timeline editor, the
renderer and anything that lets a customer compose animation** — a video
editor with animation controls could be argued to be a "visual animation
builder", and Motion already covers those surfaces. If that ever changes,
get written confirmation from Webflow first.

**GreenSock's agent skills** (`github.com/greensock/gsap-skills`, MIT,
© 2026 GreenSock) were read, not installed: `gsap-react`,
`gsap-scrolltrigger`, `gsap-performance`, `gsap-frameworks`. Followed: client
only, `gsap.context()` scoped to the scene root and `ctx.revert()` on unmount
(no `@gsap/react` dependency needed), transforms/opacity only, `pinSpacing`
left on, `scrub` small (to be applied when a scene is built). Not followed: their default to "recommend GSAP for
React animation" and for parallax (Motion is our default; parallax is banned
by default). They say nothing about `prefers-reduced-motion`; the §5.3 pattern handles
it by never loading GSAP. One example in `gsap-scrolltrigger` has a
typo (`Max.max`), so do not paste from it blindly.

## 7. Bundle cost (next build, gzip -9, measured against origin/main)

First-load JavaScript per route, every chunk the route's entries list
(`app-build-manifest.json`), same fake-backend build for both:

| Route | main | this branch | delta |
| :-- | --: | --: | --: |
| `/` (landing), `/login`, `/pricing` | 320.4 / 358.0 / 328.6 kB | 320.9 / 358.5 / 329.1 kB | **+0.5 kB** (motion.css) |
| signed-in pages (`videos`, `home`, `jobs`, `credits`) | 398.9–420.8 kB | 421.1–443.0 kB | **+22.0 to +23.0 kB** |

| Chunk | When it loads | Size |
| :-- | :-- | :-- |
| Motion shell: `m` elements, `LazyMotion`, `MotionConfig`, motion values, frameloop, visual-element core | first load, signed-in routes | 15.1 kB |
| `AnimatePresence`, `LayoutGroup`, kit components | first load, signed-in routes | ~7 kB |
| `domAnimation` features | after hydration, async | 15.7 kB |
| `domMax` layout features (the plate) | after hydration, async, customer shell | 13.8 kB |
| GSAP + ScrollTrigger | not installed (§6); would be a per-route async chunk | ~44 kB |

Two findings worth knowing before adding Motion anywhere else:

- **`LazyMotion` alone costs ~11 kB under webpack.** Its `loadFeatures`
  imports `setFeatureDefinitions` from motion-dom's `VisualElement.mjs`, and
  webpack keeps whole modules, so the visual-element core comes along even on
  a page with no `m` element (esbuild, which shakes inside modules, measures
  the same import at 0.9 kB). That is why the provider sits in the app layout
  and not the root: with it in the root, the landing, login and pricing pages
  paid +12.5 kB for nothing. Motion's docs quote "under 4.6 kB" for `m` +
  `LazyMotion`; with Motion 13.5 the measured shell is 15.1 kB.
- **Never `import * as m`.** A dynamic `m[tag]` keeps all ~170 element
  components; named imports (`components/motion/tags.ts`) saved 1.8 kB gz.

## 8. Visual QA

`tools/visual-qa/visual-qa.mjs` (not in any bundle or default CI): real
Chromium screenshots per page × width × theme × reduced motion, CLS, LCP and
its element, horizontal overflow with the offending elements, axe-core
(WCAG 2.1 A/AA), animations still running after the page settles, and
optional click-then-capture frames. `--fake-session` with
`tools/visual-qa/fake-supabase.mjs` renders the signed-in customer shell
against fixed, read-only fake rows. Look at the screenshots; the numbers say
whether something moved, only the pictures say whether it should have.

The Motion AI Kit (`npx motion-ai`, MIT) refuses to run without an
interactive terminal ("motion-ai is interactive — run it in a terminal")
and would also register Motion's hosted MCP servers, one of them the paid
Motion+ tier, in the agent's configuration; it was not forced. Its
best-practice notes (read from the npm package) informed §2.

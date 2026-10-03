# The signed-in app, made calm: notes, decisions, measurements

Status: 2026-10-03. Branch `claude/app-simplify`. Builds on `HUMAN_TYPE.md` (Onest, scale, radii, 44px
targets). Screenshots: `docs/design/app-krea/` (`before/`, `after/`, five contact sheets, the QA tables in `qa/`).

The owner, about Krea's workspace and Claude's Usage page: calm, simple, confident; large rounded cards, one idea per
card, plain words, generous space. Their earlier complaint was "technical, robotic". The target is that quality in
**our** identity (the N tile, amber, Onest). Nothing of Krea's is copied: no asset, no copy, no layout.

## 1. What I looked at, and what I could not

| Source | How | What it showed |
| :-- | :-- | :-- |
| Krea logged-out app shell (`/video`, `/image`), 390 and 1280, dark | Chromium, session proxy CA pinned by SPKI (verification never disabled), trackers blocked. Shots in `design-inbox/app-krea/krea-*.png` | The composer itself is behind sign-in and **not reachable**. The shell is quiet: a short sidebar (Home, Moodboards, Assets, then Tools: Image, Video, Enhancer), nine items, colour-tile icons, 36px rows, 14px text; on a phone the sidebar disappears and the only visible control is one "Model" selector in the top bar. Nothing else competes. |
| Krea marketing pages, raw HTML (`/`, `/video`, `/image`, `/pricing`) | `curl` with `Accept: text/html` and the CA bundle | Same shell and wording; the pages carry no product screenshots of the composer. |
| Krea MCP page, Higgsfield MCP/CLI | the analyst notes in `design-inbox/krea-mcp/` (measured earlier: one hero, one connect card, pill tabs, a scripted chat card) | One idea per block, big radii, no chrome. Applies to `/mcp`, which another builder owns. |
| Claude / ChatGPT settings | **Not reachable** (Cloudflare challenge, as `HUMAN_TYPE.md` §2 recorded). I rely on the owner's Usage screenshot, already built as `/usage` | Large rounded cards, one number per card, plain sentences under it, a single control per card. |
| Descript, CapCut, Canva mobile "create a video" | **Not measured.** General knowledge only, stated as such | The pattern they share on a phone: the first screen asks one thing (what is it about, or a template), the rest are defaults you can change from a row that shows the current value, the primary button is at the bottom and says what it does. |

I did not use any paid generation call; every price in the proof screenshots comes from the repo's fake backend.

## 2. What that means for us (decisions)

1. **One question per card, in order.** What is it about, then how should it look and sound, then what it costs,
   then one button. The page reads top to bottom like a sentence.
2. **A choice shows its current value, not its options.** Length, voice and look are three cards, each one line:
   the label, and what it is now ("Usual length", "Your channel's voice"). Tapping opens the options inline;
   nothing is asked that already has a good default.
3. **The price is a card, before the button.** The number first and large ("About 120 credits"), then what it rests
   on, then the balance, in sentences. Unknown stays unknown: no estimate says why (never a 0); extra credits off
   and "not enough" are said in words, not only in red.
4. **Capability is folded, never removed.** Language, "making this for", a voice ID and the operator's provider
   routing are under "More options".
5. **Technical words go.** "Program monitor", "template", "Run now", "Press Enter to create" lines, the six-step
   rundown above the form. A word that stays technical (an app's name, a return host, a key) is monospace on purpose.
6. **Status is a sentence, only when there is something to say.** "1 video is waiting for your OK" with one button;
   "A clip is being made" under the recent clips. Nothing when nothing needs the person.

## 3. What changed, screen by screen

* **Create a video** (`components/create/CreateStudio.tsx`, new `components/create/flow.css`, class prefix `fl-`).
  Cards: topic (one field, three example chips, "leave it empty and we pick"), look and sound (three choice
  cards + More options), price, button. Same props, same request body, same one-confirm behaviour (§6). While a
  video is made the card says "Making your video" / "Done. Find it under Videos." from the queue job's state;
  every pipeline event stays under "Show every step".
* **Home** (`components/home/HomeHub.tsx`, `app/(app)/[channel]/home/page.tsx`). The first card is that same flow
  for the channel in view, so there is no page between the idea and the price. Above it, only a waiting-for-you
  card. Below: **Your videos** as cards (title and state in words), **More things to make** as a one-line list,
  recent clips, channels, and the Assistant folded into one row. Without a connected channel: one card and one
  button. The older composer remains as the fallback when the page hands none over (and as a hand-off link target).
* **Studio clip desk** (`GeneratePanel`, video desk). First view is the shot, its shape and length, and Generate.
  Sound, look and model are under More options (still in the DOM, still priced the same). "Program monitor" is
  now "Your clips".
* **Connect an app** (`/oauth/authorize`). Three cards: who is asking (the host it returns to and the workspace),
  what it can and can never do, the spending limit with **Allow and Deny the same size**. All security properties
  kept: the app's name and the return host in monospace inside their own `<bdi>` (`dir="ltr"` on the host),
  "the name comes from the app, rely on the address", the spend-limit sentence, Enter never submits, plain buttons.
* **Connected apps** (Developers): one card per app, name and host in monospace, 44px buttons. It now sits below the
  console and the console reserves its height, so the page no longer jumps (CLS 0.07 to 0.001 at 1280).
* **Operator chrome:** only the operator's provider routing moved under More options. The ten-tab strip and the
  balance chip are untouched (see §7).

Copy is short, warm and plain in en, ru and uz, with key parity pinned by `tests/create-flow.test.tsx`; Uzbek uses
`oʻ gʻ` (U+02BB) and `ʼ` (U+02BC), and the apostrophe tests pass. Money and legal sentences keep their meaning.

## 4. Measured

Real Chromium, `tools/visual-qa` with the fake backend (`tools/visual-qa/fake-supabase.mjs`, read only, no secrets),
built twice from the same commit range: `main` (before) and this branch (after). 180 full-page shots per side:
states `new`, `videos`, `running`, `low`, `extraoff`, `unpriced` (en, 360/390/1280, light and dark), `videos` in ru
and uz, the consent page and Developers in all three languages. Tables: `docs/design/app-krea/qa/`.

| Check | Before | After |
| :-- | --: | --: |
| Taps, Home to pressing Make, default topic (390x844, touch) | 3 (Continue, Create, Confirm) | **2** (Make this video, Yes make it) |
| Same, with a typed topic | 4 | **3** |
| Page loads on the way | 2 | **1** |
| Scroll gestures to reach the button | 1 | 2 (the price now comes first, by design) |
| Form controls to read before deciding (create page) | 5 fields + a Listen button | **1 field**, three one-line cards |
| axe, any impact, 180 shots | not run | **0** |
| CLS, Home and Create, all shots | 0 | **0** |
| CLS, Developers at 1280 | 0.067 to 0.074 | **0.001** |
| Phone shots with horizontal overflow | 2 (a 6px bottom tab bar on the clip desk while a clip is running) | 2 (same, not touched, §7) |
| Inputs under 16px on phones | 28 | **0** |
| Targets under 44px on phones | 12 (Developers "API reference") | 0 after the last change |

The taps come from a scripted touch session (`design-inbox/app-krea/taps.mjs`); the run request is answered inside
the browser, so nothing reaches any backend. The confirm tap is counted; it is kept (§6).

## 5. Tests

`tests/create-flow.test.tsx` (new, 10): defaults, example chip, a choice re-asks the price for its length, first
press only asks and the run body is exactly what was chosen, unpriced shows no number, extra credits off, not enough
credits said in words, a viewer who cannot run, and en/ru/uz key parity. `tests/home.test.tsx` and
`tests/channel-dna-ui.test.tsx` were updated (never deleted): the old format-card test now drives the composer's own
handle; selects that became choice cards are read from their one-line values; new tests for the status card, the
video cards and the clip-status line. Full suite: 218 files, all green.

## 6. Left alone on purpose

* **The confirm tap.** Create still asks once ("Yes, make it") because the run route holds a server-computed
  estimate and the browser does not send a `max_credits` ceiling the way the Studio's priced button does. Dropping
  the second tap (3 to 1 from the old count) is a money-path decision: it needs the run request to carry the
  displayed price and the route to refuse a higher one. Written up here, not done.
* SQL, RLS, credit logic, publish gate, approvals: untouched.
* A disabled button when the run is unpriced: it is enabled as before; the server refuses with the plain sentence.

## 7. Not done / next

* The ten-tab strip under the header (Pixel's #6) and the VU-style balance chip: shared chrome used by every
  screen, so a separate change.
* The 6px overflow of the phone tab bar on the clip desk with a clip running (`grid-cols-5` sizes to its labels);
  a one-line fix in `SideNav.tsx`, left out because it truncates long Russian and Uzbek labels and needs its own look.
* The Studio's other desks (image, voice, enhance) still use the older composer; the clip desk shows the way.
* Real devices and a signed-in Krea/Claude were not available: Chromium only, fake data only.

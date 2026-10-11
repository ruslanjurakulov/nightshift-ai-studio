# Mobile / Desktop view

A visitor can choose the layout the site renders in, whatever device it is opened on. The control
(`ViewModeToggle`) shows the layout on screen now (phone icon and "Mobile", or monitor icon and
"Desktop"); a press switches to the other. Default is automatic: no cookie, nothing changes.

## The choice

One cookie, `ns_view=mobile|desktop`: a year, `Path=/`, `SameSite=Lax`, `Secure` on https, not HttpOnly,
no identity in it. Written with `document.cookie` (no secret, no round trip; the page reloads right after
so the server renders the new layout). Only the two literal values are accepted (`parseViewChoice`).
Rules live in `command-center/lib/view-mode.ts` (pure, `tests/view-mode.test.ts`).

## Desktop on a phone

`app/layout.tsx` `generateViewport()` reads the cookie and emits `width=1280` (no `initial-scale`, so the
browser fits the page and the visitor zooms). No other behaviour changes. Cost of reading a cookie in the
root layout: none. The layout already reads the language cookie (`getLocale`) and the middleware mints a
CSP nonce per request, so no page was static (`next build` lists every page as dynamic).

## Mobile on a desktop

Tailwind breakpoints are viewport media queries (here: 300 `sm:`, 88 `lg:`, 32 `md:`, 6 `xl:` uses and 332
`@media` rules), so a container-query refactor is out of proportion. Instead the site is shown inside a
same-origin iframe about 430 px wide: the frame has its own viewport, so every query answers as on a phone.

- The middleware decides (`frameSrcFor`): a top-level navigation (`Sec-Fetch-Dest: document`) of a
  framable page by a visitor with `ns_view=mobile` gets a shell document that draws only the frame and the
  switch. The URL goes to the layout in a request header the middleware always overwrites
  (`x-ns-frame-src`). `/api`, `/auth`, `/oauth` are never framed.
- The framed page (`Sec-Fetch-Dest: iframe`) mounts `EmbedBridge`: it posts its path and title to the parent
  (the shell does `replaceState` and sets the tab title), so reload and pasted links open the same page in
  the same view and Back moves the frame.
- Links that cannot live in a frame leave it: another site, `/api/*` (provider connections), `/auth/*`,
  `/oauth/*` open in the whole window. `PlanPanel` uses `assignTop` for the billing portal.
- The switch stays reachable: the shell bar (outside the frame) and, inside, the account panel.
  Pressing either reloads the whole window.

## Headers

Static `X-Frame-Options: DENY` and `frame-ancestors 'none'` (next.config.ts) are unchanged. The middleware
lifts them only for a request the browser marks `Sec-Fetch-Dest: iframe` AND `Sec-Fetch-Site: same-origin`
on a framable path: `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'` (in the enforcing policy, or as a
sole `Content-Security-Policy` header in report-only/off mode). A cross-site frame sends `cross-site` and
keeps DENY. The shell gets `'self'` in `frame-src`. `deploy/Caddyfile` sends its `X-Frame-Options: DENY`
only when the request is not `Sec-Fetch-Dest: iframe` (`header @notFrame >X-Frame-Options "DENY"`; the `>` defers the write, so the response always carries exactly one line), so it cannot overwrite the app's answer for our own frame. The response depends on the cookie and on `Sec-Fetch-*`; no `Vary` for them can be added from the middleware (Next keeps its own `Vary` value, verified on a production build), so correctness rests on the pages being `Cache-Control: private, no-cache, no-store`, which they are.

## Known limitations

- A browser without Fetch Metadata (before 2023) gets the unframed desktop page.
- Language changed inside the frame updates the shell's switch label on the next load only.
- Apple Pay / Google Pay inside the Paddle overlay may be missing in the framed view (the `payment`
  permission is delegated to Paddle only, one frame less deep); card payment works. Use Desktop to pay.
- PWA "Add to Home Screen" from the framed view saves the visible URL; file pickers and downloads work
  in a same-origin frame.
- A page that is reloaded loses unsaved input: the switch reloads the window.
- With cookies blocked the choice cannot be stored: the control writes the cookie, reads it back and, if it is not there, shows one line ("Turn on cookies to change the view.") instead of reloading.

# Content-Security-Policy (BR-S-008)

The Command Center sends a content policy on every page. It is built per
request in `command-center/middleware.ts` from `command-center/lib/security/csp.ts`
and pinned, character for character, by `command-center/tests/csp.test.ts`.

## Why it exists

The browser Supabase client reads the session from a cookie (`httpOnly` is off
by design in `@supabase/ssr`). One injected script would therefore be a stolen
session. The policy makes sure only the scripts Next.js wrote for this response
can run, and that a script which does run can only talk to our own API,
Supabase and Paddle.

## What it allows

| Directive | Value | Why |
|---|---|---|
| `script-src` | `'self'`, a per-response nonce, `'strict-dynamic'`, the hash of the theme script, Paddle's CDN and Retain snippet host | Next stamps the nonce on every script it renders. `strict-dynamic` lets those scripts load Paddle.js, which loads Paddle Retain. No `'unsafe-inline'`, and no `'unsafe-eval'` outside `next dev`. |
| `style-src` | `'self' 'unsafe-inline'`, Paddle's CDN | React writes `style="…"` attributes into server-rendered HTML, and a nonce cannot cover attributes. Paddle's Retain snippet also injects un-nonced `<style>` elements (read in `public.profitwell.com/js/profitwell.js`, 2026-11-12). CSS cannot read the session cookie. |
| `img-src`, `media-src` | `'self' data: blob: https:` | Finished generations live on whichever provider host produced them, social avatars come from rotating CDN hosts, and review copies are signed Supabase Storage URLs. Images and video cannot execute script. |
| `font-src` | `'self' data:` | `next/font` serves the fonts from our own origin. |
| `connect-src` | `'self'`, the Supabase origin and its `wss:` twin, Paddle's API and Retain hosts | This is the exfiltration control. |
| `frame-src` | Paddle checkout and Retain frames (production and sandbox) | The Buy credits overlay. |
| `worker-src`, `manifest-src` | `'self' blob:`, `'self'` | No service worker and no Web Worker in the app today (`app/manifest.ts` says why); the manifest is ours. |
| `upgrade-insecure-requests` | (enforcing modes, over https only) | Any `http:` subresource is fetched over https instead of failing. Browsers ignore it in a report-only policy, so it is not in that one. |
| `report-uri` | `CSP_REPORT_URI` if set; in the enforcing modes otherwise `/api/csp-report` | See "Where reports go". |
| `object-src` | `'none'` | |
| `base-uri`, `form-action` | `'self'` | |
| `frame-ancestors` | `'none'` | Same as the header `next.config.ts` already sends (BR-S-007). |

No `'unsafe-eval'` and no `'wasm-unsafe-eval'` in production: nothing in the browser compiles code. `libsodium-wrappers`
(WebAssembly) runs only on the server (`lib/server/github-secrets.ts`); the editor draws with Konva on a canvas and
uses no worker, WebCodecs or wasm. `next dev` alone adds `'unsafe-eval'` for React's dev tooling.

### Where the Paddle hosts come from

Paddle publishes no list of hosts for a Content-Security-Policy: its full documentation
(`https://developer.paddle.com/llms-full.txt`, read 2026-11-12) does not mention CSP, and its docs assistant answers
only that Paddle.js must be loaded from `https://cdn.paddle.com/`
(`https://developer.paddle.com/paddle-js/about/include-paddlejs`, read 2026-11-12). So the list is read from the code
Paddle serves, on 2026-11-12: `https://cdn.paddle.com/paddle/v2/paddle.js` names `cdn`/`sandbox-cdn` (paddle.css,
images), `buy`/`sandbox-buy` (the checkout frame), `api`/`sandbox-api` (price previews) and, outside the sandbox only,
`public.profitwell.com/js/profitwell.js` (Retain); that snippet names `www2.profitwell.com`, `retain-api.profitwell.com`,
`api.profitwell-events.com`, `retain-widgets(-api)` and their `sandbox-` twins. Everything inside the checkout frame
(Paddle's own analytics, fonts, error reporting) is governed by Paddle's policy, not ours. Re-read both files when
Paddle changes its integration.

Every page is already rendered per request (the root layout reads cookies for
the locale), so the nonce does not make any page dynamic that was not already.

The signed media file route (`/api/media/file/…`) gets no policy from the
middleware. It keeps its own, stricter one (`default-src 'none'; sandbox`).

## The switch

`CSP_MODE` is a repository variable (Settings, Secrets and variables, Actions, Variables), mapped by
`deploy_web.yml` (`WEBENV_CSP_MODE: ${{ vars.CSP_MODE }}`) into `/opt/nightshift/.env.web` on every deploy, like the
`NIGHTSHIFT_*` switches. The middleware reads it per request; nothing is baked into the build.

| `CSP_MODE` | Headers sent | Effect |
|---|---|---|
| unset, empty, `report`, `report-only`, or anything unrecognised | `Content-Security-Policy-Report-Only` | Violations are reported, nothing is blocked. **The default, and byte for byte the header sent before this switch had more modes** (`tests/csp.test.ts` pins it). |
| `enforce` | `Content-Security-Policy` | The same policy is enforced, plus `upgrade-insecure-requests` over https and a `report-uri`. |
| `both` | `Content-Security-Policy` and `Content-Security-Policy-Report-Only` | `enforce`, plus a **stricter** policy as report-only: `img-src` and `media-src` narrowed from any https origin to our origin, Supabase, Paddle's CDN and the backdrop artwork. Its reports name every other image or video host the app really loads, which is the evidence for narrowing the enforced policy later. |
| `off` | none (only `frame-ancestors 'none'` from `next.config.ts`) | Escape hatch. Not a setting to leave on. |

`CSP_REPORT_URI` (optional, an absolute `https://` URL) adds `report-uri`, `report-to` and a `Reporting-Endpoints`
header, so violations reach that collector. Anything else in that variable is ignored.

### Where reports go

Until this change the live report-only policy carried no `report-uri` (`CSP_REPORT_URI` was never set, checked with
`curl -sSI https://nightshift-ai.studio/` on 2026-11-12), so every violation stayed in the visitor's own console and
nobody could have learned from the report-only period. Now:

- In `enforce` and `both`, the policy reports to `/api/csp-report` on the site itself unless `CSP_REPORT_URI` names a
  collector. Each violation becomes one line in the web container's log:
  `{"event":"csp_violation","directive":"script-src-attr","disposition":"enforce","blocked":"inline","page":"/terms","source":"https://nightshift-ai.studio/terms","line":1,"column":0}`.
- In report-only, to collect the same lines before enforcing, set `CSP_REPORT_URI=https://nightshift-ai.studio/api/csp-report`.

The endpoint (`app/api/csp-report/route.ts`, `lib/security/csp-report.ts`) is public by nature: a browser sends
reports with no session. So it answers 204 whatever it receives, reads no cookie, stores nothing, reads at most 16 KB
(cancelling the upload past that), takes at most 20 reports from one body, drops reports about another origin's page
(`APP_ORIGIN`), and reduces every field to a closed shape: a known directive name, an origin (never a path or query,
so a signed Supabase or media URL's token is not logged), the page's path with token-like segments replaced by `:id`
(review links), two integers. `script-sample` is never logged. The line is JSON in printable ASCII, so a field cannot
start a new log line. One process logs at most 120 lines a minute and then one `csp_violation_dropped` line with the
count.

### Turning enforcement on (owner steps)

1. Optional, recommended: set the repository variable `CSP_REPORT_URI` to `https://nightshift-ai.studio/api/csp-report`
   and run the **Deploy web** workflow (Actions, Deploy web, Run workflow, branch `main`). Report-only lines now appear
   in the web log while nothing is blocked. Use the site for a day: sign in, Studio, the editor, the library, Buy credits
   (the Paddle overlay), the pricing page.
2. Set the repository variable `CSP_MODE` to `both` (or `enforce`) and run **Deploy web** again. The deploy rewrites the
   env file and restarts `web`.
3. Check it took: `curl -sSI https://nightshift-ai.studio/ | grep -i content-security-policy` shows
   `content-security-policy: default-src 'self'; script-src …` (with `both`, a second, report-only line).
4. Watch the first day on the server: `dc logs -f web | grep csp_violation` (`dc` is the alias in DEPLOY_AX42.md:
   `docker compose --env-file /opt/nightshift/.env.web -f /opt/nightshift/app/deploy/docker-compose.yml`). What to
   look for:
   - `"disposition":"enforce"` lines are things that were **blocked**. Any on a real page (not an extension's
     `chrome-extension:` scheme, not a single visitor's odd add-on) means a feature is broken: roll back, then fix.
   - `"disposition":"report"` lines (only in `both`) are the stricter img/media policy: the list of hosts to name
     before `img-src`/`media-src` can be narrowed. They block nothing.
   - A `csp_violation_dropped` line means more than 120 a minute: something is broken on every page view.
5. Roll back without a code change: set `CSP_MODE` to `report-only` (or delete the variable) and run **Deploy web**.
   That restores today's header exactly. `off` removes the policy entirely and is only for an emergency the report-only
   header itself causes.

## How it was checked

### 2026-11-12: the enforce switch (`CSP_MODE=enforce` and `both`)

A production build (`next build`, `next start`) against the read-only fake Supabase
(`tools/visual-qa/fake-supabase.mjs`) and Paddle **production** settings (a dummy `live_` token and price, so Paddle.js
loads the Retain snippet), in headless Chromium: 18 public routes (every sitemap page, sign-in, sign-up, password
pages, the 404) and 56 signed-in routes as a customer (every section the fake account can open; the operator-only
ones redirect it to Home), plus the pricing page with Paddle.js loaded and the overlay checkout opened.
Result in `enforce` and in `both`: **0 violations of the enforced policy**; Paddle.js, `public.profitwell.com` and the
`api.paddle.com` price preview loaded and the `buy.paddle.com` frame opened. The stricter report-only half of `both`
reported exactly one thing, on every signed-in page: the backdrop's two CloudFront hosts, now named in it. The
positive control (an injected inline handler and an inline `<script>` in a same-origin `srcdoc` frame) ran under the
report-only default and was blocked and reported under `enforce`; the report arrived at `/api/csp-report` and was
logged. Repeat it with `tools/visual-qa/csp-smoke.mjs` (its header says how).

Not exercised, so the residual risk of turning enforcement on: the operator-only pages (Command Center sections such as
margin, customers, providers, audit, logs, model keys, security), and every page with real data behind it: finished
generations, thumbnails and previews from provider CDNs and Supabase Storage, social avatars, the editor with a real
project, the MFA enrolment QR, OAuth connect flows, and a real Paddle checkout past the first screen. Nothing in the
policy narrows images or media (`https:` stays), so the likely failure is a script or connection the code adds later;
`both` and the log lines above are how it would show.

### 2026-10 (#367)

A production build (`next build` and `next start`) against a read-only fake
Supabase and Paddle's sandbox, in headless Chromium, on the landing page,
login, sign-up, pricing, privacy, terms, the API docs, and the signed-in shell
(home, studio, videos, library, editor, credits with the Paddle overlay open,
developers, styles, channels, command center, welcome). This was done in both
modes. Result: no violations. Paddle.js loaded, the checkout frame opened, and
the Supabase realtime websocket connected. A positive control (an injected
`onerror` handler and a `fetch` to another origin) was reported in report-only
mode and blocked in enforce mode.

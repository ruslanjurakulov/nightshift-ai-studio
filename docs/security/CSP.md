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
| `style-src` | `'self' 'unsafe-inline'`, Paddle's CDN | React writes `style="…"` attributes into server-rendered HTML, and a nonce cannot cover attributes. CSS cannot read the session cookie. |
| `img-src`, `media-src` | `'self' data: blob: https:` | Finished generations live on whichever provider host produced them, social avatars come from rotating CDN hosts, and review copies are signed Supabase Storage URLs. Images and video cannot execute script. |
| `font-src` | `'self' data:` | `next/font` serves the fonts from our own origin. |
| `connect-src` | `'self'`, the Supabase origin and its `wss:` twin, Paddle's API and Retain hosts | This is the exfiltration control. |
| `frame-src` | Paddle checkout and Retain frames (production and sandbox) | The Buy credits overlay. |
| `object-src` | `'none'` | |
| `base-uri`, `form-action` | `'self'` | |
| `frame-ancestors` | `'none'` | Same as the header `next.config.ts` already sends (BR-S-007). |

Every page is already rendered per request (the root layout reads cookies for
the locale), so the nonce does not make any page dynamic that was not already.

The signed media file route (`/api/media/file/…`) gets no policy from the
middleware. It keeps its own, stricter one (`default-src 'none'; sandbox`).

## The switch

| `CSP_MODE` | Header sent | Effect |
|---|---|---|
| unset, empty, `report-only`, or anything unrecognised | `Content-Security-Policy-Report-Only` | Violations are reported, nothing is blocked. **This is the default.** |
| `enforce` | `Content-Security-Policy` | The same policy is enforced. |
| `off` | none (only `frame-ancestors 'none'` from `next.config.ts`) | Escape hatch if enforcement breaks something in production. |

`CSP_REPORT_URI` (optional, an absolute `https://` URL) adds `report-uri` and a
`Reporting-Endpoints` header, so violations reach a collector instead of only
the visitor's console. Anything else in that variable is ignored.

Both are read per request, not baked into the build. On the self-hosted box
they are repository variables mapped by `deploy_web.yml` (`vars.CSP_MODE`,
`vars.CSP_REPORT_URI`) into the server env file, so a restart of `web` is
enough. On Vercel they are project environment variables, which take effect
on the next deployment.

### Turning enforcement on

1. Deploy with the default (report-only), ideally with `CSP_REPORT_URI` set.
2. Use the site for a few days: sign in, open Studio, the editor, the library,
   buy credits (Paddle overlay), the pricing page in the production Paddle
   environment (Paddle Retain loads only there).
3. If no report names a directive other than an injected test, set
   `CSP_MODE=enforce` and restart. If something breaks, `CSP_MODE=report-only`
   and a restart puts it back.

## How it was checked

A production build (`next build` and `next start`) against a read-only fake
Supabase and Paddle's sandbox, in headless Chromium, on the landing page,
login, sign-up, pricing, privacy, terms, the API docs, and the signed-in shell
(home, studio, videos, library, editor, credits with the Paddle overlay open,
developers, styles, channels, command center, welcome). This was done in both
modes. Result: no violations. Paddle.js loaded, the checkout frame opened, and
the Supabase realtime websocket connected. A positive control (an injected
`onerror` handler and a `fetch` to another origin) was reported in report-only
mode and blocked in enforce mode.

# Second factor at sign-in, and the admin gate

Status: code merged with the gate in `warn` (nothing is blocked for an admin by
default). The owner turns on `enforce` by hand, after the steps below.
Ledger rows: BR-S-015 (sign-in never asked for the code), BR-S-016
(`isOperator()` failed open), BR-S-017 (operator POST routes had no Origin check).
Hardening round 2 (PR A, no migration): BR-S-018 (same-origin on every mutating
route), BR-S-019 (body caps), BR-S-020 (secret and variable value checks, rate
limit, recent-code step-up), BR-S-021 (session cookie), BR-S-022 (neutral sign-up),
BR-S-023 (strict `enforce`: factor-less admins may only enrol), BR-S-024 (Team
page last-owner guard). See "Hardening round 2" at the end.

## What changed

Before: a user could enrol an authenticator app at `/security`, but nothing ever
asked for the code. A password alone made a session the whole site accepted as
platform admin. Enrolling protected nothing.

Now the application asks for the code. It does not depend on a Supabase project
setting.

1. **Sign-in step for every account that enrolled an authenticator.**
   Password sign-in, "Continue with Google" and e-mailed confirmation links
   make a password-class session (`aal1`). An account with a *verified* TOTP
   factor is sent to `/login/verify` and is not let into the app until the code
   makes the session `aal2`. Accounts that never enrolled are never asked
   anything. The page handles a wrong code, an expired challenge, too many
   tries, a factor removed elsewhere, a network failure and a missing factor
   list, in English, Russian and Uzbek, and always has a sign-out. With two
   enrolled authenticators the person picks which one.
2. **The gate for the operator (platform owner/admin).** A server-side check,
   `NIGHTSHIFT_ADMIN_MFA`, decides what an operator on a password-only session
   may do. It runs in the middleware (every page and API call), again in the
   app layout, and again in the operator guards (`requireOperator`,
   `guardOperatorPage`) and the nine operator POST routes.
3. **`isOperator()` fails closed** (see "Fail-closed operator check").
4. **Same-origin check on the operator POST routes** (see below).

## The switch: `NIGHTSHIFT_ADMIN_MFA`

Read on every request, so a restart is enough. The value is trimmed and
lower-cased, so ` Enforce ` is `enforce`. Anything that is not `off` or `enforce`
after that (unset, empty, a typo such as `enforced`) is `warn`.

| Mode | Operator on a password-only session, **with** a verified factor | Operator, **no** factor | Everyone else |
|---|---|---|---|
| `off` | passes | passes | passes, and nobody is asked for a code at all |
| `warn` (default) | passes; banner "enter your code" on every admin page; a server-side warning is logged | passes; banner "add an authenticator" linking `/security` | **enrolled account: challenged at sign-in** (`warn` only relaxes the *admin*); never enrolled: untouched |
| `enforce` | pages redirect to `/login/verify`; API routes answer `401 {"error":"mfa_required"}` | **may open `/security` and nothing else** (strict, see below): pages redirect to `/security` with the banner; API routes answer `403 {"error":"mfa_enrol_required"}` | same as `warn` |

An `aal2` session passes in every mode.

### The lockout-safety rule

**An admin is never left with nothing to do.** A session is blocked outright only
when its account has a verified second factor, because there is then a code that
unblocks it. An admin with no factor is never blocked in `off` or `warn`: they see
a banner pushing them to enrol at `/security`. In `enforce` they are restricted,
not locked out (see "Strict `enforce`"): `/security` stays reachable, and
enrolling there is the way out. So merging this, or setting `enforce` before
enrolling, cannot lock out an admin who has no authenticator yet; at worst they
are sent to `/security`. The decision is one pure function (`mfaDecision` in
`command-center/lib/security/admin-mfa.ts`) that every layer asks, and its whole
truth table is a test. Anything unreadable (the level, the admin lookup) leans
toward asking for the code, never toward skipping it.

What the rule does *not* protect against: an admin who has a factor and loses
the device. That is the break-glass case below.

## The owner's steps

Do them in this order. Do not skip to step 5.

1. Merge and deploy this change. Nothing is blocked for you: `warn` is the
   default and you only see the banner. (This is not "nothing changes" for the
   site: any customer who has already enrolled an authenticator is now asked for
   the code at sign-in, in `warn` as well. The live database had no enrolled
   factor when this was written.)
2. **Enrol your factor before anything else.** While the owner account has no
   verified factor, someone who steals the password can sign in, enrol *their
   own* authenticator on your account, and then they are the one holding the
   second factor. Open `/security` and enrol an authenticator app now, and confirm
   the 6-digit code so it shows as verified.
3. Enrol a **second** factor on a second device (or a second authenticator on a
   password manager). Write both setup keys down offline. There are no recovery
   codes in the app: a lost device is recovered with the second factor, then
   break-glass.
4. Sign out and sign in again from each device. Each time you must reach
   `/login/verify` and get in with the code. Do it on more than one day.
5. Set the repository variable `NIGHTSHIFT_ADMIN_MFA` to `enforce`
   (GitHub, Settings, Variables, the one `deploy_web.yml` maps into the server
   env file) and redeploy, or restart `web` after changing the server env file.
6. Check: with a fresh private window, sign in with the password only and
   *do not* enter the code: you must be stopped at `/login/verify`, and a direct
   visit to `/chronos/billing` must bounce back to it.

## Break-glass

### How Supabase behaves (and what to confirm)

Once an account has a verified factor, GoTrue (`internal/api/mfa.go` in
supabase/auth) wants an `aal2` session to **unenroll** a verified factor, and the
JavaScript reference says the same for unenroll. By the same code path, enrolling
a *new* factor also needs `aal2` once a verified factor exists. That is what
protects an enrolled account from a password-only attacker adding their own
factor. It means a password-only session cannot remove a lost factor and cannot
add a replacement. **The live GoTrue behaviour has not been tested; the owner
should confirm it once** (with an enrolled test account on a password-only
session, try to enrol a second factor at `/security` and expect a refusal). Until
that is confirmed, treat "an attacker with only the password cannot add a factor
to an account that already has one" as expected, not proven.

### You lost every device

Setting `NIGHTSHIFT_ADMIN_MFA=off` is **not enough on its own**. It switches off
only this application's gate (the middleware, the layout banner, the code page).
It does not touch the factor: the account still has a verified factor, your
password session is still `aal1`, and Supabase will still refuse to unenroll the
factor or enrol a new one from it. So:

1. **Primary path, in the Supabase dashboard SQL editor** (your dashboard account
   is the root of trust; protect it with a hardware key):
   ```sql
   select id, friendly_name, status from auth.mfa_factors
   where user_id = (select id from auth.users where email = '<owner e-mail>');
   delete from auth.mfa_factors where id = '<lost factor id>';
   ```
   Delete only the factor(s) you lost. With no verified factor left, the account
   is an ordinary password account again: the code page is skipped and the gate
   has nothing to ask. (The deleted factors' sessions are not signed out for you;
   sign out of other sessions afterwards.)
2. Sign in with the password, **enrol a new factor at `/security` immediately**
   (see "enrol your factor before anything else" above: until you do, anyone with
   the password could enrol theirs).
3. Only if the code page itself misbehaves while factors are fine: set the
   repository variable `NIGHTSHIFT_ADMIN_MFA` to `off` and redeploy (the deploy
   overwrites the server env file, so editing the file on the box does not
   stick). The app then asks nobody for a code, `/login/verify` sends you
   straight on, and you can reach `/security`. Set it back to `warn`, then
   `enforce`, when fixed.
4. If you cannot sign in with the password at all, that is not this gate: use the
   Supabase dashboard (password reset).
5. After any break-glass: change the password, sign out of other sessions, and
   check who else was signed in.

`off` is for emergencies. It also turns off the code for ordinary enrolled
customers while it lasts.

## Fail-closed operator check

`isOperator()` (the question behind the operator console, `requireOperator` and
`guardOperatorPage`) used to treat "the organizations function is missing"
(`PGRST202`/`42883` from `my_organizations()`) as "this database predates the
organizations migration, so every signed-in member is the operator's team". In
production that answer can only be a failure (a stale schema cache, a dropped
grant, a bad migration), and it made every signed-in account the operator for
the pages that spend the server's GitHub token. Now, in a production build, a
missing function is "unavailable" like any other lookup error and the answer is
no. Development and tests keep the old reading, so a local database without the
migration still works. A normal signed-in user is not an operator when the
lookup errors.

## Same-origin check on operator POST routes

The existing `isSameOriginPost` (also used by sign-up, invite, review links and
others) now guards these nine routes, after authentication and before anything
is read or changed: `alerts/test`, `billing/refresh`, `billing/settings`,
`billing/topup`, `models/availability`, `setup/secrets`, `setup/variables`,
`setup/voices`, `voices/preview`. A request without our own `Origin` (or with
`Sec-Fetch-Site` other than `same-origin`) is `403 {"error":"forbidden"}`. The
browser sends `Origin` on every POST our pages make, so the site is unaffected.
Anything that called these routes without a browser (a script with only a
cookie) must now send `Origin: https://<your domain>`. Routes that already
used the helper were not touched.

## Hardening round 2 (PR A, no migration)

Every item below is application-layer only. Flags: only `NIGHTSHIFT_ADMIN_MFA`
(existing) and one optional window, `NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES`. Items
marked "always on" have no switch; to undo one, revert the PR.

### Strict `enforce`: a factor-less admin may only enrol (BR-S-023)

Gated by `NIGHTSHIFT_ADMIN_MFA=enforce`; `warn`, `off` and any typo behave exactly
as before.

While the owner account has no authenticator, anyone with the password can enrol
their own and become the only holder. `enforce` used to do nothing about it
(lockout safety). Now, in `enforce` only, an admin (platform owner/admin) whose
account has **no verified factor** and whose session is password-only:

- may open `/security` (and `/<channel>/security`, which is where the middleware
  sends `/security`), where the enrolment lives, and may sign out;
- is sent to `/security` from every other page, with the enrol banner;
- gets `403 {"error":"mfa_enrol_required"}` from every API route, including the
  nine operator POST routes and `requireOperator()`.

Why it cannot lock the owner out:

- Enrolment and sign-out talk to the auth server straight from the browser
  (`supabase.auth.mfa.*`, `supabase.auth.signOut()`), not through this app, so no
  route here is in their way. The only app page needed is `/security`, and it is
  the one page the restriction leaves open (a path test with no loose matching:
  `/security` or `/<one segment>/security`).
- After the first factor is verified the session is `aal2` and the restriction
  ends at once; the next sign-in then asks for the code like any enrolled admin.
- The admin lookup that decides this is one `is_platform_admin` call, remembered
  for a minute per user per server process. If that call fails, nobody is
  restricted (it is a tightening on top of the other layers, never a reason to
  block a customer). Customers with no factor cost the same single cached call
  in `enforce` and are never restricted.
- Undo: `NIGHTSHIFT_ADMIN_MFA=warn` (or `off`) and a restart of `web`.

**Before you set `enforce`**, enrol first (steps 2-4 above). If you set it first
you will simply land on `/security`; enrol there.

### Recent-code step-up for credential writes (BR-S-020)

Gated by `NIGHTSHIFT_ADMIN_MFA=enforce`; `warn`/`off` never ask.

`POST /api/setup/secrets` and `POST /api/setup/variables` (keys, the alert
webhook and addresses, the pipeline's routing) additionally require that the
session's authenticator code was typed recently. Supabase records each sign-in
method with a timestamp in the access token (`amr`); a token refresh keeps the
TOTP entry. In `enforce`, an `aal2` session whose last code is older than the
window gets `401 {"error":"mfa_recent_required"}` and the Providers board shows
"confirm your authenticator code again: sign out, sign in and enter the code".

- Window: `NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES` (default 480 = 8 hours, clamped to
  5 minutes .. 24 hours; junk means the default). Read per request. It is a repository variable mapped by `deploy_web.yml` (`vars.NIGHTSHIFT_ADMIN_MFA_RECENT_MINUTES`,
  unset = default) and listed in `deploy/.env.web.example`.
- Lockout-safe by design: a timestamp that cannot be read is never "stale"; only an
  `aal2` session is judged (a password-only session with a factor is already sent
  to the code page; an account with no factor has no code to ask); the way through
  is always sign out, sign in, type the code, which is a fresh timestamp. It never
  affects sign-in or any page, only these two writes.

### Value checks, rate limit and a log line on those routes (BR-S-020, always on)

`lib/server/secret-validators.ts`: a value is checked against its NAME before
GitHub is called, and nothing is written unless every value in the request passes.
A refused value answers `400 {"error":"bad_value","name":"...","reason":"..."}`
(the reason is a code such as `bad_host`, `bad_email`, `forbidden_chars`; never the
value or any part of it).

| Name | Accepted |
|---|---|
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/services/T../B../token` (also `hooks.slack-gov.com`); no port, query, fragment, userinfo, whitespace or env syntax |
| `RESEND_API_KEY` | `re_` + token |
| `YOUTUBE_CHANNEL_ID` | `UC` + 22 url-safe characters |
| `YOUTUBE_TOKEN_JSON`, `CHRONOS_YT_TOKEN_*` | a JSON object with a `refresh_token`; any `token_uri` / `auth_uri` / `revoke_uri` in it must be an `https` Google host (the pipeline posts the refresh token and client secret to `token_uri`). Written in **compact** form (`JSON.stringify(JSON.parse(raw))`, one line); refused if the compact form still holds `$` or ` #` |
| `YOUTUBE_CLIENT_SECRET_JSON` | a JSON object with an `installed` or `web` section holding `client_id` and `client_secret`; same endpoint rule |
| every other provider key | one printable-ASCII token of 8-4096 characters: no whitespace, `$`, backtick, quotes or backslash |
| `ALERT_EMAIL_TO` | exactly one address |
| `ALERT_EMAIL_FROM` | one address, or `Display Name <address>`; the display name is 1-60 characters of letters, digits, space, `.`, `_` and `-` only (no quotes, commas, `@`, `<` or `>`), the address is the same plain form as `ALERT_EMAIL_TO` |
| `CHRONOS_VIDEO_PROVIDER`, `CHRONOS_IMAGE_PROVIDER` | the closed lists (`VIDEO_PROVIDERS`, `IMAGE_PROVIDERS`), case-folded |
| the `CHRONOS_ENABLE_*` / `CHRONOS_AGENT_AUTOPILOT` switches | `0 1 true false yes no on off` |

`$`, a line break, a leading quote or ` #` in a value that goes into the server
env file or the worker env file would make `deploy_web.yml` (and
`deploy/build-service-env.py`, whose `clean()` refuses exactly those) refuse every
deploy; the validators refuse them first. For that reason the Google OAuth JSON
secrets are written in compact one-line form, so a pasted pretty-printed token cannot
carry a line break into an env file. An empty variable value is still allowed (it is
how a variable is cleared).

Writes are rate limited per person in process memory (`secret-write.ts`): secrets
20 per 10 minutes, variables 40 per 10 minutes, the wizard's YouTube key check 30
per 10 minutes; `429 {"error":"rate_limited"}` with `retry-after`. The limiter
never refuses because of an infrastructure error, so it cannot lock anyone out.

Each name written or refused logs one server line, e.g.
`[admin-write] secret user=1a2b3c4d name=GEMINI_API_KEY outcome=accepted` or
`... outcome=rejected reason=forbidden_chars`: who (a user-id prefix), which NAME and
the outcome (the reason is the same code the 400 carries). Nothing derived from the
value is logged: no hash, no length, no prefix (`CLAUDE.md`, non-negotiable 1), and
the 400 body carries only the name and the reason code. The existing
`secret.write` / `variable.write` audit rows still hold names only.

`POST /api/setup/youtube` (the wizard's "verify channel" key check) was checked
for being an open relay: it is **not** operator-only on purpose, because a customer
organization's admin adds a channel with the same wizard and types their own
key. The host is fixed (`www.googleapis.com`), the key is the caller's own, nothing
is stored and only public channel facts come back. It now has the same-origin
check, a body cap and the per-person limit above.

### Same-origin on every mutating route (BR-S-018, always on)

`requireSameOrigin()` (`lib/server/same-origin.ts`) wraps the handler with the
existing `isSameOriginPost` check: an `Origin` that is ours (the configured
`APP_ORIGIN`, or the request's own origin), and `Sec-Fetch-Site: same-origin` when
the browser sends it. A missing, `null`, foreign or cross-site Origin is `403
{"error":"forbidden"}` before the handler reads anything. It is on all about 55
cookie-authenticated POST/PUT/PATCH/DELETE routes. Excluded, each with its reason
in `tests/same-origin-routes.test.ts` (`MACHINE_TO_MACHINE`): `/api/v1/*` (bearer
API key), `/api/mcp` (OAuth bearer), `/oauth/token|register|revoke` (called
server-to-server), `/oauth/decision` (its own stronger check),
`/api/email/unsubscribe` (a mail program posts the RFC 8058 one-click with no
Origin; the token is the authority). `/api/pv`, `/api/handle-available`,
`/api/invite/join`, `/api/avatar`, review links and `/auth/callback` already had
the check. Same-origin `fetch` from the PWA and the Mobile view always sends
`Origin`, so the site is unaffected; a script that called a cookie route without a
browser must now send `Origin: https://<your domain>`. The test fails for any new
mutating route that has neither the check nor an allow-list entry.

One leniency: the XHR upload `PUT /api/media/uploads/<ticket>` (`MediaLibrary.tsx`) accepts a request with **no** `Origin` header, but only when the browser itself sends `Sec-Fetch-Site: same-origin` (a header a page cannot forge or remove); `Origin: null`, a foreign Origin, and a missing Origin without that header are still `403` (`allowMissingOriginWhenSameOrigin`, used by that one route, pinned by a test).

### Body caps (BR-S-019, always on)

`parseJsonCapped(request, maxBytes)` (`lib/server/json-body.ts`) replaces
`request.json()` in every route and helper that parsed a body: 64 KB by default,
256 KB for saved workflows, the existing 2x document cap for the editor. Over the
cap, or not JSON, throws where `request.json()` used to throw, so every route
keeps its existing 400. A declared length over the cap is refused before a byte
is read; a body with no length or a false one is cut off and the upload cancelled.

The Paddle Edge Function now reads its body with `readBodyCapped` (1 MB, the
handler's existing limit) **before** it verifies the signature. This is the only
change under `supabase/functions/`; the function is deployed by hand:
`supabase/functions/_shared/paddle.ts` and `supabase/functions/paddle-webhook/index.ts`
(redeploy with `supabase functions deploy paddle-webhook --no-verify-jwt`). Not in
this change: a Caddy `request_body { max_size ... }` (a deploy-file change for the
supervisor to decide, except `/api/media/uploads/*`).

### Session cookie (BR-S-021, always on)

`@supabase/ssr` 0.5.2 writes the session cookie as `{ path: "/", sameSite: "lax",
httpOnly: false, maxAge: 400 days }` and **ignores** a `maxAge` passed in
`cookieOptions` (its storage code sets `maxAge` from its own constant after
spreading the options; only `secure`, `sameSite`, `path` and `domain` survive; a
test pins this). So the options are hardened where each cookie is actually
written, in `setAll` of the server client, the middleware and the browser client
(`lib/supabase/cookie-options.ts`):

- `Secure` in a production build (not in `next dev`/tests, so `http://localhost`
  keeps working; Chrome and Firefox accept a Secure cookie on localhost, Safari
  does not, so test a production build over https);
- `SameSite=Lax`, never `None`;
- 30 days instead of 400, **rolling**: every token refresh (about hourly while the
  site is in use) rewrites the cookie with a fresh 30 days, so an active session
  never expires and an abandoned browser stops being signed in after 30 days. A
  deletion (`maxAge` 0) is left alone. The real session life is still the Supabase
  refresh token.
- `httpOnly` **stays off**: the browser client (sign-in, factor enrolment, Realtime)
  reads the session from `document.cookie`, and an HttpOnly cookie would make every
  one of them see "signed out".

A test drives a real `@supabase/ssr` server client through a token refresh and
checks that the cookies it writes leave hardened, so session refresh still works.
Existing browsers keep their old 400-day cookie until the next refresh rewrites it.

**CSP stays as it is** (`CSP_MODE` unset = Report-Only): that is the owner's
decision. Because the cookie is script-readable, these must be true before
`CSP_MODE=enforce` (see also `CSP.md`, "Turning enforcement on"): (1) a few days of
real use with `CSP_REPORT_URI` set shows no report naming a directive other than an
injected test; (2) every page the owner and a customer use was opened in report-only
(sign-in, Studio, editor, library, Paddle overlay, the Paddle Retain page in
production, `/security` enrolment); (3) `CSP_MODE=report-only` plus a restart is the
tested way back, so it is known before the switch; (4) `img-src https:` is accepted
as a dangling-markup channel or narrowed to known hosts first.

### Neutral sign-up (BR-S-022, always on)

An address that already has an account sees the same "check your email" screen as a
new one (`neutralSignupOutcome`); the screen says "if an email for <address> is on
its way ..." and "already have an account? sign in instead" for everyone. No new
e-mail flow was built: the notice e-mail to the existing owner is not sent.
Residual: with "Confirm email" OFF in the Supabase project a new address is signed
in at once, so the two cases still differ (the live project has confirmation on).

### Team page last-owner guard, app layer only (BR-S-024, always on)

The page no longer offers (and refuses) demoting or removing the only bound owner
(`lib/members-guard.ts`). Anyone writing `app_members` directly bypasses it; the
database guard (`owner_set_member_role` / `remove_member` refusing to leave zero
owners, owner-only admin minting) needs a migration and is not in this change.

### What is NOT in PR A

Migration items: S-1 (the database ignores the second factor; `admin_aal_ok()`,
restrictive policies, `grant_credits` wrapper), S-5 (roster, price, factor and
grant audit; `security_events`), S-6 (free-credit farming, CAPTCHA), S-7 (sign-out
everywhere, spend ceiling for the exempt org), B-05 database half. Also not done:
`CSP_MODE=enforce`, the Caddy body cap, a way to tell a replaced value from a re-saved one (any hash
of a value is derived from the secret, so none is logged or stored), a `/login/verify`-style in-place step-up page (the
step-up asks for a fresh sign-in instead).

## What this does NOT do

- **It does not stop a person with the password from calling the database
  directly.** Supabase's REST API accepts an `aal1` token. The roster, the price
  list, provider billing and credit grants are written by the browser straight to
  Supabase under row-level security, which does not look at the assurance level.
  Closing that needs the database backstop (a migration: `admin_aal_ok()` in
  `platform_role()` and restrictive write policies, flag off by default). It is
  the next step (a separate change with a migration), deliberately not in this one.
  Until then `enforce` protects the site and the server routes, not the
  database.
- It does not stop a stolen *aal2* session cookie (see CSP, BR-S-008).
- It does not stop real-time phishing of a code.
- The MCP/OAuth and public API doors authenticate by their own tokens.
- A rate limit exists on the secret, variable and key-check routes only (see above), not on admin routes in general.

## Where the code is

| What | File |
|---|---|
| The decision and the mode | `command-center/lib/security/admin-mfa.ts` |
| Reading the session's state (factors from the auth server, never from the cookie) | `command-center/lib/security/admin-mfa-server.ts` |
| Middleware check | `command-center/lib/security/mfa-middleware.ts`, `command-center/middleware.ts` |
| Sign-in step | `command-center/app/login/page.tsx`, `command-center/app/login/verify/page.tsx`, `command-center/components/auth/MfaChallenge.tsx`, `command-center/lib/security/challenge.ts`, `command-center/app/auth/callback/route.ts` |
| Operator guards and banner | `command-center/lib/auth/org-roles.ts`, `command-center/app/(app)/layout.tsx`, `command-center/components/security/AdminMfaBanner.tsx` |
| POST guard | `command-center/lib/server/admin-post-guard.ts` |
| Strict enforce path test, enrol-only decision | `command-center/lib/security/admin-mfa.ts` (`isEnrolOnlyPath`), `lib/security/mfa-middleware.ts` |
| Recent-code step-up | `command-center/lib/security/recent-mfa.ts`, `lib/security/admin-mfa-server.ts` (`requireRecentMfa`) |
| Value checks, rate limit, log line | `command-center/lib/server/secret-validators.ts`, `lib/server/secret-write.ts` |
| Same-origin wrapper, body cap | `command-center/lib/server/same-origin.ts`, `lib/server/json-body.ts` |
| Session cookie | `command-center/lib/supabase/cookie-options.ts` |
| Tests | `command-center/tests/admin-mfa-gate.test.ts`, `mfa-middleware.test.ts`, `mfa-challenge.test.tsx`, `mfa-verify-page.test.tsx`, `org-roles-mfa.test.ts`, `admin-post-origin.test.ts`, `auth-callback-mfa.test.ts`, and for round 2 `same-origin-routes.test.ts`, `secret-validators.test.ts`, `secret-routes.test.ts`, `recent-mfa.test.ts`, `cookie-options.test.ts`, `middleware-cookies.test.ts`, `json-body-capped.test.ts`, `members-guard.test.ts`, the Paddle cases in `paddle-webhook.test.ts` |

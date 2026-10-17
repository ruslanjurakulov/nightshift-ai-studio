# Second factor at sign-in, and the admin gate

Status: code merged with the gate in `warn` (nothing is blocked for an admin by
default). The owner turns on `enforce` by hand, after the steps below.
Ledger rows: BR-S-015 (sign-in never asked for the code), BR-S-016
(`isOperator()` failed open), BR-S-017 (operator POST routes had no Origin check).

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

Read on every request, so a restart is enough. Anything other than exactly
`off` or `enforce` (unset, empty, a typo) is `warn`.

| Mode | Operator on a password-only session, **with** a verified factor | Operator, **no** factor | Everyone else |
|---|---|---|---|
| `off` | passes | passes | passes, and nobody is asked for a code at all |
| `warn` (default) | passes; banner "enter your code" on every admin page; a server-side warning is logged | passes; banner "add an authenticator" linking `/security` | enrolled account: challenged; never enrolled: untouched |
| `enforce` | pages redirect to `/login/verify`; API routes answer `401 {"error":"mfa_required"}` | passes; same banner as `warn` | same as `warn` |

An `aal2` session passes in every mode.

### The lockout-safety rule

**A session is only ever blocked when its account has a verified second factor.**
There is then a code that unblocks it. An admin with no factor is never blocked,
in any mode: they see a banner pushing them to enrol at `/security`. So merging
this, or setting `enforce` before enrolling, cannot lock out an admin who has no
authenticator yet. The decision is one pure function (`mfaDecision` in
`command-center/lib/security/admin-mfa.ts`) that every layer asks, and its whole
truth table is a test. Anything unreadable (the level, the admin lookup) leans
toward asking for the code, never toward skipping it.

What the rule does *not* protect against: an admin who has a factor and loses
the device. That is the break-glass case below.

## The owner's steps

Do them in this order. Do not skip to step 5.

1. Merge and deploy this change. Nothing changes for you: `warn` is the default,
   you only see the banner.
2. Open `/security` and enrol an authenticator app. Confirm the 6-digit code so
   it shows as verified.
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

You lost both devices, or the code page misbehaves and you cannot get in:

1. Set `NIGHTSHIFT_ADMIN_MFA` to `off` (the repository variable, then redeploy;
   the deploy overwrites the server env file, so editing the file on the box does
   not stick).
2. Sign in with the password. `/login/verify` sends you straight on, and nothing
   asks for a code anywhere while the mode is `off`.
3. At `/security` remove the lost factor, enrol new ones, then set the variable
   back to `warn` and later `enforce`.
4. If you cannot even sign in with the password, that is not this gate: use the
   Supabase dashboard (password reset, or `delete from auth.mfa_factors where
   id = '…'` in the SQL editor for a lost factor).
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
- No rate limit or lockout was added to admin routes.

## Where the code is

| What | File |
|---|---|
| The decision and the mode | `command-center/lib/security/admin-mfa.ts` |
| Reading the session's state (factors from the auth server, never from the cookie) | `command-center/lib/security/admin-mfa-server.ts` |
| Middleware check | `command-center/lib/security/mfa-middleware.ts`, `command-center/middleware.ts` |
| Sign-in step | `command-center/app/login/page.tsx`, `command-center/app/login/verify/page.tsx`, `command-center/components/auth/MfaChallenge.tsx`, `command-center/lib/security/challenge.ts`, `command-center/app/auth/callback/route.ts` |
| Operator guards and banner | `command-center/lib/auth/org-roles.ts`, `command-center/app/(app)/layout.tsx`, `command-center/components/security/AdminMfaBanner.tsx` |
| POST guard | `command-center/lib/server/admin-post-guard.ts` |
| Tests | `command-center/tests/admin-mfa-gate.test.ts`, `mfa-middleware.test.ts`, `mfa-challenge.test.tsx`, `mfa-verify-page.test.tsx`, `org-roles-mfa.test.ts`, `admin-post-origin.test.ts`, `auth-callback-mfa.test.ts` |

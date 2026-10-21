# Continue with Google: owner setup (short, English)

The full Uzbek guide is `docs/GOOGLE_SIGNIN.md`. This is the checklist.

The button on `/login` and `/signup` hides itself until Supabase reports the Google provider as enabled (`GET <project>/auth/v1/settings`, `external.google === true`). The server asks while rendering the page and caches the answer for up to a minute, so the button is there from the first paint (no layout jump) and appears within about a minute of enabling the provider.

**There is no env variable, GitHub variable or `deploy_web.yml` change for this, on purpose.** A `NEXT_PUBLIC_*` flag is inlined when the web image is built, so flipping it would need a rebuild and a deploy, and it could disagree with the provider (flag on, provider off: a dead button). The provider switch in Supabase is the single switch. If a flag is ever wanted anyway, it is a server-side `GOOGLE_SIGNIN_ENABLED` key added to `deploy/.env.web.example`, mapped in `deploy_web.yml`, and ANDed with the settings answer in `lib/server/google-enabled.ts`.

The consent line ("By continuing you agree to the Terms of Service and Privacy Policy.", en/ru/uz) is under the button on both pages: with sign-ups open, a Google address that has no account yet gets one from `/login` as well, and neither page goes through the sign-up form's checkbox.

Values that come from the code:

| Value | Where |
| :-- | :-- |
| App callback path `/auth/callback` (the button adds `?next=<path>&provider=google`) | `lib/public-paths.ts` `AUTH_CALLBACK_PATH`, `lib/google-signin.ts` `googleRedirectTo` |
| Scopes: `openid`, `email`, `profile` only | Supabase default; the code asks for no more |
| Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback` | For the production project (ref `kgqzdjttlnhrxrlqxqge`): `https://kgqzdjttlnhrxrlqxqge.supabase.co/auth/v1/callback`. Confirm it against Supabase, Authentication, Sign In / Providers, Google, "Callback URL (for OAuth)" before pasting it into Google. |

1. Google Cloud Console, create or pick a project.
2. Google Auth Platform (APIs & Services, OAuth consent screen): External; app name Nightshift; support and developer email; home page `https://nightshift-ai.studio`, privacy `https://nightshift-ai.studio/privacy`, terms `https://nightshift-ai.studio/terms`; authorized domains `nightshift-ai.studio` and `supabase.co`; scopes only openid/email/profile; publish to production.
3. Google Auth Platform, Clients, Create client (older console: APIs & Services, Credentials, Create credentials, OAuth client ID), type **Web application** (a separate client from the YouTube-connect one). Authorized JavaScript origins `https://nightshift-ai.studio`. Authorized redirect URI: exactly `https://kgqzdjttlnhrxrlqxqge.supabase.co/auth/v1/callback`, and only that one (the app's own `/auth/callback` is NOT a Google redirect URI: Google returns to Supabase, Supabase returns to the app). Create; copy Client ID and Client secret.
4. Supabase Dashboard, Authentication, Sign In / Providers, Google: enable, paste Client ID and Client secret (the secret goes nowhere else: not chat, git or `.env`), Skip nonce checks off, Save.
5. Supabase, Authentication, URL Configuration: Site URL `https://nightshift-ai.studio`; Redirect URLs `https://nightshift-ai.studio/auth/callback` and `https://nightshift-ai.studio/**` (keep the existing entries). The button sends `redirectTo = <the page's own origin>/auth/callback?next=<path>&provider=google`, so every origin you sign in from needs an entry: `http://localhost:3000/**` for local work, and, only if you run a Vercel preview (this repo's production is the Docker server, and `vercel.json` disables deployments for `claude/**` branches), that preview's exact origin, for example `https://<preview-host>.vercel.app/auth/callback`. A redirect URL that is not on the list makes Supabase fall back to the Site URL (you land on the landing page, signed in nowhere).
5b. Web deploy: nothing to set (see above). `APP_ORIGIN` must already be the public origin (`docs/SIGNUP_SETUP.md`).
6. Supabase, Sign In / Providers, Email: Confirm email ON, Secure email change ON, Secure password change ON, Allow new users to sign up ON; Allow manual linking OFF.
7. Test (first: the button must appear on `/login` within a minute or two; it also stays hidden if the settings request fails, e.g. the server cannot reach Supabase or the browser console shows a CORS error, so always confirm it appears. With sign-ups disabled, new Google users end on `/login?error=google_failed`): new Google account from `/signup` (lands on `/welcome`, 100 credits after creating the workspace); sign out and back in from `/login`; an existing email+password account with the same Gmail address signs in as the same account; Cancel on Google's screen shows a calm message on `/login`; forgot password still works; the pre-account takeover test in `docs/GOOGLE_SIGNIN.md` section 3, item 5 (must pass before you leave Google on).
8. Rollback: Supabase, Providers, Google, switch off. The button disappears on its own within about a minute; email sign-in is untouched. A click in that last minute reaches Supabase's own "provider is not enabled" JSON page (the browser leaves our site for it, so the app cannot translate it); it clears when the cached answer expires.

Who can sign in and as what: Supabase keeps a Google session only for an address Google says is verified, and the callback checks again (`email_verified === true` on the Google identity and `email_confirmed_at` on the user) and signs out otherwise. The platform-admin roster (`app_members`, matched by e-mail for invited admins) reads `auth.users.email_confirmed_at` through `my_confirmed_email()`, so a Google account whose address is not verified cannot match a roster row, and the owner's verified Gmail address signs in as the same platform admin as with a password (an account with an authenticator still goes through `/login/verify` first).

Known limit: an account created only with Google has no password; to set one use `/forgot-password`.

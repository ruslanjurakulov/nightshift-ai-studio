# Continue with Google: owner setup (short, English)

The full Uzbek guide is `docs/GOOGLE_SIGNIN.md`. This is the checklist.

The button on `/login` and `/signup` hides itself until Supabase reports the Google provider as enabled (`GET <project>/auth/v1/settings`, `external.google === true`). No env variable and no deploy is needed to turn it on.

Values that come from the code:

| Value | Where |
| :-- | :-- |
| App callback path `/auth/callback` (the button adds `?next=<path>&provider=google`) | `lib/public-paths.ts` `AUTH_CALLBACK_PATH`, `lib/google-signin.ts` `googleRedirectTo` |
| Scopes: `openid`, `email`, `profile` only | Supabase default; the code asks for no more |
| Supabase callback `https://<project-ref>.supabase.co/auth/v1/callback` | Copy it from Supabase, Authentication, Sign In / Providers, Google, "Callback URL (for OAuth)". The repo's `.env.example` holds only a placeholder URL. |

1. Google Cloud Console, create or pick a project.
2. Google Auth Platform (APIs & Services, OAuth consent screen): External; app name Nightshift; support and developer email; home page `https://nightshift-ai.studio`, privacy `https://nightshift-ai.studio/privacy`, terms `https://nightshift-ai.studio/terms`; authorized domains `nightshift-ai.studio` and `supabase.co`; scopes only openid/email/profile; publish to production.
3. Credentials, Create credentials, OAuth client ID, type Web application. Authorized JavaScript origins `https://nightshift-ai.studio`. Authorized redirect URI: the Supabase callback above. Create; copy Client ID and Client secret.
4. Supabase Dashboard, Authentication, Sign In / Providers, Google: enable, paste Client ID and Client secret (the secret goes nowhere else: not chat, git or `.env`), Skip nonce checks off, Save.
5. Supabase, Authentication, URL Configuration: Site URL `https://nightshift-ai.studio`; Redirect URLs `https://nightshift-ai.studio/auth/callback` and `https://nightshift-ai.studio/**`.
6. Supabase, Sign In / Providers, Email: Confirm email ON, Secure email change ON, Secure password change ON, Allow new users to sign up ON; Allow manual linking OFF.
7. Test: new Google account from `/signup` (lands on `/welcome`, 100 credits after creating the workspace); sign out and back in from `/login`; an existing email+password account with the same Gmail address signs in as the same account; Cancel on Google's screen shows a calm message on `/login`; forgot password still works; the pre-account takeover test in `docs/GOOGLE_SIGNIN.md` section 3, item 5 (must pass before you leave Google on).
8. Rollback: Supabase, Providers, Google, switch off. The button disappears on its own; email sign-in is untouched.

Known limit: an account created only with Google has no password; to set one use `/forgot-password`.

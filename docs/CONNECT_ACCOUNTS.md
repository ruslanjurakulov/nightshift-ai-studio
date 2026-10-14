# Connect an account, then pick

The Add channel screen has one button per platform: **Connect with Google**
(YouTube), **Connect Instagram**, **Connect TikTok**. After the platform's own
sign-in the person lands on a pick screen, presses once, and the account is
added. No channel id is ever typed.

The old way (create a channel, then press Connect on it) still works and is
unchanged: `/api/oauth/youtube/start?ref=<channel>` and the Connect buttons on
the Channels page. The hand-made wizard is kept on the same screen under
"Set up a channel by hand instead".

## What each platform can list

| Platform | What the pick screen shows | Why |
| :-- | :-- | :-- |
| YouTube | The channels `channels.list?mine=true` returns for the authorisation: avatar, title, @handle, subscriber count (or "hidden"), and "already connected" for a channel this workspace already has. | `youtube.readonly` is already one of the four scopes the flow asks for; nothing is widened. |
| Instagram | The one professional account that signed in, with a confirm button. | Instagram API with Instagram Login issues a token for the single account that logged in. Its `/me` is the only account endpoint on that login; there is no "list my accounts" call (that exists only on the Facebook Login variant, which this app does not use). |
| TikTok | The one account that authorised, with a confirm button. | Login Kit returns the authorising user only. |

### YouTube and Brand Accounts

Google issues a token for the identity chosen on **Google's own consent
screen**. A Brand Account's channel is picked there, so one authorisation
usually lists one channel (several only where that identity owns several). The
pick screen says so and offers "Use another Google account", which runs the
consent again with Google's account chooser. `managedByMe=true` is not usable:
it needs a YouTube content-owner partner relationship.

One authorisation is attached to **one** channel only. A token uploads as the
channel it was granted for, so attaching one token to several list entries
would aim videos at the wrong channel. To add a second channel, run the
consent again.

## What it does, step by step

1. **Start** (`/api/oauth/<platform>/start?pick=1`): refuses before the consent
   screen unless the caller may connect here (customer workspace: its
   administrators; the operator's own workspace: a platform administrator; Instagram and TikTok:
   anyone who may edit the workspace), and unless the server can save the result
   (OAuth app configured, token store available). Sets the CSRF nonce cookie as
   before. YouTube adds Google's account chooser.
2. **Callback**: the nonce is checked, the code exchanged, the scopes checked,
   and for YouTube `channels.list` is read. The result is **held on the server**
   (`lib/server/connect-pending.ts`) and the browser is sent to
   `/all-channels/channels/connect` with an opaque handle in an httpOnly cookie.
3. **Pick screen**: server-rendered from the held list. It receives names,
   avatars and counts; never a token, never the handle.
4. **Confirm** (`POST /api/connect/pending`): the browser sends only which
   listed account it means. The server re-checks the caller's role, checks the
   id is in the list held for that sign-in, then:
   - YouTube: `create_channel` (paused, linked to the YouTube channel), then
     the token through the existing store (Vault for a customer workspace via
     `store_channel_token`; the operator's repository secret as before).
   - Instagram / TikTok: `store_social_account`, as the classic callback does.

### The held sign-in

Held in the web server's memory, not in a table: ten minutes, single use, one
per person, bound to the signed-in person and the workspace being viewed, keyed
by the SHA-256 of the handle, at most 200 at a time. A restart, or a second web
replica answering the pick, shows "this sign-in has expired" and the person
connects again; it can never show a wrong account. The deployment is one
container behind Caddy; running several replicas would need sticky routing for
`/api/connect/*` and the pick page, or a shared store behind the same functions.
There is **no migration** for this feature.

## Audit

Existing actions only: `channel.youtube.connect`, `channel.youtube.connect_failed`,
`social.<platform>.connect`, `social.<platform>.connect_failed` (detail
`flow: "pick"`). Disconnect is unchanged (`channel.youtube.disconnect`,
`social.<platform>.disconnect`).

## Owner set-up (unchanged from before)

- Redirect URIs: the same callbacks as before, nothing new to register:
  `https://<domain>/api/oauth/youtube/callback`,
  `https://<domain>/api/oauth/instagram/callback`,
  `https://<domain>/api/oauth/tiktok/callback`.
- Env names: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `TIKTOK_CLIENT_KEY`,
  `TIKTOK_CLIENT_SECRET`, `APP_ORIGIN` (self-hosted), and for the operator's own
  workspace `GITHUB_SECRETS_TOKEN` / `GITHUB_SECRETS_REPO`.
- A Google OAuth app that is not verified for the YouTube scopes is limited to
  its test users and shows Google's "unverified app" warning (see
  `GOOGLE_OAUTH_VERIFICATION.md`). Instagram and TikTok apps need their review
  before anyone outside the test accounts can connect (see `SOCIAL_SETUP.md`).

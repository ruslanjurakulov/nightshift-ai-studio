/**
 * The public /trust page ("Trust and safety"). English is the source; ru.ts and uz.ts are typed against it, and
 * tests/trust-page.test.tsx holds the shapes, ids and {placeholders} equal.
 *
 * Every sentence was checked on the review date (lib/trust.ts TRUST_LAST_REVIEWED) against the code named beside it.
 * Change the code, change the sentence:
 *  - youtube.scopes: lib/server/google-oauth.ts YOUTUBE_OAUTH_SCOPES (one entry per scope, in that order); `google` is
 *    Google's own description from https://developers.google.com/identity/protocols/oauth2/scopes (read 2026-11-14);
 *    `why` from modules/youtube_uploader.py (captions), modules/playlist.py, modules/pinned_comment.py (the channel's
 *    first comment, switchable in the channel's risk settings), modules/comment_replies.py (a reply only after a
 *    person approved that text), modules/visibility_publish.py, modules/analytics_client.py. The monetary Analytics
 *    scope is opt-in for the operator's own CLI only (config.py) and is never requested by the site.
 *  - youtube.revoke: revoke_channel_token (migration 0022) and lib/channel-tokens.ts GOOGLE_PERMISSIONS_URL.
 *  - keys: lib/server/github-secrets.ts, app/api/setup/secrets, lib/server/model-keys.ts (rule 1); migrations 0022 and
 *    0028 (Vault, write-only); 0031 + 0040 (API keys kept as a SHA-256, no part of the key); app/oauth/authorize.
 *  - publishing: CLAUDE.md rule 2, config.YOUTUBE_PRIVACY, modules/channels.py effective_privacy (channels.auto_publish,
 *    migration 0004, default false), modules/publish_gate.py, migrations 0112 and 0116, docs/APPROVE_PUBLISH_1B.md,
 *    modules/social_publish.py (cross-posts on a person's request; TikTok SELF_ONLY; YouTube cross-posts private).
 *  - aiLabel: modules/ai_disclosure.py and docs/AI_DISCLOSURE.md (auto table, provenance_unknown labels, generic TTS not
 *    labelled, `never` only for platform administrators, migration 0114).
 *  - fallback: CLAUDE.md rule 4, modules/audio_mixer.verify_voice.
 *  - payments: the Refund Policy's "Failed generations" section (lib/legal-docs).
 *  - report: the contact address is lib/legal.ts LEGAL.contactEmail (never typed here).
 *  - real: lib/trust.ts SITE_DOMAIN, lib/site/social.ts SOCIAL, docs/GOOGLE_SIGNIN.en.md (Google returns to the sign-in
 *    service's supabase.co callback, then to the site).
 *
 * Words to keep out (tests): no AI provider or model name, no "owner"/"viewer", nothing on docs/news/banned-claims.json.
 */
export const trustEn = {
  meta: {
    title: "Trust and safety · Nightshift",
    description: "What Nightshift may do on your YouTube channel, how keys are handled, what goes public and when, and how to report a problem.",
  },
  /** The footer link's label (components/legal/PublicFooter.tsx). */
  footer: "Trust and safety",
  title: "Trust and safety",
  lead: "What Nightshift can and cannot do with your channel, your keys and your money, in plain words. Each line describes what the product does today.",
  reviewed: "Last reviewed {date}",
  toc: "On this page",
  nav: {
    youtube: "YouTube access",
    keys: "Your keys",
    publishing: "Publishing",
    "ai-label": "AI disclosure",
    "no-fallback": "No silent fallback",
    payments: "Payments and refunds",
    report: "Report a problem",
    real: "Is it really us?",
  },
  youtube: {
    title: "YouTube access",
    lead: "When you connect a channel, Google asks you to allow exactly the permissions below. Nightshift asks for no other YouTube permission, and if one of them is left unticked, nothing is stored and the channel is not connected.",
    caption: "The permissions Nightshift asks Google for",
    cols: { google: "In Google’s words", why: "Why Nightshift asks for it" },
    scopes: [
      {
        id: "youtube.upload",
        google: "Manage your YouTube videos",
        why: "To upload each finished video to your channel.",
      },
      {
        id: "youtube.readonly",
        google: "View your YouTube account",
        why: "To confirm which channel you connected before anything is stored, and to read your channel and its videos.",
      },
      {
        id: "youtube.force-ssl",
        google: "See, edit, and permanently delete your YouTube videos, ratings, comments and captions",
        why: "It is the permission Google asks for to add a caption track or put a video in a playlist. Nightshift also uses it to post the channel’s own first comment under an upload (you can switch that off in the channel’s settings), to post a reply only after a person approved that exact text, and, only on a channel where publishing when approved is switched on, to make an approved video public. Nightshift has no code that deletes a video, a comment or a caption.",
      },
      {
        id: "yt-analytics.readonly",
        google: "View YouTube Analytics reports for your YouTube content",
        why: "To show how your videos do: views, watch time and retention. Nightshift does not ask for the separate permission that shows revenue.",
      },
    ],
    privateTitle: "Uploads are private by default",
    privateBody: "Nightshift uploads each video to YouTube as private. Nightshift changes that only through the switches described under Publishing below, each off by default.",
    revokeTitle: "How to remove access",
    revoke: [
      "In Nightshift, open Channels and press Disconnect on the channel. The stored sign-in is destroyed at once and uploads stop.",
      "At Google, open {link}, choose Nightshift and remove its access.",
    ],
    revokeBoth: "Do both: disconnecting in Nightshift does not remove the permission at Google, and removing it at Google leaves Nightshift nothing to use.",
  },
  keys: {
    title: "Your keys and sign-ins",
    lead: "A key or a sign-in is never printed, logged or shown back, not even a part of it.",
    items: [
      {
        id: "setup",
        title: "Keys typed into the setup",
        body: "A key typed into Nightshift’s setup to run the pipeline is sealed on our server with the public key of the repository that runs it, written to that repository’s GitHub Actions secrets, and dropped. It is never written to our database, an event or a log line. A key pasted only to be checked is checked and then forgotten.",
      },
      {
        id: "channels",
        title: "Your channel’s sign-in",
        body: "The sign-in Google returns when you connect a channel is encrypted in Supabase Vault through a database function that can only write it. No page can read it back, not even yours; only the pipeline’s own worker uses it while it works on your channel. Instagram and TikTok connections are kept the same way.",
      },
      {
        id: "api",
        title: "Nightshift API keys",
        body: "An API key is shown once, when you create it. Nightshift keeps only a fingerprint of it (its SHA-256 hash), never the key or a part of it. A lost key cannot be shown again: revoke it and create a new one in Developers → API keys.",
      },
      {
        id: "assistants",
        title: "AI assistants",
        body: "An assistant you connect sends you to sign in on {domain} itself, not inside a chat. You choose what it may do and its monthly spending limit, and you can disconnect it at any time in Developers → Connected apps.",
      },
    ],
  },
  publishing: {
    title: "Publishing: nothing goes public without a person",
    lead: "Nightshift has never published anything publicly on its own, and these rules are why.",
    items: [
      "Every YouTube upload is private by default, on a scheduled run and a manual one alike.",
      "The publish check runs before every upload. It can stop an upload; it can never cause one.",
      "Auto publish is a per-channel switch, and it is off by default. Only while someone has switched it on may that channel’s runs upload with anything other than private.",
      "Approve records who approved which exact cut, for 24 hours. On its own it does not change the video’s privacy.",
      "Publish when approved is a second per-channel switch, also off by default. Only a signed-in person of the channel’s own workspace can turn it on, never the bot itself, and every change is recorded. On such a channel, once a person approves one exact cut of an uploaded private video, Nightshift may ask YouTube once to make that video public. Before it asks, it checks again that the cut, the publish check, the approval and the switch all still hold. It shows the video as published only when YouTube itself reports it public.",
      "A finished video is sent to Instagram, TikTok or another of your YouTube channels only when a person asks for it, and only after it passed the publish check and was approved. A YouTube cross-post is uploaded as private, a TikTok post is visible only to you, and an Instagram post follows that account’s own privacy.",
    ],
  },
  aiLabel: {
    title: "AI content disclosure",
    body: [
      "YouTube asks creators to disclose realistic content made or altered with AI. Before each upload one rule decides whether a video carries that label: it does when the video contains AI-generated clips or pictures, an AI presenter, or a voice that sounds like a real person. When Nightshift cannot tell what went into a video, it labels it.",
      "A labelled video is sent with YouTube’s “altered or synthetic content” setting and, by default, a line in its description. Instagram and TikTok get their own AI flag for the same video. A generic synthetic narrator on its own is not labelled, because YouTube’s page does not ask for it; a channel can choose to label every video. Only Nightshift’s own staff can switch the label off for a channel.",
      "The label is a statement to the platform. It never makes a video public.",
    ],
  },
  fallback: {
    title: "No silent fallback",
    body: "When a channel is set to a particular voice, model or source and it is not available, the run stops and says what to fix. It does not quietly use something worse. No video is a better failure than a video in the wrong voice.",
  },
  payments: {
    title: "Payments and refunds",
    body: [
      "Before a run starts, its cost is put on hold. If the run fails or does not finish, the whole hold comes back and nothing is charged; when it completes, only what it used is charged, never more than the hold.",
      "Every hold, charge and return is recorded in your organization’s credit history.",
    ],
    link: "Read the Refund Policy",
  },
  report: {
    title: "Report abuse or a security problem",
    body: [
      "A video made with Nightshift that breaks the law or someone’s rights, a fake account, or a site or message that pretends to be us: write to us and say where you saw it.",
      "A security problem: put “Security” in the subject and describe what you did and what you saw. Please test only with your own account and never open other people’s data.",
    ],
    write: "Write to",
    noEmail: "Use the contact details in our Terms.",
    noEmailLink: "Contact details",
  },
  real: {
    title: "How to tell it’s really Nightshift",
    items: [
      "Our site is only at {domain}. Signing in, connecting a channel and paying all start there.",
      "When you sign in with Google you pass briefly through Google’s own pages and our sign-in service’s address on supabase.co, then come back to {domain}.",
      "Nightshift never asks for your password, an API key or a sign-in code in a chat, a Telegram message or an email. Keys are typed only into the app on {domain}.",
      "Anything else that uses our name is not us. Please report it to the address above.",
    ],
    accounts: "Our accounts elsewhere",
  },
};

export type TrustDictionary = typeof trustEn;

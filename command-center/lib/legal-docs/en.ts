import type { LegalTexts } from "./types";

/**
 * English — the governing text. Every factual statement below is taken from
 * the code, not from what a policy usually says: the scopes are those in
 * lib/server/google-oauth.ts and config.YOUTUBE_SCOPES, the API calls are the
 * ones modules/ actually makes, and the processors are the services the
 * pipeline and dashboard actually call. When the code changes what it touches,
 * this text must change with it — Google compares the two during verification.
 */
export const en: LegalTexts = {
  privacy: {
    title: "Privacy Policy",
    summary:
      "What Nightshift collects, what it does with your Google and YouTube data, who processes it, how long it is kept, and how to remove it.",
    sections: [
      {
        id: "who-we-are",
        heading: "1. Who we are",
        body: [
          "Nightshift (the “Service”) is an automated video production tool: a web dashboard on this domain and a pipeline that researches, writes, narrates, renders and uploads videos to YouTube channels its users connect. The Service is operated by {legalName} (“we”, “us”), {country}. Contact: {contactEmail}.",
          "This policy explains what information the Service collects, how it is used and shared, and the choices you have. It applies to this website and to the automated pipeline that acts on your behalf.",
        ],
      },
      {
        id: "information-we-collect",
        heading: "2. Information we collect",
        body: [
          {
            list: [
              "Account information: your email address and a password, handled by our authentication provider (Supabase Auth). We never see or store your password in readable form.",
              "Configuration you enter: channel names, niche, language, voice and style choices, schedules, series, and your review decisions (for example, approving a video and, where “Publish when approved” is switched on for the channel, the request that follows and what YouTube reported back), which are recorded with your user id as an audit trail.",
              "API keys you enter for third-party services: they are encrypted in our server the moment they arrive, written to our pipeline's encrypted secret store (GitHub Actions secrets), and discarded. They are never saved in our database, shown back to you, or logged.",
              "Telegram notifications, only if you connect a chat: the Telegram chat id and the first name or @username Telegram gives us for it, the language you chose for the messages, which notifications you switched on and when the last message was delivered. You can pause or disconnect the chat in Settings at any time; disconnecting deletes this data.",
              "Google user data you authorise us to access, described in section 3.",
              "E-mail preferences: whether you want an e-mail when a video is ready or a weekly summary, and the language you use the app in, so the e-mails are written in it. “Video ready” e-mails are service messages about work you started: they are on until you turn them off in Settings or with the link in any of them. The weekly summary is off unless you turn it on. We send no marketing e-mail.",
              "Technical data: our hosting and database providers record standard request logs (such as IP address, browser type and time of request) to operate and secure the Service. We do not use analytics, advertising or tracking tools.",
              "Country of your request, for some models only: where the provider of a model does not allow it in certain countries, our server looks up the country of the IP address your request came from, to decide whether to offer you that model. The lookup is made on our own server, against a copy of the DB-IP database kept there ([IP Geolocation by DB-IP](https://db-ip.com)); your address is sent to no one for it, and this check stores neither the address nor the country. It reads the address your connection comes from, so with a VPN or a proxy it reads that service’s country.",
            ],
          },
        ],
      },
      {
        id: "google-user-data",
        heading: "3. Google user data we access",
        body: [
          "When you connect a YouTube channel, you are sent to Google’s own consent screen, where you choose the Google account and see exactly what is requested. We request the following OAuth scopes and use each one only for the purposes listed:",
          {
            table: {
              head: ["Scope", "What Nightshift does with it"],
              rows: [
                [
                  "`youtube.upload`",
                  "Uploads the videos Nightshift produced for your channel, and sets their thumbnail. Uploads are private unless you choose otherwise for that channel — for example, by turning on auto-publish, which is off by default. A private upload can also be made public after you approve it, only where “Publish when approved” is switched on for that channel (off by default; see section 4).",
                ],
                [
                  "`youtube.readonly`",
                  "Reads your channel’s identity (channel id and title) to confirm which channel you connected, lists your channel’s recent uploads (ids and titles) so the same video is never uploaded twice, and reads basic details and public statistics of your videos for your dashboard.",
                ],
                [
                  "`youtube.force-ssl`",
                  "Adds a caption track to videos Nightshift uploaded; adds a published video to your series playlist; posts one comment from your channel (a question to viewers) under a video Nightshift published; reads the comments on your channel’s videos to find topics your audience asks for; and, only where an administrator of your workspace has switched on “Publish when approved” for that channel (off by default) and a person has approved that exact video, changes the visibility of that one video from private to public and reads the video back to confirm (see section 4). This scope also technically permits editing and deleting videos. Nightshift never deletes anything, and it never edits your existing videos, playlists or comments except for that one visibility change to a video you approved: that change does not touch the video’s title, description, tags or thumbnail, and apart from it Nightshift only adds the items listed here.",
                ],
                [
                  "`yt-analytics.readonly`",
                  "Reads YouTube Analytics reports for your channel’s videos: views, watch time, average view duration and percentage, likes, comments, shares, subscribers gained and lost, impressions, click-through rate and audience retention. These figures are shown in your dashboard and used to choose better topics for future videos.",
                ],
                [
                  "`yt-analytics-monetary.readonly` (optional)",
                  "Requested only if the operator explicitly turns on revenue tracking. Reads your videos’ estimated revenue for the dashboard. It is not requested otherwise.",
                ],
              ],
            },
          },
          "We do not request access to your Gmail, Google Drive, contacts or any other Google service, and we do not read your YouTube watch history, subscriptions or private messages.",
        ],
      },
      {
        id: "how-we-use-google-data",
        heading: "4. How we use Google user data",
        body: [
          "Google user data is used only to provide and improve the user-facing features you see in the Service: uploading and captioning your videos, adding them to your playlists, posting the engagement comment, preventing duplicate uploads, showing your channel’s performance in your dashboard, choosing future topics from what performed well and what your audience asked for, and, only where you have switched it on, making a video you approved public.",
          "“Publish when approved”. This is the only case in which Nightshift changes a video that is already on YouTube. It is off by default for every channel. An administrator of your workspace can switch it on for one channel, which requires typing a confirmation word, and can switch it off again at any time on the Channels page. When it is on and a person approves one exact version of a video that Nightshift already uploaded as private, a worker checks again that the approval still stands (it lasts 24 hours and ends if the video is rendered or repaired again) and then asks YouTube once to change that video’s visibility from private to public. The request repeats the video’s other status settings as YouTube reported them, so that they stay as they were. Nightshift then reads the video back and records only what YouTube reports; YouTube may still keep the video private. Nightshift does not change the video’s title, description, tags or thumbnail, does not delete anything, and does not edit any other video, playlist or comment.",
          "To produce those insights, the text of comments on your videos and your videos’ performance figures may be sent to our AI text provider (Google’s Gemini API) to be classified and summarised for your channel. We store the result — for example, a topic your audience requested and how often — not the comment text itself.",
        ],
      },
      {
        id: "limited-use",
        heading: "5. Limited Use",
        body: [
          "Nightshift’s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. In particular:",
          {
            list: [
              "we use Google user data only to provide or improve the user-facing features described above;",
              "we transfer it to others only as necessary to provide those features (the processors in section 7), to comply with applicable law, or as part of a merger, acquisition or sale of assets with notice to you;",
              "we do not use or transfer it to serve advertisements, including personalised or retargeted ads;",
              "we do not sell it, and we do not use it to determine creditworthiness or for lending purposes;",
              "we do not allow humans to read it unless you give us affirmative consent for specific data, it is necessary for security purposes (such as investigating abuse), it is needed to comply with applicable law, or it has been aggregated and anonymised for internal operations;",
              "we do not use it to develop, improve or train generalised artificial intelligence or machine-learning models.",
            ],
          },
        ],
      },
      {
        id: "tokens",
        heading: "6. How your Google access is stored",
        body: [
          "After you consent, Google returns an access token and a refresh token to our server. Where they are kept depends on whose channel it is:",
          {
            list: [
              "Channels operated by us (our own organization): the token is immediately encrypted (sealed to our pipeline repository’s public key) and stored as an encrypted GitHub Actions secret, which only the pipeline can read when it runs.",
              "Channels that your organization connects: only the refresh token is kept, encrypted at rest in Supabase Vault. The dashboard can store or delete it but can never read it back — not for you, and not for anyone in your organization; only our pipeline reads it, with a server-only key, while a run for that channel is in progress, and it is held in memory or in a file readable only by the pipeline that is deleted when the run ends. When you disconnect the channel, the stored token is destroyed.",
            ],
          },
          "In both cases tokens are never sent to your browser and never written to a log. What the dashboard shows is only non-secret connection information: which YouTube channel is connected, when and by whom, and which permissions were granted. Our OAuth client credentials are kept in server-only configuration.",
          "During the connection a short-lived, http-only cookie (10 minutes) protects the flow against cross-site request forgery.",
        ],
      },
      {
        id: "processors",
        heading: "7. Service providers",
        body: [
          "We use the following providers to run the Service. Each receives only what it needs for its task.",
          {
            table: {
              head: ["Provider", "Purpose", "Data it receives"],
              rows: [
                ["Supabase", "Database, sign-in and file storage", "Account data, configuration, video records (YouTube video id, title, privacy), performance figures, review copies of videos; for channels your organization connects, the encrypted Google refresh token (Supabase Vault)"],
                ["Vercel", "Hosting of this website (EU region)", "Web requests and request logs"],
                ["GitHub (Actions)", "Runs the video pipeline; encrypted secret store", "Encrypted Google tokens and API keys; pipeline logs and output files"],
                ["Google — YouTube Data and Analytics APIs", "Acting on your channel as described in section 3", "Your videos, captions, thumbnails and the requests described above"],
                ["Google — Gemini API", "Research, script writing, fact-checking, and analysis of comments and performance figures", "Topics, scripts, comment text and performance figures of your videos"],
                ["ElevenLabs; Microsoft Edge text-to-speech", "Narration (voice), whichever the channel is set to", "Script text"],
                ["Pexels, Pixabay", "Stock footage and photos", "Search terms derived from the script"],
                ["Optional media generators, only if the operator enables them: Google Veo, Google Gemini image, OpenAI (GPT Image), Black Forest Labs (FLUX), Ideogram, fal.ai, Leonardo.Ai, Higgsfield, Kling, MiniMax, Seedance (ByteDance), Wan (Alibaba Cloud)", "Generated images and video clips", "Prompts derived from the script"],
                ["Image and video models you choose in the Studio: Ideogram, MiniMax", "Making the image or video clip you ask for", "Your prompt, and the picture you give as a first or last frame (Ideogram receives the prompt only). MiniMax may use what it receives and what it generates to improve its own services and models, under its own terms"],
                ["vidIQ (optional)", "Keyword and title research", "Topic keywords and draft titles"],
                ["Telegram (only if you connect a chat)", "Delivering the short notifications you choose to the Telegram chat you connect: one sentence and a link back to the app", "Your Telegram chat id and the sentence and link of each message; never a script, a prompt, a file name or a video title"],
                ["Telegram, Slack (optional)", "Notifications to the operator", "Run status, video titles and links"],
                ["E-mail delivery service (optional, chosen by the operator)", "Service e-mails: a finished video, and the weekly summary if you turn it on", "Your e-mail address, the name of the channel, counts of videos and the credits you have left; never a script, a prompt or a video title"],
                ["Google Fonts, Amazon CloudFront", "Fonts and background media on these web pages", "Your IP address and browser details, as with any web request"],
                ["Dodo Payments (dodopayments.com)", "Our Merchant of Record and payment processor for credit and plan purchases: checkout page, payment processing, tax, receipts, refunds and chargebacks", "The payment and billing details you enter on Dodo’s checkout page, which Dodo handles itself under its own privacy policy; from us, your account email address (to fill in the checkout), the ids of your organisation and user account, and what you are buying"],
                ["Paddle (Paddle.com), test checkout only", "A test checkout (sandbox) shown until Dodo’s checkout is switched on; it takes no real payment and is being removed", "Whatever you enter in the test checkout; from us, your account email address and the ids of your organisation and user account"],
              ],
            },
          },
          "Only Supabase, GitHub, Google and the notification services in this list receive Google user data, and only for the purposes above. We do not sell personal information to anyone.",
          "Payments. Credits and plans are sold through Dodo Payments (“Dodo”), our Merchant of Record and payment processor: when you buy, you enter your payment and billing details on Dodo’s own checkout page, and Dodo processes them as the seller under the [Dodo Payments Privacy Policy](https://dodopayments.com/legal/privacy-policy). We never receive or store your card details or billing address. From Dodo we keep only what we need to credit a purchase and to reverse it on a refund or chargeback: the payment and refund ids, the amount and currency paid, what was bought, and the organisation (and, where known, the user) the purchase is for. We keep these records with your organisation’s credit history for as long as its account exists, or longer where tax or accounting law requires it. We are still setting up Dodo’s checkout: until it is switched on, any checkout shown in the Service is a Paddle test checkout (sandbox), which takes no real payment.",
        ],
      },
      {
        id: "retention",
        heading: "8. Retention and deletion",
        body: [
          {
            list: [
              "Google tokens are kept while your channel is connected. They stop working the moment you revoke access, and we delete them when you disconnect the channel or ask us to.",
              "Review copies of videos in our storage are limited to the five most recent per channel; older copies are deleted automatically.",
              "Pipeline output (the rendered video, thumbnails and run log) is kept by GitHub Actions for 7 days and then deleted automatically.",
              "Account data, configuration, video records and performance figures are kept while your account is active, and deleted within 30 days of a verified deletion request.",
              "Audit records of approvals and other decisions are kept as long as the account exists, because they are the record of who authorised an action on a channel.",
            ],
          },
          "You can revoke Nightshift’s access to your Google account at any time at [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions). To delete your account and the data we hold, email {contactEmail}.",
        ],
      },
      {
        id: "cookies",
        heading: "9. Cookies and local storage",
        body: [
          "Nightshift uses only what it needs to work. We set no advertising, tracking or analytics cookies, we use no third-party analytics, and we show no cookie banner: everything below is strictly necessary for something you asked for (signing in, a choice you saved, or protecting a sign-in or a connection while it is in progress).",
          {
            table: {
              head: ["Item", "What it is for", "How long"],
              rows: [
                ["Sign-in session cookies (set by our sign-in service, Supabase)", "Keep you signed in, and keep your account’s data private to you.", "Until you sign out or the session expires; refreshed while you use the Service"],
                ["`chronos_locale`", "Remembers the language you chose.", "1 year"],
                ["`ns_view`", "Remembers whether you chose the Mobile or the Desktop view.", "1 year"],
                ["`chronos_channel`, `nightshift_org`, `ns_sidebar` (signed in)", "Remember which channel and organization you last viewed and how wide the side menu is.", "1 year"],
                ["`ns_owner_mode` (platform owner only)", "Remembers whether the platform owner sees the owner sections or the customer view. Ignored for every other account.", "1 year"],
                ["`ns_auth_pending`, `ns_recovery`, `ns_invite`", "Finish an emailed sign-in link, a password reset or an invitation you opened. Only the pages that need them can read them.", "10 minutes, 15 minutes and 24 hours"],
                ["`__Host-yt_oauth_nonce`, `ig_oauth_nonce`, `tt_oauth_nonce`, `tt_oauth_pkce` (while you connect an account)", "Protect the connection of your YouTube (or other) account against cross-site request forgery while you are on the consent screen.", "10 minutes"],
                ["`__Host-ns_connect_pending` (while you pick which account to connect)", "Holds the handle of a sign-in with Google, Instagram or TikTok while you choose which account to connect. It is strictly necessary for that step, only the server can read it, and it never contains an account name or a token.", "Up to 10 minutes, or until it is used"],
                ["Local storage: `chronos_theme`", "Remembers light or dark.", "Until you clear it"],
                ["Local storage: `ns_email_locale`", "Remembers which language was last reported to the server for your e-mails, so the app does not repeat it on every visit.", "Until you clear it"],
                ["Local storage: unfinished editor drafts, side-menu and dashboard layout choices, notification read markers, an unfinished assistant plan, dismissed jobs", "Keep your screen preferences and your work in progress on your device. They are not sent to us. Editor drafts are cleared when you sign out.", "Until you clear them (a draft nobody comes back to is removed automatically)"],
                ["Session storage (this browser tab only)", "Remembers the pages you came through in this tab, an unfinished create form, a one-time notice and whether you paused the animations.", "Until you close the tab"],
              ],
            },
          },
          "Third parties. While the Paddle test checkout described in section 7 is in place, the Pricing page and the pages where you buy credits load Paddle’s script (Paddle.js) to show prices and to open that test checkout. The script and any cookie it or Paddle’s content network sets (for example a bot-protection cookie) are Paddle’s; see the [Paddle Privacy Notice](https://www.paddle.com/legal/privacy). Dodo’s checkout, which replaces it, is a page on Dodo’s own website: we load no Dodo script on our pages, and any cookie set on Dodo’s page is Dodo’s, under the [Dodo Payments Cookie Policy](https://dodopayments.com/legal/cookie-policy). When you connect your YouTube account you are sent to Google. We load no other third-party scripts.",
          "Page statistics. To see which public pages are read, we count page views ourselves, on our own servers: for each public page and each day, how many views, from which referring website (its name only), on a phone-sized or a larger screen, and in which language. This uses no cookie and no local storage, and stores no IP address, user agent or identifier, so it cannot be tied to you or to your other visits. If your browser sends Do Not Track or Global Privacy Control, nothing is counted. No data goes to an analytics provider.",
          "You can delete cookies and local storage in your browser’s settings at any time. The Service then forgets your language, theme and view choices, and you are signed out.",
        ],
      },
      {
        id: "security",
        heading: "10. Security",
        body: [
          "Traffic is encrypted in transit (HTTPS). Database access is restricted per user by row-level security, the website uses only a restricted public key, and secrets are encrypted before they are stored. No system is perfectly secure; if we learn of a breach affecting your data we will notify you as required by law.",
        ],
      },
      {
        id: "your-rights",
        heading: "11. Your choices and rights",
        body: [
          "You can disconnect a channel, revoke Google access, and ask us to access, correct, export or delete your personal data by emailing {contactEmail}. Depending on where you live, you may have further rights under local law, including the right to complain to a data-protection authority.",
        ],
      },
      {
        id: "transfers",
        heading: "12. International transfers",
        body: [
          "Our providers operate in the European Union, the United States and other countries, so your data may be processed outside your country. Where the law requires it, we rely on the providers’ standard contractual safeguards.",
        ],
      },
      {
        id: "children",
        heading: "13. Children",
        body: [
          "The Service is not directed to children or to anyone under 18. It may be used only by people who are at least 18 years old, or older where the minimum age YouTube requires to manage a channel in their country is higher. When you create an account, with an email address or with Google, you confirm that you are 18 or older. If you believe someone under 18 is using the Service, write to {contactEmail}.",
        ],
      },
      {
        id: "google-and-youtube",
        heading: "14. YouTube and Google",
        body: [
          "Nightshift uses YouTube API Services. By connecting a YouTube channel you agree to be bound by the [YouTube Terms of Service](https://www.youtube.com/t/terms). Google’s handling of your data is governed by the [Google Privacy Policy](https://policies.google.com/privacy).",
        ],
      },
      {
        id: "changes",
        heading: "15. Changes to this policy",
        body: [
          "We will post any change on this page and update the effective date ({effectiveDate}). If a change materially affects how we use Google user data, we will tell you in the Service and ask for your consent again where required.",
        ],
      },
      {
        id: "contact",
        heading: "16. Contact",
        body: ["{legalName}, {country}. Email: {contactEmail}."],
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    summary:
      "The rules for using Nightshift: your responsibilities for your channel and content, what is not allowed, how prepaid credits, payments and refunds work, and the limits of our liability.",
    sections: [
      {
        id: "agreement",
        heading: "1. Agreement",
        body: [
          "These Terms are an agreement between you and {legalName} (“we”, “us”), {country}, and govern your use of Nightshift (the “Service”). By signing in or using the Service you accept them. If you use the Service for an organisation, you confirm you may bind it to these Terms. Our [Privacy Policy](/privacy) explains how we handle your data.",
        ],
      },
      {
        id: "service",
        heading: "2. The Service",
        body: [
          "Nightshift helps you produce videos for YouTube channels you manage: it researches topics, writes and fact-checks scripts, narrates, renders, and uploads videos to your channel, and shows how they perform. It also lets you generate and edit images, video clips and audio with AI models (the Studio), and edit your videos in a video editor. Features may change, and parts of the Service may be offered as a preview.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Accounts",
        body: [
          "You must be at least 18 years old to create an account or use the Service, and by creating an account, with an email address or with Google, you confirm that you are. The Service is not intended for anyone under 18.",
          "Access is currently by invitation. Keep your sign-in details secure and tell us promptly at {contactEmail} if you suspect unauthorised use. You are responsible for activity under your account.",
        ],
      },
      {
        id: "youtube",
        heading: "4. Your YouTube channel and Google account",
        body: [
          "You may connect only channels you own or are authorised to manage. By connecting one, you authorise Nightshift to act on it within the permissions you grant on Google’s consent screen, as described in the Privacy Policy. You remain responsible for your channel and must comply with the [YouTube Terms of Service](https://www.youtube.com/t/terms) and YouTube’s [Community Guidelines](https://www.youtube.com/howyoutubeworks/policies/community-guidelines/). Google’s handling of your data is governed by the [Google Privacy Policy](https://policies.google.com/privacy).",
          "Making an approved video public. Nightshift uploads videos as private. Where an administrator of your workspace has switched on “Publish when approved” for a channel (off by default, and it can be switched off at any time), approving one exact version of a video on that channel asks YouTube to change that video from private to public. Nothing is made public this way unless that setting is on and a person has approved that version; the approval ends after 24 hours, or if the video is rendered or repaired again. YouTube may still keep the video private. A video made public this way is content published under settings you chose, and section 5 applies to it. This change does not touch the video’s title, description, tags or thumbnail, and deletes nothing.",
          "You can revoke access at any time at [https://myaccount.google.com/permissions](https://myaccount.google.com/permissions); the Service then stops acting on that channel.",
        ],
      },
      {
        id: "content",
        heading: "5. Your content and your responsibility",
        body: [
          "You own the content produced for your channel, and you are responsible for it — including everything uploaded under your account, whether you reviewed it or let the Service publish it under settings you chose. In particular, you are responsible for:",
          {
            list: [
              "having the rights to the topics, scripts, voices, footage, music, logos and other material in your videos;",
              "checking facts: generated scripts and summaries can be wrong, and a fact-check pass reduces but does not remove that risk;",
              "labelling altered or synthetic content where YouTube or the law requires it;",
              "your channel’s standing with YouTube, including strikes, monetisation decisions and terminations.",
            ],
          },
          "You grant us a limited licence to process your content solely to operate the Service for you.",
        ],
      },
      {
        id: "acceptable-use",
        heading: "6. Acceptable use",
        body: [
          "6.1. All use. You must not use the Service to:",
          {
            list: [
              "publish spam, or mass-produced, repetitive or low-value content made mainly to game YouTube’s systems, or anything that violates YouTube’s [spam, deceptive practices and scams policies](https://support.google.com/youtube/answer/2801973);",
              "mislead viewers — including clickbait titles or thumbnails that misrepresent the video, impersonation, or fabricated claims presented as fact;",
              "publish content that is illegal, infringes someone else’s rights, harasses or incites hatred, sexualises minors, or violates YouTube’s Community Guidelines;",
              "operate channels you are not authorised to manage, or create or run channels to evade a YouTube restriction or termination;",
              "circumvent YouTube API quotas or limits, access other users’ data, probe or disrupt the Service, or reverse-engineer it except where the law allows;",
              "resell or share access to the Service without our written permission.",
            ],
          },
          // 6.2-6.5 (generated content) are read by the payment providers' reviewers. "The Service does not offer face-swap or
          // voice-cloning features" is true only while Character Studio (NIGHTSHIFT_CHARACTER_STUDIO, migration 0137) and custom voice
          // (CUSTOM_VOICE_ENABLED, NIGHTSHIFT_VOICE_CLONING, migration 0117) stay off: switching either on must change this text first.
          // 6.4 restates 8.3: a refused request is a failed run or generation, and its whole hold is returned.
          // Dubbing (registry capability `dub`, which keeps each speaker's own voice) and speech-to-speech (`voice_change`) are voice
          // cloning in effect: they stay unsold only while every such registry entry carries a terms_gate (tests/legal-docs.test.ts).
          // Selling dubbing or voice change must change the face-swap and voice-cloning sentence first.
          "6.2. Generated images, video and voice. The Service lets you generate and edit text, images, video, voice and other audio with AI models made by other companies (“model makers”). These rules apply to everything you generate or edit with the Service, whether or not you publish it. You must not use the Service to create, edit or share:",
          {
            list: [
              "sexual or sexually suggestive content of any kind, including nudity, and any content that sexualises or exploits minors;",
              "a realistic image, video or voice of a real, identifiable person without that person’s explicit consent — including face swaps, deepfakes, voice cloning and voice impersonation;",
              "content that impersonates a person or an organisation, or that is presented as real footage, a real photograph or a real recording of real events in order to deceive;",
              "content that infringes copyright, trademarks or other rights, including content made by asking a model to copy someone else’s protected work;",
              "content that harasses or threatens anyone, incites hatred, promotes violence, promotes or encourages self-harm or suicide, or is otherwise illegal;",
              "anything obtained by getting around, or trying to get around, a model’s safety filters — for example by rewording a refused request to hide what it asks for.",
            ],
          },
          "The Service does not offer face-swap or voice-cloning features.",
          "6.3. Labels and provenance. Some model makers add a visible watermark or label, or provenance metadata, to what their models generate. You must not remove, hide or alter such a watermark or label, or strip or alter that metadata to hide that the content was generated. You must not present generated content as made by a person where the law or the platform you publish on requires you to disclose that it was generated or altered; section 5 also applies.",
          "6.4. Safety filters. Model makers apply their own safety filters and may refuse a request. You are not charged for a request a model refuses: the credits held for it are returned, as for any run that fails (section 8.3).",
          "6.5. Reporting abuse. To report content made with the Service that breaks these rules — including content that shows you, or uses your voice, without your consent — write to {contactEmail} and tell us where you found it. We may remove content that breaks these rules and suspend or end the access of the account that made it, as described in section 13. Child sexual abuse material is never allowed, in any circumstances: we remove it, end the access of the account that made it, and report it to the competent authorities, including the US National Center for Missing & Exploited Children (NCMEC) where applicable.",
          "6.6. Copyright notices. If you believe content made with the Service infringes your copyright or another right of yours, write to {contactEmail}. We may remove content that a notice identifies, or disable access to it. Your notice must include:",
          {
            list: [
              "the work or right you say is infringed;",
              "where the content appears, for example a link, so that we can find it;",
              "your name and contact details, including an email address;",
              "a statement that you believe in good faith that the use is not authorised by the rights holder, its agent or the law, that the information in your notice is accurate, and that you are the rights holder or authorised to act for them.",
            ],
          },
        ],
      },
      {
        id: "third-parties",
        heading: "7. Third-party services",
        body: [
          "The Service relies on third-party providers, listed in the Privacy Policy. Where you supply your own API keys, your use of those providers is subject to their terms and their charges, and we are not responsible for their availability or output.",
        ],
      },
      {
        id: "credits",
        heading: "8. Prepaid credits, payments and refunds",
        body: [
          {
            note: "This section describes how prepaid credits work in the Service today. It is awaiting review by a qualified lawyer; any change will be published on this page with a new effective date.",
          },
          "8.1. What you buy. Some use of the Service is paid for with prepaid credits, sold in two ways at the prices shown on our [Pricing](/pricing) page and, finally, in the checkout before you pay: (a) monthly plans — a subscription that renews automatically every month until you cancel it and grants a set number of credits for each paid billing period; those credits can be used only during that period and expire at its end, without carrying over; you can cancel at any time, and the plan then stays active until the end of the period already paid for, with no further charge; and (b) credit packs — one-time payments that never renew. Credits are added to the balance of the organisation you buy them for, and can be used only for the Service, by that organisation. Plan credits are used before pack credits, and the credits that expire soonest are used first.",
          "8.2. Who you buy from. Our order process is conducted by Dodo Payments (“Dodo”), our Merchant of Record and payment processor. Dodo is an authorised reseller of our credits and plans: you buy them from Dodo, under [Dodo’s Buyer Terms](https://dodopayments.com/legal/buyer-terms), and we provide the Service to you. Dodo processes the payment on its own checkout page, calculates and collects any applicable sales tax or VAT, sends your order confirmation and receipt by email, and handles payment questions, refund requests and chargebacks. Dodo handles your payment details under the [Dodo Payments Privacy Policy](https://dodopayments.com/legal/privacy-policy); we never receive or store your card details. We are still setting up Dodo’s checkout: until it is switched on, any checkout shown in the Service is a Paddle test checkout (sandbox) that takes no real payment.",
          "8.3. How credits are used. Credits are used when the Service produces a video for one of your organisation’s channels (a “run”), when it generates or edits an image, a video clip or audio for you in the Studio (a “generation”), and for other paid work whose price the Service shows before you start it. For a run:",
          {
            list: [
              "Before a run starts, an estimated number of credits is put on hold. The estimate is the length of video requested multiplied by the per-minute rate in effect or, where no per-minute rate applies, is based on the cost of your channel’s recent runs; it is never less than the minimum per run. The estimate is shown in the Service before you start a run, and a run does not start if your available credits (your balance minus credits already on hold) do not cover it.",
              "When the run completes, the credits for the resources it actually used are charged, at the rates in effect, and never more than the hold. The unused part of the hold is returned to your available credits at the same time. If the resources a run used cannot all be measured and priced, the hold is charged in full.",
              "If a run fails or does not complete, the whole hold is returned and nothing is charged. A hold for a run that never starts, or never reports back, is returned automatically.",
            ],
          },
          "For a generation:",
          {
            list: [
              "Before it starts, the Service shows its price, which you confirm. That price is put on hold, and the generation does not start if your available credits do not cover it.",
              "When it completes, its price is charged, never more than the hold, and the rest of the hold is returned. Where you let the Service choose the model and the first model could not accept the request, the generation may be made by another model of the same kind; you are then charged no more than that model’s price.",
              "An edit of several marked areas of one picture is charged only for the areas actually applied: the share of the hold for the areas applied, rounded up to the nearest hundredth of a credit. If no area could be applied, nothing is charged.",
              "If a generation fails, is refused by the model, is cancelled or is not finished in time, the whole hold is returned and nothing is charged.",
            ],
          },
          "Any other paid work follows the same rule: credits are put on hold before it starts, it is charged no more than the hold when it completes, and the whole hold is returned if it fails. Every hold, charge and return is recorded in your organisation’s credit history in the Service.",
          "8.4. Nature of credits. Credits are a prepaid right to use the Service, not money or a deposit: they have no cash value, earn no interest, and cannot be exchanged for cash (except by a refund under section 8.6), transferred to another organisation or resold.",
          {
            creditExpiry: {
              never: "8.5. Expiry. Credits do not expire.",
              after: "8.5. Expiry. Unused credits expire {months} months after the date they were purchased.",
              unknown: "8.5. Expiry. The expiry term for top-up credits is the one in force for packs when you buy them. It could not be shown here just now; for the current term, write to us at {contactEmail}.",
            },
          },
          "8.6. Refunds. Because Dodo is the seller, refunds are decided by Dodo under [Dodo’s Buyer Terms](https://dodopayments.com/legal/buyer-terms) and applicable law, including any right you have as a consumer where you live to withdraw from a purchase. To ask for a refund, write to us at {contactEmail} and we will take it up with Dodo, or contact Dodo directly: look up your purchase and request a refund in Dodo’s customer portal at [customer.dodopayments.com](https://customer.dodopayments.com). Our [Refund Policy](/refund) sets out these rules on one page.",
          "8.7. Refunds and chargebacks remove credits. When a purchase is refunded or charged back, the credits it added are removed from your organisation’s balance — all of them for a full refund, and in proportion to the amount refunded for a partial one. Only available credits can be removed: credits already used, or on hold for a run in progress, cannot. Where a chargeback leaves credits used but unpaid, we may suspend the organisation’s access to paid features.",
          "8.8. Price changes. We may change the prices of credit packs and the rates at which credits are used. A change never reduces the credits already in your balance, and a run is never charged more than the hold taken when it started.",
        ],
      },
      {
        id: "ip",
        heading: "9. Our intellectual property",
        body: [
          "The Service, its software and its brand belong to us or our licensors. These Terms give you a personal, non-exclusive, non-transferable right to use the Service while your account is active. If you send us feedback, we may use it without obligation to you.",
        ],
      },
      {
        id: "disclaimers",
        heading: "10. Disclaimers",
        body: [
          "The Service is provided “as is” and “as available”. To the extent the law allows, we disclaim all implied warranties. We do not guarantee views, subscribers, revenue, monetisation approval, or that YouTube will not restrict, demonetise or remove any video or channel.",
        ],
      },
      {
        id: "liability",
        heading: "11. Limitation of liability",
        body: [
          "To the extent the law allows, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data, goodwill or channel standing. Our total liability for any claim relating to the Service is limited to the amount you paid us for the Service in the twelve months before the event giving rise to the claim. Nothing in these Terms limits liability that cannot be limited by law.",
        ],
      },
      {
        id: "indemnity",
        heading: "12. Indemnity",
        body: [
          "You will indemnify us against claims by third parties arising from your content, your channel, or your breach of these Terms or the law.",
        ],
      },
      {
        id: "termination",
        heading: "13. Suspension and termination",
        body: [
          "You may stop using the Service at any time, disconnect your channels and revoke Google access. We may suspend or end your access if you breach these Terms, if your use puts YouTube’s or Google’s policies — or our compliance with them — at risk, or if the law requires it; where reasonable we will tell you first. When access ends, the Service stops acting on your channels, your stored Google tokens are deleted, and your data is deleted as described in the Privacy Policy. Sections 5, 9, 10, 11, 12 and 15 survive termination.",
        ],
      },
      {
        id: "changes",
        heading: "14. Changes to these Terms",
        body: [
          "We may update these Terms. We will post the new version on this page with a new effective date ({effectiveDate}) and tell you in the Service about material changes. Continuing to use the Service after a change takes effect means you accept it.",
        ],
      },
      {
        id: "law",
        heading: "15. Governing law",
        body: [
          "These Terms are governed by the laws of {country}, without prejudice to any mandatory consumer protection you have where you live.",
        ],
      },
      {
        id: "contact",
        heading: "16. Contact",
        body: ["{legalName}, {country}. Email: {contactEmail}."],
      },
    ],
  },
  refund: {
    title: "Refund Policy",
    summary:
      "How refunds work for Nightshift credits and plans: how to ask for one, what happens to your credits, and how to cancel a monthly plan.",
    sections: [
      {
        id: "seller",
        heading: "1. Who handles refunds",
        body: [
          {
            note: "This policy restates section 8 of our [Terms of Service](/terms#credits) in one place. That section is awaiting review by a qualified lawyer; any change will be published on both pages with a new effective date. If the two ever differ, the Terms of Service apply.",
          },
          "Our order process is conducted by Dodo Payments (“Dodo”), our Merchant of Record and payment processor: you buy credits and plans from Dodo, under [Dodo’s Buyer Terms](https://dodopayments.com/legal/buyer-terms), and Dodo processes the payment, sends your receipt and handles refund requests and chargebacks. We are still setting up Dodo’s checkout: until it is switched on, any checkout shown in the Service is a Paddle test checkout (sandbox) that takes no real payment, so there is nothing to refund through it.",
        ],
      },
      {
        id: "how-to-ask",
        heading: "2. How to ask for a refund",
        body: [
          "You can ask for a refund in any of these ways:",
          {
            list: [
              "write to us at {contactEmail}, and we will take it up with Dodo;",
              "contact Dodo Payments directly: look up your purchase and request a refund in Dodo’s customer portal at [customer.dodopayments.com](https://customer.dodopayments.com), giving the order number from your receipt and the email address you used for the purchase.",
            ],
          },
        ],
      },
      {
        id: "when",
        heading: "3. When a refund is given",
        body: [
          "Refunds are decided by Dodo in line with [Dodo’s Buyer Terms](https://dodopayments.com/legal/buyer-terms) and applicable law, including any right you have as a consumer where you live to withdraw from a purchase. We do not set a separate refund period of our own.",
          "Nothing in this policy limits your statutory rights as a consumer.",
        ],
      },
      {
        id: "credits",
        heading: "4. What happens to your credits",
        body: [
          "When a purchase is refunded or charged back, the credits it added are removed from your organisation’s balance — all of them for a full refund, and in proportion to the amount refunded for a partial one.",
          "Only available credits can be removed: credits already used, or on hold for a run in progress, cannot. Where a chargeback leaves credits used but unpaid, we may suspend the organisation’s access to paid features.",
          "Credits have no cash value and cannot be exchanged for cash except by a refund as described here.",
        ],
      },
      {
        id: "failed-runs",
        heading: "5. Failed generations",
        body: [
          "You do not need to ask for anything when a generation fails. Before a run starts, its estimated cost is put on hold. If the run fails or does not complete, the whole hold is returned and nothing is charged; a hold for a run that never starts, or never reports back, is returned automatically. When a run completes, only what it actually used is charged, never more than the hold. The same applies to a generation in the Studio: if it fails or the model refuses it, its whole hold is returned (section 8.3 of the Terms).",
          "Every hold, charge and return is recorded in your organisation’s credit history in the Service.",
        ],
      },
      {
        id: "subscriptions",
        heading: "6. Cancelling a monthly plan",
        body: [
          "You can cancel a monthly plan at any time, in Manage subscription on the Credits page of the Service. The plan then stays active until the end of the period already paid for, with no further charge, and does not renew. Credits granted with a plan can be used only during the period they were granted for and expire at its end.",
          "Cancelling stops future renewals. To ask for a refund of a payment already made, see section 2.",
        ],
      },
      {
        id: "contact",
        heading: "7. Contact",
        body: ["{legalName}, {country}. Email: {contactEmail}. See also our [Terms of Service](/terms) and [Privacy Policy](/privacy)."],
      },
    ],
  },
};

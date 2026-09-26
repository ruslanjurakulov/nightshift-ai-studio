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
              "Configuration you enter: channel names, niche, language, voice and style choices, schedules, series, team membership and roles, and your review decisions (for example, approving a video), which are recorded with your user id as an audit trail.",
              "API keys you enter for third-party services: they are encrypted in our server the moment they arrive, written to our pipeline's encrypted secret store (GitHub Actions secrets), and discarded. They are never saved in our database, shown back to you, or logged.",
              "Google user data you authorise us to access, described in section 3.",
              "Technical data: our hosting and database providers record standard request logs (such as IP address, browser type and time of request) to operate and secure the Service. We do not use analytics, advertising or tracking tools.",
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
                  "Uploads the videos Nightshift produced for your channel, and sets their thumbnail. Uploads are private unless you choose otherwise for that channel — for example, by turning on auto-publish, which is off by default.",
                ],
                [
                  "`youtube.readonly`",
                  "Reads your channel’s identity (channel id and title) to confirm which channel you connected, lists your channel’s recent uploads (ids and titles) so the same video is never uploaded twice, and reads basic details and public statistics of your videos for your dashboard.",
                ],
                [
                  "`youtube.force-ssl`",
                  "Adds a caption track to videos Nightshift uploaded; adds a published video to your series playlist; posts one comment from your channel (a question to viewers) under a video Nightshift published; and reads the comments on your channel’s videos to find topics your audience asks for. This scope also technically permits editing and deleting videos — Nightshift never deletes anything and never edits your existing videos, playlists or comments; it only adds the items listed here.",
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
          "Google user data is used only to provide and improve the user-facing features you see in the Service: uploading and captioning your videos, adding them to your playlists, posting the engagement comment, preventing duplicate uploads, showing your channel’s performance in your dashboard, and choosing future topics from what performed well and what your audience asked for.",
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
          "After you consent, Google returns an access token and a refresh token to our server. They are immediately encrypted (sealed to our pipeline repository’s public key) and stored as an encrypted GitHub Actions secret, which only the pipeline can read when it runs. Tokens are never stored in our database, never sent to your browser, and never written to a log. Our OAuth client credentials are kept in server-only configuration.",
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
                ["Supabase", "Database, sign-in and file storage", "Account data, configuration, video records (YouTube video id, title, privacy), performance figures, review copies of videos"],
                ["Vercel", "Hosting of this website (EU region)", "Web requests and request logs"],
                ["GitHub (Actions)", "Runs the video pipeline; encrypted secret store", "Encrypted Google tokens and API keys; pipeline logs and output files"],
                ["Google — YouTube Data and Analytics APIs", "Acting on your channel as described in section 3", "Your videos, captions, thumbnails and the requests described above"],
                ["Google — Gemini API", "Research, script writing, fact-checking, and analysis of comments and performance figures", "Topics, scripts, comment text and performance figures of your videos"],
                ["ElevenLabs; Microsoft Edge text-to-speech", "Narration (voice), whichever the channel is set to", "Script text"],
                ["Pexels, Pixabay", "Stock footage and photos", "Search terms derived from the script"],
                ["Optional media generators, only if the operator enables them: Google Veo, Leonardo.Ai, Higgsfield, Kling, MiniMax, Seedance (ByteDance), Wan (Alibaba Cloud)", "Generated images and video clips", "Prompts derived from the script"],
                ["vidIQ (optional)", "Keyword and title research", "Topic keywords and draft titles"],
                ["Telegram, Slack (optional)", "Notifications to the operator", "Run status, video titles and links"],
                ["Google Fonts, Amazon CloudFront", "Fonts and background media on these web pages", "Your IP address and browser details, as with any web request"],
              ],
            },
          },
          "Only Supabase, GitHub, Google and the notification services in this list receive Google user data, and only for the purposes above. We do not sell personal information to anyone.",
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
          "We use only what the Service needs to work: sign-in session cookies (Supabase), a cookie remembering your language, a cookie remembering the channel you last viewed, the 10-minute cookie used while connecting YouTube, and your theme choice in your browser’s local storage. We use no advertising or analytics cookies.",
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
          "The Service is not directed to children and may not be used by anyone under 13, or by anyone below the minimum age YouTube requires to manage a channel in their country.",
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
      "The rules for using Nightshift: your responsibilities for your channel and content, what is not allowed, and the limits of our liability.",
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
          "Nightshift helps you produce videos for YouTube channels you manage: it researches topics, writes and fact-checks scripts, narrates, renders, and uploads videos to your channel, and shows how they perform. Features may change, and parts of the Service may be offered as a preview.",
        ],
      },
      {
        id: "accounts",
        heading: "3. Accounts",
        body: [
          "Access is currently by invitation. Keep your sign-in details secure and tell us promptly at {contactEmail} if you suspect unauthorised use. You are responsible for activity under your account, including actions taken by team members you invite.",
        ],
      },
      {
        id: "youtube",
        heading: "4. Your YouTube channel and Google account",
        body: [
          "You may connect only channels you own or are authorised to manage. By connecting one, you authorise Nightshift to act on it within the permissions you grant on Google’s consent screen, as described in the Privacy Policy. You remain responsible for your channel and must comply with the [YouTube Terms of Service](https://www.youtube.com/t/terms) and YouTube’s [Community Guidelines](https://www.youtube.com/howyoutubeworks/policies/community-guidelines/). Google’s handling of your data is governed by the [Google Privacy Policy](https://policies.google.com/privacy).",
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
          "You must not use the Service to:",
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
        heading: "8. Prepaid credits",
        body: [
          {
            note: "TEMPLATE — NOT IN EFFECT. This section is a draft for a future paid plan. It must be reviewed with a qualified lawyer, and the bracketed values filled in, before any credits are sold.",
          },
          {
            list: [
              "Credits are purchased in advance and consumed as the Service produces videos, at the rates shown in the Service before you start a run.",
              "An estimate is shown before a run starts; the credits actually consumed reflect the resources used, [up to / not exceeding] the estimate by [X]%.",
              "Credits have no cash value, cannot be transferred, and expire [N months] after purchase.",
              "Credits consumed by a run that fails because of a fault in the Service are returned to your balance.",
              "Unused credits are refundable [within N days of purchase / only where required by law].",
              "Payments are processed by [payment provider], which acts as the merchant of record; we never receive or store your card details.",
              "We may change credit prices; a change never affects credits already purchased.",
            ],
          },
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
};

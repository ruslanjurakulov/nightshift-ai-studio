/**
 * The YouTube Autopilot pillar (/solutions/youtube-channels, components/site/AutopilotPillar.tsx). English is the source of
 * truth; ru.ts and uz.ts are typed against it, and tests/site-copy.test.ts holds the three to the same shape (this lives under
 * site.autopilot.pillar).
 *
 * Every sentence about publishing was checked against modules/publish_gate.py, modules/visibility_publish.py,
 * docs/APPROVE_PUBLISH_1B.md, config.YOUTUBE_PRIVACY and migrations 0004, 0112, 0116 and 0145; tests/autopilot-pillar.test.tsx
 * pins the ones a constant can hold. No provider and no competitor is named (docs/research/competitors.md): the category is
 * "many autopilot tools". {hours} is lib/site/autopilot-pillar APPROVAL_HOURS.
 */
export const pillarEn = {
  meta: {
    title: "YouTube Autopilot that keeps you in control",
    description:
      "Topic to private YouTube upload: research, script, fact-check, voice, visuals and render. Nothing goes public until a person decides it should.",
  },
  hero: {
    kicker: "YouTube Autopilot",
    title: "Your channel on autopilot. Nothing goes public without you.",
    lead: "Give it a topic. Nightshift researches it, writes and fact-checks a script, narrates it, finds the pictures, renders the video and uploads it to your channel as private. You watch it and approve the exact cut.",
  },
  composer: {
    label: "Your topic",
    genres: "Start from a genre",
    items: [
      { id: "history", name: "History", starter: "How the Great Library of Alexandria was really lost" },
      { id: "mystery", name: "Mystery", starter: "The Flannan Isles Lighthouse Mystery" },
      { id: "explainer", name: "Explainer", starter: "Why the sky is blue, explained with one simple experiment" },
      { id: "kids", name: "Kids", starter: "A gentle story about a little turtle who learns to ask for help" },
    ],
    go: "Open the run form",
    empty: "Type a topic first.",
    note: "This only fills in the run form. Nothing runs and nothing is charged until you press Start there, after the price is shown.",
    kidsTitle: "Made for kids",
    kidsNote:
      "Videos for children must be declared “made for kids” on YouTube, a rule that comes from the US children’s privacy law (COPPA). This genre opens the run form with that declaration on, and a person confirms it before the video can be approved. Comments and personalised ads are then off on that video: YouTube’s rule, not ours.",
  },
  sample: {
    label: "Sample output",
    tag: "Sample script from our repository",
    note: "The script our render test runs on, in the format the script stage writes, shown as written (in English). The lengths are what the script plans, not a measurement.",
    topic: "Topic",
    titleA: "Title A",
    titleB: "Title B",
    hook: "Opening line",
    sections: "Sections",
    seconds: "{n} s planned",
    source: "From",
    more: "See the file behind each stage",
  },
  stages: {
    slug: "How a run moves",
    title: "Eleven stages, in the order they run.",
    lead: "What each stage does and what it costs. A run has one price for the whole video, shown before it starts; no stage is priced on its own.",
    price: "The whole run: {n} {unit} per finished minute of video, held when it starts.",
    minimum: "At least {n} {unit} a run.",
    priceUnknown: "No per-minute rate is published yet. The run form shows the price before anything starts.",
    refund: "If the run fails, the whole hold goes back to your balance by itself. A finished run is charged what it measured, never more than the hold.",
    costLabel: "Cost",
    measures: "Counted in the run’s cost record: {what}.",
    ledger: {
      tokens: "language-model tokens",
      narration: "characters narrated",
      footage: "footage searches, and any generated clips or pictures",
      render: "seconds of rendering",
      upload: "bytes uploaded",
    },
    inPrice: "Part of the run’s one price.",
    noCharge: "No credits.",
    items: [
      {
        id: "topic",
        name: "Topic",
        does: "Takes your topic, or picks one from the channel’s plan, and screens out one the channel has already made.",
      },
      {
        id: "research",
        name: "Research",
        does: "Asks a language model what it knows about the topic, with its own confidence on each fact. That is recall, not sourced research, so it stays unverified until the fact-check.",
      },
      {
        id: "script",
        name: "Script",
        does: "Writes the script in sections, opening line first, with two titles to compare, a description and tags.",
      },
      {
        id: "factcheck",
        name: "Fact-check",
        does: "Checks each claim in the script, looking it up in the English Wikipedia by default. A claim it cannot verify is marked for a person; if the check would block the video, the run stops here, before the voice is paid for.",
      },
      {
        id: "voice",
        name: "Voice",
        does: "Narrates the script in the channel’s own voice and times every word for the captions. If that voice cannot be reached, the run stops.",
      },
      {
        id: "visuals",
        name: "Visuals",
        does: "Finds footage for each section from its search words, generates clips or pictures where the channel is set to, and plans the thumbnail.",
      },
      {
        id: "render",
        name: "Render",
        does: "The video engine builds each scene from a recipe and cuts the video with its captions.",
      },
      {
        id: "gate",
        name: "Publish check",
        does: "Checks the finished file before it may be uploaded: the fact-check’s verdict, the file itself (its streams, its length against the narration, black or silent stretches) and the title and description limits.",
      },
      {
        id: "upload",
        name: "Private upload",
        does: "Uploads an allowed video to your channel as private: only you and the people you share it with can watch it.",
      },
      {
        id: "approve",
        name: "Your approval",
        does: "You watch the review copy and approve one exact cut. That is a record of your decision; it does not change the video’s privacy.",
      },
      {
        id: "public",
        name: "Public",
        does: "You make the video public on YouTube, or, on a channel where someone who manages the workspace switched on “Publish when approved”, your approval asks YouTube for it once.",
      },
    ],
    more: "See the real files behind these stages",
  },
  control: {
    slug: "You stay in control",
    title: "Private first. Public only by a person’s decision.",
    lead: "Many autopilot tools publish automatically by default, and reviewing first is optional. Here it is the other way round: every upload is private, and each step from private to public is written below as the code runs it.",
    diagram: "From finished video to public",
    steps: [
      {
        id: "check",
        state: "Before any upload",
        title: "The publish check",
        body: "Runs on the finished file and is on by default for every channel. A video it blocks is not uploaded: it is kept for you to review.",
      },
      {
        id: "private",
        state: "Private",
        title: "Uploaded as private",
        body: "Every upload asks YouTube for private. Even with the channel’s auto-publish switch on (it is off by default), a new video stays private until a person answers YouTube’s “made for kids” question for it.",
      },
      {
        id: "approve",
        state: "Approved",
        title: "You approve one exact cut",
        body: "Approving records who approved, which cut (its sha256 fingerprint), until when ({hours} hours) and what they acknowledged. It needs a stored publish-check verdict that allows the video, and it does not change the video’s privacy.",
      },
      {
        id: "public",
        state: "Public",
        title: "Public, by your act",
        body: "By default you make the video public yourself, on YouTube, when you are ready.",
      },
    ],
    branch: {
      title: "Or “Publish when approved”, only if someone who manages the workspace turned it on",
      items: [
        "Off by default for every channel. Only someone who manages the channel’s workspace can switch it on, through an audited database function, never the bot; one tap switches it off.",
        "With it on, your approval queues one request. The worker that carries it out is itself off unless the server is set to run it.",
        "Just before acting, the worker asks the database again: still the approved cut, the approval not expired, the publish check’s verdict stored and allowed, the switch still on.",
        "It asks YouTube once to make the video public, then reads it back. The app says “Published” only when YouTube’s answer says public. If anything fails before YouTube is asked, the video stays private.",
      ],
    },
    fallback: {
      title: "No silent fallback",
      body: "A channel set to a voice gets that voice, or no video. Before anything is paid for, the run checks that the channel’s narrator can really speak, and the picture and clip models it is set to the same way. If one cannot, the run stops and says why. It never narrates in a different, cheaper voice: a video in the wrong voice is worse than no video.",
    },
    unknown: {
      title: "Unknown means unknown",
      items: [
        "A video with no stored publish-check verdict reads “unknown”, never “passed”, and cannot be approved.",
        "A fact-check that did not run is never counted as passed: by default it holds the video.",
        "A claim the fact-check could not verify is marked for a person, never passed as true.",
        "A price nobody published reads “not published”, as on this page.",
      ],
    },
  },
  faq: {
    slug: "Questions",
    title: "Before you start",
    sources: "YouTube’s own pages",
    items: [
      {
        id: "publish",
        q: "Will it ever publish a video on its own?",
        a: "No. Every upload is private. A video becomes public when a person makes it public on YouTube, or when a person approves it on a channel where someone who manages the workspace switched on “Publish when approved”. The switches that could change this are per channel and off by default.",
      },
      {
        id: "monetize",
        q: "Can a channel made this way earn money?",
        a: "We cannot promise monetization or any income, and nobody honestly can. Whether a channel joins the YouTube Partner Program, and stays in it, is YouTube’s decision under its own policies. Checked on 14 November 2026: YouTube’s monetization policies exclude mass-produced or repetitive content, meaning videos that look made from a template with little variation, or that are easy to reproduce at scale. YouTube calls this “inauthentic content”; until July 2025 it was “repetitious content”. Make each video worth watching on its own, and read YouTube’s pages yourself, because they change.",
      },
      {
        id: "disclosure",
        q: "Does YouTube need to know the video was made with AI?",
        a: "Sometimes, and the run decides it from what it actually made. YouTube asks creators to disclose realistic altered or synthetic content. By default a video is labelled when it contains AI-generated clips or pictures, an AI presenter or a voice set as a real person’s, or when the run cannot tell; the label goes to YouTube with the upload and a line is added to the description. A video of stock footage with a generic narrator is not labelled by default, because YouTube’s page does not name text-to-speech. A channel can choose to label every video.",
      },
      {
        id: "fails",
        q: "What happens if a stage fails?",
        a: "The run stops, and you are not charged for it. Credits are held before a run starts, at the price you were shown. If it fails at any stage, or stops before the render because the fact-check would block it, the whole hold goes back to your balance by itself. A run is charged only when it reports a finished video, and then what it measured, never more than the hold; if any part of it could not be priced, the hold is charged rather than a guess.",
      },
      {
        id: "kids",
        q: "What about videos for children?",
        a: "YouTube requires videos made for children to be declared “made for kids”, a rule that comes from the US children’s privacy law (COPPA). A kids run is detected as kids content and its private upload is declared made for kids. Before it can be approved, a person answers “is this video made for kids?” on its review page. Declaring it turns off comments, personalised ads and notifications on that video: YouTube’s rule, not ours.",
      },
    ],
    links: {
      monetization: "Channel monetization policies",
      disclosure: "Disclosing altered or synthetic content",
      terms: "Credits in our terms",
    },
  },
};

export type PillarDictionary = typeof pillarEn;

/**
 * The public /studio page ("What you can make and edit"). English is the source of truth; ru.ts and uz.ts are typed
 * against it (and tests/site-copy.test.ts holds the shapes equal).
 *
 * Every sentence here describes something that is on main today; where it was checked is in the PR that added the page.
 * No figures except the ones the product itself fixes (the speeds, the cross-fade range, the frame shapes), no prices,
 * no speed or quality promise, no provider names. A feature that is not live is not listed, however close it is.
 */
export const studioPageEn = {
  meta: {
    title: "What you can make and edit · Nightshift",
    description:
      "Read the plan before a video is made, cut your own videos in the editor, keep uploads private until you publish, and see the price before anything is spent.",
  },
  hero: {
    label: "Studio",
    title: "What you can make and edit.",
    lead: "Nightshift makes a YouTube video from a topic, lets you read the plan before it is paid for, and has an editor for your own cuts. This page lists what is in the product today, and says where a tool needs setting up first.",
    cta: "Start free",
    secondary: "See pricing",
    jumpLabel: "On this page",
    jump: [
      { id: "plan", label: "The plan" },
      { id: "editor", label: "The editor" },
      { id: "publish", label: "Publishing" },
      { id: "price", label: "Price" },
      { id: "faq", label: "Questions" },
    ],
  },
  example: "Example",
  plan: {
    label: "Plan first",
    title: "Read the plan before anything is made.",
    lead: "A video starts with a topic and a price you can see. On a channel that asks for it, the run stops after the script and the scene plan and waits for you.",
    items: [
      { id: "price", title: "The price comes first", body: "You see what a video costs before it starts, and confirm a second time. If the price changes in between, you are asked again." },
      { id: "review", title: "Review the storyboard", body: "Switch it on for a channel and its runs stop at “Storyboard ready”. Nothing is rendered, and no render is charged, until you approve." },
      { id: "edit", title: "Change the plan", body: "Edit a scene’s narration or visual description, move scenes, delete one or add one. Save, and the price updates." },
      { id: "no", title: "Saying no costs nothing", body: "Discard a storyboard and nothing is rendered or charged." },
    ],
    figure:
      "Illustration of a storyboard waiting for review: three scenes with their narration and visual, and a button that approves the render and carries its price. Everything shown is an example.",
    figureTitle: "Storyboard ready",
    scene: "Scene {n}",
    narration: "Narration",
    visual: "Visual",
    scenes: [
      { narration: "At dusk the caravan reaches the square.", visual: "Wide shot, warm light" },
      { narration: "Why every route crossed this one city.", visual: "Slow pan over a market" },
      { narration: "What the traders carried, and what they left.", visual: "Close details of cloth and spice" },
    ],
    approve: "Approve and render",
    approveNote: "The price is on the button",
    discard: "Discard",
  },
  editor: {
    label: "The editor",
    title: "Cut your own videos. Editing is free.",
    lead: "The editor works on videos in your library. Editing and exporting use no credits, an export is saved to your library, and nothing is published from it.",
    items: [
      { id: "trim", title: "Trim and split", body: "Type the start and end, drag a handle, or use the arrow keys: one frame at a time, one second with Shift. Split a clip at the playhead." },
      { id: "speed", title: "Speed", body: "Play a clip at 0.5×, 0.75×, 1.25×, 1.5× or 2×." },
      { id: "crossfade", title: "Cross-fade", body: "Blend one clip into the next for 0.2 to 2 seconds. The clips overlap, so the video gets shorter by the same amount." },
      { id: "text", title: "Text on screen", body: "Add text, choose its size and whether it sits at the top, middle or bottom, and set when it shows." },
      { id: "sound", title: "Music and sound", body: "Add music or effects from your library, set the volume and fades, and have music lowered by an exact amount under the sounds you mark as speech and clips with their own sound." },
      { id: "captions", title: "Captions", body: "Make a transcript of a recording, edit the captions, pick one of four looks, and they are burned into the picture on export. Download .srt or .vtt too. The transcript is a priced step, shown before it starts, and is offered only where transcription is set up." },
      { id: "frame", title: "Frame shape", body: "Vertical 9:16, wide 16:9 or square 1:1 for the whole video. Vertical suits Shorts, Reels and TikTok." },
      { id: "fit", title: "Fit or Fill, per clip", body: "Fit shows the whole picture and adds bars; Fill crops the centre so no bars show. You cannot move the crop yet." },
      { id: "drafts", title: "Drafts", body: "Unsaved changes are kept as a draft in this browser and offered back when you reopen the project. Saving stays your button." },
    ],
    notes: [
      "The preview is approximate; the exported video is exact.",
      "One export can be up to 30 minutes long, and a daily limit applies to free exports.",
    ],
    figure:
      "Illustration of the editor: three tracks (video, text and music) with their clips, and the three frame shapes 9:16, 16:9 and 1:1. Everything shown is an example.",
    figureTitle: "Editor",
    tracks: { video: "Video", text: "Text", music: "Music" },
    clips: ["Opening", "Market", "Caravan"],
    caption: "Samarkand, 1404",
    fade: "Fade",
    frames: "Frame shape",
    crossfade: "Cross-fade",
    save: "Save",
    export: "Export",
  },
  publish: {
    label: "Publishing",
    title: "Private until you say so.",
    lead: "Nightshift does not put a video in front of your audience unless you let it. The last step is yours.",
    items: [
      { id: "private", title: "Uploads go to YouTube as private", body: "A finished video is sent to your channel as a private video, which only you and the people you share it with can watch, until it is made public." },
      { id: "check", title: "A publish check runs first", body: "Every video passes a publish check, and the verdict is shown on the video’s page: passed, or blocked and why." },
      { id: "approve", title: "Going public is your decision", body: "You watch the video and record your decision in the app. You make it public on YouTube or, on a channel where someone who manages your workspace has switched on “Publish when approved”, by approving that exact video in the app. Auto-publish and “Publish when approved” are switches per channel, and both stay off until you turn them on." },
    ],
    figure: "Illustration of a video’s state before it goes public: uploaded as private, the publish check passed, waiting for your approval. Everything shown is an example.",
    figureTitle: "Publish desk",
    lines: ["Uploaded as private", "Publish check passed", "Waiting for your approval"],
  },
  price: {
    label: "Price",
    title: "The price comes first. A failure costs nothing.",
    lead: "Nightshift runs on credits. A video, a Studio generation and a transcript each show their price before they start. Trimming, splitting and the rest of the editor use no credits.",
    link: "How credits are priced",
    ledgerLabel: "How a price becomes a charge",
  },
  faq: {
    label: "Questions",
    title: "Before you start.",
    items: [
      {
        id: "pay",
        q: "What do I pay?",
        a: "Nightshift runs on credits. Every video, Studio generation and transcript shows its price in credits before it starts. The credits are held when it starts and charged when it finishes, never more than the price you saw. Editing and exporting in the editor use no credits.",
      },
      {
        id: "fails",
        q: "What if a run fails?",
        a: "The credits held for it go back to your balance on their own. You do not need to ask, and your credit history shows each hold, charge and return.",
      },
      {
        id: "publishes",
        q: "Do you publish for me?",
        a: "Only if you switch it on. Finished videos go to YouTube as private and pass a publish check first. Auto-publish is off for a channel until you turn it on. “Publish when approved” is also off until someone who manages your workspace turns it on for a channel; then approving that exact video in the app asks YouTube to make it public.",
      },
      {
        id: "languages",
        q: "Which languages does it work in?",
        a: "The app is in Uzbek, Russian and English. Each channel is set to one of the three for its videos, and captions in the editor can be made in the languages the transcription model supports.",
      },
      {
        id: "channel",
        q: "Can I use my own channel?",
        a: "Yes. You connect your own YouTube channel through Google’s consent screen, and Nightshift uploads only to the channel you connect. You can disconnect it, or revoke access in your Google account, at any time.",
      },
      {
        id: "private",
        q: "What is a private upload?",
        a: "On YouTube, a private video can be watched only by you and the people you share it with. Nightshift sends every finished video to your channel that way first, and it becomes public only when you make it public: on YouTube or, where “Publish when approved” is on for the channel, by approving it in the app.",
      },
      {
        id: "data",
        q: "What happens to my data?",
        a: "Your Google data is used only to upload to the channel you connect and to show you that channel’s analytics, never for advertising. Access tokens are encrypted and never reach the browser. Nightshift uses no analytics, advertising or tracking tools.",
      },
      {
        id: "drafts",
        q: "What happens to my drafts?",
        a: "In the editor, unsaved changes are kept as a draft in this browser for up to 14 days and offered back when you reopen the project. A draft is not applied if the project was saved again after it was made, and it is cleared when you sign out. Only Save puts changes in your account.",
      },
    ],
    links: { pay: "See pricing", fails: "Terms: credits and refunds", data: "Read the Privacy Policy" },
  },
  caveat: "Some tools need setting up on this deployment first. For example, auto-captions are offered only where a transcription is set up and priced, and the app says so when one is not.",
  final: {
    title: "Start with a topic.",
    lead: "Start free. See the price before every run, and every video stays private until you make it public.",
    cta: "Start free",
  },
};

export type StudioPageDictionary = typeof studioPageEn;

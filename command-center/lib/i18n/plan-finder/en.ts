/**
 * "What does my plan make?" on /pricing (lib/plan-finder.ts): each plan card's outputs, the plan finder and the per-item
 * cost table. English is the source of truth; ru.ts and uz.ts are typed against it. `{name}` fillers are filled with fmt().
 *
 * Words to keep: a figure is "≈" and rounded down; a missing rate reads "price unavailable", never a number; the voice
 * does not change the quote (the price list has one per-minute rate); and a failed run gives its hold back, exactly as
 * modules/credits.py and migration 0020 do it. Counts are written as "label: number", so no language needs a plural form.
 */
export const planFinderEn = {
  card: {
    youtube: "Finished YouTube videos",
    images: "Studio images",
    clips: "Studio video clips",
    studio: "Studio outputs",
    approx: "≈ {n}",
    range: "≈ {low}–{high}",
    lessThanOne: "fewer than one",
    unavailable: "price unavailable",
    /** Under the YouTube figure: the settings it was worked out for. */
    youtubeSettings: "{m} min each · any voice · {res}",
    /** Under a Studio range: the dearest setting, then the cheapest. */
    fromTo: "{low} to {high}",
    one: "{model}",
    withSetting: "{model}, {setting}",
    clip: "{s} s",
    signedOut: "Per-model prices are shown when you sign in.",
    failed: "The Studio's prices could not be read.",
    noneOnSale: "None on sale yet.",
    welcome: "From the free credits you start with.",
  },
  stamp: {
    set: "Rate set {date}",
    read: "Rate as read on {date}",
  },
  finder: {
    title: "What does my plan make?",
    lead: "Tell us what your channels make in a month. The card works it out from today's per-minute rate, the same one Run now holds credits with, and picks the smallest plan that covers it.",
    formLabel: "Your month",
    channels: "Channels",
    perWeek: "Videos a week, on each channel",
    length: "Length of each video, in minutes",
    fewer: "Fewer",
    more: "More",
    voice: "Voice",
    voiceStandard: "Standard voice",
    voicePremium: "Premium voice",
    voiceNote: "The voice does not change the price: the price list has one per-minute rate for every voice.",
    rerun: "Room for runs made again",
    rerunNone: "None",
    rerunStep: "+{n}%",
    rerunNote: "A run made again is a new run with its own quote. This adds room for it.",
    matchTitle: "Your match",
    recommended: "Recommended for you",
    usage: "Expected use: {used} of {credits} {unit} a month",
    spare: "Left over: {n} {unit}",
    over: "More than any plan here. {plan} has {credits} credits a month: {short} short. Top-up packs cover the rest.",
    noPlans: "No plan is on sale here, so there is nothing to match. Top-up packs are listed below.",
    unavailable: "Price unavailable: no per-minute rate is published, so the month cannot be worked out.",
    seePlan: "See the plan",
    videos: "Videos a month",
    videosHow: "{c} × {w} a week × 52/12 weeks, rounded up",
    perVideo: "Each video",
    perVideoHow: "{m} min × {rate} credits a minute",
    perVideoFloor: "the smallest hold of any run",
    headroom: "Room for runs made again (+{p}%)",
    total: "At most, a month",
    credits: "{n} {unit}",
    bar: "{plan}: {used} of {credits} {unit}",
    barOver: "Over every plan: {used} {unit}",
    charge: "A run is never charged more than its quote: it is charged what it used, or the quote when part of it has no price.",
    concept: "A channel with concept thumbnails on also pays for up to {n} generated pictures per video. This leaves them out.",
  },
  table: {
    title: "What each item costs",
    lead: "Credits per unit, as charged today. Only what is on sale has a price; anything else says so.",
    caption: "Credits per item",
    item: "Item",
    setting: "Setting",
    credits: "Credits",
    per: "Per",
    youtube: "YouTube autopilot",
    minute: "A finished minute of video",
    perMinute: "per minute",
    minimum: "The smallest hold of any run",
    perRun: "per run",
    studio: "Studio",
    notOnSale: "Not on sale",
    notOpen: "Not open to any workspace yet",
    firstPurchase: "After a first credit purchase",
    unpublished: "No per-minute rate is published yet.",
    signedOut: "Studio prices, model by model, are shown when you sign in.",
    signIn: "Sign in",
    failed: "The Studio's prices could not be read, so none is shown rather than a guess.",
    notEnabled: "The Studio's models are not set up on this deployment.",
    empty: "No Studio model is on sale yet.",
  },
  /** The one line on failures: modules/credits.py (a failed run is released in full), 0020 (an unstarted hold expires
   *  after 3 hours), 0036 (a failed, cancelled or expired generation is released). */
  failures:
    "If a run or a generation fails, is cancelled or never starts, its whole hold goes back to your balance and nothing is charged. A hold that never started returns by itself after about 3 hours.",
};

export type PlanFinderDictionary = typeof planFinderEn;

/**
 * The live canvas's node cards (components/live): what a card says about its own state. Source of truth for ./ru and ./uz.
 * Kind labels are set in capitals by CSS (.ds-t-label), so they are written here in sentence case: an uppercase string would
 * be read letter by letter by some screen readers.
 */
export const liveNodesEn = {
  kind: {
    script: "Script",
    shot: "Shot {n}",
    character: "Character",
    location: "Location",
    prop: "Prop",
    still: "Still",
    clip: "Clip",
    voice: "Voice",
    music: "Music",
    film: "Film",
  },
  state: {
    ghost: "Planned",
    queued: "Queued",
    working: "Working",
    arrived: "Ready",
    failed: "Needs you",
    disabled: "Not available",
    insufficient: "Needs credits",
  },
  /** A working card's phase word: what the job is doing, as the server reported it. */
  phase: {
    queued: "Queued",
    making: "Making",
    storing: "Storing",
  },
  /** {n}: the vendor's own queue position, shown only when the vendor reports one. */
  queuePosition: "Position {n} in the vendor's queue",
  /** The elapsed timer, for a screen reader: "Elapsed 1:05". */
  elapsed: "Elapsed {time}",
  /** A percentage the vendor itself measured (never estimated here). */
  measured: "{pct}% done, as the provider reports it",
  progressLabel: "Progress",
  /** Over a prompt revealed on the card: the server already checked this text. */
  written: "Written",
  prompt: "Prompt",
  model: "Model",
  price: "{n} {unit}",
  priceLabel: "Price",
  open: "Open {name}",
  failed: {
    cause: "What happened",
    remedy: "What to do",
    retry: "Retry this one · {n} {unit}",
    /** The backend gave no price for a retry: it cannot be pressed. */
    retryUnpriced: "Retry · price unavailable",
    retrying: "Retrying…",
  },
  insufficient: {
    shortfall: "Needs {n} more {unit} than you have.",
    topUp: "Add credits",
  },
  ready: "Your {kind} is ready.",
  /** The alt text of an arrived picture when the caller has no better one. */
  resultAlt: "Result for {name}",
  empty: {
    title: "Your canvas is empty",
    prompt: "Write one sentence in the chat, and the plan will appear here.",
    examplesLabel: "Try one of these",
    examples: [
      "A lighthouse keeper finds a letter from 1952",
      "A 30-second ad for a small coffee roaster",
      "How a city gets its water, for curious kids",
    ],
  },
  /** The style guide's specimen (operators only): every card here is a fixture, said so on the page. */
  specimen: {
    title: "Live canvas nodes",
    note: "Fixtures, not a real run. Each card shows one state the live canvas can be in.",
    replay: "Play the arrival again",
    connectors: "Connectors by data type",
  },
};

export type LiveNodesDictionary = typeof liveNodesEn;

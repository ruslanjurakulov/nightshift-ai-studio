/**
 * Fixtures for the live canvas's cards: one per state, for the style guide's specimen and the tests. Not a real run, and the
 * specimen says so on the page. The prices, models and timings are made-up sample values for drawing the card; nothing
 * here is ever shown as a quote.
 */
import type { LiveNodeProps } from "./LiveNode";

/** A drawn sample picture (an inline SVG), so the "arrived" card is shown without a network or a signed URL. */
export const SAMPLE_STILL =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2a4a"/><stop offset="1" stop-color="#e58a4b"/></linearGradient></defs><rect width="320" height="180" fill="url(#s)"/><circle cx="232" cy="118" r="26" fill="#ffd27a"/><path d="M0 140 L70 112 L130 132 L200 104 L320 136 L320 180 L0 180 Z" fill="#0b1324"/><rect x="58" y="70" width="10" height="46" fill="#e6eefc"/><path d="M56 70 h14 l-7 -10 z" fill="#ff5c6c"/></svg>`,
  );

export type LiveFixture = Omit<LiveNodeProps, "onOpen" | "onRetry">;

export function liveFixtures(now: number): LiveFixture[] {
  return [
    {
      id: "scene",
      kind: "scene",
      scene: 4,
      state: "ghost",
      title: "The keeper climbs the stairs",
      summary: "Night. A spiral stair inside the tower, lamplight above; Mara climbs with the letter in her hand.",
      durationS: 8,
      durationBasis: "planned",
      provisional: true,
    },
    { id: "ghost", kind: "shot", shot: 4, state: "ghost", title: "The keeper climbs the stairs" },
    {
      id: "queued",
      kind: "character",
      state: "queued",
      title: "Mara, the keeper",
      prompt: "Woman in her sixties, wind-cut face, oilskin coat, grey braid; warm lamplight from below.",
      model: "image-model-a",
      price: 12,
    },
    {
      id: "working",
      kind: "still",
      shot: 2,
      state: "working",
      phase: "making",
      title: "Shot 02: the letter on the table",
      prompt: "Close-up, an envelope dated 1952 on a scarred oak table, a brass lamp at frame left, dust in the light.",
      model: "image-model-a",
      startedAt: now - 65_000,
      price: 12,
    },
    {
      id: "measured",
      kind: "clip",
      shot: 3,
      state: "working",
      phase: "making",
      title: "Shot 03: the beam sweeps the sea",
      model: "video-model-b",
      startedAt: now - 92_000,
      progress: 0.42,
      queuePosition: null,
    },
    {
      id: "arrived",
      kind: "still",
      shot: 1,
      state: "arrived",
      title: "Shot 01: the lighthouse at dusk",
      prompt: "Wide, a white lighthouse on black rocks at dusk, the sun low over a calm sea.",
      model: "image-model-a",
      mediaSrc: SAMPLE_STILL,
      mediaAlt: "A lighthouse on dark rocks at dusk",
      selected: true,
    },
    {
      id: "failed",
      kind: "clip",
      shot: 5,
      state: "failed",
      title: "Shot 05: the storm reaches the window",
      model: "video-model-b",
      failureCause: "The provider refused this shot's prompt.",
      failureRemedy: "Change the prompt in Details, then retry this shot only.",
      retryPrice: 40,
    },
    {
      id: "failed-unpriced",
      kind: "voice",
      state: "failed",
      title: "Narration, chapter 2",
      failureCause: "The voice provider did not answer in time.",
      failureRemedy: "Retry when its price is available again.",
      retryPrice: null,
    },
    {
      id: "disabled",
      kind: "music",
      state: "disabled",
      title: "Score",
      reason: "Music is not available on this workspace's plan yet.",
    },
    {
      id: "unknown",
      kind: "clip",
      shot: 6,
      state: "unknown",
      title: "Shot 06: the keeper reads",
      reason: "This step's result could not be read.",
      durationS: 5,
      durationBasis: "measured",
    },
    {
      id: "insufficient",
      kind: "film",
      state: "insufficient",
      title: "Assembly",
      price: 60,
      shortfallCredits: 18,
      topUpHref: "/all-channels/credits",
    },
  ];
}

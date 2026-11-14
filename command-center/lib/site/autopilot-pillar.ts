/**
 * The YouTube Autopilot pillar (/solutions/youtube-channels, components/site/AutopilotPillar.tsx): the pure half.
 *
 * Three things live here so a test can hold each one against the code it describes (tests/autopilot-pillar.test.tsx):
 *
 * - the run's stages in main.py's order, and for each one which of the cost ledger's units it records
 *   (modules/cost_ledger.py), so "what it costs" never says more than the ledger measures;
 * - the "You stay in control" facts: the default privacy (config.YOUTUBE_PRIVACY), how long an approval holds
 *   (migrations 0112/0116/0145), and the two switches that are off until someone turns them on (0116 and the worker's env);
 * - the composer's link: the run form with a topic filled in, through sign-up. It is a link and nothing more (CLAUDE.md #3):
 *   the run form shows the price and asks again before anything is held or started.
 */
import { ALL_CHANNELS_SLUG } from "@/lib/channels";
import { HOME_FORMATS, TOPIC_MAX, lengthSeconds, runHandoffHref, type HomeFormatId, type HomeLanguage } from "@/lib/home";
import { SIGNUP_PATH } from "@/lib/public-paths";
import { fitsAfterSignup } from "@/lib/safe-redirect";
import { APPROVAL_TTL_HOURS } from "@/lib/videoApproval";

// ── the control facts ───────────────────────────────────────────────────────

/** config.py `YOUTUBE_PRIVACY = os.getenv("YOUTUBE_PRIVACY", "private")`: what every upload asks for unless told otherwise. */
export const DEFAULT_UPLOAD_PRIVACY = "private";
/** approve_video_publish's `now() + interval '24 hours'` (0112, redefined in 0116 and 0145 with the same interval). */
export const APPROVAL_HOURS = APPROVAL_TTL_HOURS;
/** 0116 adds the per-channel "Publish when approved" switch as `not null default false`: off for every channel. */
export const PUBLISH_ON_APPROVE_DEFAULT = false;
/** `channels.auto_publish boolean not null default false` (0004): the auto-publish switch is off for every channel. */
export const AUTO_PUBLISH_DEFAULT = false;
/** modules/visibility_publish.enabled(): the worker that carries out "Publish when approved" reads this, default "off". */
export const VISIBILITY_WORKER_ENV = "NIGHTSHIFT_VISIBILITY_PUBLISH";

// ── the stages ──────────────────────────────────────────────────────────────

/**
 * What the run's cost record counts, in words a reader knows: language-model tokens, characters narrated, footage searches and
 * generated clips or pictures, seconds of rendering, bytes uploaded. tests/autopilot-pillar.test.tsx maps each group to
 * modules/cost_ledger.py's unit names and to the main.py line that records it (the names carry a provider's, so they stay out
 * of the page and its bundle).
 */
export const LEDGER_GROUPS = ["tokens", "narration", "footage", "render", "upload"] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

/**
 * One stage of a run, in main.py's order. `meters` is the ledger group main.py records for it (null: the stage records no
 * unit of its own). `paid` says whether it is inside the run's one price: a run is quoted per finished minute and held before
 * it starts (modules/credits.py), and nothing after the upload is charged in credits.
 *
 * The publish check comes BEFORE the private upload: main.py evaluates publish_gate on the rendered file and uploads only an
 * allowed video (main.py "Stage 8: Upload"). Its stored verdict is asked for again before anything is approved or made public.
 */
export const PILLAR_STAGES = [
  { id: "topic", meters: "tokens", paid: true },
  { id: "research", meters: null, paid: true },
  { id: "script", meters: "tokens", paid: true },
  { id: "factcheck", meters: "tokens", paid: true },
  { id: "voice", meters: "narration", paid: true },
  { id: "visuals", meters: "footage", paid: true },
  { id: "render", meters: "render", paid: true },
  { id: "gate", meters: null, paid: true },
  { id: "upload", meters: "upload", paid: true },
  { id: "approve", meters: null, paid: false },
  { id: "public", meters: null, paid: false },
] as const satisfies readonly { id: string; meters: LedgerGroup | null; paid: boolean }[];
export type PillarStageId = (typeof PILLAR_STAGES)[number]["id"];

// ── the genres and the composer's link ──────────────────────────────────────

/**
 * The genre tabs. Each only fills the composer: a starter topic in the visitor's language and the length of the matching
 * Home format (lib/home HOME_FORMATS). Only kids travels as a format (`format=kids`): the run form then starts with YouTube's
 * "made for kids" on (lib/madeForKids.ts, migration 0145), which is why that tab carries the COPPA note.
 */
export const PILLAR_GENRES = [
  { id: "history", format: "story" },
  { id: "mystery", format: "story" },
  { id: "explainer", format: "explainer" },
  { id: "kids", format: "kids" },
] as const satisfies readonly { id: string; format: HomeFormatId }[];
export type PillarGenreId = (typeof PILLAR_GENRES)[number]["id"];

/** The run length a genre asks for, in seconds: the matching Home format's. */
export function genreSeconds(id: PillarGenreId): number {
  const genre = PILLAR_GENRES.find((g) => g.id === id)!;
  const format = HOME_FORMATS.find((f) => f.id === genre.format)!;
  return lengthSeconds(format.length);
}

/** The run form in the all-channels workspace, with this topic (cut to `max` characters, on a word) and the genre's length. */
function runForm(topic: string, genre: PillarGenreId, language: HomeLanguage, max: number): string {
  const clean = topic.replace(/\s+/g, " ").trim().slice(0, TOPIC_MAX);
  const chars = Array.from(clean);
  let words = clean;
  if (chars.length > max) {
    const head = chars.slice(0, Math.max(0, max)).join("");
    const space = head.search(/\s\S*$/);
    words = (space > 0 ? head.slice(0, space) : head).trim();
  }
  const format = PILLAR_GENRES.find((g) => g.id === genre)!.format;
  return runHandoffHref(ALL_CHANNELS_SLUG, { topic: words, seconds: genreSeconds(genre), language, format });
}

/**
 * Where the composer sends a signed-out visitor: sign-up, then the run form with the topic filled in. The topic is cut (on a
 * word) until the form still fits through sign-up's callback and /welcome (lib/safe-redirect afterSignupPath); null for an
 * empty topic, so the composer asks for one instead of opening an empty form.
 */
export function pillarComposeHref(topic: string, genre: PillarGenreId, language: HomeLanguage): string | null {
  if (!topic.trim()) return null;
  let path = runForm(topic, genre, language, Number.MAX_SAFE_INTEGER);
  if (!fitsAfterSignup(path)) {
    let lo = 0;
    let hi = Array.from(topic).length;
    let best: string | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const p = runForm(topic, genre, language, mid);
      if (fitsAfterSignup(p)) {
        best = p;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!best) return SIGNUP_PATH;
    path = best;
  }
  return `${SIGNUP_PATH}?next=${encodeURIComponent(path)}`;
}

// ── structured data ─────────────────────────────────────────────────────────

/**
 * schema.org HowTo from the page's own "where to start" steps (the person's three steps, not the bot's stages: a HowTo is
 * what a reader does). The same strings the page prints, plain text.
 */
export function howToJsonLd(input: { name: string; steps: readonly string[]; inLanguage: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: input.name,
    inLanguage: input.inLanguage,
    step: input.steps.map((text, i) => ({ "@type": "HowToStep", position: i + 1, name: text, text })),
  };
}

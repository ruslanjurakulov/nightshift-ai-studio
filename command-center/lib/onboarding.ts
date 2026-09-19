// Onboarding / health checklist — pure logic, no I/O.
//
// The page (app/(app)/[channel]/getting-started/page.tsx) gathers the REAL live
// state (Supabase config, the signed-in user, GitHub forwarding, provider
// secrets, routing variables, a connected YouTube credential, and the channel /
// team / series counts) and hands it here as a plain object of booleans. This
// module decides, deterministically, which steps are done and what the overall
// progress is — so the ordering and the progress maths are unit-testable without
// a database, a request, or a network call.
//
// Every step maps to an existing page that fixes it (`href`, channel-relative —
// the page runs it through the channel-scoped path helper). Nothing here invents
// state: a step is `done` only when its signal is genuinely true.

/** The live signals the checklist reads. Each is a fact the page verified. */
export interface OnboardingState {
  /** NEXT_PUBLIC Supabase URL + anon key are both present. */
  supabaseConfigured: boolean;
  /** A user is signed in (RLS acts as them). */
  signedIn: boolean;
  /** The GitHub secrets/variables forwarding token + repo are set. */
  githubConfigured: boolean;
  /** At least one provider API key is set (listConfiguredSecretNames non-empty). */
  providerKeySet: boolean;
  /** The pipeline's video routing variable is set (readVariables has it). */
  routingSet: boolean;
  /** A channel's YouTube upload is connected, or the OAuth flow is configured. */
  youtubeConnected: boolean;
  /** At least one channel row exists. */
  hasChannel: boolean;
  /** At least one team member/owner has claimed a seat (app_members non-empty). */
  hasMember: boolean;
  /** At least one content series exists. */
  hasSeries: boolean;
}

/** The stable key of a checklist step — matches an i18n `onboarding.step_*` key. */
export type OnboardingStepKey =
  | "supabase"
  | "signedIn"
  | "github"
  | "provider"
  | "routing"
  | "youtube"
  | "channel"
  | "member"
  | "series";

export interface ChecklistItem {
  key: OnboardingStepKey;
  done: boolean;
  /** Channel-relative path to the page that fixes this step. */
  href: string;
}

export interface ChecklistProgress {
  done: number;
  total: number;
  /** Whole-number percentage, 0–100 (0 when there are no steps). */
  pct: number;
}

export interface Checklist {
  items: ChecklistItem[];
  progress: ChecklistProgress;
}

/**
 * The ordered steps: from "the backend is wired" to "a channel can actually
 * publish its first automated video". The order is the natural setup path, so
 * the first `todo` is always the next thing to do.
 */
const STEPS: { key: OnboardingStepKey; href: string; signal: (s: OnboardingState) => boolean }[] = [
  { key: "supabase", href: "/integrations", signal: (s) => s.supabaseConfigured },
  { key: "signedIn", href: "/members", signal: (s) => s.signedIn },
  { key: "github", href: "/integrations", signal: (s) => s.githubConfigured },
  { key: "provider", href: "/providers", signal: (s) => s.providerKeySet },
  { key: "routing", href: "/providers", signal: (s) => s.routingSet },
  { key: "youtube", href: "/providers", signal: (s) => s.youtubeConnected },
  { key: "channel", href: "/channels", signal: (s) => s.hasChannel },
  { key: "member", href: "/members", signal: (s) => s.hasMember },
  { key: "series", href: "/series", signal: (s) => s.hasSeries },
];

/** Compute the ordered checklist and overall progress from live state. */
export function computeChecklist(state: OnboardingState): Checklist {
  const items: ChecklistItem[] = STEPS.map(({ key, href, signal }) => ({
    key,
    href,
    done: signal(state),
  }));
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { items, progress: { done, total, pct } };
}

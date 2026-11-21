import { describe, expect, it } from "vitest";
import {
  computeChecklist,
  type OnboardingState,
  type OnboardingStepKey,
} from "@/lib/onboarding";

const FRESH: OnboardingState = {
  supabaseConfigured: false,
  signedIn: false,
  githubConfigured: false,
  providerKeySet: false,
  routingSet: false,
  youtubeConnected: false,
  hasChannel: false,
  hasMember: false,
  hasSeries: false,
};

const FULL: OnboardingState = {
  supabaseConfigured: true,
  signedIn: true,
  githubConfigured: true,
  providerKeySet: true,
  routingSet: true,
  youtubeConnected: true,
  hasChannel: true,
  hasMember: true,
  hasSeries: true,
};

const EXPECTED_ORDER: OnboardingStepKey[] = [
  "supabase",
  "signedIn",
  "github",
  "provider",
  "routing",
  "youtube",
  "channel",
  "member",
  "series",
];

describe("computeChecklist", () => {
  it("fresh state: every step todo, progress 0%", () => {
    const { items, progress } = computeChecklist(FRESH);
    expect(items).toHaveLength(9);
    expect(items.every((i) => i.done === false)).toBe(true);
    expect(progress).toEqual({ done: 0, total: 9, pct: 0 });
  });

  it("fully configured: every step done, progress 100%", () => {
    const { items, progress } = computeChecklist(FULL);
    expect(items.every((i) => i.done === true)).toBe(true);
    expect(progress).toEqual({ done: 9, total: 9, pct: 100 });
  });

  it("keeps a stable setup order and gives every step a fixing href", () => {
    const { items } = computeChecklist(FRESH);
    expect(items.map((i) => i.key)).toEqual(EXPECTED_ORDER);
    expect(items.every((i) => i.href.startsWith("/"))).toBe(true);
  });

  it("partial state: only the true signals are done, pct rounds", () => {
    // Backend wired + signed in + one provider key + a channel = 4 of 9.
    const partial: OnboardingState = {
      ...FRESH,
      supabaseConfigured: true,
      signedIn: true,
      providerKeySet: true,
      hasChannel: true,
    };
    const { items, progress } = computeChecklist(partial);

    const doneKeys = items.filter((i) => i.done).map((i) => i.key);
    expect(doneKeys).toEqual(["supabase", "signedIn", "provider", "channel"]);
    expect(progress.done).toBe(4);
    expect(progress.total).toBe(9);
    expect(progress.pct).toBe(44); // Math.round(4 / 9 * 100) = 44
  });
});

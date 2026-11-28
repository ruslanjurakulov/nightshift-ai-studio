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
  "series",
];

describe("computeChecklist", () => {
  it("fresh state: every step todo, progress 0%", () => {
    const { items, progress } = computeChecklist(FRESH);
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.done === false)).toBe(true);
    expect(progress).toEqual({ done: 0, total: 8, pct: 0 });
  });

  it("fully configured: every step done, progress 100%", () => {
    const { items, progress } = computeChecklist(FULL);
    expect(items.every((i) => i.done === true)).toBe(true);
    expect(progress).toEqual({ done: 8, total: 8, pct: 100 });
  });

  it("keeps a stable setup order and gives every step a fixing href", () => {
    const { items } = computeChecklist(FRESH);
    expect(items.map((i) => i.key)).toEqual(EXPECTED_ORDER);
    expect(items.every((i) => i.href.startsWith("/"))).toBe(true);
  });

  it("no step sends anyone to the removed Team page", () => {
    // /members only redirects now; a checklist link to it would be a step nobody can complete there.
    const { items } = computeChecklist(FRESH);
    expect(items.some((i) => i.href === "/members")).toBe(false);
  });

  it("partial state: only the true signals are done, pct rounds", () => {
    // Backend wired + signed in + one provider key + a channel = 4 of 8.
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
    expect(progress.total).toBe(8);
    expect(progress.pct).toBe(50); // Math.round(4 / 8 * 100) = 50
  });
});

import { describe, expect, it, vi } from "vitest";

// github-secrets is `server-only`; neutralize the guard for the test runner.
vi.mock("server-only", () => ({}));

import {
  PROVIDERS,
  PROVIDER_SECRET_NAMES,
  providersByCategory,
  isConfigured,
} from "../lib/providers";

const { isWritableSecretName } = await import("../lib/server/github-secrets");

describe("provider registry", () => {
  it("gives every provider a unique id and secret name", () => {
    const ids = PROVIDERS.map((p) => p.id);
    const secrets = PROVIDERS.map((p) => p.secretName);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(secrets).size).toBe(secrets.length);
  });

  it("uses https console URLs only", () => {
    for (const p of PROVIDERS) {
      expect(p.consoleUrl, p.id).toMatch(/^https:\/\//);
    }
  });

  it("every provider secret name is writable through the allowlist", () => {
    // The whole point of sharing one list: a key typed on the board must be
    // accepted by the secrets endpoint, never silently refused.
    for (const name of PROVIDER_SECRET_NAMES) {
      expect(isWritableSecretName(name), name).toBe(true);
    }
  });

  it("groups by category without dropping or duplicating providers", () => {
    const groups = providersByCategory();
    const flat = groups.flatMap((g) => g.items);
    expect(flat).toHaveLength(PROVIDERS.length);
    // Each group is non-empty and internally consistent.
    for (const g of groups) {
      expect(g.items.length).toBeGreaterThan(0);
      for (const p of g.items) expect(p.category).toBe(g.category);
    }
  });
});

describe("isConfigured", () => {
  it("is true only when the provider's secret name is present", () => {
    const gemini = PROVIDERS.find((p) => p.id === "gemini")!;
    const higgs = PROVIDERS.find((p) => p.id === "higgsfield")!;
    const set = ["GEMINI_API_KEY"];
    expect(isConfigured(gemini, set)).toBe(true);
    expect(isConfigured(higgs, set)).toBe(false);
    // Accepts a Set too.
    expect(isConfigured(gemini, new Set(set))).toBe(true);
  });
});

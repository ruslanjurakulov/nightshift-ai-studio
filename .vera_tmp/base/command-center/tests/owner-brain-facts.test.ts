import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { paymentPlan } from "@/lib/owner-analytics/payment-plan";
import type { ProviderRunway } from "@/lib/owner-analytics/runway";

vi.mock("server-only", () => ({}));

// Synthetic figures only: no real price, top-up or balance.
const NOW = Date.parse("2026-11-21T12:00:00Z");
const row = (over: Partial<ProviderRunway>): ProviderRunway =>
  ({
    id: "minimax", name: "MiniMax", left: 50, leftUsd: 50, leftNative: null, nativeRunway: false, perDay7d: 10, perDay14d: 10,
    status: "ok", emptyUnchecked: false, perDay14dEstimate: false, autoRecharge: false, checkedAt: null, models: [],
    ledger: { remaining: { kind: "estimate", usd: 50, credits: null } },
    ...over,
  }) as unknown as ProviderRunway;

describe("owner payment plan", () => {
  it("lists a provider that runs out inside the plan, pays a day early, and asks for ten days of the 14-day pace", () => {
    const p = paymentPlan([row({})], NOW);
    expect(p.due).toHaveLength(1);
    expect(p.due[0]).toMatchObject({ reason: "runs_out", runsOutOn: "2026-11-26", payBy: "2026-11-25", amount: 100, basis: "estimated" });
    expect(p.due[0].topUpUrl).toMatch(/^https:\/\//);
  });

  it("rounds up to a minimum top-up only when one is known, and says none is recorded otherwise", () => {
    expect(paymentPlan([row({})], NOW, 10, { minimax: 30 }).due[0].amount).toBe(120);
    expect(paymentPlan([row({})], NOW).due[0].minimumTopUp).toBeNull();
  });

  it("puts an empty provider first, due today, whatever an estimate says is left", () => {
    const p = paymentPlan([row({ id: "kling", name: "Kling", left: 1000 }), row({ status: "empty" })], NOW);
    expect(p.due[0]).toMatchObject({ provider: "minimax", reason: "empty", payBy: "2026-11-21" });
  });

  it("never reads an unknown pace or balance as nothing to pay", () => {
    const p = paymentPlan([row({ perDay14d: null }), row({ id: "kling", name: "Kling", left: null })], NOW);
    expect(p.due).toHaveLength(0);
    expect(p.unknown.map((l) => l.reason)).toEqual(["unknown", "unknown"]);
    expect(p.unknown.find((l) => l.provider === "minimax")?.amount).toBeNull();
  });

  it("cannot judge a provider whose empty check did not run, and asks for no amount for an empty one with no pace", () => {
    expect(paymentPlan([row({ emptyUnchecked: true })], NOW).unknown).toHaveLength(1);
    expect(paymentPlan([row({ status: "empty", perDay14d: 0 })], NOW).due[0]).toMatchObject({ reason: "empty", amount: null });
    // 10 × 0.07 is 0.7000000000000001 in floats: one cent of noise must not round up.
    expect(paymentPlan([row({ perDay14d: 0.07, left: 0.1 })], NOW).due[0].amount).toBe(0.7);
  });

  it("labels the provider's own reading measured, and keeps a self-recharging provider off the due list", () => {
    const measured = row({ ledger: { remaining: { kind: "reported", amount: 50, unit: "usd", checkedAt: "2026-11-21T10:00:00Z", usd: 50 } } as never, checkedAt: "2026-11-21T10:00:00Z" });
    expect(paymentPlan([measured], NOW).due[0]).toMatchObject({ basis: "measured", asOf: "2026-11-21T10:00:00Z" });
    expect(paymentPlan([row({ autoRecharge: true })], NOW).fine).toHaveLength(1);
  });
});

describe("owner facts are the owner's only", () => {
  it("refuses to build for anyone but the platform owner, before reading anything", async () => {
    vi.resetModules();
    const read = vi.fn();
    vi.doMock("@/lib/server/owner-analytics", () => ({ ownerAccess: async () => "denied", readMoney: read }));
    vi.doMock("@/lib/server/owner-runway", () => ({ readRunway: read }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: read }));
    const { buildOwnerFacts, OwnerOnlyError } = await import("@/lib/server/owner-brain-facts");
    await expect(buildOwnerFacts(NOW)).rejects.toBeInstanceOf(OwnerOnlyError);
    expect(read).not.toHaveBeenCalled();
  });

  // The customer side of Nightshift Brain must not be able to reach the owner's facts at all — not by a prompt rule, by the
  // import graph. Walks every import from the customer Brain code and from every route outside the owner's zones.
  it("no customer route or Brain module imports the owner facts, directly or through another file", () => {
    const root = path.resolve(__dirname, "..");
    const OWNER_ONLY = [/^lib\/server\/owner-brain-facts\.ts$/];
    const OWNER_ZONES = [/^app\/\(owner\)\//, /^app\/owner\//, /^app\/api\/brain\/owner\//, /^app\/api\/owner-/, /^app\/\(app\)\/\[channel\]\/owner-analytics\//];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = path.join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n)) files.push(path.relative(root, f));
      }
    };
    for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(root, path.dirname(from), spec) : null;
      if (!base) return null;
      const noJs = base.replace(/\.(m|c)?jsx?$/, "");
      for (const c of [base, `${noJs}.ts`, `${noJs}.tsx`, `${noJs}.mts`, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        if (existsSync(c) && statSync(c).isFile()) return path.relative(root, c);
      }
      return null;
    };
    const imports = new Map<string, string[]>();
    const edges = (f: string) => {
      if (!imports.has(f)) {
        // Comments stripped first: an apostrophe in one ("the owner's facts") would end the specifier match early.
        const src = readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        const specs = [...src.matchAll(/\bfrom\s*['"`]([^'"`]+)['"`]|\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
        imports.set(f, specs.map((s) => resolve(f, s)).filter((x): x is string => x !== null));
      }
      return imports.get(f)!;
    };
    const entries = files.filter(
      (f) => (f.startsWith("app/") || f.startsWith("lib/brain/") || f.startsWith("components/")) && !OWNER_ZONES.some((z) => z.test(f)) && !OWNER_ONLY.some((o) => o.test(f)),
    );
    // Not vacuous: the customer Brain's own route is walked (it must exist and not sit in an owner zone).
    if (existsSync(path.join(root, "app/api/brain/turn/route.ts"))) expect(entries).toContain("app/api/brain/turn/route.ts");
    expect(entries.some((e) => e.startsWith("app/api/brain/owner/"))).toBe(false);
    const leaks: string[] = [];
    for (const e of entries) {
      const seen = new Set<string>([e]);
      const stack = [e];
      while (stack.length) {
        const f = stack.pop()!;
        for (const n of edges(f)) {
          if (OWNER_ONLY.some((o) => o.test(n))) leaks.push(`${e} → … → ${f} → ${n}`);
          // Owner-zone files are walked too: a customer route reaching the facts through a helper in app/(owner)/ is a leak.
          else if (!seen.has(n)) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  // Catch-all behind the graph walk, for the forms no regex follows (a computed import, a string built at runtime): outside
  // the owner's zones, no file so much as names the module.
  it("no file outside the owner's zones names the owner facts module", () => {
    const root = path.resolve(__dirname, "..");
    const OWNER_ZONES = [/^app\/\(owner\)\//, /^app\/owner\//, /^app\/api\/brain\/owner\//, /^app\/api\/owner-/, /^app\/\(app\)\/\[channel\]\/owner-analytics\//, /^lib\/server\/owner-brain-facts\.ts$/];
    const named: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = path.join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(n)) {
          const rel = path.relative(root, f);
          if (!OWNER_ZONES.some((z) => z.test(rel)) && /owner-brain-facts|buildOwnerFacts|loadOwnerFacts|owner\/_facts/.test(readFileSync(f, "utf8"))) named.push(rel);
        }
      }
    };
    for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
    expect(named).toEqual([]);
  });
});

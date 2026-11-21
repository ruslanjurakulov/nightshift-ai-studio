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
    status: "ok", autoRecharge: false, checkedAt: null, models: [],
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
    const OWNER_ZONES = [/^app\/\(owner\)\//, /^app\/api\/brain\/owner\//, /^app\/api\/owner-/, /^app\/\(app\)\/\[channel\]\/owner-analytics\//];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const f = path.join(dir, n);
        if (statSync(f).isDirectory()) walk(f);
        else if (/\.(ts|tsx)$/.test(n)) files.push(path.relative(root, f));
      }
    };
    for (const d of ["app", "lib", "components"]) walk(path.join(root, d));
    const resolve = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(root, path.dirname(from), spec) : null;
      if (!base) return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
        if (existsSync(c) && statSync(c).isFile()) return path.relative(root, c);
      }
      return null;
    };
    const imports = new Map<string, string[]>();
    const edges = (f: string) => {
      if (!imports.has(f)) {
        const src = readFileSync(path.join(root, f), "utf8");
        const specs = [...src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
        imports.set(f, specs.map((s) => resolve(f, s)).filter((x): x is string => x !== null));
      }
      return imports.get(f)!;
    };
    const entries = files.filter(
      (f) => (f.startsWith("app/") || f.startsWith("lib/brain/")) && !OWNER_ZONES.some((z) => z.test(f)) && !OWNER_ONLY.some((o) => o.test(f)),
    );
    const leaks: string[] = [];
    for (const e of entries) {
      const seen = new Set<string>([e]);
      const stack = [e];
      while (stack.length) {
        const f = stack.pop()!;
        for (const n of edges(f)) {
          if (OWNER_ONLY.some((o) => o.test(n))) leaks.push(`${e} → … → ${f} → ${n}`);
          else if (!seen.has(n) && !OWNER_ZONES.some((z) => z.test(n))) {
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});

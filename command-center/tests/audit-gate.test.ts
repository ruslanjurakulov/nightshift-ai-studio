import { describe, expect, it } from "vitest";
import { advisories, evaluate } from "../scripts/audit-gate.mjs";
import { ALLOWLIST } from "../scripts/audit-allowlist.mjs";

const via = (id: string, severity: string) => ({ url: `https://github.com/advisories/${id}`, severity, title: `t ${id}` });
const report = (rows: Record<string, { severity: string; via: unknown[] }>) => ({ vulnerabilities: rows });
const EMPTY = report({});
const BRACES = "GHSA-vfj7-8cjw-p6xm";
const dev = report({
  braces: { severity: "high", via: [via(BRACES, "high")] },
  micromatch: { severity: "high", via: ["braces"] }, // propagation row: no advisory of its own
});
const allow = [{ id: BRACES, reason: "lint-time only", expires: "2027-01-12" }];
const TODAY = "2026-10-14";

describe("Dependency advisories gate", () => {
  it("reads advisories, not the packages that merely depend on a vulnerable one", () => {
    expect(advisories(dev)).toEqual([{ id: BRACES, name: "braces", severity: "high", title: `t ${BRACES}` }]);
  });

  it("passes the dev-only braces advisory while its allowance is current, and still prints it", () => {
    const r = evaluate(dev, EMPTY, allow, TODAY);
    expect(r.failures).toEqual([]);
    expect(r.notes.join("\n")).toContain(BRACES);
  });

  it("fails again once the allowance has expired", () => {
    expect(evaluate(dev, EMPTY, allow, "2027-01-13").failures.join("\n")).toContain("expired");
  });

  it("fails a high advisory in the dev tree that nobody listed", () => {
    const other = report({ tar: { severity: "high", via: [via("GHSA-aaaa-bbbb-cccc", "high")] } });
    expect(evaluate(other, EMPTY, allow, TODAY).failures.join("\n")).toContain("GHSA-aaaa-bbbb-cccc");
  });

  it("fails a moderate advisory in the production tree, which the old high-only gate let through", () => {
    const prod = report({ next: { severity: "moderate", via: [via("GHSA-4jqv-0000-0000", "moderate")] } });
    expect(evaluate(prod, prod, allow, TODAY).failures.join("\n")).toContain("production: GHSA-4jqv-0000-0000");
  });

  it("does not let an allowance cover an advisory that ships to production", () => {
    expect(evaluate(dev, dev, allow, TODAY).failures.join("\n")).toContain("production tree");
  });

  it("refuses an allowance with no reason or no expiry date", () => {
    expect(evaluate(dev, EMPTY, [{ id: BRACES } as never], TODAY).failures.join("\n")).toContain("needs id, reason and expires");
  });

  it("ignores low and moderate dev advisories (the old gate did too)", () => {
    const low = report({ x: { severity: "moderate", via: [via("GHSA-lowl-owlo-wlow", "moderate")] } });
    expect(evaluate(low, EMPTY, [], TODAY).failures).toEqual([]);
  });

  it("ships an allowlist whose every entry (if any) is well formed and dated", () => {
    expect(Array.isArray(ALLOWLIST)).toBe(true);
    expect(evaluate(EMPTY, EMPTY, ALLOWLIST, TODAY).failures).toEqual([]);
  });
});

// @vitest-environment jsdom
/**
 * LENS-2 on the workflow run screens (BR-L-006 + the unknown-amount nit):
 *
 * - who may carry a run on is decided by the caller's role in the RUN's
 *   organization, never the organization being viewed (else a page polls with
 *   "forbidden" every few seconds, or a run nobody can carry on);
 * - an amount the database did not give is said in words, never shown as 0;
 * - the two new step refusals (a confirmer who may no longer spend, a step key
 *   that was already taken) have their own words in all three languages.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chronos/workflows/runs/1",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { canCarryRun, coerceRun, coerceRunSummary, stepFailureReason } from "@/lib/workflows";
import { RunView } from "@/components/workflows/RunView";

const t = dictionaries.en;
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "11111111-1111-4111-8111-111111111111";
const WF = "22222222-2222-4222-8222-222222222222";

const runJson = (run: Record<string, unknown>, steps: Record<string, unknown>[] = []) => ({
  run: { id: RUN, org_id: ORG_A, workflow_id: WF, workflow_name: "Promo", status: "failed", ...run },
  steps,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("who carries a run on", () => {
  const orgs = [
    { id: ORG_A, role: "viewer" as const },
    { id: ORG_B, role: "editor" as const },
  ];
  it("is the role in the run's own organization, not the one being viewed", () => {
    expect(canCarryRun(orgs, ORG_A)).toBe(false);
    expect(canCarryRun(orgs, ORG_B)).toBe(true);
    expect(canCarryRun([{ id: ORG_A, role: "owner" }], ORG_A)).toBe(true);
  });
  it("is no one outside the run's organization", () => {
    expect(canCarryRun(orgs, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBe(false);
    expect(canCarryRun([], ORG_A)).toBe(false);
  });
  it("the run page reads it from the run's org_id", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/[channel]/workflows/runs/[id]/page.tsx", "utf8");
    expect(src).toMatch(/canCarryRun\(org\.orgs, read\.value\.org_id, platformAdmin\)/);
    expect(src).not.toMatch(/resolveCurrentOrgRole/);
  });
});

describe("amounts the database did not give", () => {
  it("stay unknown in a run, never 0", () => {
    const r = coerceRun(runJson({ max_credits: null }, [{ step_index: 0, status: "pending" }]));
    expect(r?.max_credits).toBeNull();
    expect(r?.charged_credits).toBeNull();
    expect(r?.steps[0].quoted_credits).toBeNull();
    const known = coerceRun(runJson({ max_credits: "15.9", charged_credits: 4 }, [{ step_index: 0, status: "completed", quoted_credits: 4 }]));
    expect(known?.max_credits).toBe(15.9);
    expect(known?.charged_credits).toBe(4);
    expect(known?.steps[0].quoted_credits).toBe(4);
  });

  it("stay unknown in the recent runs list, never 0", () => {
    const row = coerceRunSummary({ id: RUN, workflow_id: WF, workflow_name: "Promo", status: "failed", max_credits: null, charged_credits: "x" });
    expect(row?.max_credits).toBeNull();
    expect(row?.charged_credits).toBeNull();
    expect(coerceRunSummary({ id: RUN, workflow_id: WF, max_credits: "8", charged_credits: 0 })).toMatchObject({ max_credits: 8, charged_credits: 0 });
    expect(coerceRunSummary({ id: RUN })).toBeNull();
  });

  it("read as words on the run page", () => {
    const run = coerceRun(runJson({ max_credits: null, charged_credits: null }, [{ step_index: 0, status: "pending", quoted_credits: null }]))!;
    render(
      <I18nProvider locale="en">
        <RunView initial={run} canAct={false} toolLabels={{}} />
      </I18nProvider>,
    );
    const p = t.workflows.runPage;
    expect(screen.getByText(p.confirmedUnknown)).toBeTruthy();
    expect(screen.getByText(p.chargedUnknown)).toBeTruthy();
    expect(screen.getByText(p.quotedUnknown)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b0 credits\b/);
  });
});

describe("the new refusals", () => {
  it("each has its own words in every language", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const d = dictionaries[lang];
      const e = d.workflows.stepErrors as Record<string, string>;
      for (const code of ["confirmation_revoked", "idempotency_conflict"]) {
        expect(typeof e[code], `${lang} ${code}`).toBe("string");
        expect(stepFailureReason(d, code)).toBe(e[code]);
        expect(stepFailureReason(d, code)).not.toBe(e.other);
      }
      const p = d.workflows.runPage as Record<string, string>;
      for (const k of ["confirmedUnknown", "chargedUnknown", "quotedUnknown"]) expect(p[k]?.length, `${lang} ${k}`).toBeGreaterThan(0);
      expect((d.workflows as Record<string, unknown>).runSummaryUnknown).toBeTruthy();
    }
  });
});

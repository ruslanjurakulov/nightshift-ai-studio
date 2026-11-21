// @vitest-environment jsdom
/**
 * LENS-4 on the workflow run screen:
 *
 * - BR-L-011 (0083): a step that cannot start yet because everything the plan
 *   may run at once is busy, or credits are short, is WAITING, not failed: the
 *   page says so, says what was charged so far, and when the run stops if it
 *   still cannot start (a day after the price was confirmed), in all three
 *   languages;
 * - BR-L-013: in the operator's own organization only a platform owner/admin
 *   may carry a run on, so the page does not poll a refusal; and whenever the
 *   database refuses an advance, the page turns read-only and keeps refreshing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { dictionaries, fmt } from "@/lib/i18n";
import { DEFAULT_ORG_ID } from "@/lib/orgs";
import {
  ADVANCE_EVERY_MS,
  canCarryRun,
  coerceRun,
  confirmationDeadline,
  stepWaitCode,
  waitingStep,
  WAIT_CODES,
} from "@/lib/workflows";
import { RunView } from "@/components/workflows/RunView";

const t = dictionaries.en;
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN = "11111111-1111-4111-8111-111111111111";
const WF = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-10-02T08:00:00.000Z";

const runJson = (run: Record<string, unknown>, steps: Record<string, unknown>[]) => ({
  run: { id: RUN, org_id: ORG_A, workflow_id: WF, workflow_name: "Promo", status: "running", created_at: CREATED, ...run },
  steps,
});
const waitingJson = (code: string, run: Record<string, unknown> = {}) =>
  runJson({ max_credits: 15.9, charged_credits: 4, ...run }, [
    { step_index: 0, status: "completed", quoted_credits: 4, charged_credits: 4, job_id: "j0" },
    { step_index: 1, status: "pending", quoted_credits: 10, error_code: code, error: "active=1 limit=1" },
    { step_index: 2, status: "pending", quoted_credits: 1.9 },
  ]);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function show(data: unknown, canAct = false, locale: "en" | "ru" | "uz" = "en") {
  return render(
    <I18nProvider locale={locale}>
      <RunView initial={coerceRun(data)!} canAct={canAct} toolLabels={{}} />
    </I18nProvider>,
  );
}

describe("a step that waits (BR-L-011)", () => {
  it("is a pending step with a reason that passes, and only while the run is running", () => {
    expect(WAIT_CODES).toEqual(["run_limit_reached", "insufficient_credits"]);
    expect(stepWaitCode({ status: "pending", error_code: "run_limit_reached" })).toBe("run_limit_reached");
    expect(stepWaitCode({ status: "pending", error_code: "insufficient_credits" })).toBe("insufficient_credits");
    // A refusal that does not pass is a failed step, never "waiting".
    expect(stepWaitCode({ status: "failed", error_code: "run_limit_reached" })).toBeNull();
    expect(stepWaitCode({ status: "pending", error_code: "price_changed" })).toBeNull();
    expect(stepWaitCode({ status: "pending", error_code: null })).toBeNull();
    expect(waitingStep(coerceRun(waitingJson("run_limit_reached"))!)?.step_index).toBe(1);
    expect(waitingStep(coerceRun(waitingJson("run_limit_reached", { status: "cancelled" }))!)).toBeNull();
  });

  it("stops a day after the price was confirmed, or says so when that time is not on record", () => {
    expect(confirmationDeadline({ created_at: CREATED })?.toISOString()).toBe("2026-10-03T08:00:00.000Z");
    expect(confirmationDeadline({ created_at: null })).toBeNull();
    expect(confirmationDeadline({ created_at: "not a date" })).toBeNull();
  });

  it("reads as waiting for a free slot, with the charge so far and the deadline", () => {
    show(waitingJson("run_limit_reached"));
    const p = t.workflows.runPage;
    expect(screen.getByText(fmt(p.charged, { n: "4" }), { exact: false })).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain(fmt(p.waitingSlot, { n: 2 }));
    const when = new Date("2026-10-03T08:00:00.000Z").toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
    expect(text).toContain(fmt(p.waitingUntil, { when }));
    expect(text).toContain(fmt(p.stepWaiting, { why: t.workflows.waitReasons.run_limit_reached }));
    // Not a failure: no "This step stopped" line, and the run is still running.
    expect(text).not.toContain(fmt(p.failedBecause, { why: "" }).trim());
    expect(text).toContain(t.workflows.status.running);
  });

  it("reads as waiting for credits, and without a time when the confirmation time is unknown", () => {
    show(waitingJson("insufficient_credits", { created_at: null }));
    const p = t.workflows.runPage;
    const text = document.body.textContent ?? "";
    expect(text).toContain(fmt(p.waitingCredits, { n: 2 }));
    expect(text).toContain(p.waitingUntilUnknown);
    expect(text).toContain(fmt(p.stepWaiting, { why: t.workflows.waitReasons.insufficient_credits }));
  });

  it("a step that has simply not started yet is not called waiting", () => {
    show(runJson({ max_credits: 15.9, charged_credits: 0 }, [
      { step_index: 0, status: "running", quoted_credits: 4, job_id: "j0", job_status: "running" },
      { step_index: 1, status: "pending", quoted_credits: 10 },
    ]));
    const p = t.workflows.runPage;
    const text = document.body.textContent ?? "";
    expect(text).toContain(p.notStarted);
    expect(text).not.toContain(fmt(p.waitingSlot, { n: 2 }));
    expect(text).not.toContain(fmt(p.waitingCredits, { n: 2 }));
  });

  it("has its words in every language", () => {
    for (const lang of ["en", "ru", "uz"] as const) {
      const d = dictionaries[lang];
      const p = d.workflows.runPage as Record<string, string>;
      for (const k of ["waitingSlot", "waitingCredits", "waitingUntil", "waitingUntilUnknown", "stepWaiting"]) {
        expect(p[k]?.length, `${lang} ${k}`).toBeGreaterThan(0);
      }
      expect(p.waitingSlot).toContain("{n}");
      expect(p.waitingCredits).toContain("{n}");
      expect(p.waitingUntil).toContain("{when}");
      expect(p.stepWaiting).toContain("{why}");
      for (const code of WAIT_CODES) expect(d.workflows.waitReasons[code]?.length, `${lang} ${code}`).toBeGreaterThan(0);
    }
  });
});

describe("the operator's organization (BR-L-013)", () => {
  const operator = (role: "owner" | "editor" | "viewer") => [{ id: DEFAULT_ORG_ID, role, is_default: true }];

  it("is carried on only by a platform owner/admin, whatever the organization role", () => {
    expect(canCarryRun(operator("owner"), DEFAULT_ORG_ID)).toBe(false);
    expect(canCarryRun(operator("editor"), DEFAULT_ORG_ID, false)).toBe(false);
    expect(canCarryRun(operator("owner"), DEFAULT_ORG_ID, true)).toBe(true);
    expect(canCarryRun(operator("viewer"), DEFAULT_ORG_ID, true)).toBe(false);
    // Recognised by the flag too, not only by the fixed id.
    expect(canCarryRun([{ id: ORG_A, role: "owner", is_default: true }], ORG_A)).toBe(false);
  });

  it("changes nothing for a customer's organization", () => {
    expect(canCarryRun([{ id: ORG_A, role: "editor", is_default: false }], ORG_A)).toBe(true);
    expect(canCarryRun([{ id: ORG_A, role: "editor", is_default: false }], ORG_A, false)).toBe(true);
    expect(canCarryRun([{ id: ORG_A, role: "viewer", is_default: false }], ORG_A, true)).toBe(false);
  });

  it("the run page asks the platform role for a run there and passes it in", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/[channel]/workflows/runs/[id]/page.tsx", "utf8");
    expect(src).toMatch(/read\.value\.org_id === DEFAULT_ORG_ID \? await isPlatformAdmin\(\) : false/);
    expect(src).toMatch(/canCarryRun\(org\.orgs, read\.value\.org_id, platformAdmin\)/);
  });
});

describe("the run routes' answer", () => {
  it("is read back as the run it carries (Run now, advance, read, stop)", async () => {
    const running = waitingJson("run_limit_reached");
    const routed = coerceRun(running)!; // what the routes put in { run }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ run: routed, replay: false }), { status: 200 })));
    const api = await import("@/components/workflows/workflowsApi");
    for (const out of [
      await api.advanceRun(RUN),
      await api.readRun(RUN),
      await api.cancelRun(RUN),
      await api.runWorkflow(WF, RUN, 1, {}, 15.9),
    ]) {
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.value).toEqual(routed);
    }
    expect(coerceRun(routed)).toEqual(routed);
  });
});

describe("an advance the database refuses (BR-L-013)", () => {
  it("turns the page read-only and keeps refreshing, without asking to advance again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = runJson({ max_credits: 15.9, charged_credits: 4 }, [
      { step_index: 0, status: "completed", quoted_credits: 4, charged_credits: 4, job_id: "j0" },
      { step_index: 1, status: "running", quoted_credits: 10, job_id: "j1", job_status: "running" },
    ]);
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/advance")) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
        // What the run route answers: { run: <the run, steps inside> }.
        return new Response(JSON.stringify({ run: coerceRun(running) }), { status: 200 });
      }),
    );
    show(running, true);
    const p = t.workflows.runPage;
    expect(screen.getByText(p.cancel)).toBeTruthy(); // offered until the database says otherwise
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls[0]).toMatchObject({ method: "POST" });
    expect(calls[0].url).toMatch(/\/advance$/);
    expect(calls[1]).toMatchObject({ method: "GET" });
    // Two more timer ticks, each after the one before has answered.
    for (const want of [3, 4]) {
      await waitFor(() => expect(document.body.textContent).not.toContain(p.refreshing));
      await act(async () => {
        vi.advanceTimersByTime(ADVANCE_EVERY_MS + 10);
      });
      await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(want));
    }
    expect(calls.slice(1).every((c) => c.method === "GET" && !c.url.endsWith("/advance"))).toBe(true);
    // Read-only: no error, no Stop, the follow-only line.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(p.cancel)).toBeNull();
    expect(document.body.textContent).toContain(p.viewOnly);
  });

  it("a member who may carry the run on keeps advancing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = runJson({ max_credits: 15.9, charged_credits: 4 }, [
      { step_index: 0, status: "running", quoted_credits: 4, job_id: "j0", job_status: "running" },
    ]);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ run: coerceRun(running) }), { status: 200 });
      }),
    );
    show(running, true);
    await waitFor(() => expect(calls.length).toBe(1));
    await waitFor(() => expect(document.body.textContent).not.toContain(t.workflows.runPage.refreshing));
    await act(async () => {
      vi.advanceTimersByTime(ADVANCE_EVERY_MS + 50);
    });
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls.every((u) => u.endsWith("/advance"))).toBe(true);
  });
});

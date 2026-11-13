/**
 * The server half of "Not available yet" (lib/server/tool-availability.ts) and the small honesty fixes that ride with it.
 * What would break without these: a failed registry read drawn as "nothing is on sale" (rule 5), the operator's previews missing from
 * the marks while the create page offers them (a tool marked unavailable that the form can actually make), a customer handed the
 * operator's previews; a failed latest job taking the Video desk's monitor; "Renews –"; a dead "Create my link" button.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const readStudioModels = vi.fn();
const loadOperatorPreviewModels = vi.fn();
const isOperator = vi.fn();
vi.mock("@/lib/server/creative", () => ({ readStudioModels, loadOperatorPreviewModels }));
vi.mock("@/lib/auth/org-roles", () => ({ isOperator }));
vi.mock("@/lib/channel-tokens", () => ({ isOperatorOrg: (id: string | null) => id === "op-org" }));

const { readToolAvailability } = await import("../lib/server/tool-availability");
const { featuredJob } = await import("../components/studio/JobFeed");
const { planDateLine } = await import("../components/credits/PlanPanel");
const { inviteWorthShowing } = await import("../lib/friend-invites");
const { en, ru, uz } = await import("../lib/i18n").then((m) => m.dictionaries);

const model = (id: string, capabilities: string[]) => ({ id, displayName: id, capabilities, beta: false });

beforeEach(() => {
  readStudioModels.mockReset();
  loadOperatorPreviewModels.mockReset();
  isOperator.mockReset();
});

describe("readToolAvailability", () => {
  it("is unknown without an organization, and when the registry could not be read — never 'nothing on sale'", async () => {
    expect(await readToolAvailability(null)).toEqual({ state: "unknown" });
    expect(readStudioModels).not.toHaveBeenCalled();
    readStudioModels.mockResolvedValue(null);
    expect(await readToolAvailability("org-1")).toEqual({ state: "unknown" });
    readStudioModels.mockRejectedValue(new Error("boom"));
    expect(await readToolAvailability("org-1")).toEqual({ state: "unknown" });
  });

  it("is the capabilities of the models the Studio form offers; read and empty is 'nothing on sale'", async () => {
    readStudioModels.mockResolvedValue([]);
    expect(await readToolAvailability("org-1")).toEqual({ state: "known", sold: [] });
    readStudioModels.mockResolvedValue([model("a", ["t2i", "edit"]), model("b", ["t2v"])]);
    expect(await readToolAvailability("org-1")).toEqual({ state: "known", sold: ["edit", "t2i", "t2v"] });
    // A customer's organization: the operator's previews are never asked for.
    expect(loadOperatorPreviewModels).not.toHaveBeenCalled();
    expect(isOperator).not.toHaveBeenCalled();
  });

  it("adds the operator's previews only in the operator's own organization, as the create page does", async () => {
    readStudioModels.mockResolvedValue([]);
    loadOperatorPreviewModels.mockResolvedValue([{ ...model("p", ["video_upscale"]), preview: true }]);
    isOperator.mockResolvedValue(true);
    expect(await readToolAvailability("op-org")).toEqual({ state: "known", sold: ["video_upscale"] });
    isOperator.mockResolvedValue(false);
    expect(await readToolAvailability("op-org")).toEqual({ state: "known", sold: [] });
  });
});

describe("the Video desk's monitor", () => {
  const job = (id: string, status: string) => ({ id, status });
  it("shows the newest job that did not fail; the person's pick wins; all failed still shows the newest", () => {
    expect(featuredJob([job("f", "failed"), job("ok", "completed")], null)?.id).toBe("ok");
    expect(featuredJob([job("c", "cancelled"), job("run", "running")], null)?.id).toBe("run");
    expect(featuredJob([job("f", "failed"), job("ok", "completed")], "f")?.id).toBe("f");
    expect(featuredJob([job("f1", "failed"), job("f2", "failed")], null)?.id).toBe("f1");
    expect(featuredJob([], null)).toBeNull();
  });
});

describe("the plan's date line", () => {
  it("says the date is unknown instead of 'Renews –', and never guesses one", () => {
    const sub = { status: "active", cancelAtPeriodEnd: false, periodEnd: null };
    expect(planDateLine(en.plans, sub, "en")).toBe("Renewal date unknown");
    expect(planDateLine(en.plans, { ...sub, periodEnd: "not a date" }, "en")).toBe("Renewal date unknown");
    expect(planDateLine(en.plans, { ...sub, cancelAtPeriodEnd: true }, "en")).toBe(en.plans.endsUnknown);
    expect(planDateLine(en.plans, { ...sub, periodEnd: "2026-12-01T00:00:00Z" }, "en")).toMatch(/^Renews .*1/);
    expect(planDateLine(en.plans, null, "en")).toBeNull();
    for (const d of [ru, uz]) {
      expect(d.plans.renewsUnknown.trim()).not.toBe("");
      expect(d.plans.endsUnknown.trim()).not.toBe("");
    }
    for (const d of [en, ru, uz]) expect(d.plans.renewsUnknown).not.toContain("–");
  });
});

describe("the invite card", () => {
  const invite = (over: Record<string, unknown> = {}) =>
    ({ enabled: false, link: null, joined: 0, required: 5, reward: 100, paid: false, pending: false, creditsPaid: null, ...over }) as never;
  it("is left out while invites are closed and there is no link; a workspace with a link keeps its progress", () => {
    expect(inviteWorthShowing(invite())).toBe(false);
    expect(inviteWorthShowing(invite({ enabled: true }))).toBe(true);
    expect(inviteWorthShowing(invite({ link: { token: "abc" } }))).toBe(true);
  });
});

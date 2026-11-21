// @vitest-environment jsdom
/**
 * The redesigned /owner/ai: four live cards and a chat. What would break:
 *  - a card that shows 0 (or a half sum) when its source is missing — "nobody signed up" read from a renamed column (rule 5);
 *  - "today" counted on the server's UTC day instead of the owner's Tashkent day;
 *  - today's revenue read before the second-factor check (0182's money read has none of its own);
 *  - a failed read drawn as "unknown" with no way to ask again, or a migration gap drawn as a retry that can never work;
 *  - Enter not sending, Shift+Enter sending, a send button that looks the same enabled and disabled;
 *  - a named refusal from the route shown without its remedy, or a retry offered where retrying cannot help;
 *  - the voice button doing anything.
 * Every fetch is mocked: no test here calls the route, let alone a paid model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import type { MoneyRow } from "../lib/owner-analytics/money";
import type { OwnerFacts } from "../lib/owner-console/facts-types";
import type { PlanLine } from "../lib/owner-analytics/payment-plan";
import { aiKpis, failedCard, revenueTodayCard, runwayCard, signupsCard, tashkentDayStart } from "../lib/owner-console/ai-kpis";
import { firstNameOf } from "../lib/owner-console/greeting";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  load: vi.fn(),
  readMoney: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../app/owner/_facts", () => ({ loadOwnerFacts: h.load }));
vi.mock("@/lib/server/owner-analytics", () => ({ readMoney: h.readMoney }));

const { AiKpiCards, AiKpiSkeleton, AiKpiUnavailable } = await import("../components/owner-console/AiKpiCards");
const { OwnerAssistant, sendsOnKey, COUNTER_FROM } = await import("../components/owner-console/OwnerAssistant");
const { OwnerAiKpis } = await import("../app/owner/ai/_kpis");

const c = en.ownerConsole;
const a = c.assistant;
const f = c.facts;
const AS_OF = "2026-11-21T03:00:00.000Z";
// 08:00 in Tashkent on 21 Nov; the Tashkent day began at 2026-11-20T19:00Z.
const NOW = Date.parse(AS_OF);

const sale = (at: string, minor: number | null, over: Partial<MoneyRow> = {}): MoneyRow => ({
  event: "sale",
  at,
  provider: "paddle",
  paymentRef: `p-${at}`,
  orgRef: "org-1",
  kind: "plan",
  item: "pro",
  charge: "initial",
  currency: "USD",
  amountMinor: minor,
  feeMinor: null,
  periodStart: null,
  periodEnd: null,
  subscriptionRef: null,
  internal: false,
  ...over,
});

const line = (over: Partial<PlanLine>): PlanLine => ({
  provider: "x",
  name: "X",
  topUpUrl: null,
  basis: "estimated",
  left: 10,
  perDay: 1,
  unit: "usd",
  runsOutOn: "2026-12-01",
  payBy: null,
  amount: 10,
  minimumTopUp: null,
  reason: "ok",
  asOf: AS_OF,
  autoRecharge: false,
  ...over,
});

function facts(over: { people?: OwnerFacts["people"]; health?: OwnerFacts["health"]; plan?: { due?: PlanLine[]; unknown?: PlanLine[]; fine?: PlanLine[] } | null } = {}): OwnerFacts {
  const plan = over.plan === null ? null : { days: 10, asOf: AS_OF, due: [], unknown: [], fine: [], ...(over.plan ?? {}) };
  return {
    version: 1,
    as_of: AS_OF,
    people: over.people ?? { state: "measured", as_of: AS_OF, value: { signups: { d1: 3, d7: 9 } } },
    health: over.health ?? {
      state: "measured",
      as_of: AS_OF,
      value: { queues: { creative: { failed_24h: 2, quota_failed_24h: 1 }, render: { failed_24h: "1" } } },
    },
    revenue: { state: "unknown", why: "read failed" },
    providers: plan === null ? { state: "unknown", why: "database not configured" } : { state: "estimated", as_of: AS_OF, value: { plan, providers: [] } },
  };
}

describe("the live cards' figures", () => {
  it("counts today on the owner's Tashkent day, not the server's UTC day", () => {
    expect(tashkentDayStart(NOW)).toBe("2026-11-20T19:00:00.000Z");
    const rows = [
      sale("2026-11-20T18:30:00.000Z", 10_000), // 23:30 the evening before, in Tashkent: yesterday
      sale("2026-11-20T19:30:00.000Z", 2_500), // 00:30 today in Tashkent
      sale("2026-11-21T02:00:00.000Z", 1_000),
      sale("2026-11-21T02:10:00.000Z", 99_900, { internal: true }), // the owner's own workspace never counts
    ];
    expect(revenueTodayCard({ ok: true, data: rows, truncated: false }, NOW)).toEqual({ state: "measured", value: 35 });
  });

  it("says unknown, not a smaller total, when a sale today had no amount", () => {
    const card = revenueTodayCard({ ok: true, data: [sale("2026-11-21T01:00:00.000Z", 1_000), sale("2026-11-21T02:00:00.000Z", null)], truncated: false }, NOW);
    expect(card.state).toBe("unknown");
  });

  it("marks a cut read, offers a retry for a failed read, and no retry for a missing migration", () => {
    expect(revenueTodayCard({ ok: true, data: [], truncated: true }, NOW)).toEqual({ state: "measured", value: 0, hint: { kind: "truncated" } });
    expect(revenueTodayCard({ ok: false, reason: "error" }, NOW)).toEqual({ state: "error" });
    expect(revenueTodayCard({ ok: false, reason: "missing" }, NOW)).toEqual({ state: "unknown", why: "migration 0182 is not applied" });
  });

  it("never turns a missing count into 0: no d1 key is unknown, one missing queue is unknown (not half a sum)", () => {
    expect(signupsCard(facts())).toEqual({ state: "measured", value: 3 });
    expect(signupsCard(facts({ people: { state: "measured", as_of: AS_OF, value: { signups: { d7: 9 } } } })).state).toBe("unknown");
    expect(failedCard(facts())).toEqual({ state: "measured", value: 3, hint: { kind: "refused", n: 1 } });
    const oneQueue = facts({ health: { state: "measured", as_of: AS_OF, value: { queues: { creative: { failed_24h: 2 } } } } });
    expect(failedCard(oneQueue).state).toBe("unknown");
    expect(signupsCard(facts({ people: { state: "unknown", why: "migration 0197 is not applied" } }))).toEqual({ state: "unknown", why: "migration 0197 is not applied" });
    expect(failedCard(facts({ health: { state: "unknown", why: "read failed" } }))).toEqual({ state: "error" });
  });

  it("names the provider that runs out first, an empty one before all, and says unknown when none can be judged", () => {
    const due = runwayCard(facts({ plan: { due: [line({ name: "Empty Co", reason: "empty", runsOutOn: "2026-11-21" }), line({ name: "Later", reason: "runs_out" })] } }));
    expect(due).toMatchObject({ state: "estimated", value: { name: "Empty Co", runsOut: "empty", due: true } });
    const fine = runwayCard(facts({ plan: { fine: [line({ name: "Never", runsOutOn: "never" }), line({ name: "Soon", runsOutOn: "2026-12-05" })], unknown: [line({ reason: "unknown" })] } }));
    expect(fine).toMatchObject({ state: "estimated", value: { name: "Soon", runsOut: "2026-12-05", due: false }, hint: { kind: "unjudged", n: 1 } });
    expect(runwayCard(facts({ plan: { unknown: [line({ reason: "unknown" })] } })).state).toBe("unknown");
    expect(runwayCard(facts({ plan: {} }))).toMatchObject({ state: "estimated", value: { name: null } });
    expect(runwayCard(facts({ plan: null })).state).toBe("unknown");
  });
});

describe("the live cards on screen", () => {
  const html = (el: ReactElement) => renderToStaticMarkup(el);

  it("draws each value with its source's word, and an unknown with its reason and no number", () => {
    const k = aiKpis(
      facts({ people: { state: "measured", as_of: AS_OF, value: { signups: {} } }, plan: { due: [line({ name: "Voice Co", reason: "runs_out", runsOutOn: "2026-11-25" })] } }),
      { ok: true, data: [sale("2026-11-21T01:00:00.000Z", 4_200)], truncated: false },
      NOW,
    );
    const out = html(<AiKpiCards kpis={k} asOf={AS_OF} a={a} f={f} locale="en" />);
    expect(out).toContain("$42");
    expect(out).toContain(`oc-tag-measured">${f.tag.measured}`);
    expect(out).toContain(`oc-tag-estimated">${f.tag.estimated}`);
    expect(out).toContain("Voice Co");
    expect(out).toContain("runs out 2026-11-25");
    // The signups card: the unknown tag and a reason, and no digit inside that card.
    const signups = out.split(a.kpi.signups24h)[1].split("</div>")[0];
    expect(signups).toContain(`oc-tag-unknown">${f.tag.unknown}`);
    expect(signups).not.toMatch(/\d/);
  });

  it("offers Try again on a failed figure, and it re-reads the page without touching the chat", async () => {
    const k = aiKpis(facts({ health: { state: "unknown", why: "read failed" } }), { ok: true, data: [], truncated: false }, NOW);
    render(<AiKpiCards kpis={k} asOf={AS_OF} a={a} f={f} locale="en" />);
    expect(screen.getByText(a.kpi.error)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: f.retry })));
    expect(h.refresh).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("has a skeleton that is announced once and draws no figure", () => {
    const out = html(<AiKpiSkeleton a={a} />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain(a.kpi.loading);
    const slots = out.match(/<dd[^>]*>.*?<\/dd>/g) ?? [];
    expect(slots).toHaveLength(4);
    for (const s of slots) expect(s.replace(/<[^>]+>/g, "")).toBe("");
  });

  it("sends a password-only session to verify, and a failed load to try again", () => {
    expect(html(<AiKpiUnavailable kind="second_factor" a={a} f={f} verifyHref="/verify" />)).toContain('href="/verify"');
    expect(html(<AiKpiUnavailable kind="failed" a={a} f={f} verifyHref="/verify" />)).toContain(f.retry);
  });
});

describe("the live cards' reads", () => {
  beforeEach(() => {
    h.load.mockReset();
    h.readMoney.mockReset();
  });

  it("does not read today's revenue until the facts (and their second-factor check) have loaded", async () => {
    h.load.mockResolvedValue({ ok: false, kind: "second_factor" });
    const out = renderToStaticMarkup((await OwnerAiKpis({ c, locale: "en", verifyHref: "/v", nowMs: NOW })) as ReactElement);
    expect(h.readMoney).not.toHaveBeenCalled();
    expect(out).toContain(f.needsSecondFactor);
  });

  it("reads today's money window from the Tashkent day start", async () => {
    h.load.mockResolvedValue({ ok: true, facts: facts() });
    h.readMoney.mockResolvedValue({ ok: true, data: [], truncated: false });
    await OwnerAiKpis({ c, locale: "en", verifyHref: "/v", nowMs: NOW });
    expect(h.readMoney).toHaveBeenCalledWith("2026-11-20T19:00:00.000Z", "2026-11-22T03:00:00.000Z");
  });
});

describe("the greeting", () => {
  it("takes a first name and refuses an address", () => {
    expect(firstNameOf({ given_name: "Dilnoza", full_name: "X Y" })).toBe("Dilnoza");
    expect(firstNameOf({ full_name: "  Aziz   Karimov " })).toBe("Aziz");
    expect(firstNameOf({ name: "me@example.com" })).toBeNull();
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf({ full_name: 42 })).toBeNull();
  });
});

describe("the chat", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  const mount = () => render(<OwnerAssistant a={a} verifyHref="/verify" signInHref="/login" />);
  const reply = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
  const box = () => screen.getByLabelText(a.label) as HTMLTextAreaElement;
  const send = () => screen.getByRole("button", { name: a.ask }) as HTMLButtonElement;

  it("starts empty with every suggestion as a card with its icon, and a send button that is off until there is a question", () => {
    mount();
    expect(screen.getByText(a.empty)).toBeTruthy();
    for (const s of a.suggest) {
      const card = screen.getByRole("button", { name: s });
      expect(card.className).toContain("ai-suggest-card");
      expect(card.querySelector("svg")).not.toBeNull();
    }
    expect(send().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "  " } });
    expect(send().disabled).toBe(true);
    fireEvent.change(box(), { target: { value: "How are we?" } });
    expect(send().disabled).toBe(false);
  });

  it("sends on Enter, not on Shift+Enter, and never mid-composition", () => {
    expect(sendsOnKey({ key: "Enter", shiftKey: false })).toBe(true);
    expect(sendsOnKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(sendsOnKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(sendsOnKey({ key: "a", shiftKey: false })).toBe(false);
  });

  it("shows the question as the owner's bubble, the thinking state, then the answer with its as-of line", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mount();
    fireEvent.change(box(), { target: { value: "Which API must I pay?" } });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(a.asking);
    expect(document.querySelector(".ai-typing")).not.toBeNull();
    expect((screen.getByRole("button", { name: a.asking }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolve({ ok: true, status: 200, json: async () => ({ answer: "Pay Voice Co by 24 Nov (estimated).", draft: null, removed_links: 0, as_of: AS_OF }) });
    });
    expect(document.querySelector(".ai-bubble-you")?.textContent).toBe("Which API must I pay?");
    expect(document.querySelector(".ai-answer")?.textContent).toBe("Pay Voice Co by 24 Nov (estimated).");
    expect(screen.getByText("Figures as of 2026-11-21 08:00 (Tashkent)")).toBeTruthy();
    expect(box().value).toBe("");
    expect(document.querySelector(".ai-typing")).toBeNull();
  });

  const refusals: Array<[string, number, Record<string, unknown>, string, "retry" | "verify" | "none"]> = [
    ["not_configured", 409, { error: "model_unavailable", reason: "not_configured" }, a.errors.model_unavailable.not_configured, "none"],
    ["model switched off", 409, { error: "model_unavailable", reason: "not_on_sale" }, a.errors.model_unavailable.not_on_sale, "none"],
    ["needs migration", 503, { error: "not_enabled", needs: "0203" }, a.errors.not_enabled.replace("{n}", "0203"), "none"],
    ["mfa_required", 401, { error: "second_factor" }, a.errors.second_factor, "verify"],
    ["owner_ai_daily_cap", 429, { error: "daily_cap", used: 200, limit: 200 }, a.errors.daily_cap.replace("{limit}", "200"), "none"],
    ["output_too_long", 502, { error: "model_failed", reason: "output_too_long" }, a.errors.model_failed.output_too_long, "retry"],
  ];
  for (const [name, status, body, message, way] of refusals) {
    it(`says the remedy for ${name}, with ${way === "none" ? "no retry" : way}`, async () => {
      reply(status, body);
      mount();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: a.suggest[0] })));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(message);
      expect(alert.querySelector(`a[href="/verify"]`) !== null).toBe(way === "verify");
      expect(screen.queryByRole("button", { name: a.retry }) !== null).toBe(way === "retry");
      // The question that failed stays on screen as the owner's bubble, so the retry has something to point at.
      expect(document.querySelector(".ai-bubble-you")?.textContent).toBe(a.suggest[0]);
    });
  }

  it("asks again with the same question on retry", async () => {
    reply(503, { error: "unavailable" });
    reply(200, { answer: "All good.", as_of: AS_OF });
    mount();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: a.suggest[2] })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: a.retry })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).question).toBe(a.suggest[2]);
    expect(screen.getByText("All good.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the character counter only near the 2000 limit, and flags it at the limit", () => {
    mount();
    fireEvent.change(box(), { target: { value: "x".repeat(COUNTER_FROM - 1) } });
    expect(document.getElementById("owner-ai-count")?.textContent).toBe("");
    fireEvent.change(box(), { target: { value: "x".repeat(COUNTER_FROM) } });
    expect(document.getElementById("owner-ai-count")?.textContent).toBe(`${COUNTER_FROM} / 2000`);
    fireEvent.change(box(), { target: { value: "x".repeat(2000) } });
    expect(document.getElementById("owner-ai-count")?.hasAttribute("data-full")).toBe(true);
  });

  it("has a voice button that says it is coming soon and does nothing", () => {
    mount();
    const mic = screen.getByRole("button", { name: `${a.mic} (${a.soon})` });
    expect(mic.getAttribute("aria-disabled")).toBe("true");
    expect(mic.getAttribute("data-tip")).toBe(a.soon);
    fireEvent.click(mic);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the disclaimer as one line under the composer", () => {
    mount();
    const line = document.querySelector("form .ai-disclaimer");
    expect(line?.textContent).toContain(a.noActions);
  });
});

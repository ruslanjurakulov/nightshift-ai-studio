// @vitest-environment jsdom
/**
 * Review follow-ups to the model-driven Studio (PR #745): a setting the picked model does not make is changed in sight, never
 * silently (CLAUDE.md #4); the model sheet says when a price was asked at other settings and never guesses a lock; the live credits
 * say when they may be out of date and never reuse a read that predates a hold; the tool marks leave out models no organization can
 * buy; the workflow builder offers each step's model's own lengths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => null, getUser: async () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
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
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { modelLock, snapShape, type StudioModel } from "@/lib/creative/studio";
import { planGate } from "@/lib/models-discovery";
import { creditsFor, creditsStale, refreshCredits, resetCreditsLive, seedCredits } from "@/lib/credits-live";
import { onlyOpenToSome } from "@/lib/tool-availability";
import { fromDefinition } from "@/lib/workflows-builder";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const VEO: StudioModel = {
  id: "veo-like",
  displayName: "Veo Like",
  capabilities: ["t2v", "i2v"],
  beta: false,
  aspectRatios: ["16:9", "9:16"],
  durations: [4, 6, 8],
  resolutions: ["720p", "1080p", "4k"],
};
const SEED: StudioModel = {
  id: "seed-like",
  displayName: "Seed Like",
  capabilities: ["t2v"],
  beta: false,
  aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"],
  durations: [4, 5, 8, 10, 15],
  resolutions: ["480p", "720p", "1080p"],
  defaultResolution: "720p",
  resolutionPriced: true,
};

let quotes: Array<{ model?: string; params: Record<string, unknown> }>;
let fetchMock: ReturnType<typeof vi.fn>;
let quoteReply: () => Promise<Response>;
const accountReads = () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/api/credits/account"));

beforeEach(() => {
  quotes = [];
  quoteReply = () => json({ quote: { credits: 25 } });
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === "/api/creative/quote") {
      quotes.push(JSON.parse(String(init?.body)));
      return quoteReply();
    }
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/credits/account")) return json({ supported: true, account: { balance: 400, reserved: 25 } });
    if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  resetCreditsLive();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCreditsLive();
});

describe("a setting the model does not make is changed in sight, never silently (rule 4)", () => {
  it("snapShape keeps the orientation: tall goes to the tallest listed, wide to the widest", () => {
    expect(snapShape("9:16", ["16:9", "4:3", "3:4", "2:3"])).toBe("2:3");
    expect(snapShape("4:3", ["16:9", "21:9", "9:16"])).toBe("21:9");
    expect(snapShape("9:16", ["16:9", "4:3"])).toBe("16:9");
    expect(snapShape("1:1", ["16:9", "9:16"])).toBe("16:9");
  });

  it("the panel says which model does not make what, and what it was set to; a listed pick ends it", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[VEO]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "1:1", duration: 5 }} />));
    expect(screen.getByTestId("gen-snap-note").textContent).toBe("Veo Like doesn't make 1:1, 5 s — set to 16:9, 4 s.");
    fireEvent.click(screen.getByRole("button", { name: "16:9" }));
    fireEvent.click(screen.getByRole("button", { name: "4 s" }));
    expect(screen.queryByTestId("gen-snap-note")).toBeNull();
  });

  it("a resolution the model does not offer is said too", () => {
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={[SEED]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 5, resolution: "540p" }} />,
      ),
    );
    expect(screen.getByTestId("gen-snap-note").textContent).toBe("Seed Like doesn't make 540p — set to 720p.");
  });

  it("a model that lists no clip length is not priced at a stand-in length: the reason is named", async () => {
    const none: StudioModel = { ...VEO, id: "lengthless", displayName: "Lengthless", durations: [] };
    render(withI18n(<GeneratePanel orgId={ORG} models={[none]} initial={{ capability: "t2v", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    expect(await screen.findByText(t.gen.noLength.replace("{model}", "Lengthless"))).toBeTruthy();
    await new Promise((r) => setTimeout(r, 700));
    expect(quotes).toEqual([]);
  });
});

describe("the sheet says where a price was asked at other settings, and never guesses a lock", () => {
  it("a model priced at its own length shows that length beside the price; the picked one shows none", async () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={[VEO, SEED]} initial={{ capability: "t2v", model: "veo-like", prompt: "x", aspect: "16:9", duration: 6 }} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    await waitFor(() => expect(document.querySelector('[data-priced-at="seed-like"]')?.textContent).toBe("at 5 s"));
    expect(document.querySelector('[data-priced-at="veo-like"]')).toBeNull();
  });

  it("an entitlement refusal that cannot be told apart reads the generic sentence, muted, with no lock badge", async () => {
    quoteReply = () => json({ error: "entitlement_required" }, 403);
    const plain: StudioModel = { id: "plain", displayName: "Plain", capabilities: ["t2i"], beta: false };
    render(withI18n(<GeneratePanel orgId={ORG} models={[plain]} initial={{ capability: "t2i", model: "", prompt: "x", aspect: "16:9", duration: 5 }} />));
    fireEvent.click(screen.getByRole("button", { name: t.gen.modelChangeLabel }));
    await waitFor(() => expect(document.querySelector('[data-price="plain"]')?.textContent).toBe(t.creative.errors.entitlement_required));
    expect(document.querySelector('[data-lock="plain"]')).toBeNull();
    expect(document.querySelector('[data-price="plain"]')?.className).toContain("color-muted");
  });

  it("the lock and the Models catalog read one rule (planGate)", () => {
    for (const [ent, purchased] of [["models_video:premium", true], ["paid", false], ["paid", true], ["paid", null], ["any", false], [null, null]] as const) {
      const gate = planGate(ent, purchased);
      const want = !gate ? null : gate.kind === "not_open" ? "not_on_sale" : gate.kind === "first_purchase" && gate.known ? "first_purchase" : null;
      expect(modelLock(ent, purchased)).toBe(want);
    }
    expect(t.gen.lock.not_on_sale).toBe("Not open to any workspace");
  });
});

describe("credits-live after review", () => {
  it("a failed read after a change of credits marks the value stale until a read succeeds; a failed read on view does not", async () => {
    seedCredits(ORG, { balance: 50, reserved: 0, available: 50 });
    fetchMock.mockImplementationOnce(() => json({ error: "credits_read_failed" }, 503));
    await refreshCredits(ORG, "view");
    expect(creditsStale(ORG)).toBe(false);
    fetchMock.mockImplementationOnce(() => json({ error: "credits_read_failed" }, 503));
    await refreshCredits(ORG);
    expect(creditsStale(ORG)).toBe(true);
    expect(creditsFor(ORG)).toEqual({ balance: 50, reserved: 0, available: 50 });
    await refreshCredits(ORG);
    expect(creditsStale(ORG)).toBe(false);
    expect(creditsFor(ORG)).toEqual({ balance: 400, reserved: 25, available: 375 });
  });

  it("a request during a running read gets one more read after it (the running one may predate the hold)", async () => {
    seedCredits(ORG, { balance: 400, reserved: 0, available: 400 });
    const first = refreshCredits(ORG);
    const second = refreshCredits(ORG);
    const third = refreshCredits(ORG);
    await Promise.all([first, second, third]);
    expect(accountReads()).toHaveLength(2);
  });

  it("a server reading older than this browser's own read does not replace it; a newer one does", async () => {
    seedCredits(ORG, { balance: 400, reserved: 0, available: 400 }, new Date(Date.now() - 60_000).toISOString());
    await refreshCredits(ORG);
    seedCredits(ORG, { balance: 400, reserved: 0, available: 400 }, new Date(Date.now() - 30_000).toISOString());
    expect(creditsFor(ORG)).toEqual({ balance: 400, reserved: 25, available: 375 });
    seedCredits(ORG, { balance: 500, reserved: 0, available: 500 }, new Date(Date.now() + 1_000).toISOString());
    expect(creditsFor(ORG)?.balance).toBe(500);
  });
});

describe("tool availability and the workflow builder", () => {
  it("a plan-tier model does not make its tool available; a paid one and an open one do", () => {
    const rows = [
      { id: "t", capabilities: ["t2v"], entitlement: "models_video:premium" },
      { id: "p", capabilities: ["t2i"], entitlement: "paid" },
      { id: "o", capabilities: ["tts"], entitlement: null },
    ];
    expect(onlyOpenToSome(rows).map((m) => m.id)).toEqual(["p", "o"]);
  });

  it("a saved workflow keeps any length and shape the database could take (the builder snaps them to the step's model)", () => {
    const d = fromDefinition({
      name: "w",
      inputs: [],
      steps: [{ capability: "t2v", model: "veo-like", params: { prompt: "x", aspect_ratio: "4:3", duration_s: 6 } }],
    } as unknown as Parameters<typeof fromDefinition>[0]);
    expect(d.steps[0]).toMatchObject({ aspect: "4:3", seconds: 6 });
  });
});

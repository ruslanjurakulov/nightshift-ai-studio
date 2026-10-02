// @vitest-environment jsdom
/**
 * "Regenerate scene" on the video page (migration 0076), in a browser-like DOM.
 *
 * What would break without these: the price appearing only after the press
 * (or never); opening the panel spending anything; a press sending another
 * price than the one on the button, or a new key on a retry of the same
 * press; stock offered as a silent default instead of an explicit tick; a
 * person who may not start paid work offered the button; an in-progress or
 * failed regeneration shown without saying what it cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { dictionaries, fmt } from "@/lib/i18n";
import { RegenerateSceneButton } from "@/components/videos/RegenerateSceneButton";
import type { RegenRow } from "@/lib/sceneRegenerate";

const t = dictionaries.en.sceneRegen;
const VID = "run-0123456789abcdef0123";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let quotes: Record<string, unknown> = {};
let pressAnswer: { status: number; body: unknown } = { status: 200, body: { ok: true } };

beforeEach(() => {
  calls = [];
  refresh.mockReset();
  quotes = {
    same: { status: "priced", credits: 10, may_start: true, source_kind: "generated" },
    stock: { status: "priced", credits: 5, may_start: true, source_kind: "stock", explicit_stock: true },
  };
  pressAnswer = { status: 200, body: { ok: true, id: "r1", status: "queued" } };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url, method, body });
    if (method === "GET") {
      const src = new URL(url, "http://x").searchParams.get("source") ?? "same";
      return new Response(JSON.stringify({ quote: quotes[src], queue: true }), { status: 200 });
    }
    return new Response(JSON.stringify(pressAnswer.body), { status: pressAnswer.status });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(latest: RegenRow | null = null) {
  return render(<RegenerateSceneButton videoId={VID} sceneId="s001" latest={latest} labels={t} />);
}

describe("RegenerateSceneButton", () => {
  it("opening asks for the price and spends nothing; the price is on the button before the press", async () => {
    mount();
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    const confirm = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "10" }) });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(screen.getByText(t.sameGenerated)).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const press = calls.find((c) => c.method === "POST")!;
    expect(press.body).toMatchObject({ max_credits: 10, source: "same", prompt: null });
    expect(String(press.body?.idempotency_key)).toMatch(/^scene-regen:/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("stock for a generated scene is an explicit tick, re-priced, and sent as the choice", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    const tick = (await screen.findByLabelText(t.stockChoice)) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    fireEvent.click(tick);
    const confirm = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "5" }) });
    expect(calls.some((c) => c.method === "GET" && c.url.includes("source=stock"))).toBe(true);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ source: "stock", max_credits: 5 }));
  });

  it("a changed price is said with the new number, nothing is pressed again by itself, and the next press is a new key", async () => {
    pressAnswer = { status: 409, body: { error: "price_changed", credits: 12 } };
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    const shown = await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "10" }) });
    // The owner raised the price after it was shown.
    quotes.same = { status: "priced", credits: 12, may_start: true, source_kind: "generated" };
    fireEvent.click(shown);
    expect(await screen.findByText(fmt(t.errors.priceChanged, { credits: "12" }))).toBeTruthy();
    const first = calls.filter((c) => c.method === "POST");
    expect(first).toHaveLength(1);
    pressAnswer = { status: 200, body: { ok: true } };
    fireEvent.click(await screen.findByRole("button", { name: fmt(t.priceButton, { credits: "12" }) }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [a, b] = calls.filter((c) => c.method === "POST");
    expect(b.body?.max_credits).toBe(12);
    expect(b.body?.idempotency_key).not.toBe(a.body?.idempotency_key);
  });

  it("someone who may not start paid work sees the price but no button", async () => {
    quotes.same = { status: "priced", credits: 10, may_start: false, source_kind: "generated" };
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    expect(await screen.findByText(t.noPermission)).toBeTruthy();
    expect(screen.queryByRole("button", { name: fmt(t.priceButton, { credits: "10" }) })).toBeNull();
  });

  it("an unset price is said, never shown as 0, and cannot be pressed", async () => {
    quotes.same = { status: "unpriced", credits: null, may_start: true };
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    expect(await screen.findByText(t.unpriced)).toBeTruthy();
    expect(screen.queryByText(/0 credits/)).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an unavailable scene says why, and offers stock only as a choice", async () => {
    quotes.same = { status: "unavailable", reason: "generator_not_recorded", had_generated: true, may_start: true };
    mount();
    fireEvent.click(screen.getByRole("button", { name: t.action }));
    expect(await screen.findByText(t.reasons.generator_not_recorded)).toBeTruthy();
    expect((screen.getByLabelText(t.stockChoice) as HTMLInputElement).checked).toBe(false);
  });

  it("a regeneration in progress shows its status instead of a second button", () => {
    mount({
      id: "r1", sceneId: "s001", status: "queued", sourceKind: "generated", explicitStock: false,
      quotedCredits: 10, chargedCredits: null, errorCode: null, previousAssetIds: ["a_old"], createdAt: null, finishedAt: null,
    });
    expect(screen.getByText(t.status.queued)).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.action })).toBeNull();
  });

  it("a failed one says the scene is unchanged and nothing was charged, and can be tried again", () => {
    mount({
      id: "r1", sceneId: "s001", status: "failed", sourceKind: "generated", explicitStock: false,
      quotedCredits: 10, chargedCredits: 0, errorCode: "provider_unavailable", previousAssetIds: ["a_old"],
      createdAt: null, finishedAt: "2026-10-02T10:00:00Z",
    });
    expect(screen.getByRole("status").textContent).toContain(t.status.failed);
    expect(screen.getByRole("status").textContent).toContain(t.failures.provider_unavailable);
    expect(screen.getByRole("button", { name: t.action })).toBeTruthy();
  });
});

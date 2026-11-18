// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import type { StudioModel } from "@/lib/creative/studio";

vi.mock("next/navigation", () => ({ usePathname: () => "/synthetic/create", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/synthetic${p}` }));
vi.mock("@/lib/credits-live", () => ({ useLiveCredits: () => null, refreshCredits: vi.fn() }));
vi.mock("@/components/studio/useStyleKits", () => ({ useStyleKits: () => ({ state: "ready", kits: [], reload: vi.fn() }) }));

const models: StudioModel[] = [
  { id: "synthetic-a", displayName: "Model A", capabilities: ["t2i"], beta: false },
  { id: "synthetic-b", displayName: "Model B", capabilities: ["t2i"], beta: false },
];
const t = dictionaries.en;
const json = (body: unknown) => new Response(JSON.stringify(body));
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(600); }); };
beforeEach(() => { vi.useFakeTimers(); window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["transport aborts", "old response processing completes late"] as const)(
  "a newer model quote survives when %s", async (mode) => {
    let first = true;
    let oldSignal: AbortSignal | null = null;
    let completeOld!: (body: unknown) => void;
    const observations: unknown[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/creative/quote") {
        const body = JSON.parse(String(init?.body));
        if (first && body.model === "synthetic-a") {
          first = false;
          oldSignal = init?.signal as AbortSignal;
          if (mode === "transport aborts") {
            return new Promise<Response>((_resolve, reject) => {
              oldSignal!.addEventListener("abort", () => reject(new DOMException("Synthetic request cancelled", "AbortError")), { once: true });
            });
          }
          // An already-returned, nonpaid quote response with asynchronous local
          // processing. Cancellation is observed below; it cannot be assumed
          // to cancel every continuation after the transport has returned.
          return { ok: true, json: () => new Promise((resolve) => { completeOld = resolve; }) } as Response;
        }
        return json({ quote: { credits: body.model === "synthetic-b" ? 9 : 2 } });
      }
      if (url === "/api/creative/jobs" && init?.method === "POST") throw new Error("Unexpected generation attempt");
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      return new Response("{}", { status: 503 });
    });
    vi.stubGlobal("fetch", fetcher);
    const page = render(<I18nProvider locale="en"><GeneratePanel
      orgId="11111111-1111-4111-8111-111111111111" models={models}
      initial={{ capability: "t2i", model: "synthetic-a", prompt: "Synthetic scene", aspect: "16:9", duration: 5 }}
    /></I18nProvider>);
    const summary = () => page.getByTestId("gen-review");
    const value = (label: string) => within(summary()).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    const jobAttempts = () => fetcher.mock.calls.filter(([url, init]) => url === "/api/creative/jobs" && init?.method === "POST");
    await tick();
    expect(first).toBe(false);
    fireEvent.click(page.getByRole("button", { name: t.gen.modelChangeLabel }));
    const dialog = page.getByRole("dialog", { name: t.gen.sheetTitle });
    const option = within(dialog).getAllByRole("option").find(el => el.getAttribute("data-model") === "synthetic-b")!;
    fireEvent.click(option);
    await tick();
    expect(oldSignal!.aborted).toBe(true);
    expect(value(t.gen.modelLabel)).toBe("Model B");
    expect(value(t.gen.review.credits)).toBe("9 credits");
    expect(jobAttempts()).toHaveLength(0);
    observations.push({ stage: "newer model quote", model: value(t.gen.modelLabel), credits: value(t.gen.review.credits) });
    if (mode === "old response processing completes late") {
      await act(async () => { completeOld({ quote: { credits: 2 } }); });
    }
    observations.push({ stage: "old quote settled", model: value(t.gen.modelLabel), credits: value(t.gen.review.credits), oldAborted: oldSignal!.aborted, jobAttempts: jobAttempts().length });
    console.info("NS-216 synthetic observation", JSON.stringify({ mode, observations }));
    expect(jobAttempts()).toHaveLength(0);
    expect(value(t.gen.modelLabel)).toBe("Model B");
    expect(value(t.gen.review.credits)).toBe("9 credits");
  },
);

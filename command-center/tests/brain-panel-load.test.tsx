// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt } from "@/lib/i18n";
import { AI_PANEL_LOAD_TIMEOUT_MS, NightshiftAiPanel } from "@/components/brain/NightshiftAiPanel";

/**
 * L1-02 (live audit 2026-11-21, /all-channels/studio): the Nightshift AI panel sat on "Yuklanmoqda…" with nothing else. Its first
 * read (/api/brain) had no time limit, so a request that never answered kept it there for good — no error, no Retry. And a 200 whose
 * body was not the panel's answer (an HTML page) was drawn as "ready" with no plan, and the render that read plan.limit threw.
 * What would break without these: the panel stuck on loading again, or a failure said as a generic line (or not at all).
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/studio" }));

const en = dictionaries.en.aiChat;
const READY = { plan: { used: 0, limit: 10, trial_left: null, max_input_chars: 2000 }, model: "available", canEdit: true, canRun: true, session: null };
const json = (status: number, body: unknown) => ({ ok: status < 400 && status >= 200, status, json: async () => body });

/** A request that never answers on its own: it ends only when the panel aborts it, the way a browser's fetch does. */
function hanging(_url: string, init?: RequestInit) {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

function mount() {
  return render(
    <I18nProvider locale="en">
      <NightshiftAiPanel channelId="c1" channelSlug="chronos" />
    </I18nProvider>,
  );
}

const box = () => document.getElementById("ns-ai-input");

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Nightshift AI panel: first load never stays on loading", () => {
  it("draws a skeleton (not a line of text) while the first read is out", async () => {
    vi.stubGlobal("fetch", vi.fn(hanging));
    mount();
    const loading = await screen.findByTestId("ns-ai-loading");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    // Screen readers still hear "Loading…"; sighted people see the shape of the box that is coming.
    expect(loading.querySelector(".sr-only")?.textContent).toBe(en.loading);
  });

  it("a read that never answers ends as a named timeout with Retry, and Retry loads the panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(hanging);
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await screen.findByTestId("ns-ai-loading");
    await act(async () => {
      vi.advanceTimersByTime(AI_PANEL_LOAD_TIMEOUT_MS + 10);
    });
    const failed = await screen.findByTestId("ns-ai-load-failed");
    expect(failed.getAttribute("data-why")).toBe("timeout");
    expect(failed.textContent).toContain(en.errors.load_timeout);
    expect(screen.queryByTestId("ns-ai-loading")).toBeNull();
    // The request itself was given the abort signal: the timer is not just a label over a request still running.
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);

    fetchMock.mockImplementation(async () => json(200, READY) as unknown as Promise<never>);
    fireEvent.click(screen.getByRole("button", { name: en.retry }));
    await waitFor(() => expect(box()).toBeTruthy());
    expect(screen.queryByTestId("ns-ai-load-failed")).toBeNull();
  });

  it("an unreachable server is said as such, not as 'could not answer'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    mount();
    const failed = await screen.findByTestId("ns-ai-load-failed");
    expect(failed.getAttribute("data-why")).toBe("offline");
    expect(failed.textContent).toContain(en.errors.load_offline);
    expect(screen.getByRole("button", { name: en.retry })).toBeTruthy();
  });

  it("a server error names its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(502, { error: "bad_gateway" })));
    mount();
    const failed = await screen.findByTestId("ns-ai-load-failed");
    expect(failed.getAttribute("data-why")).toBe("server");
    expect(failed.textContent).toContain(fmt(en.errors.load_server, { status: 502 }));
  });

  it.each([
    ["an HTML page", async () => { throw new SyntaxError("Unexpected token '<'"); }],
    ["a JSON body with no plan", async () => ({ ok: true })],
  ])("a 200 that is not the panel's answer (%s) is a named failure, not a crash", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: body })));
    mount();
    const failed = await screen.findByTestId("ns-ai-load-failed");
    expect(failed.getAttribute("data-why")).toBe("bad_answer");
    expect(failed.textContent).toContain(en.errors.load_bad_answer);
  });
});

describe("Nightshift AI panel load errors: every language", () => {
  it.each(["en", "ru", "uz"] as const)("has all four named load errors in %s, the server one with its status", (locale) => {
    const e = dictionaries[locale].aiChat.errors;
    for (const k of ["load_timeout", "load_offline", "load_server", "load_bad_answer"] as const) expect(e[k].trim().length, k).toBeGreaterThan(10);
    expect(e.load_server).toContain("{status}");
  });
});

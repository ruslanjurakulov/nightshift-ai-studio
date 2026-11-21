// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The Payme panel on the Credits page. What would break without these: the browser sending an amount (or anything but
 * our pack id), the page following a link to some other host, a second press opening a second order, a refusal shown as
 * success, or copy missing in a language.
 */

const h = vi.hoisted(() => ({ assigned: [] as string[], refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/credits",
  useRouter: () => ({ push: vi.fn(), refresh: h.refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (section: string) => `/my-channel${section}` }));
vi.mock("@/components/view-mode/frame-nav", () => ({
  assignTop: (url: string) => {
    h.assigned.push(url);
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { PaymeBuyCredits } from "@/components/credits/PaymeBuyCredits";
import type { PaymeView } from "@/lib/payme";

const t = dictionaries.en;
const view: PaymeView = { environment: "test", packs: [{ id: "starter", credits: 1000, uzs: 120000 }] };
let answer: () => Response;
const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  h.assigned.length = 0;
  fetchCalls.length = 0;
  answer = () => new Response(JSON.stringify({ url: "https://test.paycom.uz/bT0xMjM=" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, body: JSON.parse(String(init.body)) });
    return answer();
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(
    <I18nProvider locale="en">
      <PaymeBuyCredits view={view} />
    </I18nProvider>,
  );

describe("PaymeBuyCredits", () => {
  it("sends only our pack id, the return path and the language, then goes to Payme's checkout", async () => {
    mount();
    expect(screen.getByText(t.payme.testMode)).toBeTruthy();
    const button = screen.getByRole("button", { name: /Pay .*120,000.* with Payme/ });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fetchCalls).toEqual([{ url: "/api/billing/payme/checkout", body: { pack: "starter", return_path: "/my-channel/credits", lang: "en" } }]);
    expect(h.assigned).toEqual(["https://test.paycom.uz/bT0xMjM="]);
  });

  it("never follows a link to another host", async () => {
    answer = () => new Response(JSON.stringify({ url: "https://evil.example/pay" }), { status: 200 });
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(h.assigned).toEqual([]);
    expect(screen.getByText(t.payme.failed)).toBeTruthy();
  });

  it("says too many on 429 and not on sale on 404, never success", async () => {
    answer = () => new Response(JSON.stringify({ error: "too_many_checkouts" }), { status: 429 });
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByText(t.payme.tooMany)).toBeTruthy();
    answer = () => new Response(JSON.stringify({ error: "not_on_sale" }), { status: 404 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByText(t.payme.notOnSale)).toBeTruthy();
  });

  it("has every string in en, ru and uz", () => {
    const keys = Object.keys(dictionaries.en.payme).sort();
    for (const loc of ["ru", "uz"] as const) {
      expect(Object.keys(dictionaries[loc].payme).sort()).toEqual(keys);
      for (const k of keys) expect((dictionaries[loc].payme as Record<string, string>)[k]).not.toBe((dictionaries.en.payme as Record<string, string>)[k]);
    }
  });
});

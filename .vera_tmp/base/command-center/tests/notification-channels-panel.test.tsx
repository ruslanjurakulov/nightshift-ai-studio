// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/organization",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { NotificationChannels } from "@/components/notifications/NotificationChannels";
import { parsePreferences, type ChannelRow } from "@/lib/notify-channels";

const ID = "0f0e0d0c-0b0a-4000-8000-000000000001";
const TOKEN = "0123456789abcdef".repeat(3) + "01234567";
const LINK = `https://t.me/reply_NightshiftAiStudio_bot?start=${TOKEN}`;

const chat = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: ID, kind: "telegram", label: "Ana", locale: "en", status: "active", verified_at: "2026-10-01T00:00:00Z",
  last_ok_at: null, last_error_code: null, ...over,
});
const allOn = parsePreferences(
  ["creative_job_completed", "creative_job_failed", "storyboard_ready", "editor_export_done", "credits_low"].map((event) => ({ event, channel: "telegram", enabled: true })),
);

let calls: { url: string; body: unknown }[];
let answer: (url: string, body: Record<string, unknown>) => { status?: number; json: unknown };
let listing: { channels: unknown[]; preferences: unknown[] };

function mount(channels: ChannelRow[], locale: Locale = "en") {
  return render(
    <I18nProvider locale={locale}>
      <NotificationChannels initialChannels={channels} initialPreferences={allOn} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  calls = [];
  listing = { channels: [], preferences: [] };
  answer = () => ({ json: { ok: true } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (!init?.method || init.method === "GET") return new Response(JSON.stringify(listing), { status: 200 });
    const a = answer(url, body);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NotificationChannels", () => {
  it("offers Connect, the consent line and switches that wait for a chat", () => {
    mount([]);
    const t = dictionaries.en.notifyChannels;
    expect(screen.getByRole("button", { name: t.connect })).toBeTruthy();
    expect(screen.getByText(t.consent)).toBeTruthy();
    expect(screen.getByText(t.eventsNeedChat)).toBeTruthy();
    for (const sw of screen.getAllByRole("switch")) expect((sw as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for a link in the page's language and shows it as an Open Telegram link, nothing stored", async () => {
    answer = () => ({ json: { ok: true, url: LINK, expires_at: new Date(Date.now() + 600_000).toISOString() } });
    mount([], "ru");
    fireEvent.click(screen.getByRole("button", { name: dictionaries.ru.notifyChannels.connect }));
    const open = await screen.findByRole("link", { name: new RegExp(dictionaries.ru.notifyChannels.openTelegram) });
    expect(open.getAttribute("href")).toBe(LINK);
    expect(open.getAttribute("rel")).toContain("noopener");
    expect(calls[0]).toEqual({ url: "/api/notifications/telegram", body: { locale: "ru" } });
    expect(window.localStorage.length).toBe(0);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("says why linking failed with a fixed sentence, never provider text", async () => {
    answer = () => ({ status: 429, json: { error: "rate_limited" } });
    mount([]);
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.notifyChannels.connect }));
    expect((await screen.findByRole("alert")).textContent).toBe(dictionaries.en.notifyChannels.errors.rate_limited);
  });

  it("notices the new chat while waiting and says it is connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer = () => ({ json: { ok: true, url: LINK, expires_at: new Date(Date.now() + 600_000).toISOString() } });
    mount([]);
    fireEvent.click(screen.getByRole("button", { name: dictionaries.en.notifyChannels.connect }));
    await screen.findByTestId("notify-waiting");
    listing = { channels: [chat()], preferences: allOn.map((p) => ({ ...p, channel: "telegram" })) };
    await vi.advanceTimersByTimeAsync(3100);
    await waitFor(() => expect(screen.queryByTestId("notify-waiting")).toBeNull());
    expect(screen.getByTestId("notify-channel")).toBeTruthy();
    expect(screen.getByText(fmt(dictionaries.en.notifyChannels.connectedAs, { name: "Ana" }))).toBeTruthy();
  });

  it("shows a blocked chat with the way out, and a delivery time only when one is known", () => {
    const t = dictionaries.en.notifyChannels;
    mount([chat({ status: "blocked" })]);
    expect(screen.getByText(t.blockedHelp)).toBeTruthy();
    expect(screen.getByText(t.neverDelivered)).toBeTruthy();
    expect((screen.getByRole("button", { name: t.sendTest }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount([chat({ last_ok_at: "2026-10-02T10:00:00Z" })]);
    expect(screen.queryByText(t.neverDelivered)).toBeNull();
    expect(screen.getByText(/Last message delivered/)).toBeTruthy();
  });

  it("disconnect asks first, then calls the channel route for that id", async () => {
    const t = dictionaries.en.notifyChannels;
    mount([chat()]);
    fireEvent.click(screen.getByRole("button", { name: t.disconnect }));
    expect(calls.length).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: t.disconnectYes }));
    await waitFor(() => expect(calls[0]).toEqual({ url: "/api/notifications/telegram/channel", body: { id: ID, action: "disconnect" } }));
  });

  it("a switch flips at once and goes back with a sentence when the server refuses", async () => {
    answer = () => ({ status: 429, json: { error: "rate_limited" } });
    mount([chat()]);
    const sw = screen.getByRole("switch", { name: dictionaries.en.notifyChannels.events.credits_low });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByTestId("notify-error")).toBeTruthy());
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(calls[0]).toEqual({ url: "/api/notifications/telegram/preference", body: { event: "credits_low", enabled: false } });
  });

  it("changes the message language of one chat", async () => {
    mount([chat()]);
    fireEvent.change(screen.getByLabelText(dictionaries.en.notifyChannels.language), { target: { value: "uz" } });
    await waitFor(() => expect(calls[0].body).toEqual({ id: ID, action: "locale", locale: "uz" }));
  });
});

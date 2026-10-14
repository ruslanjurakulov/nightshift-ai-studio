// @vitest-environment jsdom
/**
 * The Add channel buttons and the pick screen.
 *
 * What would break without these: a button that starts a flow the server
 * cannot finish, a pick that sends anything but the listed channel's id, a
 * hidden subscriber count printed as 0, an "already connected" channel that can
 * be created twice, a dead end when the sign-in expired, and a page that fails
 * axe in any language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import axe from "axe-core";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/channels/connect",
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ConnectStart } from "@/components/channels/ConnectStart";
import { ConnectPicker } from "@/components/channels/ConnectPicker";
import type { PickView } from "@/lib/connect-picker";

const tc = dictionaries.en.connectPicker;
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const all = { youtube: true, instagram: true, tiktok: true };

const youtube = (over: Partial<Extract<PickView, { platform: "youtube" }>> = {}): PickView => ({
  platform: "youtube",
  expiresAt: Date.now() + 60_000,
  candidates: [
    { id: "UCaaaaaaaaaaaaaaaaaaaaaa", title: "Extinct World", handle: "@extinctworld", thumbnail: "https://yt3.ggpht.com/a.jpg", subscribers: "1200", videos: "48", linkedTo: null },
    { id: "UCbbbbbbbbbbbbbbbbbbbbbb", title: "Quiet Channel", handle: null, thumbnail: null, subscribers: null, videos: null, linkedTo: null },
    { id: "UCcccccccccccccccccccccc", title: "Already Here", handle: "@here", thumbnail: null, subscribers: "5", videos: "1", linkedTo: { channelId: "already-here", name: "Already Here" } },
  ],
  ...over,
});

async function violations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

beforeEach(() => {
  push.mockReset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("ConnectStart: one button per platform", () => {
  it("offers one link per platform to its start route in the pick flow", () => {
    render(withI18n(<ConnectStart canYoutube canSocial configured={all} result={null} />));
    const hrefs = (name: string) => screen.getByRole("link", { name }).getAttribute("href");
    expect(hrefs(tc.connectYoutube)).toBe("/api/oauth/youtube/start?pick=1");
    expect(hrefs(tc.connectInstagram)).toBe("/api/oauth/instagram/start?pick=1");
    expect(hrefs(tc.connectTiktok)).toBe("/api/oauth/tiktok/start?pick=1");
    expect(screen.getAllByRole("link")).toHaveLength(3);
  });
  it("carries what /welcome asked for into the YouTube start only", () => {
    render(withI18n(<ConnectStart canYoutube canSocial configured={all} result={null} niche="Ancient history" language="Russian" />));
    const yt = new URL(screen.getByRole("link", { name: tc.connectYoutube }).getAttribute("href") ?? "", "https://x.test");
    expect(yt.searchParams.get("niche")).toBe("Ancient history");
    expect(yt.searchParams.get("language")).toBe("Russian");
    expect(screen.getByRole("link", { name: tc.connectTiktok }).getAttribute("href")).not.toMatch(/niche/);
  });
  it("says a platform is not available instead of offering a button that cannot finish", () => {
    render(withI18n(<ConnectStart canYoutube canSocial configured={{ ...all, tiktok: false }} result={null} />));
    expect(screen.queryByRole("link", { name: tc.connectTiktok })).toBeNull();
    expect(screen.getByText(tc.unavailableYet.replace("{platform}", tc.tiktok))).toBeTruthy();
  });
  it("offers nothing to someone the server would refuse, and says why", () => {
    render(withI18n(<ConnectStart canYoutube={false} canSocial={false} configured={all} result={null} />));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getAllByText(tc.noPermission)).toHaveLength(3);
  });
  it("shows the word a failed connect came back with, in the platform's name", () => {
    render(withI18n(<ConnectStart canYoutube canSocial configured={all} result={{ platform: "instagram", word: "not_business" }} />));
    expect(screen.getByRole("alert").textContent).toBe(tc.results.not_business);
  });
  it.each(["en", "ru", "uz"] as const)("passes axe in %s", async (locale) => {
    const { container } = render(withI18n(<ConnectStart canYoutube canSocial configured={all} result={{ platform: "youtube", word: "denied" }} />, locale));
    expect(await violations(container)).toEqual([]);
  });
});

describe("ConnectPicker: YouTube", () => {
  it("lists each channel with avatar slot, title, handle and counts; a hidden count reads hidden, not 0", () => {
    render(withI18n(<ConnectPicker view={youtube()} />));
    const list = screen.getByRole("list", { name: tc.pick.listLabel });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Extinct World");
    expect(rows[0].textContent).toContain("@extinctworld");
    expect(rows[0].textContent).toContain("1,200 subscribers");
    expect(rows[1].textContent).toContain(tc.pick.subscribersHidden);
    expect(rows[1].textContent).not.toMatch(/\b0\b/);
    expect(rows[0].querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  it("marks a channel that is already connected and does not offer to create it again", () => {
    render(withI18n(<ConnectPicker view={youtube()} />));
    const row = screen.getByText("Already Here", { selector: "div" }).closest("li") as HTMLElement;
    expect(row.textContent).toContain(tc.pick.alreadyConnected);
    expect(within(row).queryByRole("button", { name: tc.pick.useChannel })).toBeNull();
    expect(within(row).getByRole("link", { name: tc.pick.openChannels }).getAttribute("href")).toBe("/all-channels/channels");
    expect(screen.getAllByRole("button", { name: tc.pick.useChannel })).toHaveLength(2);
  });
  it("sends only the platform and the chosen channel id, then goes to the Channels page", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: "connected", channel_id: "extinctworld" }));
    render(withI18n(<ConnectPicker view={youtube()} />));
    fireEvent.click(screen.getAllByRole("button", { name: tc.pick.useChannel })[0]);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/all-channels/channels?yt=connected"));
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/connect/pending");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ action: "confirm", platform: "youtube", channel_id: "UCaaaaaaaaaaaaaaaaaaaaaa" });
  });
  it("disables every choice while one is in flight (no double create)", async () => {
    let release: (r: Response) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((r) => (release = r)));
    render(withI18n(<ConnectPicker view={youtube()} />));
    fireEvent.click(screen.getAllByRole("button", { name: tc.pick.useChannel })[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: tc.pick.connecting })).toBeTruthy());
    for (const b of screen.getAllByRole("button", { name: tc.pick.useChannel })) expect((b as HTMLButtonElement).disabled).toBe(true);
    release(Response.json({ ok: true, result: "connected" }));
  });
  it("shows our own words for a refusal and stays put, never the server's text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: false, result: "forbidden", detail: "RAW PROVIDER ERROR" }, { status: 403 }));
    render(withI18n(<ConnectPicker view={youtube()} />));
    fireEvent.click(screen.getAllByRole("button", { name: tc.pick.useChannel })[0]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tc.pick.errors.forbidden));
    expect(document.body.textContent).not.toContain("RAW PROVIDER ERROR");
    expect(push).not.toHaveBeenCalled();
  });
  it("survives a network failure with a retryable message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    render(withI18n(<ConnectPicker view={youtube()} />));
    fireEvent.click(screen.getAllByRole("button", { name: tc.pick.useChannel })[0]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(tc.pick.errors.failed));
    expect((screen.getAllByRole("button", { name: tc.pick.useChannel })[0] as HTMLButtonElement).disabled).toBe(false);
  });
  it("tells the Brand Account story and offers another Google account (a fresh consent) and cancel", () => {
    render(withI18n(<ConnectPicker view={youtube()} />));
    expect(screen.getByText(tc.pick.brandHint)).toBeTruthy();
    expect(screen.getByRole("link", { name: tc.pick.anotherGoogle }).getAttribute("href")).toBe("/api/oauth/youtube/start?pick=1");
    expect(screen.getByRole("button", { name: tc.pick.cancel })).toBeTruthy();
  });
  it("cancel tells the server to drop the held sign-in and returns to Add channel", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    render(withI18n(<ConnectPicker view={youtube()} />));
    fireEvent.click(screen.getByRole("button", { name: tc.pick.cancel }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/all-channels/channels/new"));
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ action: "cancel" });
  });
  it.each(["en", "ru", "uz"] as const)("passes axe in %s", async (locale) => {
    const { container } = render(withI18n(<ConnectPicker view={youtube()} />, locale));
    expect(await violations(container)).toEqual([]);
  });
});

describe("ConnectPicker: Instagram and TikTok confirm", () => {
  const social = (connected: boolean): PickView => ({
    platform: "tiktok",
    expiresAt: Date.now() + 60_000,
    account: { externalId: "oid-1", name: "Brand", username: null, avatarUrl: null, connected },
  });
  it("shows the one authorised account and confirms it with the platform only", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: "connected" }));
    render(withI18n(<ConnectPicker view={social(false)} />));
    expect(screen.getByText("Brand")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tc.pick.confirm }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/all-channels/channels?social=connected&platform=tiktok"));
    expect(JSON.parse(String((f.mock.calls[0][1] as RequestInit).body))).toEqual({ action: "confirm", platform: "tiktok" });
  });
  it("says reconnecting renews an account that is already connected", () => {
    render(withI18n(<ConnectPicker view={social(true)} />));
    expect(screen.getByRole("button", { name: tc.pick.reconnect })).toBeTruthy();
    expect(screen.getByText(tc.pick.socialAlready)).toBeTruthy();
  });
  it("explains that the platform connects the account signed in there, and offers another", () => {
    render(withI18n(<ConnectPicker view={social(false)} />));
    expect(screen.getByRole("link", { name: tc.pick.anotherAccount.replace("{platform}", tc.tiktok) }).getAttribute("href")).toBe("/api/oauth/tiktok/start?pick=1");
  });
  it.each(["en", "ru", "uz"] as const)("passes axe in %s", async (locale) => {
    const { container } = render(withI18n(<ConnectPicker view={social(true)} />, locale));
    expect(await violations(container)).toEqual([]);
  });
});

describe("ConnectPicker: nothing waiting", () => {
  it("is never a dead end: it says the sign-in expired and links back to Add channel", async () => {
    const { container } = render(withI18n(<ConnectPicker view={null} />));
    expect(screen.getByText(tc.pick.expiredTitle)).toBeTruthy();
    expect(screen.getByRole("link", { name: tc.pick.startAgain }).getAttribute("href")).toBe("/all-channels/channels/new");
    expect(await violations(container)).toEqual([]);
  });
});

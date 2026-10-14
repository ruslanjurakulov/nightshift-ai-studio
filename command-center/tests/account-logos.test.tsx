// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { ConnectedAccountsList } from "@/components/account/AccountParts";
import type { AccountSummary, ConnectedAccount } from "@/lib/account";

const en = dictionaries.en;
const EMAIL = "ana.k@example.com";

const yt = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  platform: "youtube",
  id: "UC1",
  name: "Night Owl",
  avatarUrl: "https://yt3.example.test/night-owl.jpg",
  connected: true,
  ...over,
});
const summary = (accounts: ConnectedAccount[]): AccountSummary => ({
  email: EMAIL,
  plan: { kind: "unknown" },
  credits: null,
  accounts,
  connectable: { instagram: false, tiktok: false },
});
const list = (accounts: ConnectedAccount[]) =>
  render(
    <I18nProvider locale="en">
      <ConnectedAccountsList data={summary(accounts)} state="ready" />
    </I18nProvider>,
  );

afterEach(cleanup);

describe("connected accounts: before anything is connected", () => {
  it("draws each platform's logo in its tile, not letter chips", () => {
    const { container } = list([]);
    for (const p of ["youtube", "instagram", "tiktok"]) {
      const tile = container.querySelector(`[data-platform-tile="${p}"]`) as HTMLElement;
      expect(tile.getAttribute("aria-hidden")).toBe("true");
      expect(tile.querySelector(`svg[data-platform="${p}"] path`)).not.toBeNull();
    }
    expect(container.textContent).not.toMatch(/\b(YT|IG|TT)\b/);
  });

  it("keeps the names, Connect for YouTube and the coming-soon state for the others", () => {
    list([]);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("YouTube")).toBeTruthy();
    expect(within(rows[0]).getByText(en.account.noYoutube)).toBeTruthy();
    expect(within(rows[0]).getByRole("link", { name: en.account.connect }).getAttribute("href")).toBe("/chronos/channels");
    for (const i of [1, 2]) {
      expect(within(rows[i]).getByText(en.account.comingSoon)).toBeTruthy();
      expect(within(rows[i]).getByRole("button", { name: en.account.connect }).hasAttribute("disabled")).toBe(true);
    }
  });
});

describe("connected accounts: a connected account", () => {
  it("shows its own avatar, its name first and the platform second, with a platform badge", () => {
    const { container } = list([yt()]);
    const row = screen.getAllByRole("listitem")[0];
    const img = row.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://yt3.example.test/night-owl.jpg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("aria-hidden")).toBe("true");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(row.querySelector("[data-account-avatar] svg[data-platform='youtube']")).not.toBeNull();
    const lines = Array.from(row.querySelectorAll("p")).map((p) => p.textContent);
    expect(lines).toEqual(["Night Owl", "YouTube"]);
    expect(within(row).getByText(en.account.connected)).toBeTruthy();
    // The unconnected platforms keep their placeholders.
    expect(container.querySelectorAll("[data-platform-tile]")).toHaveLength(2);
  });

  it("falls back to the platform logo when there is no avatar", () => {
    const { container } = list([yt({ avatarUrl: null })]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-platform-tile="youtube"]')).not.toBeNull();
  });

  it("falls back to the platform logo when the image does not load", () => {
    const { container } = list([yt()]);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('[data-platform-tile="youtube"]')).not.toBeNull();
    // The text is untouched.
    expect(screen.getByText("Night Owl")).toBeTruthy();
  });

  it("keeps a known but not connected account's wording", () => {
    list([yt({ connected: false, avatarUrl: null })]);
    const row = screen.getAllByRole("listitem")[0];
    expect(within(row).getByText(en.account.notConnected)).toBeTruthy();
    expect(within(row).getByText("Night Owl")).toBeTruthy();
  });

  it("names things only by their text: the pictures are hidden from assistive tech and no e-mail is drawn", () => {
    const { container } = list([yt()]);
    expect(container.innerHTML).not.toContain(EMAIL);
    expect(container.innerHTML).not.toContain("example.com/");
    for (const el of container.querySelectorAll("svg, img")) expect(el.closest("[aria-hidden='true']"), el.outerHTML.slice(0, 40)).not.toBeNull();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    // The only tooltip is the disabled Connect buttons' "Coming soon".
    for (const el of container.querySelectorAll("[title]")) expect(el.getAttribute("title")).toBe(en.account.comingSoon);
  });
});

describe("what the page may load", () => {
  it("the CSP already allows an https avatar, so nothing new is needed", () => {
    const csp = readFileSync(path.join(process.cwd(), "lib/security/csp.ts"), "utf8");
    expect(csp).toMatch(/\["img-src", \["'self'", "data:", "blob:", "https:"\]\]/);
  });

  it("the logos are inline: no image file and no remote address in the module", () => {
    const src = readFileSync(path.join(process.cwd(), "components/account/PlatformLogo.tsx"), "utf8");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/\.(png|jpe?g|svg|webp)["']/);
  });
});

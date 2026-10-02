// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";

const push = vi.fn();
let pathname = "/chronos/create";
let search = "";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push, refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/components/navigation/NavigationProvider", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), channelName: () => null, showChannel: false }),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { SideNav } from "@/components/SideNav";
import { Header } from "@/components/Header";
import { SectionShell } from "@/components/SectionShell";
import { CreditMenu } from "@/components/shell/CreditMenu";
import { ShellProvider } from "@/components/shell/ShellContext";
import {
  CUSTOMER_RAIL,
  CUSTOMER_SIDEBAR,
  NAV_ITEMS,
  RAIL_HIDDEN_KEYS,
  STUDIO_TOOLS,
  navGroupsFor,
  sectionAllowed,
  sidebarCurrent,
} from "@/lib/navigation";
import { COMPOSER_CAPABILITIES, prefillFromQuery } from "@/lib/creative/studio";
import { creditPillAmount, creditUnit } from "@/lib/credits";
import { planName, type AccountPlan } from "@/lib/account";

const en = dictionaries.en;
const PIC = "3f2a8c1e-5b7d-4e9a-8c6f-1d2e3f4a5b6c";
const ACCOUNT = { balance: 1240, reserved: 60, available: 1240 };
const PLAN: AccountPlan = {
  kind: "plan",
  id: "creator",
  name: "Creator",
  isDefault: false,
  status: "active",
  periodEnd: null,
  cancelAtPeriodEnd: false,
};

function withI18n(ui: ReactNode, locale: Locale = "en") {
  return <I18nProvider locale={locale}>{ui}</I18nProvider>;
}

beforeEach(() => {
  pathname = "/chronos/create";
  search = "";
  push.mockClear();
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(cleanup);

describe("customer sidebar model", () => {
  it("lists exactly the Studio's tools, voice tools included, in the composer's order", () => {
    expect([...STUDIO_TOOLS]).toEqual([...COMPOSER_CAPABILITIES]);
    expect(CUSTOMER_SIDEBAR.tools.map((t) => t.href)).toEqual(STUDIO_TOOLS.map((t) => `/create?tool=${t}`));
  });

  it("every tool link opens its tool in the form, with no picture and nothing priced", () => {
    for (const { tool, href } of CUSTOMER_SIDEBAR.tools) {
      const q = new URL(href, "https://x").searchParams;
      const p = prefillFromQuery(q.get("tool") ?? undefined, q.get("source") ?? undefined);
      expect(p, tool).toMatchObject({ capability: tool, prompt: "", model: "" });
      expect(p?.sourceId ?? null, tool).toBeNull();
    }
  });

  it("reaches every rail destination, and only screens a customer may open", () => {
    const hrefs = [CUSTOMER_SIDEBAR.home, ...CUSTOMER_SIDEBAR.work, ...CUSTOMER_SIDEBAR.footer].map((i) => i.href);
    for (const r of CUSTOMER_RAIL) expect(hrefs, r.key).toContain(r.href);
    for (const h of [...hrefs, ...CUSTOMER_SIDEBAR.tools.map((t) => t.href)]) {
      const section = h.slice(1).split("?")[0];
      expect(sectionAllowed(section, false), h).toBe(true);
    }
  });

  it("marks the row you are on: a tool on /create, Studio for its tabs, Library and Settings for theirs", () => {
    expect(sidebarCurrent("/create", "t2v")).toBe("tool:t2v");
    expect(sidebarCurrent("/create", null)).toBe("hub");
    expect(sidebarCurrent("/create", "not-a-tool")).toBe("hub");
    expect(sidebarCurrent("/studio", null)).toBe("hub");
    expect(sidebarCurrent("/series", null)).toBe("hub");
    expect(sidebarCurrent("/library", null)).toBe("library");
    expect(sidebarCurrent("/styles", null)).toBe("styles");
    expect(sidebarCurrent("/editor", null)).toBe("editor");
    expect(sidebarCurrent("/editor/3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e", null)).toBe("editor");
    expect(sidebarCurrent("/videos/abc", null)).toBe("videos");
    expect(sidebarCurrent("/credits", null)).toBe("credits");
    expect(sidebarCurrent("/developers", null)).toBe("settings");
    expect(sidebarCurrent("/pipeline", null)).toBeNull();
  });

  it("leaves the operator's console exactly as it was", () => {
    const keys = navGroupsFor(true).flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toEqual(NAV_ITEMS.map((i) => i.key).filter((k) => !RAIL_HIDDEN_KEYS.includes(k)));
    expect(navGroupsFor(false).flatMap((g) => g.items.map((i) => i.key))).toEqual(CUSTOMER_RAIL.map((i) => i.key));
  });
});

describe("prefillFromQuery from a sidebar link", () => {
  it("accepts a text tool without a picture, and refuses one that carries a picture", () => {
    expect(prefillFromQuery("t2v", undefined)).toMatchObject({ capability: "t2v" });
    expect(prefillFromQuery("tts", undefined)).toMatchObject({ capability: "tts" });
    expect(prefillFromQuery("t2i", PIC)).toBeNull();
  });

  it("opens a picture tool with no picture chosen, but never with a malformed one", () => {
    expect(prefillFromQuery("edit", undefined)).toMatchObject({ capability: "edit", sourceId: null });
    expect(prefillFromQuery("i2v", "../etc")).toBeNull();
    expect(prefillFromQuery("i2v", [PIC])).toBeNull();
    expect(prefillFromQuery("sfx", undefined)).toBeNull();
    expect(prefillFromQuery("<script>", undefined)).toBeNull();
  });
});

describe("customer sidebar (rendered)", () => {
  it("shows Studio, the Create group of tools, Your work, and the account foot", () => {
    render(withI18n(<SideNav email="me@example.com" plan={PLAN} />));
    const nav = screen.getByRole("navigation", { name: en.shell.primary });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      en.nav.hub,
      ...STUDIO_TOOLS.map((t) => en.gen.kinds[t]),
      en.nav.styles,
      en.nav.library,
      en.nav.editor,
      en.nav.videos,
      en.nav.channels,
    ]);
    expect(within(nav).getByRole("heading", { name: en.shell.gCreate })).toBeTruthy();
    expect(within(nav).getByRole("heading", { name: en.shell.gWork })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: en.gen.kinds.t2v }).getAttribute("href")).toBe("/chronos/create?tool=t2v");

    const aside = nav.closest("aside") as HTMLElement;
    expect(within(aside).getByRole("link", { name: en.shell.plansCredits }).getAttribute("href")).toBe("/chronos/credits");
    expect(within(aside).getByRole("link", { name: en.nav.settings }).getAttribute("href")).toBe("/chronos/organization");
    const card = screen.getByRole("button", { name: en.account.open });
    expect(card.textContent).toContain("me@example.com");
    expect(card.textContent).toContain("Creator");
  });

  it("marks the tool in the URL as the current page", () => {
    search = "tool=upscale";
    render(withI18n(<SideNav email={null} plan={null} />));
    const nav = screen.getByRole("navigation", { name: en.shell.primary });
    expect(within(nav).getByRole("link", { name: en.gen.kinds.upscale }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("link", { name: en.nav.hub }).getAttribute("aria-current")).toBeNull();
  });

  it("leaves an unknown plan off the user card rather than calling it Free", () => {
    render(withI18n(<SideNav email="me@example.com" plan={{ kind: "unknown" }} />));
    const card = screen.getByRole("button", { name: en.account.open });
    expect(card.textContent).toBe("Mme@example.com");
  });

  it("is not what an operator gets: no tool rows, no user card, the console rail instead", () => {
    render(withI18n(<SideNav operator />));
    expect(screen.queryByRole("navigation", { name: en.shell.primary })).toBeNull();
    expect(screen.queryByRole("link", { name: en.gen.kinds.t2i })).toBeNull();
    expect(screen.queryByRole("button", { name: en.account.open })).toBeNull();
    expect(screen.getByRole("link", { name: en.nav.pipeline })).toBeTruthy();
  });
});

describe("credit pill and menu", () => {
  it("shows nothing — not a 0 — when the balance is unknown", () => {
    const { container, rerender } = render(withI18n(<CreditMenu account={null} />));
    expect(container.textContent).toBe("");
    rerender(withI18n(<CreditMenu account={{ balance: NaN, reserved: 0, available: NaN }} />));
    expect(container.textContent).toBe("");
    expect(creditPillAmount(null)).toBeNull();
    expect(creditPillAmount({ balance: 0, reserved: 0, available: 0 })).toBe(0);
  });

  it("is hidden in the customer top bar when the layout has no balance", () => {
    render(withI18n(<Header operator={false} credits={null} email="me@example.com" />));
    expect(screen.queryByRole("button", { name: /credits menu/i })).toBeNull();
  });

  it("shows the formatted balance and opens a labelled popover with the balance and plan", () => {
    render(withI18n(<CreditMenu account={ACCOUNT} plan={PLAN} />));
    const pill = screen.getByRole("button", { name: /1,240 credits available/ });
    expect(pill.textContent).toContain("1,240");
    expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(pill);
    const dialog = screen.getByRole("dialog", { name: en.shell.creditsMenu });
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(pill.getAttribute("aria-controls")).toBe(dialog.id);
    expect(dialog.textContent).toContain("1,240");
    expect(dialog.textContent).toContain("Creator");
    expect(dialog.textContent).toContain("60");
  });

  it("offers only links to the Credits page — no payment form, no card, no checkout", () => {
    render(withI18n(<CreditMenu account={ACCOUNT} plan={PLAN} />));
    fireEvent.click(screen.getByRole("button", { name: /credits menu/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelectorAll("button, form, input, iframe, select, textarea")).toHaveLength(0);
    const hrefs = Array.from(dialog.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/chronos/credits", "/chronos/credits#activity-title"]);
    expect(within(dialog).getByRole("link", { name: en.shell.addCredits })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: en.shell.usage })).toBeTruthy();
    // Nothing that could open a checkout is even imported.
    const src = readFileSync(path.join(process.cwd(), "components/shell/CreditMenu.tsx"), "utf8");
    const imports = src.split("\n").filter((l) => l.startsWith("import "));
    expect(imports.join("\n")).not.toMatch(/paddle|billing|checkout/i);
    expect(src).not.toMatch(/\bfetch\(|window\.open|Paddle\./);
  });

  it("closes on Escape and returns focus to the pill", () => {
    render(withI18n(<CreditMenu account={ACCOUNT} plan={PLAN} />));
    const pill = screen.getByRole("button", { name: /credits menu/i });
    pill.focus();
    fireEvent.click(pill);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it("names the unit in the reader's language, plural forms included", () => {
    expect(creditUnit(1, "en", en.shell.creditUnit)).toBe("credit");
    expect(creditUnit(1240, "en", en.shell.creditUnit)).toBe("credits");
    const ru = dictionaries.ru.shell.creditUnit;
    expect(creditUnit(1, "ru", ru)).toBe("кредит");
    expect(creditUnit(3, "ru", ru)).toBe("кредита");
    expect(creditUnit(1240, "ru", ru)).toBe("кредитов");
    expect(creditUnit(1.5, "ru", ru)).toBe("кредита");
    expect(creditUnit(7, "uz", dictionaries.uz.shell.creditUnit)).toBe("kredit");
  });

  it("names a plan only when it is known", () => {
    expect(planName(PLAN, "Exempt")).toBe("Creator");
    expect(planName({ kind: "exempt" }, "Exempt")).toBe("Exempt");
    expect(planName({ kind: "unknown" }, "Exempt")).toBeNull();
    expect(planName(null, "Exempt")).toBeNull();
  });
});

describe("customer page frame", () => {
  it("is a page, not a panel: no ✕, no scrim, and Escape does not eject to the Command Center", () => {
    pathname = "/chronos/videos";
    render(
      withI18n(
        <ShellProvider operator={false}>
          <SectionShell>
            <p>page</p>
          </SectionShell>
        </ShellProvider>,
      ),
    );
    expect(screen.queryByRole("button", { name: en.ops.shortcutsClose })).toBeNull();
    expect(document.querySelector('button[aria-hidden="true"]')).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the operator's panel and its ✕", () => {
    pathname = "/chronos/videos";
    render(
      withI18n(
        <ShellProvider operator>
          <SectionShell>
            <p>page</p>
          </SectionShell>
        </ShellProvider>,
      ),
    );
    expect(screen.getByRole("button", { name: en.ops.shortcutsClose })).toBeTruthy();
  });
});

describe("shell copy", () => {
  it("is translated in ru and uz, and names no provider", () => {
    const flat = (o: object): string[] => Object.values(o).flatMap((v) => (typeof v === "string" ? [v] : flat(v)));
    for (const loc of ["en", "ru", "uz"] as const) {
      const strings = flat(dictionaries[loc].shell);
      for (const s of strings) expect(s.trim().length, loc).toBeGreaterThan(0);
      expect(strings.join(" ")).not.toMatch(/paddle|stripe|openai|google|eleven|runway|kling|fal\b|replicate/i);
    }
    expect(dictionaries.ru.shell.addCredits).not.toBe(en.shell.addCredits);
    expect(dictionaries.uz.shell.gWork).not.toBe(en.shell.gWork);
  });
});

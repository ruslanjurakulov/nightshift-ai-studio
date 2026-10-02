// @vitest-environment jsdom
/**
 * The living style guide (docs/design/IDENTITY.md) and its gate. What would
 * break without these: the page opening for a customer (it is the operator's
 * tool, and the same isOperator gate the operator-only sections use), the two
 * themes no longer shown side by side, a primitive dropping out of the guide,
 * or a section with no words in Russian or Uzbek.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/x/design",
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const operator = { value: false };
vi.mock("@/lib/auth/org-roles", () => ({ isOperator: async () => operator.value }));

import { I18nProvider } from "@/lib/i18n/context";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";
import type { Locale } from "@/lib/i18n";
import { StyleGuide, SWATCHES } from "@/components/design/StyleGuide";

afterEach(cleanup);

function withI18n(ui: ReactNode, locale: Locale = "en") {
  return <I18nProvider locale={locale}>{ui}</I18nProvider>;
}

describe("the design page gate", () => {
  it("is a 404 for anyone who is not the platform operator", async () => {
    operator.value = false;
    const { default: DesignPage } = await import("@/app/(app)/[channel]/design/page");
    await expect(DesignPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the guide for the operator", async () => {
    operator.value = true;
    const { default: DesignPage } = await import("@/app/(app)/[channel]/design/page");
    render(withI18n(await DesignPage()));
    expect(screen.getByRole("heading", { level: 1, name: en.design.title })).toBeTruthy();
  });
});

describe("the style guide", () => {
  it("shows the same specimen in a dark box and a light box", () => {
    render(withI18n(<StyleGuide />));
    const dark = screen.getByTestId("specimen-dark");
    const light = screen.getByTestId("specimen-light");
    expect(dark.getAttribute("data-theme-scope")).toBe("dark");
    expect(light.getAttribute("data-theme-scope")).toBe("light");
    expect(screen.getByRole("region", { name: en.design.dark })).toBe(dark);
    expect(screen.getByRole("region", { name: en.design.light })).toBe(light);
  });

  it("each box has every primitive", () => {
    render(withI18n(<StyleGuide />));
    for (const theme of ["dark", "light"]) {
      const box = screen.getByTestId(`specimen-${theme}`);
      for (const cls of ["ns-tc", "ns-lamp", "ns-meter", "ns-price-button", "ns-chip", "ns-panel", "ns-seg", "ns-sheet", "ns-step", "ns-ruler"]) {
        expect(box.querySelector(`.${cls}`), `${theme} ${cls}`).not.toBeNull();
      }
      expect(within(box).getAllByRole("meter").length).toBeGreaterThan(0);
      expect(within(box).getByRole("radiogroup")).toBeTruthy();
      expect(box.querySelectorAll("[data-theme-scope] .ns-tc").length).toBeGreaterThan(0);
    }
  });

  it("names a role for every swatch, and the spend key's disabled sample says why", () => {
    render(withI18n(<StyleGuide />));
    const dark = screen.getByTestId("specimen-dark");
    for (const [, role] of SWATCHES) expect(within(dark).getAllByText(en.design.roles[role]).length).toBeGreaterThan(0);
    const disabled = within(dark)
      .getAllByRole("button")
      .find((b) => (b as HTMLButtonElement).disabled) as HTMLButtonElement;
    expect(disabled.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dark).getByText(en.design.reasonSample)).toBeTruthy();
  });

  it("speaks ru and uz", () => {
    render(withI18n(<StyleGuide />, "ru"));
    expect(screen.getByRole("heading", { level: 1, name: ru.design.title })).toBeTruthy();
    cleanup();
    render(withI18n(<StyleGuide />, "uz"));
    expect(screen.getByRole("heading", { level: 1, name: uz.design.title })).toBeTruthy();
  });

  it("has every design string in all three languages", () => {
    const flat = (o: unknown, prefix = ""): string[] =>
      Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === "string" ? [prefix + k] : flat(v, `${prefix}${k}.`),
      );
    const keys = flat(en.design).sort();
    expect(flat(ru.design).sort()).toEqual(keys);
    expect(flat(uz.design).sort()).toEqual(keys);
    for (const d of [ru.design, uz.design]) for (const k of keys) expect(k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], d)).toBeTruthy();
  });
});

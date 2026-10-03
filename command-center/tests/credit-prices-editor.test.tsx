// @vitest-environment jsdom
/**
 * The Credit prices list on the operator's Credits page. On a phone the value
 * columns used to sit off-screen inside a 520px table, so every price read as
 * a bare unit name with no value. Pinned here: each price renders as a phone
 * row that carries its credits per unit, margin and charged figure beside the
 * unit (no horizontal scroll box around it), the table stays for wide
 * screens, and the figures are the operator's own, never rounded to a cent.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { parsePrices } from "../lib/credits";

const dict = vi.hoisted(() => ({ current: null as unknown, locale: "en" }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));
vi.mock("@/lib/i18n/context", () => ({
  useI18n: () => ({ t: dict.current, locale: dict.locale, fmt: (s: string) => s, setLocale: () => {} }),
}));

import { CreditPricesEditor } from "../components/credits/CreditPricesEditor";

const prices = Object.values(
  parsePrices([
    { unit: "model_elevenlabs_v4_character", credits_per_unit: 0.008, margin: 2, updated_at: null },
    { unit: "model_wan_2_7_second_720p", credits_per_unit: 10, margin: 1.5, updated_at: null },
    { unit: "video_minute", credits_per_unit: 20, margin: 2, updated_at: null },
    { unit: "job_minimum", credits_per_unit: 1, margin: 0, updated_at: null },
    { unit: "custom_thing", credits_per_unit: 7, margin: 0, updated_at: null },
  ]),
);

function render(t: typeof en, locale: string, canEdit = true) {
  dict.current = t;
  dict.locale = locale;
  const html = renderToStaticMarkup(<CreditPricesEditor prices={prices} canEdit={canEdit} />);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { html, doc };
}

describe("CreditPricesEditor", () => {
  it("renders a phone row per price with its value, margin and charge in view", () => {
    const { doc } = render(en, "en");
    const rows = Array.from(doc.querySelectorAll("ul li"));
    expect(rows).toHaveLength(prices.length);
    const wan = rows.find((r) => r.textContent?.includes("model_wan_2_7_second_720p"))!;
    expect(wan.textContent).toContain("per second, at 720p");
    // credits per unit 10, +150% margin, charged 10 x 2.5 = 25
    const values = Array.from(wan.querySelectorAll("dd")).map((d) => d.textContent);
    expect(values).toEqual(["10", "+150%", "25"]);
    const labels = Array.from(wan.querySelectorAll("dt")).map((d) => d.textContent);
    expect(labels).toEqual([en.credits.colRate, en.credits.colMargin, en.credits.colCharged]);
  });

  it("shows tiny rates exactly and a flat floor as flat", () => {
    const { doc } = render(en, "en");
    const rows = Array.from(doc.querySelectorAll("ul li"));
    const voice = rows.find((r) => r.textContent?.includes("model_elevenlabs_v4_character"))!;
    expect(Array.from(voice.querySelectorAll("dd")).map((d) => d.textContent)).toEqual(["0.008", "+200%", "0.024"]);
    const floor = rows.find((r) => r.textContent?.includes("job_minimum"))!;
    expect(Array.from(floor.querySelectorAll("dd")).map((d) => d.textContent)).toEqual(["1", en.credits.flatUnit, "1"]);
  });

  it("glosses a unit only where its name settles it", () => {
    const { doc } = render(en, "en");
    const rows = Array.from(doc.querySelectorAll("ul li"));
    const custom = rows.find((r) => r.textContent?.includes("custom_thing"))!;
    expect(custom.querySelectorAll("p")).toHaveLength(1); // the unit name alone
    const minute = rows.find((r) => r.textContent?.startsWith("video_minute"))!;
    expect(minute.textContent).toContain(en.credits.unitMeaning.videoMinute);
  });

  it("keeps the table for wide screens and shows the phone list below md only", () => {
    const { doc } = render(en, "en");
    expect(doc.querySelector("ul")!.className).toContain("md:hidden");
    const box = doc.querySelector("table")!.parentElement!;
    expect(box.className).toContain("hidden");
    expect(box.className).toContain("md:block");
    const heads = Array.from(doc.querySelectorAll("th")).map((h) => h.textContent);
    expect(heads).toContain(en.credits.colCharged);
    // the table's value cells are in the foreground colour, not the muted one
    expect(doc.querySelector("tbody td.mono")!.className).toContain("text-[var(--color-fg)]");
  });

  it("offers Edit and Remove on every phone row to an admin, and none to a reader", () => {
    const admin = render(en, "en").doc;
    expect(admin.querySelectorAll("ul li button")).toHaveLength(prices.length * 2);
    const reader = render(en, "en", false).doc;
    expect(reader.querySelectorAll("ul li button")).toHaveLength(0);
    expect(reader.body.textContent).toContain(en.credits.readOnlyPrices);
  });

  it.each([
    ["ru", ru],
    ["uz", uz],
  ] as const)("reads in %s", (locale, t) => {
    const { doc } = render(t as typeof en, locale);
    const row = Array.from(doc.querySelectorAll("ul li")).find((r) => r.textContent?.includes("video_minute"))!;
    expect(row.textContent).toContain(t.credits.unitMeaning.videoMinute);
    expect(Array.from(row.querySelectorAll("dt")).map((d) => d.textContent)).toContain(t.credits.colCharged);
    expect(row.querySelectorAll("dd")[2].textContent).toBe(new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(60));
  });
});

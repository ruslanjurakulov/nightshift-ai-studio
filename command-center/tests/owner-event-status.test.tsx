import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OwnerGlance } from "../components/dashboard/OwnerGlance";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const states = [
  ["eventStatusClear", "ok"],
  ["eventStatusErrors", "fail"],
  ["eventStatusUnavailable", "warn"],
  ["eventStatusEmpty", "idle"],
] as const;

describe("Owner event evidence wording", () => {
  for (const [locale, t, unverified] of [
    ["en", en, "Service and Brain health are unverified."],
    ["ru", ru, "Состояние сервисов и Brain не проверено."],
    ["uz", uz, "Xizmatlar va Brain holati tekshirilmagan."],
  ] as const) {
    for (const [key, tone] of states) {
      it(`${locale}: ${key} remains visible beside the unverified-health explanation`, () => {
        const label = t.dashboard[key];
        const html = renderToStaticMarkup(<>
          <p className="g5-sub">{t.dashboard.eventStatusScope}</p>
          <OwnerGlance label={t.ownerShell.glanceLabel}
            health={{ tone, text: label, detail: null, live: key === "eventStatusClear" }}
            tiles={[]} unknown={t.common.unknown} />
        </>);
        expect(html).toContain(`class="ns-lamp-label">${label}</span>`);
        expect(html).toContain(unverified);
        expect(html).not.toContain(t.dashboard.systemHealthy);
        expect(new Set(states.map(([k]) => t.dashboard[k])).size).toBe(4);
      });
    }
  }

  it("the Command Center uses event-scoped copy for each existing chip branch", () => {
    const page = readFileSync("app/(app)/[channel]/command-center/page.tsx", "utf8");
    for (const [key] of states) expect(page).toContain(`t.dashboard.${key}`);
    expect(page).toContain('<p className="g5-sub">{t.dashboard.eventStatusScope}</p>');
    expect(page).not.toContain("t.dashboard.systemHealthy");
  });
});

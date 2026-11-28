import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { priceConfigHints } from "@/lib/server/price-config-hints";
import { CHANNEL_TOKEN_SECRET_PREFIX, channelTokenSecret } from "@/lib/server/github-secrets";
import { secretRefSuffix } from "@/lib/secret-ref";
import { BANNED_LIST, bannedHits } from "@/lib/marketing-banned";
import { bannedHitsIn, compileBanned } from "@/lib/marketing-banned-match";
import { LOCALES } from "@/lib/i18n/core";

/**
 * Vendor sweep 3/3: three of our own names that sat in chunks every signed-in page (or anyone) can download. The build is
 * checked by scripts/vendor-bundle-check.mjs (its positive controls and tests/security-vendor-bundle-check-breach.test.ts);
 * these pin the source side, so the leak is caught before a build too.
 */
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("C1: the per-unit cost variable is named to the operator only", () => {
  it.each(["en", "ru", "uz"])("the shared %s dictionary names no CHRONOS_PRICE_ variable (it is a static chunk)", (loc) => {
    expect(read(`lib/i18n/${loc}.ts`)).not.toMatch(/CHRONOS_PRICE_/);
  });

  it.each(["en", "ru"] as const)("the operator's %s hints name the variable in every sentence", (loc) => {
    const h = priceConfigHints(loc);
    expect(h).not.toBeNull();
    for (const s of [h!.spendOverview, h!.measure, h!.portfolio]) expect(s).toContain("CHRONOS_PRICE_<UNIT>");
  });

  it("Uzbek has none: the owner's copy says 'ask the developer' in words (tests/owner-plain-copy.test.ts)", () => {
    expect(priceConfigHints("uz")).toBeNull();
    expect(LOCALES.map((l) => l.code).filter((l) => priceConfigHints(l) !== null)).toEqual(["en", "ru"]);
  });

  it("each page that shows them asks isOperator() on the server first", () => {
    for (const page of ["measurement", "portfolio", "intelligence"]) {
      const src = read(`app/(app)/[channel]/${page}/page.tsx`);
      expect(src, page).toMatch(/(?:operator|isOperator\(\)\)) \? \(?priceConfigHints\(locale\)/);
      expect(src, page).not.toMatch(/"CHRONOS_PRICE_|CHRONOS_PRICE_\{/);
    }
    // The client panel only receives the sentence; it has no way to make it.
    expect(read("components/intelligence/AdvisoryPanel.tsx")).not.toMatch(/CHRONOS_|priceConfigHints/);
  });
});

describe("C2: the per-channel token secret's name is made on the server", () => {
  it.each(["components/channels/AddChannelWizard.tsx", "components/channels/ChannelCard.tsx", "lib/secret-ref.ts"])(
    "%s (client code) holds no CHRONOS_YT_TOKEN_ literal",
    (f) => expect(read(f)).not.toMatch(/CHRONOS_YT_TOKEN_/),
  );

  it("the wizard's prefix + suffix is the name the server writes and the bot reads", () => {
    for (const ref of ["finance", "extinct-world", "-a--b-", "News 24"]) {
      expect(CHANNEL_TOKEN_SECRET_PREFIX + secretRefSuffix(ref)).toBe(channelTokenSecret(ref));
    }
    expect(channelTokenSecret("extinct-world")).toBe("CHRONOS_YT_TOKEN_EXTINCT_WORLD");
  });

  it("the pages pass it: the prefix to the wizard, a whole name to the card", () => {
    expect(read("app/(app)/[channel]/channels/new/page.tsx")).toMatch(/tokenPrefix:\s*CHANNEL_TOKEN_SECRET_PREFIX/);
    expect(read("app/(app)/[channel]/channels/page.tsx")).toMatch(/tokenSecret=\{[^}]*channelTokenSecret\(/);
  });
});

describe("C3: the marketing board's banned provider names stay on the server", () => {
  it("lib/marketing-banned.ts is server-only, and no client module imports it", () => {
    expect(read("lib/marketing-banned.ts")).toMatch(/^import "server-only";$/m);
    for (const f of ["components/marketing/NewPostPanel.tsx", "components/marketing/MarketingBoard.tsx", "lib/marketing-banned-match.ts"]) {
      expect(read(f), f).not.toMatch(/from "@\/lib\/marketing-banned"/);
    }
  });

  it("the matcher holds no vendor name of its own", () => {
    const src = read("lib/marketing-banned-match.ts").toLowerCase();
    for (const name of BANNED_LIST.providerNames.filter((n) => n.length > 4)) expect(src, name).not.toContain(`"${name}"`);
  });

  it("the form's matcher over the prop finds what the server's check finds", () => {
    const compiled = compileBanned(BANNED_LIST);
    for (const texts of [{ en: "Made with Runway, free forever" }, { ru: "Лучший сервис" }, { uz: "Yangi funksiya." }, {}]) {
      expect(bannedHitsIn(texts, compiled)).toEqual(bannedHits(texts));
    }
    expect(bannedHits({ en: "Made with Runway" }).map((h) => h.id)).toContain("provider:runway");
  });
});

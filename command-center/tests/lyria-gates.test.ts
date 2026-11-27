/**
 * Google Lyria 3.5 (music; schemas/model_registry.json google-lyria-3.5, docs/research/lyria-3-5.md): the end-user conditions Google's
 * terms put on it, held by the gates every Google model already goes through, and the legal text for the owner's review.
 *
 * What would break without these: Lyria quoted or created for a person in Russia (not one of Google's available regions) or for one whose
 * country could not be read (Google's list is an ALLOW-list, so unknown is refused, never let through); Lyria offered to someone with no
 * adult attestation (the Gemini API terms are 18+); Lyria reaching the public API; and the privacy and terms pages dropping what is sent
 * to Google for music, how long it is kept, the SynthID watermark, or Google's Prohibited Use Policy, in any of the three languages.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { parseGeoTable } from "@/lib/geo/table";
import { CLIENT_IP_HEADER } from "@/lib/geo/client-ip";
import { GOOGLE_BLOCKED, GOOGLE_MODELS, isBlockedIn, refusesUnknownCountry, withoutBlocked } from "@/lib/geo/blocked";
import { geoRefusal } from "@/lib/server/geo";
import { adultLock } from "@/lib/age";
import { discoverySpec } from "@/lib/models-discovery";
import { LEGAL_TEXTS } from "@/lib/legal-docs";
import type { LegalBlock } from "@/lib/legal-docs/types";

const LYRIA = "google-lyria-3.5";
const ROOT = join(__dirname, "..", "..");
const TABLE = parseGeoTable(new Uint8Array(readFileSync(join(__dirname, "fixtures", "geoip-fixture.bin"))));
// The shared fixture (tests/test_geoip_build.py writes it): 8.8.9.1 is Russia, 7.7.7.7 Uzbekistan, 11.0.0.1 has no country.
const from = (ip: string) => new Headers({ [CLIENT_IP_HEADER]: ip });
const entry = (JSON.parse(readFileSync(join(ROOT, "schemas", "model_registry.json"), "utf8")) as { models: Array<Record<string, unknown>> })
  .models.find((m) => m.id === LYRIA)!;

describe("Lyria: the end user's country (Google's available regions)", () => {
  it("is one of Google's allow-list models, with Google's own blocked list", () => {
    expect(GOOGLE_MODELS).toContain(LYRIA);
    expect(refusesUnknownCountry(LYRIA)).toBe(true);
    expect(entry.blocked_countries).toEqual(GOOGLE_BLOCKED);
  });

  it("is refused in Russia and for a country nobody could read, and offered in Uzbekistan", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(geoRefusal(LYRIA, from("8.8.9.1"), undefined, () => TABLE)).toEqual({ status: 451, body: { error: "country_blocked" } });
    expect(geoRefusal(LYRIA, from("11.0.0.1"), undefined, () => TABLE)).toEqual({ status: 451, body: { error: "country_unverified" } });
    expect(geoRefusal(LYRIA, new Headers(), undefined, () => TABLE)).toEqual({ status: 451, body: { error: "country_unverified" } });
    expect(geoRefusal(LYRIA, from("7.7.7.7"), undefined, () => TABLE)).toBeNull();
    expect(isBlockedIn(LYRIA, "RU")).toBe(true);
    expect(isBlockedIn(LYRIA, "UZ")).toBe(false);
  });

  it("is hidden from the picker when the country is unknown", () => {
    expect(withoutBlocked([{ id: LYRIA }], null)).toEqual([]);
    expect(withoutBlocked([{ id: LYRIA }], "RU")).toEqual([]);
    expect(withoutBlocked([{ id: LYRIA }], "UZ")).toEqual([{ id: LYRIA }]);
  });
});

describe("Lyria: 18+ and web only", () => {
  it("needs the adult attestation (0192): locked for a person who has none or is a minor", () => {
    expect(entry.requires_adult).toBe(true);
    const model = { adultOnly: entry.requires_adult === true };
    expect(adultLock(model, "none")).toBe("adult_only");
    expect(adultLock(model, "minor")).toBe("adult_only");
    expect(adultLock(model, "adult")).toBeNull();
  });

  it("is never on the public API or the MCP connector (Google APIs Terms 4a)", () => {
    expect(entry.api_exposure).toBe("web_only");
    expect(entry.mcp_oauth_exposure).toBeUndefined();
    expect(discoverySpec({ api_exposure: entry.api_exposure }).webOnly).toBe(true);
  });
});

const strings = (b: LegalBlock): string[] =>
  typeof b === "string" ? [b] : "list" in b ? b.list : "table" in b ? b.table.rows.flat() : "note" in b ? [b.note] : [];

describe("Lyria: the legal text for the owner's review", () => {
  const words = {
    en: { privacy: ["Lyria", "Gemini API", "fifty-five (55) days", "delete the request at Google", "SynthID audio watermark"], terms: ["Lyria", "artist’s voice", "lyrics of an existing song", "SynthID"] },
    ru: { privacy: ["Lyria", "Gemini API", "пятидесяти пяти (55) дней", "удалим запрос у Google", "водяной знак Google SynthID"], terms: ["Lyria", "голосу конкретного исполнителя", "текст существующей песни", "SynthID"] },
    uz: { privacy: ["Lyria", "Gemini API", "ellik besh (55) kunlik", "Google’dan oʻchiramiz", "SynthID audio suv belgisi"], terms: ["Lyria", "ijrochining ovoziga", "mavjud qoʻshiq matnini", "SynthID"] },
  } as const;

  it.each(["en", "ru", "uz"] as const)("%s: privacy says what is sent, how long it is kept and that it is deleted; terms pass on the policy", (locale) => {
    const privacy = LEGAL_TEXTS[locale].privacy.sections.find((s) => s.id === "processors")!.body.flatMap(strings).join(" ");
    const terms = LEGAL_TEXTS[locale].terms.sections.find((s) => s.id === "third-parties")!.body.flatMap(strings).join(" ");
    for (const w of words[locale].privacy) expect(privacy, w).toContain(w);
    for (const w of words[locale].terms) expect(terms, w).toContain(w);
    // Terms 7 already binds Google's models to the Prohibited Use Policy; the Lyria rule sits under that sentence.
    expect(terms).toContain("https://policies.google.com/terms/generative-ai/use-policy");
  });

  it("publishes no vendor price on a public page", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const all = JSON.stringify(LEGAL_TEXTS[locale]);
      expect(all).not.toMatch(/\$\s?0?\.08|0[.,]08\s?(USD|\$)/);
    }
  });

  it("writes Uzbek with the modifier letters (U+02BB, U+02BC), never a typewriter apostrophe", () => {
    const terms = LEGAL_TEXTS.uz.terms.sections.find((s) => s.id === "third-parties")!.body.flatMap(strings).join(" ");
    const privacy = LEGAL_TEXTS.uz.privacy.sections.find((s) => s.id === "processors")!.body.flatMap(strings).join(" ");
    for (const text of [terms, privacy]) {
      const lyria = text.slice(text.indexOf("Lyria") - 40);
      expect(lyria).not.toMatch(/[a-z]'[a-z]/i);
      expect(lyria).toMatch(/oʻ/);
    }
  });
});

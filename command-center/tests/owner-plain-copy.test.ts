import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

/** Owner copy in words, not in setup instructions: no environment-variable names and no literal "$X" placeholder. */
const ENV = /\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_<>*]+\b|PADDLE_SETUP|\$X\b/;

function leaves(node: unknown, path: string, out: Array<[string, string]>) {
  if (typeof node === "string") out.push([path, node]);
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) leaves(v, path ? `${path}.${k}` : k, out);
}

describe("the Uzbek owner sentences that used to tell the owner to edit environment variables", () => {
  const all: Array<[string, string]> = [];
  leaves(uz, "", all);
  const FIXED = ["advSpendOvUnpriced", "unpricedHint", "enforcedOff", "notEnforced", "comingSoonOperator"];
  it.each(FIXED)("%s names no variable", (key) => {
    const hits = all.filter(([p]) => p.endsWith(`.${key}`));
    expect(hits.length, key).toBeGreaterThan(0);
    for (const [p, text] of hits) expect(text, p).not.toMatch(ENV);
  });
  it("the unpriced-spend sentences send the owner to the developer, and do not claim a page can set the price", () => {
    for (const [p, text] of all) {
      if (p.endsWith(".advSpendOvUnpriced") || p.endsWith(".unpricedHint") || /portfolio\.notConfigured$/.test(p)) {
        expect(text, p).toMatch(/dasturchi/i);
        expect(text, p).not.toMatch(/sahifasida/i);
      }
    }
  });
  it("the credits and portfolio 'not connected' sentences name no variable or doc file", () => {
    for (const [p, text] of all) if (/(credits|portfolio|margin)\..*(notConfigured)$/.test(p) || p.endsWith("buy.notConfigured")) expect(text, p).not.toMatch(ENV);
  });
});

describe("the unit-cost heading shows no placeholder", () => {
  it.each([["en", en], ["ru", ru], ["uz", uz]] as const)("%s", (_l, t) => {
    expect(t.billing.title ?? "").not.toMatch(/\$X/);
    const title = (t as unknown as { billing: { title?: string }; unitEconomics: { title: string } }).unitEconomics.title;
    expect(title).not.toMatch(/\$X/);
    expect(title.length).toBeGreaterThan(8);
  });
});

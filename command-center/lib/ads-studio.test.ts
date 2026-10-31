import { describe, expect, it } from "vitest";
import { buildAdConcepts, normalizeWebsite, validBrandColor, type BrandKit } from "./ads-studio";
const brand: BrandKit = { name: "Nightshift", website: "", headline: "Launch", tagline: "", color: "#ABCDEF", audience: "all", tone: "calm" };
const product = { id: "p1", name: "Product One", sellingPoint: "Approved fact", price: "$12" };
describe("ads studio campaign concepts", () => {
  it("plans deterministic placement variations", () => {
    const ads = buildAdConcepts(brand, [product], ["feed", "story"], 4, "spotlight");
    expect(ads).toHaveLength(4);
    expect(ads.map(a => a.format)).toEqual(["feed","story","feed","story"]);
    expect(ads.every(a => a.status === "concept_only")).toBe(true);
  });
  it("caps batches at twelve and requires an approved product", () => {
    expect(buildAdConcepts(brand,[product],["square"],100,"minimal")).toHaveLength(12);
    expect(buildAdConcepts(brand,[],["square"],5,"minimal")).toHaveLength(0);
  });
  it("avoids arbitrary CSS color injection", () => {
    expect(validBrandColor("url(javascript:evil)")).toBe("#D9AA61");
  });
  it("accepts only well-formed https external URLs for display", () => {
    expect(normalizeWebsite("https://example.com/")).toBe("https://example.com/");
    expect(normalizeWebsite("http://example.com/")).toBeNull();
    expect(normalizeWebsite("https://localhost/")).toBeNull();
    expect(normalizeWebsite("https://user:pass@example.com/")).toBeNull();
  });
});

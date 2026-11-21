/** Nightshift Ads Studio: deterministic campaign planning, no provider calls. */
export const AD_FORMATS = {
  square: { label: "Instagram Square", width: 1080, height: 1080, ratio: "1:1" },
  feed: { label: "Instagram Feed", width: 1080, height: 1350, ratio: "4:5" },
  story: { label: "Stories / Reels", width: 1080, height: 1920, ratio: "9:16" },
  landscape: { label: "Landscape", width: 1920, height: 1080, ratio: "16:9" },
} as const;
export type AdFormat = keyof typeof AD_FORMATS;
export type Product = { id: string; name: string; price?: string; sellingPoint?: string };
export type BrandKit = {
  name: string;
  website: string;
  headline: string;
  tagline: string;
  color: string;
  audience: string;
  tone: string;
};
export type AdVariant = {
  id: string;
  productId: string;
  product: string;
  headline: string;
  subline: string;
  format: AdFormat;
  color: string;
  direction: "spotlight" | "editorial" | "minimal";
  status: "concept_only";
};
const SAFE_HEX = /^#[0-9a-fA-F]{6}$/;
export function validBrandColor(input: string): string {
  return SAFE_HEX.test(input) ? input : "#D9AA61";
}
export function normalizeWebsite(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password) return null;
    if (url.hostname === "localhost" || url.hostname.endsWith(".local")) return null;
    return url.toString();
  } catch { return null; }
}
export function buildAdConcepts(
  brand: BrandKit,
  products: Product[],
  formats: AdFormat[],
  count: number,
  direction: AdVariant["direction"],
): AdVariant[] {
  if (!brand.name.trim() || !products.length || !formats.length) return [];
  const max = Math.min(12, Math.max(1, Math.trunc(Number.isFinite(count) ? count : 1)));
  const safeColor = validBrandColor(brand.color);
  return Array.from({ length: max }, (_, index) => {
    const product = products[index % products.length];
    const format = formats[index % formats.length];
    const headline = (brand.headline.trim() || product.sellingPoint?.trim() || brand.tagline.trim() || product.name).slice(0, 120);
    return {
      id: `concept-${index + 1}`,
      productId: product.id,
      product: product.name.slice(0, 100),
      headline,
      subline: [product.sellingPoint, product.price].filter(Boolean).join(" · ").slice(0, 180),
      format,
      color: safeColor,
      direction,
      status: "concept_only" as const,
    };
  });
}

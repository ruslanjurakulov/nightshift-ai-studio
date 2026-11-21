/**
 * The landing's formats (shown on the gallery card of the sample that shows each one, components/site/ShowcaseGallery.tsx, and as the
 * prompt bar's chips): one line per format, naming the showcase job (lib/site/showcase.json)
 * whose clip shows it. A card appears only while that job's entry and files are merged, so a format is never a placeholder; the
 * card's title and line (lib/i18n/site/*.ts site.formats.items, same ids) describe that clip, so change them together.
 */
export const FORMATS = [
  { id: "product-ad", job: "a04d5d55-27ef-4cae-95a2-25488503829e" },
  { id: "satisfying", job: "bf349995-6836-47fe-9481-a433b4fccb04" },
  { id: "cctv", job: "826322ba-3ac9-4030-bc19-367b5ae1277a" },
  { id: "miniature", job: "5778bf5a-f751-472b-bbc0-c59b10567d32" },
  { id: "pov", job: "f00c9666-0906-40cc-90d2-dd69680d5077" },
  { id: "soap", job: "0e7b89cb-282b-43b8-8777-55001b398f67" },
] as const;

export type FormatId = (typeof FORMATS)[number]["id"];

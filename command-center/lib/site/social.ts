import type { SiteDictionary } from "@/lib/i18n/site/en";

/**
 * The studio's public channels, linked from the public footer. To add one: a
 * line here, its glyph in components/site/SocialIcons.tsx, and its name in
 * site.footer of all three dictionaries (`label` is that key; tsc holds it).
 * tests/footer-social.test.tsx loops over this list, so a new entry is checked
 * for https, its own host and no query string without touching the test (a pasted
 * share link carries tracking parameters that identify the person who copied it).
 */
export type Social = {
  id: string;
  href: string;
  /** The host the link must be on. */
  host: string;
  /** Key of site.footer holding the link's accessible name. */
  label: keyof SiteDictionary["footer"];
  /** Key of the glyph map in components/site/SocialIcons.tsx. */
  icon: string;
};

export const SOCIAL: readonly Social[] = [
  { id: "telegram", href: "https://t.me/nightshiftaistudio", host: "t.me", label: "telegram", icon: "telegram" },
  { id: "instagram", href: "https://www.instagram.com/nightshift_ai.studio/", host: "www.instagram.com", label: "instagram", icon: "instagram" },
  { id: "x", href: "https://x.com/nightshift_ai", host: "x.com", label: "x", icon: "x" },
  { id: "youtube", href: "https://www.youtube.com/@nightshift_ai_studio", host: "www.youtube.com", label: "youtube", icon: "youtube" },
];

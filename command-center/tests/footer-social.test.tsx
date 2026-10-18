// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach } from "vitest";
import { dictionaries, LOCALES } from "@/lib/i18n";
import { PublicFooter } from "@/components/legal/PublicFooter";
import { SOCIAL } from "@/lib/site/social";
import { ICONS } from "@/components/site/SocialIcons";

afterEach(cleanup);

describe("lib/site/social", () => {
  it("lists the studio's Telegram channel and Instagram profile, in that order", () => {
    expect(SOCIAL.map((s) => [s.id, s.href])).toEqual([
      ["telegram", "https://t.me/nightshiftaistudio"],
      ["instagram", "https://www.instagram.com/nightshift_ai.studio/"],
    ]);
  });

  it("has unique ids, and every entry has a glyph and a name in all three languages", () => {
    expect(new Set(SOCIAL.map((s) => s.id)).size).toBe(SOCIAL.length);
    for (const s of SOCIAL) {
      expect(Object.keys(ICONS), s.id).toContain(s.icon);
      for (const { code } of LOCALES) expect(dictionaries[code].site.footer[s.label], `${s.id} ${code}`).toBeTruthy();
    }
  });

  it.each(SOCIAL.map((s) => [s.id, s] as const))("%s: https, its own host, no query string, credentials or fragment", (_id, s) => {
    const u = new URL(s.href);
    expect(u.protocol).toBe("https:");
    expect(u.hostname).toBe(s.host);
    expect(u.username + u.password).toBe("");
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
    expect(s.href).not.toMatch(/[?#]/);
  });
});

describe("the public footer's social links", () => {
  it.each(LOCALES.map((l) => l.code))("%s: both links, named from the dictionary, opening safely, glyphs decorative", (code) => {
    const t = dictionaries[code];
    const { container } = render(<PublicFooter t={t} />);
    const nav = screen.getByRole("navigation", { name: t.site.footer.social });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(SOCIAL.map((s) => s.href));
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual(SOCIAL.map((s) => t.site.footer[s.label]));
    for (const s of SOCIAL) expect(screen.getByRole("link", { name: t.site.footer[s.label] }).getAttribute("href")).toBe(s.href);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      const svg = a.querySelector("svg")!;
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("fill")).toBe("currentColor");
    }
    // Inline only: nothing for the CSP to allow.
    expect(container.querySelector(".st-social img, .st-social script, .st-social image, .st-social use")).toBeNull();
  });

  it("names the Telegram channel in each language", () => {
    expect(dictionaries.en.site.footer.telegram).toBe("Telegram channel");
    expect(dictionaries.en.site.footer.instagram).toBe("Instagram");
    expect(dictionaries.ru.site.footer.telegram).toBe("Telegram-канал");
    expect(dictionaries.uz.site.footer.telegram).toBe("Telegram kanali");
  });
});

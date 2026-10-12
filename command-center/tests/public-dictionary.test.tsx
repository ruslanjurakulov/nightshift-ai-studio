// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { dictionaries, getDictionaryFor } from "@/lib/i18n";
import { publicDictionary } from "@/lib/i18n/public";
import { PublicI18nProvider, usePublicI18n } from "@/lib/i18n/public-context";
import { useI18n } from "@/lib/i18n/context";

afterEach(cleanup);

describe("the public pages' dictionary", () => {
  it("carries only the public slice, not the app's screens", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      const slice = publicDictionary(getDictionaryFor(locale));
      const json = JSON.stringify(slice);
      expect(json.length).toBeLessThan(JSON.stringify(getDictionaryFor(locale)).length / 5);
      expect(Object.keys(slice)).not.toContain("nav");
      // No setup copy (env-var names, the database vendor) rides along.
      expect(json).not.toMatch(/NEXT_PUBLIC_SUPABASE|Supabase/);
      // …nor the operator's setup notes: env names, docs paths, server keys.
      expect(json).not.toMatch(/NEXT_PUBLIC_|PADDLE_[A-Z]|docs\/[A-Z_]+\.md/);
    }
  });

  it("refuses the full-dictionary hook under the public slice, so a misplaced app component fails loudly", () => {
    function NeedsApp() {
      useI18n();
      return null;
    }
    function NeedsPublic() {
      return <span>{usePublicI18n().t.landing.nav.skip}</span>;
    }
    const t = publicDictionary(dictionaries.en);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<PublicI18nProvider locale="en" t={t}><NeedsApp /></PublicI18nProvider>)).toThrow(/I18nProvider/);
    spy.mockRestore();
    render(<PublicI18nProvider locale="en" t={t}><NeedsPublic /></PublicI18nProvider>);
    expect(screen.getByText(dictionaries.en.landing.nav.skip)).toBeTruthy();
  });
});

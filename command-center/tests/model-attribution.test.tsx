// @vitest-environment jsdom
/**
 * A model maker's required credit line in the Studio (spec.attribution). Runway's Terms of Use §1 let its API power an end-user app
 * only if the app "prominently display[s] 'Powered by Runway' and link[s] to runway.com"; before this the line was drawn on the Models
 * catalog only, so a Runway clip made in the Studio carried no credit at all.
 *
 * What would break without these: the line missing beside a Runway model in the panel, the desk dock or the overview's composer, or on
 * the job card of what it made; the line drawn for a model that asks for none, or for Auto before the quote names its pick; a row's URL
 * that is not https (a `javascript:` link) rendered as an href; the maker's words translated away; the spoken label missing in a language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { coercePreviewModels, modelAttribution, withTiers, type StudioModel } from "@/lib/creative/studio";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const registry = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "model_registry.json"), "utf8")) as {
  models: { id: string; provider: string; attribution: unknown }[];
};

const ORG = "11111111-1111-4111-8111-111111111111";
const RUNWAY = { text: "Powered by Runway", url: "https://runway.com" };
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

// What operator_preview_models() / sellable_models() hand the Studio: the id and the public half of spec.
const PREVIEW_ROWS = [
  { id: "runway-gen4.5", display_name: "Runway Gen-4.5", provider: "runway", capabilities: ["t2v", "i2v"], spec: { attribution: RUNWAY, quality_tier: 5 } },
  { id: "clip-plain", display_name: "Clip Plain", provider: "lab", capabilities: ["t2v"], spec: { attribution: null, quality_tier: 3 } },
];

describe("modelAttribution", () => {
  it("keeps the maker's words and an https link", () => {
    expect(modelAttribution(RUNWAY)).toEqual({ text: "Powered by Runway", url: "https://runway.com/" });
  });

  it("refuses anything that is not an https link with words", () => {
    for (const bad of [
      null,
      undefined,
      "Powered by Runway",
      [RUNWAY],
      { text: "Powered by Runway", url: "javascript:alert(1)" },
      { text: "Powered by Runway", url: "http://runway.com" },
      { text: "Powered by Runway", url: "https://user:pw@runway.com" },
      { text: "Powered by Runway", url: "not a url" },
      { text: "   ", url: "https://runway.com" },
      { text: "x".repeat(61), url: "https://runway.com" },
      { url: "https://runway.com" },
    ]) {
      expect(modelAttribution(bad)).toBeNull();
    }
  });

  it("reaches the Studio's models from the spec, for a preview and for a model on sale", () => {
    const previews = coercePreviewModels(PREVIEW_ROWS);
    expect(previews.find((m) => m.id === "runway-gen4.5")?.attribution).toEqual({ text: "Powered by Runway", url: "https://runway.com/" });
    expect(previews.find((m) => m.id === "clip-plain")?.attribution).toBeUndefined();
    const onSale: StudioModel[] = [{ id: "runway-gen4.5", displayName: "Runway Gen-4.5", capabilities: ["i2v"], beta: false }];
    expect(withTiers(onSale, PREVIEW_ROWS)[0].attribution?.text).toBe("Powered by Runway");
  });

  it("is what the registry says for every Runway model, so the Studio always has a line to draw", () => {
    const runway = registry.models.filter((m) => m.provider === "runway");
    expect(runway.length).toBeGreaterThan(0);
    for (const m of runway) expect(modelAttribution(m.attribution)?.text).toBe("Powered by Runway");
  });
});

describe("the line in the Studio", () => {
  let jobs: unknown[] = [];
  beforeEach(() => {
    jobs = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/creative/quote") return json({ quote: { credits: 60, exempt: true, preview: true } });
        if (url.startsWith("/api/creative/jobs")) return json({ jobs });
        if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
        return json({}, 404);
      }),
    );
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const models = () => coercePreviewModels(PREVIEW_ROWS);

  it("is drawn beside the Runway model's price key, linked, opening in a new tab, in every layout", () => {
    for (const props of [{}, { desk: "video" as const }, { layout: "composer" as const }]) {
      const { unmount } = render(withI18n(<GeneratePanel orgId={ORG} models={models()} initial={{ capability: "t2v", model: "runway-gen4.5" } as never} {...props} />));
      const links = screen.getAllByTestId("model-attribution");
      expect(links).toHaveLength(1);
      const a = links[0];
      expect(a.textContent).toBe("Powered by Runway");
      expect(a.getAttribute("href")).toBe("https://runway.com/");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      // The accessible name starts with the visible words (WCAG 2.5.3), then says where it goes.
      expect(a.getAttribute("aria-label")).toBe(`Powered by Runway: ${dictionaries.en.gen.attributionOpens.split(": ")[1]}`);
      unmount();
    }
  });

  it("is not drawn for a model that asks for none", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={models()} initial={{ capability: "t2v", model: "clip-plain" } as never} />));
    expect(screen.queryByTestId("model-attribution")).toBeNull();
  });

  it("is not guessed for Auto before the quote names its pick", () => {
    render(withI18n(<GeneratePanel orgId={ORG} models={models()} initial={{ capability: "t2v", model: "runway-gen4.5" } as never} />));
    expect(screen.getByTestId("model-attribution")).toBeTruthy();
    fireEvent.click(screen.getByTestId("gen-auto"));
    expect(screen.queryByTestId("model-attribution")).toBeNull();
  });

  it("keeps the maker's English words in Russian and Uzbek; only the spoken label is translated", () => {
    for (const locale of ["ru", "uz"] as const) {
      const { unmount } = render(
        withI18n(<GeneratePanel orgId={ORG} models={models()} initial={{ capability: "t2v", model: "runway-gen4.5" } as never} />, locale),
      );
      const a = screen.getByTestId("model-attribution");
      expect(a.textContent).toBe("Powered by Runway");
      expect(a.getAttribute("aria-label")).toBe(dictionaries[locale].gen.attributionOpens.replace("{text}", "Powered by Runway"));
      unmount();
    }
  });

  it("is on the job card of what the Runway model made or is making, not on a failed one or another model's", async () => {
    const row = (over: Record<string, unknown>) => ({
      id: "j",
      capability: "i2v",
      status: "completed",
      requested_model: "runway-gen4.5",
      params: { prompt: "slow push in" },
      quoted_credits: 60,
      charged_credits: 0,
      error_code: null,
      result: null,
      result_asset_ids: [],
      created_at: "2026-11-13T00:00:00Z",
      ...over,
    });
    jobs = [
      row({ id: "done" }),
      row({ id: "running", status: "running", charged_credits: null }),
      row({ id: "failed", status: "failed", error_code: "policy", charged_credits: null }),
      row({ id: "other", requested_model: "clip-plain", capability: "t2v" }),
    ];
    render(withI18n(<JobFeed orgId={ORG} models={models()} />));
    await screen.findAllByText("Runway Gen-4.5");
    const links = screen.getAllByTestId("model-attribution");
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.textContent).toBe("Powered by Runway");
      expect(a.getAttribute("href")).toBe("https://runway.com/");
    }
  });

  it("has its spoken label in all three languages, around the maker's words", () => {
    for (const d of [dictionaries.en, dictionaries.ru, dictionaries.uz]) {
      expect(d.gen.attributionOpens).toMatch(/^\{text\}: \S/);
    }
    expect(dictionaries.uz.gen.attributionOpens).not.toMatch(/['‘’`]/);
  });
});

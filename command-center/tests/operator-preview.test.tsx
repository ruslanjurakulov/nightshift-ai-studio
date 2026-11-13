// @vitest-environment jsdom
/**
 * The operator's preview of a hidden model in the Studio (migration 0139).
 *
 * What would break without these: a preview row read as a model on sale (no badge, so the operator cannot tell it from what customers
 * see); a malformed row offered as a model; a model listed twice once it is opened to customers; the badge showing on a model that is not
 * a preview; the create page asking for previews on a customer's page; and the badge's words missing in one of the three languages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { coercePreviewModels, withPreviews, type StudioModel } from "@/lib/creative/studio";
import { isOperatorOrg } from "@/lib/channel-tokens";
import { DEFAULT_ORG_ID } from "@/lib/orgs";

const ORG = DEFAULT_ORG_ID;
const withI18n = (ui: ReactNode, locale: "en" | "ru" | "uz" = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const ON_SALE: StudioModel[] = [{ id: "pic-fast", displayName: "Picture Fast", capabilities: ["t2i"], beta: false }];
const ROWS = [
  { id: "pic-preview", display_name: "Picture Preview", provider: "lab", capabilities: ["t2i", "edit"], spec: { quality_tier: 4, speed_tier: 3 } },
  { id: "", display_name: "no id", capabilities: ["t2i"], spec: {} },
  { id: "no-caps", display_name: "No caps", capabilities: [], spec: {} },
  "not a row",
];

describe("preview rows from operator_preview_models()", () => {
  it("become Studio models marked preview, never beta, with the registry's marks", () => {
    const got = coercePreviewModels(ROWS);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "pic-preview", displayName: "Picture Preview", capabilities: ["t2i", "edit"], beta: false, preview: true });
    expect(got[0].qualityTier).toBe(4);
    expect(got[0].speedTier).toBe(3);
  });

  it("an answer that is not a list (no migration, an error) is no previews", () => {
    expect(coercePreviewModels(null)).toEqual([]);
    expect(coercePreviewModels({ error: "x" })).toEqual([]);
  });

  it("come after the models on sale, and a model already on sale is not listed twice", () => {
    const previews = coercePreviewModels([...ROWS, { id: "pic-fast", display_name: "Picture Fast", capabilities: ["t2i"], spec: {} }]);
    const list = withPreviews(ON_SALE, previews);
    expect(list.map((m) => m.id)).toEqual(["pic-fast", "pic-preview"]);
    expect(list[0].preview).toBeUndefined();
  });

  it("are asked for only in the operator's own organization", () => {
    expect(isOperatorOrg(DEFAULT_ORG_ID)).toBe(true);
    expect(isOperatorOrg("11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(isOperatorOrg(null)).toBe(false);
    // The create page asks only for the platform operator in that organization; the panel alone gets them (not the Assistant).
    const page = readFileSync(join(__dirname, "..", "app", "(app)", "[channel]", "create", "page.tsx"), "utf8");
    expect(page).toContain("const previews = operator && isOperatorOrg(genOrgId) && genOrgId ? await loadOperatorPreviewModels(genOrgId) : [];");
    expect(page.match(/withPreviews\(/g)).toHaveLength(1);
    expect(page).toContain("const panelModels = withPreviews(models, previews);");
    // Both generate boxes (the overview's composer and the desks' panel) get them; the overview's composer was missing them.
    // The Effects desk gets the same list (lib/effects/catalog.ts): an effect may name a preview model only where the panel it
    // opens offers that model, and the effect's own banner resolves over panelModels too.
    expect(page.match(/models=\{panelModels\}/g)).toHaveLength(3);
    expect(page).toContain("<EffectsDesk models={panelModels} />");
    expect(page).toContain("resolveEffect(effectAsk.effect, panelModels)");
    // The Assistant plans only with the models on sale.
    expect(page).toMatch(/const assistant: AssistantData = \{\s*orgId: genOrgId,\s*models,/);
  });
});

describe("the Studio's badge", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn((url: string) => {
      if (url === "/api/creative/quote") return json({ quote: { credits: 30, exempt: true, preview: true } });
      if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
      if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("marks a preview model and only a preview model", () => {
    const models = withPreviews(ON_SALE, coercePreviewModels(ROWS));
    const { unmount } = render(withI18n(<GeneratePanel orgId={ORG} models={models} initial={{ capability: "t2i", model: "pic-preview" } as never} />));
    const badge = screen.getByTestId("gen-model-preview");
    expect(badge.textContent).toBe(dictionaries.en.gen.preview);
    expect(badge.getAttribute("title")).toBe(dictionaries.en.gen.previewHint);
    unmount();
    render(withI18n(<GeneratePanel orgId={ORG} models={models} initial={{ capability: "t2i", model: "pic-fast" } as never} />));
    expect(screen.queryByTestId("gen-model-preview")).toBeNull();
  });

  it("speaks Uzbek first, and Russian and English, with no vendor name and no superlative", () => {
    const models = coercePreviewModels(ROWS);
    render(withI18n(<GeneratePanel orgId={ORG} models={models} initial={{ capability: "t2i", model: "pic-preview" } as never} />, "uz"));
    expect(screen.getByTestId("gen-model-preview").textContent).toBe("Sinov");
    for (const d of [dictionaries.uz, dictionaries.ru, dictionaries.en]) {
      expect(d.gen.preview.length).toBeGreaterThan(0);
      expect(d.gen.previewHint.length).toBeGreaterThan(0);
      expect(`${d.gen.preview} ${d.gen.previewHint}`).not.toMatch(/meta|muse|best|лучш|eng yaxshi/i);
    }
    // Uzbek letters oʻ / gʻ with U+02BB, never a plain or curly quote.
    expect(dictionaries.uz.gen.previewHint).toContain("koʻrasiz");
    expect(dictionaries.uz.gen.previewHint).not.toMatch(/['‘’`]/);
  });
});

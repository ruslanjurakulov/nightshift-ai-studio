// @vitest-environment jsdom
/**
 * Studio templates only fill the panel: every template is a kind the panel
 * makes, its starter params are what the database accepts, every language
 * names every template, and a click fills the form without pricing a source
 * tool or starting anything.
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
import { GenerateSection } from "@/components/studio/GenerateSection";
import { PROMPT_MAX, STUDIO_CAPABILITIES, buildParams, canQuote, type StudioModel } from "@/lib/creative/studio";
import { STUDIO_TEMPLATES, TEMPLATE_IDS, templatePrefill } from "@/lib/creative/templates";

const t = dictionaries.en;
const ORG = "11111111-1111-4111-8111-111111111111";
const withI18n = (ui: ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

const MODELS: StudioModel[] = [
  { id: "pic", displayName: "Picture", capabilities: ["t2i", "edit", "upscale", "remove_bg"], beta: false },
  { id: "vid", displayName: "Motion", capabilities: ["t2v", "i2v"], beta: false },
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
    if (url.startsWith("/api/media")) return json({ available: true, assets: [], uploads: [] });
    if (url === "/api/creative/quote") return json({ quote: { credits: 4 } });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("templates", () => {
  it("each is a kind the panel makes, with params the database accepts", () => {
    expect(STUDIO_TEMPLATES.map((x) => x.id)).toEqual([...TEMPLATE_IDS]);
    for (const tpl of STUDIO_TEMPLATES) {
      expect(STUDIO_CAPABILITIES).toContain(tpl.capability);
      const p = templatePrefill(tpl);
      expect(p.prompt.length).toBeLessThanOrEqual(PROMPT_MAX);
      expect(p.sourceId).toBeNull();
      const params = buildParams({ ...p });
      if (tpl.capability === "remove_bg") expect(params).not.toHaveProperty("prompt");
      if (tpl.capability === "t2i" || tpl.capability === "t2v") expect(params.aspect_ratio).toBe(tpl.aspect);
    }
  });

  it("text templates are ready to price; picture tools wait for a picture", () => {
    for (const tpl of STUDIO_TEMPLATES) {
      const ready = canQuote(templatePrefill(tpl));
      expect(ready).toBe(["t2i", "t2v", "tts"].includes(tpl.capability));
    }
  });

  it("every language names every template", () => {
    for (const d of Object.values(dictionaries)) {
      for (const id of TEMPLATE_IDS) {
        expect(d.studioTemplates.items[id].title.trim()).not.toBe("");
        expect(d.studioTemplates.items[id].who.trim()).not.toBe("");
      }
    }
  });
});

describe("TemplateGallery in the Studio", () => {
  it("fills the panel with the template and starts nothing", async () => {
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: `${t.studioTemplates.use}: ${t.studioTemplates.items.shorts_clip.title}` }));

    expect(screen.getByRole("button", { name: t.gen.kinds.t2v }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "9:16" }).getAttribute("aria-pressed")).toBe("true");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toContain("[subject]");
    expect(await screen.findByRole("button", { name: "Generate · 4 credits" }, { timeout: 2000 })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u, init]) => u === "/api/creative/jobs" && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("a picture tool template opens the picker instead of a price", async () => {
    render(withI18n(<GenerateSection orgId={ORG} models={MODELS} />));
    fireEvent.click(screen.getByRole("button", { name: `${t.studioTemplates.use}: ${t.studioTemplates.items.cutout.title}` }));
    expect(screen.getByRole("button", { name: t.gen.kinds.remove_bg }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText(t.gen.sourceEmpty)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/creative/quote")).toBe(false);
  });
});

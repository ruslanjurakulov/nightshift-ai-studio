// @vitest-environment jsdom
/**
 * Breach, PR #947 (the Studio's explore grid). Hostile inputs against lib/creative/explore.ts, lib/site/showcase-link.ts
 * studioCreateSection, lib/templates/trends.ts templateCreateHref and components/studio/StudioExplore.tsx. What would break without
 * these: a card href that leaves this origin (`//evil`, `/\evil`, `javascript:`) or smuggles a second `model=` / `next=` into the
 * Studio form; a forged /api/templates body (model_status "available", a prototype key as model id, a kind the route never sends)
 * that draws a card for a model this workspace cannot buy; a hostile template title or poster that becomes markup; a load or a retry
 * that does anything but one GET of /api/templates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/my-channel/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- pulled out so they never reach the <a>
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children?: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { StudioExplore } from "@/components/studio/StudioExplore";
import { exploreSamples, exploreTemplates, isOnSale, onSaleCatalog, type OnSale } from "@/lib/creative/explore";
import { SHOWCASE_ENTRIES, type ShowcaseEntry } from "@/lib/site/showcase";
import { SHOWCASE_FILES } from "@/components/site/showcase-assets";
import { studioCreateSection } from "@/lib/site/showcase-link";
import { channelPath } from "@/lib/channels";
import { coerceTemplateRows, templateCreateHref, toDto, type TemplateDto } from "@/lib/templates/trends";
import type { StudioModel } from "@/lib/creative/studio";

const ORIGIN = "https://studio.lab.invalid";
const NOW = new Date("2026-11-27T00:00:00Z");
const ALLOWED_SAMPLE_KEYS = new Set(["tool", "model", "prompt", "sample"]);
// Tab, LF and CR are kept on purpose (a prompt may have lines; lib/creative/improve.ts CONTROL); every other control and bidi is not.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;

const HOSTILE_SLUGS = [
  "//evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "x?model=runway-gen4.5&next=//evil.example",
  "x#model=runway-gen4.5",
  "javascript:alert(1)",
  "%2F%2Fevil.example",
  "%5Cevil.example",
  "a‮gnp.exe",
  "a\u0000b\r\nLocation: //evil.example",
  "../../api/creative/create",
];

/** Where a card's href actually lands, resolved the way a browser resolves it from the page. */
function land(href: string): URL {
  return new URL(href, `${ORIGIN}/my-channel/create`);
}

describe("link safety", () => {
  it("a hostile template slug never leaves the origin, never leaves /<channel>/create, and carries template= alone", () => {
    for (const slug of HOSTILE_SLUGS) {
      const href = channelPath("my-channel", templateCreateHref(slug));
      expect(href.startsWith("/my-channel/create?"), slug).toBe(true);
      const u = land(href);
      expect(u.origin, slug).toBe(ORIGIN);
      expect(u.pathname, slug).toBe("/my-channel/create");
      expect([...u.searchParams.keys()], slug).toEqual(["template"]);
      expect(u.searchParams.get("template"), slug).toBe(slug);
      expect(u.hash, slug).toBe("");
    }
  });

  const base = SHOWCASE_ENTRIES.find((e) => e.capability === "t2v")!;
  const hostilePrompts = [
    "a cat&model=evil-model&next=//evil.example#frag",
    "javascript:alert(document.cookie)",
    "‮evil‬ ⁦x⁩ ​zero‍ width",
    "a\u0000b\u0007c\r\nd",
    "%26model%3Devil%26next%3D%2F%2Fevil.example",
    "/\\evil.example?next=//evil.example",
  ];

  it("a hostile showcase prompt reaches the sample href only as one encoded prompt=, with no control or bidi character", () => {
    for (const prompt of hostilePrompts) {
      const s: ShowcaseEntry = { ...base, prompt, operatorPreview: false, shutdownOn: null };
      const section = studioCreateSection(s, NOW, { entries: [s], files: SHOWCASE_FILES });
      expect(section, prompt).not.toBeNull();
      expect(section!.startsWith("/create?"), prompt).toBe(true);
      const u = land(channelPath("my-channel", section!));
      expect(u.origin, prompt).toBe(ORIGIN);
      expect(u.pathname, prompt).toBe("/my-channel/create");
      expect(u.hash, prompt).toBe("");
      for (const k of u.searchParams.keys()) expect(ALLOWED_SAMPLE_KEYS.has(k), `${prompt}: ${k}`).toBe(true);
      expect(u.searchParams.getAll("model"), prompt).toEqual([base.modelId]);
      expect(u.searchParams.getAll("next"), prompt).toEqual([]);
      expect(INVISIBLE.test(u.searchParams.get("prompt") ?? ""), prompt).toBe(false);
    }
  });

  it("a hostile model id or tool in showcase data gets no link at all (never a href that names it)", () => {
    for (const modelId of ["//evil.example", "../../x", "runway&next=//evil", "javascript:alert(1)", "A B", ""]) {
      const s: ShowcaseEntry = { ...base, modelId, operatorPreview: false, shutdownOn: null };
      expect(studioCreateSection(s, NOW, { entries: [s], files: SHOWCASE_FILES }), modelId).toBeNull();
    }
    for (const capability of ["javascript:", "//evil", "captions", "t2v&next=//evil"]) {
      const s = { ...base, capability, operatorPreview: false, shutdownOn: null } as ShowcaseEntry;
      expect(studioCreateSection(s, NOW, { entries: [s], files: SHOWCASE_FILES }), capability).toBeNull();
    }
  });
});

describe("data leaks", () => {
  it("a sample DTO has only the drawn fields: no model id, name, maker, preview flag, cost or attribution under any key", () => {
    const entries = SHOWCASE_ENTRIES.map((e) => ({ ...e, operatorPreview: false, shutdownOn: null }));
    const onSale: OnSale = {};
    for (const e of entries) ((onSale as Record<string, string[]>)[e.capability] ??= []).push(e.modelId);
    const samples = exploreSamples(entries, SHOWCASE_FILES, onSale, "en", NOW);
    expect(samples.length).toBeGreaterThan(0);
    const allowed = ["id", "kind", "width", "height", "poster", "srcSet", "clip", "title", "line", "href"];
    for (const s of samples) {
      expect(Object.keys(s).sort()).toEqual([...allowed].sort());
      const e = entries.find((x) => x.jobId === s.id)!;
      // Everything except the href (where model= is the designed carrier): the serialised prop a browser receives.
      const { href, ...rest } = s;
      const json = JSON.stringify(rest);
      expect(json).not.toContain(e.modelName);
      expect(json).not.toContain(`"${e.provider}"`);
      expect(json).not.toMatch(/operatorPreview|vendorModel|usdEstimate|attribution|modelName|provider/);
      const keys = new Set(land(channelPath("my-channel", href)).searchParams.keys());
      for (const k of keys) expect(ALLOWED_SAMPLE_KEYS.has(k)).toBe(true);
    }
  });

  it("an operator preview or shut-down sample never becomes a DTO, even when a forged catalogue lists its model", () => {
    const pv = SHOWCASE_ENTRIES.map((e) => ({ ...e, operatorPreview: true, shutdownOn: null }));
    const gone = SHOWCASE_ENTRIES.map((e) => ({ ...e, operatorPreview: false, shutdownOn: "2026-11-01" }));
    const everything: OnSale = { t2v: SHOWCASE_ENTRIES.map((e) => e.modelId), t2i: SHOWCASE_ENTRIES.map((e) => e.modelId), i2v: SHOWCASE_ENTRIES.map((e) => e.modelId) };
    expect(exploreSamples(pv, SHOWCASE_FILES, everything, "en", NOW)).toEqual([]);
    expect(exploreSamples(gone, SHOWCASE_FILES, everything, "en", NOW)).toEqual([]);
  });
});

describe("the on-sale rule", () => {
  const model = (id: string, capabilities: string[], extra: Partial<StudioModel> = {}): StudioModel => ({ id, displayName: id, capabilities, beta: false, ...extra });

  it("the server's catalogue drops previews and every kind of lock, and holds nothing for a tool it was not asked about", () => {
    const cat = onSaleCatalog(
      [
        model("ok-video", ["t2v"]),
        model("pv", ["t2v", "t2i"], { preview: true }),
        model("lock-a", ["t2v"], { lock: "first_purchase" }),
        model("lock-b", ["t2i"], { lock: "not_on_sale" }),
        model("lock-c", ["t2v"], { lock: "adult_only" }),
        model("ok-image", ["t2i"]),
      ],
      ["t2v", "t2i"],
    );
    expect(cat).toEqual({ t2v: ["ok-video"], t2i: ["ok-image"] });
    expect(isOnSale(cat, "i2v", "ok-video")).toBe(false);
    // I-2 (fixed in the same PR): a prototype key as the capability is own-keys-only now, false rather than a TypeError.
    for (const cap of ["__proto__", "constructor", "toString"]) expect(isOnSale(cat, cap, "ok-video")).toBe(false);
  });

  const tpl = (slug: string, over: Partial<TemplateDto> | Record<string, unknown> = {}): TemplateDto =>
    ({
      slug,
      kind: "video",
      title: "t",
      description: "d",
      category: "viral",
      prompt: "p",
      placeholders: [],
      model_id: "ok-video",
      model_available: true,
      model_status: "available",
      aspect: "9:16",
      duration_s: 5,
      quality: null,
      poster_url: `/templates/${slug}/poster.webp`,
      ...over,
    }) as TemplateDto;

  it("a forged /api/templates body cannot put a card on a model the page's catalogue does not sell", () => {
    const onSale: OnSale = { t2v: ["ok-video"], t2i: ["ok-image"] };
    const forged = [
      tpl("not-listed", { model_id: "runway-gen4.5" }),
      tpl("proto-a", { model_id: "__proto__" }),
      tpl("proto-b", { model_id: "constructor" }),
      tpl("proto-c", { model_id: "toString" }),
      tpl("other-tool", { model_id: "ok-image" }),
      tpl("img-as-video", { kind: "image", category: "business", model_id: "ok-video", aspect: "1:1" }),
      tpl("odd-kind", { kind: "audio", model_id: "ok-video" }),
      tpl("unknown-st", { model_status: "unknown", model_available: true }),
      tpl("missing-st", { model_status: undefined }),
      tpl("truthy-st", { model_status: true as unknown as "available" }),
      tpl("upper-st", { model_status: "Available" as "available" }),
      tpl("no-poster", { poster_url: undefined }),
      tpl("empty-poster", { poster_url: "" }),
      tpl("array-id", { model_id: ["ok-video"] as unknown as string }),
    ];
    const rows = exploreTemplates(forged, onSale);
    expect([...rows.trending, ...rows.topics, ...rows.brand].map((t) => t.slug)).toEqual([]);
  });

  it("a model locked for this organization is not on sale for templates either, whatever the route says", () => {
    const cat = onSaleCatalog([model("ok-video", ["t2v"], { lock: "first_purchase" })], ["t2v", "t2i"]);
    const rows = exploreTemplates([tpl("locked-one")], cat);
    expect(rows.trending).toEqual([]);
  });
});

describe("server-built template media URLs", () => {
  it("a hostile database row never yields a poster or preview URL outside /templates/<slug>/", () => {
    const rows = coerceTemplateRows([
      { slug: "../../etc", title: { en: "a", ru: "a", uz: "a" }, description: { en: "a", ru: "a", uz: "a" }, category: "viral", kind: "video", prompt_template: "p", model_id: "m", aspect: "9:16", duration_s: 5 },
      { slug: "javascript:alert(1)", title: { en: "a", ru: "a", uz: "a" }, description: { en: "a", ru: "a", uz: "a" }, category: "viral", kind: "video", prompt_template: "p", model_id: "m", aspect: "9:16", duration_s: 5 },
      { slug: "good-one", title: { en: "<img src=x onerror=alert(1)>", ru: "a", uz: "a" }, description: { en: "a", ru: "a", uz: "a" }, category: "viral", kind: "video", prompt_template: "p", model_id: "m", aspect: "9:16", duration_s: 5 },
    ]);
    expect(rows.map((r) => r.slug)).toEqual(["good-one"]);
    const dto = toDto(rows[0], "en", { t2v: new Set(["m"]), t2i: new Set() }, { "good-one": { poster: true, preview: true }, "../../etc": { poster: true } });
    expect(dto.poster_url).toBe("/templates/good-one/poster.webp");
    expect(dto.preview_url).toBe("/templates/good-one/preview.mp4");
  });
});

describe("the rendered grid against a hostile /api/templates", () => {
  const onSale: OnSale = { t2v: ["ok-video"], t2i: ["ok-image"] };
  const xss = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  const body = {
    status: "ok",
    templates: [
      {
        slug: "//evil.example",
        kind: "video",
        title: xss,
        description: `javascript:alert(1) ${xss}`,
        category: "viral",
        prompt: "p",
        placeholders: [],
        model_id: "ok-video",
        model_available: true,
        model_status: "available",
        aspect: "9:16",
        duration_s: 5,
        quality: null,
        poster_url: "/templates/x/poster.webp",
      },
      {
        slug: "forged-model",
        kind: "video",
        title: "Forged",
        description: "d",
        category: "viral",
        prompt: "p",
        placeholders: [],
        model_id: "runway-gen4.5",
        model_available: true,
        model_status: "available",
        aspect: "9:16",
        duration_s: 5,
        quality: null,
        poster_url: "/templates/forged-model/poster.webp",
      },
    ],
  };
  let status = 200;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    if (status !== 200) return new Response(JSON.stringify({ error: "failed" }), { status });
    return new Response(JSON.stringify(body), { status: 200 });
  });

  beforeEach(() => {
    status = 200;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    delete (window as unknown as { __pwned?: number }).__pwned;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const draw = () =>
    render(
      <I18nProvider locale="en">
        <StudioExplore data={{ state: "ok", samples: [], onSale }} />
      </I18nProvider>,
    );

  it("hostile words are text, the hostile slug stays on this channel's form, and the forged model draws no card", async () => {
    draw();
    await waitFor(() => expect(document.querySelectorAll("[data-mf-card]").length).toBe(1));
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();
    for (const el of Array.from(document.querySelectorAll("*")))
      for (const a of Array.from(el.attributes)) expect(a.name.startsWith("on"), `${el.tagName} ${a.name}`).toBe(false);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.body.textContent).not.toContain("Forged");
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
      const href = a.getAttribute("href")!;
      if (href.startsWith("#")) continue;
      expect(href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\"), href).toBe(true);
      const u = land(href);
      expect(u.origin, href).toBe(ORIGIN);
      expect(u.searchParams.has("next"), href).toBe(false);
      expect(u.searchParams.has("model"), href).toBe(false);
    }
  });

  it("a load and a retry are each one GET of /api/templates, with no body, credentials override or other endpoint", async () => {
    status = 500;
    draw();
    const retry = await screen.findByTestId("explore-retry");
    status = 200;
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelectorAll("[data-mf-card]").length).toBe(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchMock.mock.calls) {
      const u = new URL(String(input), ORIGIN);
      expect(String(input).startsWith("/api/templates?")).toBe(true);
      expect(u.origin).toBe(ORIGIN);
      expect([...u.searchParams.keys()]).toEqual(["locale"]);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.credentials).toBeUndefined();
    }
  });
});

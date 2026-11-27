// @vitest-environment jsdom
/**
 * The price of a sample's picture-to-video form, with the real composer (components/studio/GeneratePanel). What would break without
 * this: a quote asked on load for a source that does not exist yet (the database refuses it, or worse, a price shown for a picture
 * the person has not chosen), or the press of "Use this picture" creating a job. The quote must come only once the copy is the
 * form's source, name that source, and nothing may be created without Generate (CLAUDE.md #3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/studio/JobFeed", () => ({ JobFeed: () => <div data-testid="feed" /> }));
vi.mock("@/components/studio/TemplateGallery", () => ({ TemplateGallery: () => null }));
vi.mock("@/components/studio/Availability", () => ({ DeskAvailabilityNote: () => null, NothingOnSaleNote: () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/all-channels/create",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/all-channels${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { GenerateSection } from "@/components/studio/GenerateSection";
import type { StudioModel, StudioPrefill } from "@/lib/creative/studio";
import type { SampleSource } from "@/lib/site/sample-source";

const ORG = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const TICKET = "33333333-3333-4333-8333-333333333333";
const MODELS: StudioModel[] = [{ id: "motion", displayName: "Motion", capabilities: ["i2v"], beta: false }];
const FORM = { capability: "i2v", model: "motion", prompt: "drift", aspect: "16:9", duration: 5, sourceId: null } as StudioPrefill;
const READY: SampleSource = {
  state: "ready",
  sampleId: "fc1fad12-16de-4cd5-9cd9-e77ed245f469",
  src: "/_next/static/media/poster.abc.webp",
  name: "sample-e3da9148.webp",
  sourceJobId: "e3da9148-f2f8-443e-95b1-8ed36ef3dea4",
  width: 1280,
  height: 720,
};
const asset = { id: ASSET, kind: "image", mime: "image/webp", bytes: 8, width: 1280, height: 720, durationS: null, source: "upload", name: READY.name, variants: ["thumb"], version: 1, createdAt: "2026-11-22T10:00:00Z", thumbUrl: null, viewUrl: null };

let fetchMock: ReturnType<typeof vi.fn>;
let ingested = false;
const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }));
const calls = () => fetchMock.mock.calls.map(([u, init]) => ({ url: String(u), method: ((init as RequestInit | undefined)?.method ?? "GET").toUpperCase(), body: (init as RequestInit | undefined)?.body }));

beforeEach(() => {
  ingested = false;
  sessionStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", `/all-channels/create?tool=i2v&model=motion&sample=${(READY as { sampleId: string }).sampleId}`);
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === (READY as { src: string }).src)
      return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: "image/webp" }) });
    if (url === "/api/media/uploads" && method === "POST") return json({ ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: READY.state === "ready" ? READY.name : "" });
    if (url === `/api/media/uploads/${TICKET}` && method === "PUT") {
      ingested = true;
      return json({ ok: true });
    }
    if (url === `/api/media/uploads/${TICKET}`) return json({ status: "ingested", asset_id: ASSET });
    if (url === `/api/media/${ASSET}`) return json({ asset });
    // The library (the composer's picture list, and the copy's name search): the copy is there once the worker took it.
    if (url.startsWith("/api/media")) return json({ available: true, host: { media: true, staging: true, signing: true }, assets: ingested ? [asset] : [], uploads: [], quota: { usedBytes: 0, limitBytes: 1_000_000, maxUploadBytes: 100_000 } });
    if (url === "/api/creative/quote") return json({ quote: { credits: 40 } });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a sample's form asks a price only once the copy is its source", () => {
  it(
    "no quote and no write on load; after the press one quote names the copy, and no job is created",
    async () => {
      render(
        <I18nProvider locale="en">
          <GenerateSection orgId={ORG} models={MODELS} desk="video" initial={FORM} sample={READY} />
        </I18nProvider>,
      );
      await new Promise((r) => setTimeout(r, 900));
      expect(calls().filter((c) => c.url === "/api/creative/quote")).toEqual([]);
      expect(calls().filter((c) => c.method !== "GET")).toEqual([]);

      fireEvent.click(screen.getByTestId("sample-use"));
      await waitFor(
        () => {
          const q = calls().filter((c) => c.url === "/api/creative/quote");
          expect(q.length).toBeGreaterThan(0);
          expect((JSON.parse(String(q.at(-1)!.body)) as { params: { source_asset_id?: string } }).params.source_asset_id).toBe(ASSET);
        },
        { timeout: 5000 },
      );
      // The upload came first; the quote only after it.
      const order = calls().map((c) => `${c.method} ${c.url}`);
      expect(order.indexOf(`PUT /api/media/uploads/${TICKET}`)).toBeLessThan(order.indexOf("POST /api/creative/quote"));
      expect(calls().some((c) => c.url.startsWith("/api/creative/jobs") && c.method !== "GET")).toBe(false);
    },
    10000,
  );
});

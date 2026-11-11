// @vitest-environment jsdom
/**
 * The "Scan my site" panel (components/ads/BrandScanPanel.tsx, NIGHTSHIFT_ADS_BRAND_SCAN).
 * What would break without these: the panel drawn while the switch is off, a hosting parent sent as "my domain", a TXT record a person
 * cannot copy, a scan started without the quoted price as its ceiling (or a retry of the same press that starts a second scan), a price
 * or a cap shown with a number the database never gave, a value the scan read rendered as HTML or its source drawn as a link to the site,
 * a field accepted that the person did not tick, a new kit started without its name, and a viewer offered buttons that can only fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { adsBrandScanEn as t } from "../lib/i18n/ads-brand-scan/en";
import type { AdsWorkspaceData, BrandKit } from "../lib/adsFactory/model";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/studio/useLibraryImages", () => ({
  useLibraryImages: () => ({ state: "ready", images: [], recordings: [], previews: new Map(), reload: vi.fn() }),
}));

const { AdsWorkspace } = await import("../components/ads/AdsWorkspace");
const ORG = "0a000000-0000-4000-8000-00000000000a";
const KIT = "0b000000-0000-4000-8000-00000000000b";
const DOMAIN = "0c000000-0000-4000-8000-00000000000c";
const SCAN = "0d000000-0000-4000-8000-00000000000d";
const LOGO = "0e000000-0000-4000-8000-00000000000e";
const TOKEN = "0123456789abcdef0123456789abcdef";

const kit = (over: Partial<BrandKit> = {}): BrandKit => ({
  id: KIT, name: "Mine", siteUrl: null, logo: null, palette: ["#000000"], fonts: [], voice: "", source: "manual", updatedAt: null, products: [], ...over,
});
const data = (over: Partial<AdsWorkspaceData> = {}): AdsWorkspaceData => ({ available: true, kits: [kit()], campaigns: [], ...over });

const domain = (over: Record<string, unknown> = {}) => ({
  id: DOMAIN, host: "shop.example.com", recordName: "_nightshift.shop.example.com", recordValue: `nightshift-verify=${TOKEN}`,
  verifiedAt: null, lastCheckedAt: null, lastCheckCode: null, pending: false, ...over,
});
const src = (where: string, url = "https://shop.example.com/") => ({ url, where });
const readyScan = (over: Record<string, unknown> = {}) => ({
  id: SCAN, url: "https://shop.example.com/", status: "ready", errorCode: null, credits: 1, charged: 1, createdAt: null,
  fields: {
    name: { value: "<b>Brand</b>", source: src("og_site_name") },
    description: { value: "Plain goods.", source: src("meta_description") },
    logo: { value: LOGO, source: src("icon", "https://shop.example.com/icon.png") },
    palette: { value: ["#112233"], source: src("logo_palette", "https://shop.example.com/icon.png") },
    fonts: null,
    themeColor: null,
  },
  products: [{ title: { value: "Mug", source: src("jsonld_product") }, description: null, price: { value: "$12", source: src("jsonld_product") }, image: null }],
  pages: ["https://shop.example.com/"], notes: [{ code: "logo_svg", url: "https://shop.example.com/l.svg" }], accepted: [], kitId: null, ...over,
});

type State = { quote: unknown; domains: unknown[]; scans: unknown[] };
let state: State;
let calls: { method: string; url: string; body: unknown }[] = [];
let answers: ((url: string, method: string) => { status: number; body: unknown } | "network" | undefined)[] = [];

beforeEach(() => {
  state = { quote: { onSale: true, credits: 1, exempt: false }, domains: [], scans: [] };
  calls = [];
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers.map((f) => f(url, method)).find(Boolean);
    if (a === "network") throw new TypeError("network");
    const out = a ?? (url.startsWith("/api/ads/scan?") ? { status: 200, body: { org: ORG, ...state, pictures: {} } } : { status: 200, body: { org: ORG, kits: [kit()], campaigns: [] } });
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  }));
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (scan = true, canEdit = true) =>
  render(<AdsWorkspace orgId={ORG} canEdit={canEdit} initial={data()} libraryHref="/alpha/library" scan={scan} />);
const openPanel = async () => {
  fireEvent.click(screen.getByRole("button", { name: t.open }));
  await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/ads/scan?"))).toBe(true));
};
const posts = (prefix: string) => calls.filter((c) => c.method === "POST" && c.url.startsWith(prefix));

describe("the switch", () => {
  it("draws nothing of the scan while it is off", () => {
    show(false);
    expect(screen.queryByRole("button", { name: t.open })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reads nothing until the panel is opened", () => {
    show(true);
    expect(screen.getByRole("button", { name: t.open })).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe("1. proving the domain", () => {
  it("sends the host as the database stores it, then shows the TXT record to copy and Check now", async () => {
    show();
    await openPanel();
    fireEvent.change(screen.getByLabelText(t.domain.label), { target: { value: " HTTPS://Shop.Example.com/about " } });
    state.domains = [domain()];
    answers.push((url, m) => (m === "POST" && url === "/api/ads/scan/domains" ? { status: 201, body: { id: DOMAIN } } : undefined));
    fireEvent.click(screen.getByRole("button", { name: t.domain.submit }));
    await screen.findByText("_nightshift.shop.example.com");
    expect(posts("/api/ads/scan/domains")[0].body).toEqual({ org_id: ORG, host: "shop.example.com" });
    expect(screen.getByText(`nightshift-verify=${TOKEN}`)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: t.domain.copy })[1]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`nightshift-verify=${TOKEN}`));
    answers.push((url, m) => (m === "POST" && url.endsWith("/check") ? { status: 202, body: { pending: true } } : undefined));
    state.domains = [domain({ pending: true })];
    fireEvent.click(screen.getByRole("button", { name: t.domain.check }));
    await screen.findByText(t.domain.checking);
    expect(posts(`/api/ads/scan/domains/${DOMAIN}/check`)).toHaveLength(1);
  });

  it("refuses a hosting parent before anything is sent, and says the wait the database gave", async () => {
    show();
    await openPanel();
    fireEvent.change(screen.getByLabelText(t.domain.label), { target: { value: "myshopify.com" } });
    fireEvent.click(screen.getByRole("button", { name: t.domain.submit }));
    expect(await screen.findByText(t.errors.hosting_parent)).toBeTruthy();
    expect(posts("/api/ads/scan/domains")).toEqual([]);
    cleanup();
    state.domains = [domain({ lastCheckCode: "no_record" })];
    answers.push((url, m) => (m === "POST" && url.endsWith("/check") ? { status: 429, body: { error: "too_soon", retry_after: 9 } } : undefined));
    show();
    await openPanel();
    expect(await screen.findByText(`Last check: ${t.domain.results.no_record}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t.domain.check }));
    expect(await screen.findByText("Wait 9 seconds before checking again.")).toBeTruthy();
  });
});

describe("2. the scan", () => {
  it("not on sale: says so and offers no scan button", async () => {
    state = { quote: { onSale: false, credits: null, exempt: false }, domains: [domain({ verifiedAt: "2026-11-11T00:00:00Z" })], scans: [] };
    show();
    await openPanel();
    expect(await screen.findByText(t.scan.notOnSale)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Scan/ })).toBeNull();
  });

  it("starts with the quoted price as its ceiling; a retry after a lost answer is the same press", async () => {
    state.domains = [domain({ verifiedAt: "2026-11-11T00:00:00Z" })];
    show();
    await openPanel();
    expect(await screen.findByText(/A scan costs 1 credits/)).toBeTruthy();
    answers.push((url, m) => (m === "POST" && url === "/api/ads/scan" ? "network" : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Scan for 1 credits" }));
    expect(await screen.findByText(t.errors.failed)).toBeTruthy();
    answers.length = 0;
    answers.push((url, m) => (m === "POST" && url === "/api/ads/scan" ? { status: 409, body: { error: "price_changed", price: 2 } } : undefined));
    fireEvent.click(screen.getByRole("button", { name: "Scan for 1 credits" }));
    expect(await screen.findByText("The price is now 2 credits. Press again to scan at that price. Nothing was charged.")).toBeTruthy();
    const sent = posts("/api/ads/scan").filter((c) => c.url === "/api/ads/scan").map((c) => c.body as Record<string, unknown>);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ org_id: ORG, url: "https://shop.example.com/", max_credits: 1 });
    expect(sent[1].idem).toBe(sent[0].idem);
  });

  it("refuses an address outside the proved domain before anything is sent", async () => {
    state.domains = [domain({ verifiedAt: "2026-11-11T00:00:00Z" })];
    show();
    await openPanel();
    fireEvent.change(await screen.findByLabelText(t.scan.urlLabel), { target: { value: "https://evilshop.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan for 1 credits" }));
    expect(await screen.findByText(t.errors.domain_not_verified)).toBeTruthy();
    expect(posts("/api/ads/scan").filter((c) => c.url === "/api/ads/scan")).toEqual([]);
  });

  it("a failed scan says why in words and that the credits were released", async () => {
    state.domains = [domain({ verifiedAt: "2026-11-11T00:00:00Z" })];
    state.scans = [readyScan({ status: "failed", errorCode: "fetch_robots", fields: { name: null, description: null, logo: null, palette: null, fonts: null, themeColor: null }, products: [] })];
    show();
    await openPanel();
    expect(await screen.findByText(`The scan did not finish: ${t.failures.fetch_robots} The credits held for it were released.`)).toBeTruthy();
  });
});

describe("3. review and accept", () => {
  beforeEach(() => {
    state.domains = [domain({ verifiedAt: "2026-11-11T00:00:00Z" })];
    state.scans = [readyScan()];
  });

  it("shows what was found as text with its source as text, never as HTML or a link", async () => {
    show();
    await openPanel();
    expect(await screen.findByText("<b>Brand</b>")).toBeTruthy();
    expect(document.querySelector(".ads-scan-panel b")).toBeNull();
    expect(document.querySelectorAll('.ads-scan-panel a')).toHaveLength(0);
    expect(screen.getAllByText("https://shop.example.com/").length).toBeGreaterThan(0);
    expect(screen.getByText(/an SVG picture/)).toBeTruthy();
    const swatches = [...document.querySelectorAll<HTMLElement>(".ads-scan-panel .ads-swatch > span[aria-hidden]")];
    expect(swatches.map((s) => s.style.background)).toContain("rgb(17, 34, 51)");
  });

  it("accepts exactly the ticked fields; a new kit needs the name", async () => {
    show();
    await openPanel();
    await screen.findByText("<b>Brand</b>");
    fireEvent.click(screen.getByRole("button", { name: t.review.acceptSelected }));
    expect(await screen.findByText(t.review.nothingTicked)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: `${t.review.accept}: ${t.review.fields.palette}` }));
    fireEvent.click(screen.getByRole("button", { name: t.review.acceptSelected }));
    expect(await screen.findByText(t.review.nameForNewKit)).toBeTruthy();
    expect(posts(`/api/ads/scan/${SCAN}/accept`)).toEqual([]);
    fireEvent.click(screen.getByRole("checkbox", { name: `${t.review.accept}: ${t.review.fields.name}` }));
    fireEvent.click(screen.getByRole("checkbox", { name: `${t.review.accept}: Product: Mug` }));
    answers.push((url, m) => (m === "POST" && url.endsWith("/accept") ? { status: 200, body: { kit_id: KIT } } : undefined));
    fireEvent.click(screen.getByRole("button", { name: t.review.acceptSelected }));
    expect(await screen.findByText(t.review.accepted)).toBeTruthy();
    expect(posts(`/api/ads/scan/${SCAN}/accept`)[0].body).toEqual({ kit_id: null, fields: ["name", "palette", "product:0"] });
  });

  it("into an existing kit: shows its current value beside the proposal and sends its id", async () => {
    show();
    await openPanel();
    fireEvent.change(await screen.findByLabelText(t.review.target), { target: { value: KIT } });
    expect(document.querySelector(".ads-scan-table")?.textContent).toContain("Mine");
    fireEvent.click(screen.getByRole("checkbox", { name: `${t.review.accept}: ${t.review.fields.description}` }));
    answers.push((url, m) => (m === "POST" && url.endsWith("/accept") ? { status: 409, body: { error: "limit_reached", max: 20 } } : undefined));
    fireEvent.click(screen.getByRole("button", { name: t.review.acceptSelected }));
    expect(await screen.findByText("At most 20 are allowed. Nothing was changed.")).toBeTruthy();
    expect(posts(`/api/ads/scan/${SCAN}/accept`)[0].body).toEqual({ kit_id: KIT, fields: ["description"] });
  });

  it("a viewer reads the review and has nothing to press", async () => {
    show(true, false);
    await openPanel();
    await screen.findByText("<b>Brand</b>");
    expect(screen.getByText(t.readOnly)).toBeTruthy();
    expect(document.querySelectorAll(".ads-scan-panel input, .ads-scan-panel select")).toHaveLength(0);
    expect([...document.querySelectorAll(".ads-scan-panel button")]).toEqual([]);
  });
});

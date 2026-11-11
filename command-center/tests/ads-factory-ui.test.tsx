// @vitest-environment jsdom
/**
 * The Ads workspace (components/ads): its states and its buttons.
 * What would break without these: a viewer offered buttons that can only fail, a "New campaign" button with no products behind it,
 * a failed read shown as an empty workspace, a retry of "add drafts" that adds a second set (a new press id), a refusal swallowed or
 * shown as raw text, a cap shown with a number the database never gave, a mistake in a form sent to the server before it is named,
 * a typed name rendered as HTML, a colour that is not #rrggbb reaching a style attribute, and a site address drawn as a link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import type { AdCampaign, AdsWorkspaceData, BrandKit } from "../lib/adsFactory/model";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/studio/useLibraryImages", () => ({
  useLibraryImages: () => ({ state: "ready", images: [{ id: "0f000000-0000-4000-8000-000000000001", thumbUrl: null, name: "logo.png" }], recordings: [], previews: new Map(), reload: vi.fn() }),
}));

const { AdsWorkspace } = await import("../components/ads/AdsWorkspace");
const a = en.adsFactory;
const ORG = "0a000000-0000-4000-8000-00000000000a";
const KIT = "0b000000-0000-4000-8000-00000000000b";
const CAMPAIGN = "0c000000-0000-4000-8000-00000000000c";
const C1 = "0d000000-0000-4000-8000-000000000001";
const PRODUCT = "0e000000-0000-4000-8000-000000000001";

const kit = (over: Partial<BrandKit> = {}): BrandKit => ({
  id: KIT, name: "<b>Acme</b>", siteUrl: "https://example.com/", logo: null, palette: ["#112233"], fonts: ["Inter"], voice: "Calm.", source: "manual", updatedAt: null,
  products: [{ id: PRODUCT, kitId: KIT, title: "Tea", description: "", price: "$12", source: "manual", images: [] }], ...over,
});
const campaign = (over: Partial<AdCampaign> = {}): AdCampaign => ({
  id: CAMPAIGN, kitId: KIT, name: "Launch", objective: "launch", language: "en", formats: ["1:1"], directions: ["bold"], productIds: [PRODUCT], updatedAt: null,
  concepts: [{ id: C1, campaignId: CAMPAIGN, productId: PRODUCT, format: "1:1", direction: "bold", kind: "image", headline: "New from Acme: Tea", body: "Green.", cta: "Shop now", visualBrief: "A cup.", storyboard: null, status: "draft", updatedAt: null }],
  ...over,
});
const data = (over: Partial<AdsWorkspaceData> = {}): AdsWorkspaceData => ({ available: true, kits: [kit()], campaigns: [campaign()], ...over });

let calls: { method: string; url: string; body: unknown }[] = [];
let answers: ((url: string, method: string) => { status: number; body: unknown } | undefined)[] = [];
beforeEach(() => {
  calls = [];
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const a = answers.map((f) => f(url, method)).find(Boolean) ?? { status: 200, body: { org: ORG, kits: [kit()], campaigns: [campaign()] } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (initial = data(), canEdit = true) => render(<AdsWorkspace orgId={ORG} canEdit={canEdit} initial={initial} libraryHref="/alpha/library" />);

describe("states", () => {
  it("says what this version does not do, and draws typed text as text", () => {
    show();
    expect(screen.getByText(a.firstVersion)).toBeTruthy();
    expect(screen.getByText(a.concepts.templateNote)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "<b>Acme</b>" })).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });

  it("shows the site address as text, never as a link, and only checked colours", () => {
    show(data({ kits: [kit({ palette: ["#112233"] })] }));
    expect(screen.getByText("https://example.com/").closest("a")).toBeNull();
    expect(document.querySelectorAll('a[href^="https://example.com"]')).toHaveLength(0);
    const swatches = [...document.querySelectorAll<HTMLElement>(".ads-swatch > span[aria-hidden]")];
    expect(swatches.map((s) => s.style.background)).toEqual(["rgb(17, 34, 51)"]);
  });

  it("empty: says how to start, and explains why there is no campaign button yet", () => {
    show(data({ kits: [], campaigns: [] }));
    expect(screen.getByText(a.kits.empty)).toBeTruthy();
    expect(screen.getByText(a.campaigns.needKit)).toBeTruthy();
    expect(screen.queryByRole("button", { name: a.campaigns.add })).toBeNull();
    expect(screen.getByRole("button", { name: a.kits.add })).toBeTruthy();
  });

  it("not set up: says so and draws nothing else", () => {
    show({ available: false, kits: [], campaigns: [] });
    expect(screen.getByText(a.notAvailable)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a failed first read says so and offers Try again; a good retry draws the data", async () => {
    show({ ...data({ kits: [], campaigns: [] }), error: "read_failed" });
    expect(screen.getByRole("alert").textContent).toContain(a.loadFailed);
    fireEvent.click(screen.getByRole("button", { name: a.retry }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "<b>Acme</b>" })).toBeTruthy());
    expect(calls).toEqual([{ method: "GET", url: `/api/ads?org=${ORG}`, body: undefined }]);
  });

  it("a viewer reads everything and gets no button, with the reason said", () => {
    show(data(), false);
    expect(screen.getByText(a.readOnly)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("New from Acme: Tea")).toBeTruthy();
  });
});

describe("concept drafts", () => {
  it("one press sends only kind, count and a press id; a retry after a network failure reuses the id", async () => {
    answers.push((url, method) => (method === "POST" && calls.filter((c) => c.method === "POST").length === 1 ? { status: 502, body: { error: "failed" } } : undefined));
    answers.push((url, method) => (method === "POST" ? { status: 201, body: { ids: [C1, C1], replayed: false } } : undefined));
    show();
    const card = screen.getByRole("group", { name: a.concepts.addHeading });
    fireEvent.change(within(card).getByLabelText(a.concepts.kindLabel), { target: { value: "video" } });
    fireEvent.change(within(card).getByLabelText(a.concepts.countLabel), { target: { value: "2" } });
    fireEvent.click(within(card).getByRole("button", { name: a.concepts.add }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(a.errors.failed));
    fireEvent.click(within(card).getByRole("button", { name: a.concepts.add }));
    await waitFor(() => expect(screen.getByText("2 drafts added.")).toBeTruthy());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toBe(`/api/ads/campaigns/${CAMPAIGN}/concepts`);
    expect(Object.keys(posts[0].body as object).sort()).toEqual(["batch", "count", "kind"]);
    expect(posts[0].body).toMatchObject({ kind: "video", count: 2 });
    expect((posts[1].body as { batch: string }).batch).toBe((posts[0].body as { batch: string }).batch);
  });

  it("a cap is shown with the number the database gave, and the next press is a new one", async () => {
    answers.push((url, method) => (method === "POST" ? { status: 409, body: { error: "limit_reached", max: 24 } } : undefined));
    show();
    const card = screen.getByRole("group", { name: a.concepts.addHeading });
    fireEvent.click(within(card).getByRole("button", { name: a.concepts.add }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This workspace has reached its limit of 24. Delete one to add another."));
    fireEvent.click(within(card).getByRole("button", { name: a.concepts.add }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    const [p1, p2] = calls.filter((c) => c.method === "POST").map((c) => (c.body as { batch: string }).batch);
    expect(p1).not.toBe(p2);
  });

  it("approve says that nothing was generated, and an unknown error word reads as the plain failure", async () => {
    answers.push((url, method) => (method === "PATCH" ? { status: 200, body: { id: C1, status: "approved" } } : undefined));
    show();
    fireEvent.click(screen.getByRole("button", { name: a.concepts.approve }));
    await waitFor(() => expect(screen.getByText(a.concepts.approvedNothingStarted)).toBeTruthy());
    expect(calls[0]).toEqual({ method: "PATCH", url: `/api/ads/concepts/${C1}`, body: { status: "approved" } });
    answers.unshift((url, method) => (method === "PATCH" ? { status: 500, body: { error: "<script>x</script>" } } : undefined));
    fireEvent.click(screen.getByRole("button", { name: a.concepts.archive }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(a.errors.failed));
  });

  it("an approved concept offers no edit, only back to draft, archive and delete", () => {
    show(data({ campaigns: [campaign({ concepts: [{ ...campaign().concepts[0], status: "approved" }] })] }));
    const card = screen.getByText("New from Acme: Tea").closest("article")!;
    const names = within(card as HTMLElement).getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual([a.concepts.toDraft, a.concepts.archive, a.delete]);
    expect(within(card as HTMLElement).getByText(a.concepts.onlyDraftEdits)).toBeTruthy();
  });
});

describe("forms", () => {
  it("a brand kit form names a mistake before sending, keeps what was typed, then saves and reads again", async () => {
    answers.push((url, method) => (method === "POST" ? { status: 201, body: { id: KIT } } : undefined));
    show(data({ kits: [], campaigns: [] }));
    fireEvent.click(screen.getByRole("button", { name: a.kits.add }));
    const dialog = screen.getByRole("dialog", { name: a.kits.createTitle });
    fireEvent.change(within(dialog).getByLabelText(a.kits.name), { target: { value: "Acme" } });
    fireEvent.change(within(dialog).getByLabelText(`${a.kits.site} (${a.optional})`), { target: { value: "http://169.254.169.254/" } });
    fireEvent.click(within(dialog).getByRole("button", { name: a.save }));
    expect(within(dialog).getByRole("alert").textContent).toBe(a.errors.invalid_site_url);
    expect(calls).toEqual([]);
    expect((within(dialog).getByLabelText(a.kits.name) as HTMLInputElement).value).toBe("Acme");
    fireEvent.change(within(dialog).getByLabelText(`${a.kits.site} (${a.optional})`), { target: { value: "https://example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pick logo.png" }));
    fireEvent.click(within(dialog).getByRole("button", { name: a.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/ads/kits", body: { org_id: ORG, name: "Acme", site_url: "https://example.com", logo_asset_id: "0f000000-0000-4000-8000-000000000001" } });
    expect(calls[1]).toMatchObject({ method: "GET", url: `/api/ads?org=${ORG}` });
  });

  it("a refusal from the server is shown in the form, and Escape closes it back to the button that opened it", async () => {
    answers.push((url, method) => (method === "DELETE" ? { status: 409, body: { error: "kit_in_use" } } : undefined));
    show();
    const opener = screen.getAllByRole("button", { name: a.delete })[0];
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: a.kits.deleteTitle });
    expect(within(dialog).getByText(/“<b>Acme<\/b>” and its 1 products will be deleted/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: a.confirmDelete }));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe(a.errors.kit_in_use));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("a campaign form needs at least one format and product, and sends the closed-list words", async () => {
    answers.push((url, method) => (method === "POST" ? { status: 201, body: { id: CAMPAIGN } } : undefined));
    show(data({ campaigns: [] }));
    fireEvent.click(screen.getByRole("button", { name: a.campaigns.add }));
    const dialog = screen.getByRole("dialog", { name: a.campaigns.createTitle });
    fireEvent.change(within(dialog).getByLabelText(a.campaigns.name), { target: { value: "Spring" } });
    fireEvent.click(within(dialog).getByRole("button", { name: a.format["1:1"] }));
    fireEvent.click(within(dialog).getByRole("button", { name: a.save }));
    expect(within(dialog).getByRole("alert").textContent).toBe(a.errors.invalid_formats);
    fireEvent.click(within(dialog).getByRole("button", { name: a.format["9:16"] }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tea" }));
    fireEvent.click(within(dialog).getByRole("button", { name: a.save }));
    expect(within(dialog).getByRole("alert").textContent).toBe(a.errors.invalid_products);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Tea" }));
    fireEvent.change(within(dialog).getByLabelText(a.campaigns.objective), { target: { value: "offer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: a.save }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/ads/campaigns", body: { kit_id: KIT, name: "Spring", objective: "offer", language: "en", formats: ["9:16"], directions: ["spotlight"], product_ids: [PRODUCT] } });
  });
});

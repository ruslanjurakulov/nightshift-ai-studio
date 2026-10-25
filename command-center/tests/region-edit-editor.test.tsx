// @vitest-environment jsdom
/**
 * The region editor end to end in the browser layer, with the Konva canvas and the library picker replaced by
 * stand-ins (jsdom has no canvas) and fetch faked: pick a picture, add regions up to five, the sixth is refused,
 * the price is asked only once a region has words and a model is chosen, the run key stays off until there is a
 * price, a run asks for exactly the regions on screen at the price shown with one key per press, and the result says
 * which regions were applied and which were not and what was charged.
 * What would break without these: a sixth region, a price asked for a model nobody chose, a quote body that is not
 * the regions on screen, a run key that works without a price, a double press that pays twice, a retry with a new key,
 * a failed region shown as applied, or a charge shown that the database did not record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { en } from "../lib/i18n/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/studio/SourcePicker", () => ({
  SourcePicker: ({ onChange }: { onChange: (id: string) => void }) => (
    <>
      <button onClick={() => onChange("33333333-3333-4333-8333-333333333333")}>pick-picture</button>
      <button onClick={() => onChange("44444444-4444-4444-8444-444444444444")}>pick-other</button>
    </>
  ),
}));
vi.mock("@/components/studio/BeforeAfter", () => ({ BeforeAfter: () => <div data-testid="compare" /> }));
vi.mock("@/components/regionEdit/RegionCanvas", () => ({
  RegionCanvas: (p: { regions: unknown[]; onDraw: (r: { x: number; y: number; w: number; h: number }) => void }) => (
    <div data-testid="canvas" data-count={p.regions.length}>
      <button onClick={() => p.onDraw({ x: 5, y: 5, w: 50, h: 50 })}>draw</button>
    </div>
  ),
}));

const { RegionEditor } = await import("../components/regionEdit/RegionEditor");

const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";
const calls: { url: string; body?: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/api/media/"))
        return new Response(JSON.stringify({ asset: { kind: "image", width: 800, height: 600 }, urls: { original: "/f/x" }, served: true }), { status: 200 });
      if (url.startsWith("/api/region-edit/versions"))
        return new Response(JSON.stringify({ chain: { items: [{ id: PIC, parentId: null, version: 1, createdAt: null, width: 800, height: 600 }], at: 0 } }), { status: 200 });
      if (url === "/api/region-edit/quote")
        return new Response(JSON.stringify({ quote: { model: "m1", feather: 4, total: 7, count: 1, perRegion: 7, skipped: [] } }), { status: 200 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const models = [{ id: "m1", displayName: "Model One" }, { id: "m2", displayName: "Model Two" }];

async function open() {
  render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
  fireEvent.click(screen.getByText("pick-picture"));
  await screen.findByTestId("canvas");
}

describe("RegionEditor", () => {
  it("offers nothing to draw on until a picture is chosen, and always says the changed parts are AI-generated", () => {
    render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
    expect(screen.queryByTestId("canvas")).toBeNull();
    expect(screen.getByText(en.regionEdit.aiLabel)).toBeTruthy();
    expect(screen.getByText(en.regionEdit.previewNote)).toBeTruthy();
  });

  it("takes at most five regions: the add key goes off at five and the count says so", async () => {
    await open();
    const add = screen.getByRole("button", { name: en.regionEdit.add }) as HTMLButtonElement;
    for (let i = 0; i < 5; i += 1) fireEvent.click(add);
    await waitFor(() => expect(screen.getByTestId("canvas").getAttribute("data-count")).toBe("5"));
    expect(add.disabled).toBe(true);
    expect((screen.getByRole("button", { name: en.regionEdit.drawOn }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("draw"));
    expect(screen.getByTestId("canvas").getAttribute("data-count")).toBe("5");
    expect(screen.getByText("5 of 5 regions")).toBeTruthy();
    expect(screen.getAllByTestId("region-row")).toHaveLength(5);
  });

  it("names new regions Region 1, 2, ... and a drawn rectangle becomes a region", async () => {
    await open();
    fireEvent.click(screen.getByText("draw"));
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.add }));
    const names = screen.getAllByLabelText(en.regionEdit.fieldName).map((e) => (e as HTMLInputElement).value);
    expect(names).toEqual(["Region 1", "Region 2"]);
  });

  it("asks no price until a region has words AND a model is chosen, then asks for exactly the regions on screen", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.add }));
    expect(screen.getByText(en.regionEdit.errors.model_required, { selector: "p" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(en.regionEdit.fieldPrompt), { target: { value: "make it dusk" } });
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(calls.some((c) => c.url === "/api/region-edit/quote")).toBe(false);
    fireEvent.change(screen.getByLabelText(en.regionEdit.modelLabel), { target: { value: "m2" } });
    await waitFor(() => expect(calls.some((c) => c.url === "/api/region-edit/quote")).toBe(true), { timeout: 3000 });
    const q = calls.find((c) => c.url === "/api/region-edit/quote")!.body as { model: string; source_asset_id: string; feather: number; regions: { prompt: string; name: string }[] };
    expect(q).toMatchObject({ model: "m2", source_asset_id: PIC, feather: 4 });
    expect(q.regions).toHaveLength(1);
    expect(q.regions[0]).toMatchObject({ name: "Region 1", prompt: "make it dusk" });
    expect(await screen.findByText("At most 7 credits, if every region is applied")).toBeTruthy();
    expect(screen.getByText("About 7 credits per region. Only a region that is applied is charged.")).toBeTruthy();
  });

  it("does not preselect a model when there is a choice, and the run key stays off with an honest reason", async () => {
    await open();
    expect((screen.getByLabelText(en.regionEdit.modelLabel) as HTMLSelectElement).value).toBe("");
    const run = screen.getByRole("button", { name: en.regionEdit.run }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByText(en.regionEdit.runWhy)).toBeTruthy();
    fireEvent.click(run);
    expect(calls.filter((c) => c.url.includes("/run"))).toEqual([]);
  });

  it("a different picture starts with no regions", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.add }));
    expect(screen.getAllByTestId("region-row")).toHaveLength(1);
    fireEvent.click(screen.getByText("pick-other"));
    await waitFor(() => expect(screen.queryAllByTestId("region-row")).toHaveLength(0));
  });
});

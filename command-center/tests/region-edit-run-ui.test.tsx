// @vitest-environment jsdom
/**
 * The run step in the browser layer (components/regionEdit/RunPanel.tsx inside RegionEditor), fetch faked, the canvas and the
 * library picker replaced by stand-ins: the run key needs a price; a press asks for exactly the regions on screen at the price
 * shown, with one key; a double press and a retry name the same job; the result says which regions were applied and which were
 * not, what was charged and what was given back; a refresh mid-job finds the job again; every state has words.
 * What would break without these: a press that pays twice, a retry under a new key, a failed region shown as applied, a charge
 * shown that the database did not record, a result that is a dead end (no way to open the new version or close it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/components/studio/SourcePicker", () => ({
  SourcePicker: ({ onChange }: { onChange: (id: string) => void }) => <button onClick={() => onChange("33333333-3333-4333-8333-333333333333")}>pick-picture</button>,
}));
vi.mock("@/components/studio/BeforeAfter", () => ({ BeforeAfter: () => <div data-testid="compare" /> }));
vi.mock("@/components/regionEdit/RegionCanvas", () => ({ RegionCanvas: (p: { regions: unknown[] }) => <div data-testid="canvas" data-count={p.regions.length} /> }));

const { RegionEditor } = await import("../components/regionEdit/RegionEditor");

const ORG = "11111111-1111-4111-8111-111111111111";
const PIC = "33333333-3333-4333-8333-333333333333";
const NEW = "66666666-6666-4666-8666-666666666666";
const JOB = "55555555-5555-4555-8555-555555555555";
const models = [{ id: "m1", displayName: "Model One" }];

interface Call { url: string; method: string; body?: Record<string, unknown> }
let calls: Call[];
let runAnswers: (() => Response | Promise<Response>)[];
let jobAnswers: (() => Response | Promise<Response>)[];
let total = 9;
let versionsChain: unknown;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: JOB, capability: "edit", status: "queued", quoted_credits: 9, charged_credits: null, error_code: null, result: null, result_asset_ids: [],
  params: {
    source_asset_id: PIC,
    regions: [{ id: "r1", name: "Region 1", prompt: "a", rect: {} }, { id: "r2", name: "Region 2", prompt: "b", rect: {} }, { id: "r3", name: "Region 3", prompt: "c", rect: {} }],
  },
  ...over,
});
const done = (statuses: [string, string?][], over: Record<string, unknown> = {}) => ({
  status: "completed", charged_credits: 6, result_asset_ids: [NEW],
  result: { regions: statuses.map(([s, c], i) => ({ id: `r${i + 1}`, status: s, ...(c ? { code: c } : {}) })) },
  ...over,
});

beforeEach(() => {
  calls = [];
  total = 9;
  runAnswers = [];
  jobAnswers = [];
  versionsChain = { items: [{ id: PIC, parentId: null, version: 1, createdAt: null, width: 800, height: 600 }], at: 0 };
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.startsWith("/api/media/")) return json({ asset: { kind: "image", width: 800, height: 600 }, urls: { original: "/f/x" }, served: true });
      if (url.startsWith("/api/region-edit/versions")) return json({ chain: versionsChain });
      if (url === "/api/region-edit/quote")
        return json({ quote: { model: "m1", feather: 4, total, count: (calls.at(-1)!.body!.regions as unknown[]).filter((r) => (r as { prompt: string }).prompt).length, perRegion: 3, skipped: [] } });
      if (url === "/api/region-edit/run") return (runAnswers.shift() ?? (() => json({ job: jobRow(), replay: false }, 201)))();
      if (url.startsWith("/api/creative/jobs/") && method === "POST") return json({ job: jobRow({ status: "cancelled" }) });
      if (url.startsWith("/api/creative/jobs/")) return (jobAnswers.shift() ?? (() => json({ job: jobRow() })))();
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function ready(nRegions = 3) {
  render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" creditsHref="/x/credits" />);
  fireEvent.click(screen.getByText("pick-picture"));
  await screen.findByTestId("canvas");
  for (let i = 0; i < nRegions; i += 1) fireEvent.click(screen.getByRole("button", { name: en.regionEdit.add }));
  const boxes = screen.getAllByLabelText(en.regionEdit.fieldPrompt);
  boxes.forEach((b, i) => fireEvent.change(b, { target: { value: "abc"[i] } }));
  await waitFor(() => expect(calls.some((c) => c.url === "/api/region-edit/quote")).toBe(true), { timeout: 3000 });
  await screen.findByText(`At most ${total} credits, if every region is applied`);
}

const runButton = () => screen.getByRole("button", { name: en.regionEdit.run }) as HTMLButtonElement;
const runCalls = () => calls.filter((c) => c.url === "/api/region-edit/run");

describe("the run key", () => {
  it("stays off with an honest reason until a picture, a model with a price and a region with words exist", async () => {
    render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
    expect(runButton().disabled).toBe(true);
    expect(screen.getByText(en.regionEdit.runWhy)).toBeTruthy();
    fireEvent.click(screen.getByText("pick-picture"));
    await screen.findByTestId("canvas");
    expect(runButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: en.regionEdit.add }));
    expect(runButton().disabled).toBe(true);
    expect(runCalls()).toEqual([]);
  });

  it("turns on once the database has priced exactly the regions on screen", async () => {
    await ready(2);
    expect(runButton().disabled).toBe(false);
  });
});

describe("pressing it", () => {
  it("asks for exactly the regions on screen, the model, the feather, the price that was shown and one key", async () => {
    await ready(3);
    fireEvent.click(runButton());
    await waitFor(() => expect(runCalls()).toHaveLength(1));
    const body = runCalls()[0].body as { org_id: string; source_asset_id: string; model: string; feather: number; max_credits: number; idempotency_key: string; regions: { name: string; prompt: string }[] };
    expect(body).toMatchObject({ org_id: ORG, source_asset_id: PIC, model: "m1", feather: 4, max_credits: 9 });
    expect(body.idempotency_key).toMatch(/^re-[A-Za-z0-9_-]+$/);
    expect(body.regions.map((r) => [r.name, r.prompt])).toEqual([["Region 1", "a"], ["Region 2", "b"], ["Region 3", "c"]]);
    expect(body).not.toHaveProperty("prompt");
  });

  it("a double press asks once: the key is off while the request is in flight", async () => {
    await ready(1);
    let release: (r: Response) => void = () => undefined;
    runAnswers.push(() => new Promise<Response>((res) => { release = res; }));
    fireEvent.click(runButton());
    const busy = screen.getByRole("button", { name: en.regionEdit.starting }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    fireEvent.click(busy);
    expect(runCalls()).toHaveLength(1);
    await act(async () => release(json({ job: jobRow(), replay: false }, 201)));
  });

  it("a retry after a dropped answer names the same job (same key); other regions are another request (new key)", async () => {
    await ready(1);
    runAnswers.push(() => { throw new TypeError("network down"); });
    fireEvent.click(runButton());
    expect(await screen.findByText(en.regionEdit.errors.failed)).toBeTruthy();
    runAnswers.push(() => json({ error: "insufficient_credits", available: 1, needed: 9 }, 402));
    fireEvent.click(runButton());
    await waitFor(() => expect(runCalls()).toHaveLength(2));
    expect(runCalls()[1].body!.idempotency_key).toBe(runCalls()[0].body!.idempotency_key);
    fireEvent.change(screen.getByLabelText(en.regionEdit.fieldPrompt), { target: { value: "something else" } });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/region-edit/quote").length).toBeGreaterThan(1), { timeout: 3000 });
    await waitFor(() => expect(runButton().disabled).toBe(false));
    runAnswers.push(() => json({ job: jobRow(), replay: false }, 201));
    fireEvent.click(runButton());
    await waitFor(() => expect(runCalls()).toHaveLength(3));
    expect(runCalls()[2].body!.idempotency_key).not.toBe(runCalls()[0].body!.idempotency_key);
  });

  it("says why it was refused, with a way forward when the credits are short, and nothing is shown as started", async () => {
    await ready(1);
    runAnswers.push(() => json({ error: "insufficient_credits", available: 1, needed: 9 }, 402));
    fireEvent.click(runButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(en.creative.errors.insufficient_credits);
    expect((screen.getByRole("link", { name: en.regionEdit.addCredits }) as HTMLAnchorElement).getAttribute("href")).toBe("/x/credits");
    expect(screen.queryByTestId("run-result")).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it("asks the price again when it moved, and says so", async () => {
    await ready(1);
    runAnswers.push(() => json({ error: "price_changed" }, 409));
    total = 12;
    const before = calls.filter((c) => c.url === "/api/region-edit/quote").length;
    fireEvent.click(runButton());
    expect(await screen.findByText(en.creative.errors.price_changed)).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/region-edit/quote").length).toBeGreaterThan(before), { timeout: 3000 });
    await screen.findByText("At most 12 credits, if every region is applied");
  });
});

describe("the result", () => {
  async function runWith(job: unknown) {
    jobAnswers.push(() => json({ job }));
    await ready(3);
    fireEvent.click(runButton());
    return await screen.findByTestId("run-result");
  }

  it("a partly applied job: each region's outcome and reason, only the applied ones charged, the rest given back, and the new version opens", async () => {
    const panel = await runWith(jobRow(done([["applied"], ["refused", "policy"], ["applied"]])));
    const rows = await within(panel).findAllByTestId("region-result");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Region 1Applied",
      `Region 2Refused. ${en.regionEdit.reasons.policy} ${en.regionEdit.notCharged}`,
      "Region 3Applied",
    ]);
    expect(within(panel).getByText("Done: 2 of 3 regions applied.")).toBeTruthy();
    expect(within(panel).getByTestId("run-money").textContent).toBe("Charged 6 credits of the 9 held. 3 credits were released.");
    fireEvent.click(within(panel).getByRole("button", { name: en.regionEdit.openVersion }));
    await waitFor(() => expect(calls.some((c) => c.url === `/api/media/${NEW}`)).toBe(true));
  });

  it("a job where every region failed: nothing charged, the whole hold released, every reason shown, no picture to open", async () => {
    const panel = await runWith(jobRow({
      status: "failed", error_code: "no_region_applied", charged_credits: 0,
      result: { regions: [{ id: "r1", status: "failed", code: "unavailable" }, { id: "r2", status: "refused", code: "region_out_of_bounds" }, { id: "r3", status: "failed", code: "pixel_lock_failed" }] },
    }));
    await within(panel).findByText(en.regionEdit.failures.no_region_applied);
    expect(within(panel).getByTestId("run-money").textContent).toBe("Nothing was charged. The 9 credits held were released.");
    const rows = within(panel).getAllByTestId("region-result").map((r) => r.textContent ?? "");
    expect(rows[0]).toContain(en.regionEdit.reasons.unavailable);
    expect(rows[1]).toContain(en.regionEdit.reasons.region_out_of_bounds);
    expect(rows[2]).toContain(en.regionEdit.reasons.pixel_lock_failed);
    expect(rows.every((r) => r.includes(en.regionEdit.notCharged))).toBe(true);
    expect(within(panel).queryByRole("button", { name: en.regionEdit.openVersion })).toBeNull();
  });

  it("a job that ended before any region was tried says why and charges nothing", async () => {
    const panel = await runWith(jobRow({ status: "failed", error_code: "region_editor_off", charged_credits: 0 }));
    await within(panel).findByText(en.regionEdit.failures.region_editor_off);
    expect(within(panel).getByTestId("run-money").textContent).toContain("Nothing was charged");
    expect(within(panel).getAllByTestId("region-result").every((r) => (r.textContent ?? "").includes(en.regionEdit.regionNotTried))).toBe(true);
  });

  it("a code the screen has no sentence for reads as a generic failure, never the raw word", async () => {
    const panel = await runWith(jobRow({ status: "failed", error_code: "boom_vendor_says_no", charged_credits: 0 }));
    await within(panel).findByText(en.regionEdit.failures.other);
    expect(panel.textContent).not.toContain("boom_vendor");
  });

  it("a queued job shows the hold and can be cancelled; a running job shows progress; the result can be closed when it ends", async () => {
    jobAnswers.push(() => json({ job: jobRow() }));
    const panel = await runWith(jobRow());
    await within(panel).findByText(en.regionEdit.jobQueued);
    expect(within(panel).getByText("9 credits are held. Nothing is charged until the edit is done, and a region that is not applied is never charged.")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: en.regionEdit.dismiss })).toBeNull();
    expect(runButton().disabled).toBe(true);
    fireEvent.click(within(panel).getByRole("button", { name: en.regionEdit.cancel }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `/api/creative/jobs/${JOB}` && (c.body as { action: string }).action === "cancel")).toBe(true));
  });

  it("closing a finished result clears it and its address, and the run key is free again", async () => {
    const panel = await runWith(jobRow(done([["applied"], ["applied"], ["applied"]], { charged_credits: 9 })));
    await within(panel).findByText("Done: 3 of 3 regions applied.");
    expect(window.location.search).toBe(`?job=${JOB}`);
    fireEvent.click(within(panel).getByRole("button", { name: en.regionEdit.dismiss }));
    expect(screen.queryByTestId("run-result")).toBeNull();
    expect(window.location.search).toBe("");
    await waitFor(() => expect(runButton().disabled).toBe(false));
  });

  it("a status that cannot be read keeps the last one, says so, and tries again", async () => {
    jobAnswers.push(() => json({ job: jobRow({ status: "running" }) }));
    jobAnswers.push(() => new Response("{}", { status: 503 }));
    const panel = await runWith(jobRow({ status: "running" }));
    await within(panel).findByText(en.regionEdit.jobRunning);
    await within(panel).findByText(en.regionEdit.jobStale, undefined, { timeout: 6000 });
    expect(within(panel).getByText(en.regionEdit.jobRunning)).toBeTruthy();
  }, 15000);
});

describe("a refresh in the middle of a job", () => {
  it("finds the job named in the address and the picture it was started from", async () => {
    window.history.replaceState(null, "", `/?job=${JOB}`);
    jobAnswers.push(() => json({ job: jobRow({ status: "running" }) }));
    jobAnswers.push(() => json({ job: jobRow({ status: "running" }) }));
    render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
    const panel = await screen.findByTestId("run-result");
    await within(panel).findByText(en.regionEdit.jobRunning);
    await waitFor(() => expect(calls.some((c) => c.url === `/api/media/${PIC}`)).toBe(true));
    expect(runButton().disabled).toBe(true);
  });

  it("ignores an address that is not a job id, and says so for a job that is gone", async () => {
    window.history.replaceState(null, "", "/?job=../../etc");
    render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
    expect(screen.queryByTestId("run-result")).toBeNull();
    cleanup();
    window.history.replaceState(null, "", `/?job=${JOB}`);
    jobAnswers.push(() => new Response("{}", { status: 404 }));
    render(<RegionEditor orgId={ORG} models={models} libraryHref="/x/library" />);
    expect(screen.queryByTestId("run-result")).toBeNull();
  });
});

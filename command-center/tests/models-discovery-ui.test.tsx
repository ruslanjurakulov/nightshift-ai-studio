// @vitest-environment jsdom
/**
 * The Models catalog on screen (components/models/ModelDiscovery).
 *
 * What would break without these: an unpriced model drawn as "0 cr", a "Use
 * in Studio" link that loses the channel, the tool or the model, a search or
 * a task key that hides what it should show, an empty result with no way
 * back, and a picked model whose detail never appears.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { NO_FILTERS, fromAdminRow, fromSellableRow, type DiscoveryModel } from "../lib/models-discovery";
import { PROVIDER_BRANDS } from "./helpers/brands";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/chronos${s}` }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const { ModelDiscovery } = await import("../components/models/ModelDiscovery");

const c = en.modelDiscovery;

const video = fromSellableRow(
  {
    id: "vid-a",
    display_name: "Vid A",
    provider: "bytedance",
    capabilities: ["t2v", "i2v"],
    availability: "beta",
    verified_at: "2026-09-30T10:00:00Z",
    credit_unit: "u_vid",
    entitlement: null,
    credits_per_unit: 3,
    spec: { output: "video", aspect_ratios: ["16:9"], durations_s: [5, 10], resolutions: ["720p"], unit: "second", limits: { max_prompt_chars: 2000 } },
  },
  { u_vid: 3 },
)!;
const speech = fromSellableRow(
  {
    id: "tts-a",
    display_name: "Talk A",
    provider: "elevenlabs",
    capabilities: ["tts"],
    availability: "ga",
    verified_at: "2026-09-30T10:00:00Z",
    credit_unit: "u_tts",
    entitlement: null,
    credits_per_unit: 1,
    // A model limit far above the database's 4000-character cap.
    spec: { output: "audio", unit: "character", limits: { max_prompt_chars: 40000 } },
  },
  // The list was read and has no row for it: unpriced, never 0.
  {},
)!;
// As 36 of the registry's 38 models are today: an entitlement the database refuses for every workspace.
const basic = fromSellableRow(
  {
    id: "img-n",
    display_name: "Pic N",
    provider: "openai",
    capabilities: ["t2i"],
    availability: "ga",
    verified_at: "2026-09-30T10:00:00Z",
    credit_unit: "u_img",
    entitlement: "models_image:basic",
    credits_per_unit: 6,
    spec: { output: "image", aspect_ratios: ["1:1", "16:9"], unit: "image", limits: { max_prompt_chars: 4000 } },
  },
  { u_img: 6 },
)!;

function mount(models: DiscoveryModel[] = [video, speech, basic], operator = false, filters?: Partial<typeof NO_FILTERS>) {
  return render(
    <ModelDiscovery models={models} operator={operator} pricesRead probesRead initialFilters={{ ...NO_FILTERS, ...filters }} />,
  );
}

afterEach(() => cleanup());

describe("ModelDiscovery", () => {
  it("prints each model as a frame with its state and rate — an unknown rate in words, never 0", () => {
    mount();
    const vid = screen.getByRole("button", { name: `Details: Vid A` });
    expect(within(vid).getByText(c.states.available)).toBeTruthy();
    const tts = screen.getByRole("button", { name: `Details: Talk A` });
    expect(within(tts).getByText(c.notPriced)).toBeTruthy();
    expect(tts.textContent).not.toMatch(/\b0\s*(cr|credits)/);
    expect(document.body.textContent).not.toMatch(/(^|\s)0 cr/);
  });

  it("names no provider to a customer — not on a frame, in the pane, or through search", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details: Vid A" }));
    // Display names are the Studio's own words; everything else on the screen is checked for brands.
    let text = document.body.textContent ?? "";
    for (const name of ["Vid A", "Talk A", "Pic N"]) text = text.split(name).join("");
    expect(text).not.toMatch(PROVIDER_BRANDS);
    expect(text).not.toContain("vid-a");
    fireEvent.change(screen.getByRole("searchbox", { name: c.searchLabel }), { target: { value: "bytedance" } });
    expect(screen.getByText(c.emptyFiltered)).toBeTruthy();
  });

  it("names the provider to the operator", () => {
    mount([video], true);
    const vid = screen.getByRole("button", { name: `Details: Vid A` });
    expect(within(vid).getByText("ByteDance")).toBeTruthy();
  });

  it("says 'not open to your workspace yet' for a models_*:basic model, names no tier, and offers no Studio link", () => {
    mount();
    const frame = screen.getByRole("button", { name: "Details: Pic N" });
    expect(within(frame).getByText(c.states.unavailable)).toBeTruthy();
    expect(screen.queryByRole("link", { name: `${c.useInStudio}: Pic N` })).toBeNull();
    fireEvent.click(frame);
    const pane = screen.getByRole("complementary", { name: c.details });
    expect(within(pane).getByText(c.reasons.not_open)).toBeTruthy();
    expect(pane.textContent).not.toMatch(/basic|premium|top-tier/i);
    expect(within(pane).queryAllByRole("link")).toHaveLength(0);
    expect(within(pane).getByText(c.notOffered)).toBeTruthy();
  });

  it("links an open model to the Studio with the channel, the tool and the model", () => {
    mount();
    const link = screen.getByRole("link", { name: `${c.useInStudio}: Vid A` });
    expect(link.getAttribute("href")).toBe("/chronos/create?tool=t2v&model=vid-a");
  });

  it("narrows by task: the task's own link comes first", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${c.tasks.video_image}`) }));
    expect(screen.queryByRole("button", { name: "Details: Talk A" })).toBeNull();
    expect(screen.getByRole("link", { name: `${c.useInStudio}: Vid A` }).getAttribute("href")).toBe("/chronos/create?tool=i2v&model=vid-a");
  });

  it("makes the task keys one tab stop that arrows move along", () => {
    mount();
    const keys = within(screen.getByRole("group", { name: c.tasksLabel })).getAllByRole("button");
    expect(keys.filter((k) => k.tabIndex === 0)).toHaveLength(1);
    keys[0].focus();
    fireEvent.keyDown(keys[0], { key: "ArrowRight" });
    expect(keys[1].getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(keys[1]);
  });

  it("hides a customer's zero-model task keys, and keeps them for the operator", () => {
    mount();
    const group = () => screen.getByRole("group", { name: c.tasksLabel });
    expect(within(group()).queryByRole("button", { name: new RegExp(`^${c.tasks.remove_bg}`) })).toBeNull();
    expect(within(group()).queryByRole("button", { name: new RegExp(`^${c.tasks.captions}`) })).toBeNull();
    cleanup();
    mount(undefined, true);
    expect(within(group()).getByRole("button", { name: new RegExp(`^${c.tasks.remove_bg}`) })).toBeTruthy();
  });

  it("searches, says when nothing matches, and clears back to everything", () => {
    mount();
    const box = screen.getByRole("searchbox", { name: c.searchLabel });
    fireEvent.change(box, { target: { value: "talk" } });
    expect(screen.queryByRole("button", { name: "Details: Vid A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Details: Talk A" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "nothing-like-this" } });
    expect(screen.getByText(c.emptyFiltered)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: c.clearFilters }));
    expect(screen.getByRole("button", { name: "Details: Vid A" })).toBeTruthy();
  });

  it("says a task nothing is open for is empty, in words a customer reads (no 'registry')", () => {
    mount(undefined, false, { task: "remove_bg" });
    expect(screen.getByText(c.emptyTaskCustomer)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/registry/i);
    cleanup();
    mount(undefined, true, { task: "remove_bg" });
    expect(screen.getByText(c.emptyTask)).toBeTruthy();
  });

  it("prints a tiny real rate as itself, not rounded to 0", () => {
    const voice = fromSellableRow(
      {
        id: "tts-b",
        display_name: "Talk B",
        provider: "elevenlabs",
        capabilities: ["tts"],
        availability: "ga",
        verified_at: "2026-09-30T10:00:00Z",
        credit_unit: "u_tts_b",
        credits_per_unit: 0.004,
        spec: { output: "audio", unit: "character", limits: {} },
      },
      { u_tts_b: 0.004 },
    )!;
    mount([voice]);
    const frame = screen.getByRole("button", { name: "Details: Talk B" });
    expect(frame.textContent).toContain("0.004");
  });

  it("filters by availability with real states only, and offers no plan-tier filter", () => {
    mount();
    const select = screen.getByLabelText(c.stateLabel) as HTMLSelectElement;
    // A customer is offered the states their models have, not ones that cannot occur.
    expect([...select.options].map((o) => o.value)).toEqual(["all", "available", "unavailable"]);
    fireEvent.change(select, { target: { value: "available" } });
    expect(screen.queryByRole("button", { name: "Details: Pic N" })).toBeNull();
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
  });

  it("reads the picked model in full: settings, rate and the Studio action", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details: Vid A" }));
    const pane = screen.getByRole("complementary", { name: c.details });
    expect(within(pane).getByRole("heading", { name: "Vid A" })).toBeTruthy();
    expect(within(pane).getByText("0:05")).toBeTruthy();
    expect(within(pane).getByText("0:10")).toBeTruthy();
    expect(within(pane).getByText("Words, up to 2,000 characters")).toBeTruthy();
    expect(within(pane).getByText(c.inPicture)).toBeTruthy();
    const actions = within(pane).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(actions).toEqual(["/chronos/create?tool=t2v&model=vid-a", "/chronos/create?tool=i2v&model=vid-a"]);
  });

  it("caps the words a model takes at the database's 4000 characters", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details: Talk A" }));
    const pane = screen.getByRole("complementary", { name: c.details });
    expect(within(pane).getByText("Words, up to 4,000 characters")).toBeTruthy();
    expect(pane.textContent).not.toContain("40,000");
  });

  it("shows the operator a model that needs a probe, with the reason", () => {
    const row = fromAdminRow(
      {
        id: "img-a",
        displayName: "Img A",
        provider: "openai",
        capabilities: ["t2i"],
        availability: "hidden",
        verifiedAt: null,
        creditUnit: "u_img",
        entitlement: null,
        termsGate: null,
        removedFromFile: false,
        publicSpec: { output: "image", unit: "image" },
      },
      null,
      { u_img: 4 },
    );
    mount([row], true);
    fireEvent.click(screen.getByRole("button", { name: "Details: Img A" }));
    const pane = screen.getByRole("complementary", { name: c.details });
    expect(within(pane).getByText(c.reasons.not_verified)).toBeTruthy();
    expect(within(pane).getAllByText(c.states.needs_probe).length).toBeGreaterThan(0);
    // An unproven model is never sent to the Studio, from its frame or its pane.
    expect(screen.queryAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/"))).toHaveLength(0);
    expect(within(pane).getByText(c.notOffered)).toBeTruthy();
  });
});

describe("copy", () => {
  it("is complete in all three languages", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p];
    expect(keys(ru.modelDiscovery)).toEqual(keys(en.modelDiscovery));
    expect(keys(uz.modelDiscovery)).toEqual(keys(en.modelDiscovery));
    for (const d of [en, ru, uz]) for (const v of keys(d.modelDiscovery)) expect(v).toBeTruthy();
    for (const d of [ru, uz]) {
      const flat = JSON.stringify(d.modelDiscovery);
      expect(flat).not.toMatch(/\{(?!n\}|total\}|task\}|model\}|mb\}|length\}|res\}|when\}|code\}|gate\}|key\})[a-z]+\}/);
    }
  });
});

describe("the not-open fold", () => {
  it("leads a customer's catalog with what they can use and folds the rest, closed, under 'Not open yet'", () => {
    mount();
    const fold = screen.getByText(c.notOpenGroup).closest("details")!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByRole("button", { name: "Details: Pic N" })).toBeTruthy();
    expect(within(fold).queryByRole("button", { name: "Details: Vid A" })).toBeNull();
    expect(document.body.textContent).toContain(c.notOpenHint);
  });

  it("opens the fold when nothing is open, and does not fold for the operator or an 'unavailable' filter", () => {
    mount([basic]);
    expect(screen.getByText(c.notOpenGroup).closest("details")!.open).toBe(true);
    cleanup();
    mount(undefined, true);
    expect(screen.queryByText(c.notOpenGroup)).toBeNull();
    cleanup();
    mount(undefined, false, { state: "unavailable" });
    expect(screen.queryByText(c.notOpenGroup)).toBeNull();
    expect(screen.getByRole("button", { name: "Details: Pic N" })).toBeTruthy();
  });
});

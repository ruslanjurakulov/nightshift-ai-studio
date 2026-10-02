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
import { fromAdminRow, fromSellableRow, type DiscoveryModel } from "../lib/models-discovery";

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (s: string) => `/chronos${s}` }));
vi.mock("next/link", () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: React.ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
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
    entitlement: "models_video:premium",
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
    spec: { output: "audio", unit: "character", limits: { max_prompt_chars: 3000 } },
  },
  // The list was read and has no row for it: unpriced, never 0.
  {},
)!;

function mount(models: DiscoveryModel[] = [video, speech], operator = false) {
  return render(<ModelDiscovery models={models} operator={operator} pricesRead probesRead />);
}

afterEach(() => cleanup());

describe("ModelDiscovery", () => {
  it("prints each model as a frame with its provider, state and rate — an unknown rate in words, never 0", () => {
    mount();
    const vid = screen.getByRole("button", { name: `Details: Vid A` });
    expect(within(vid).getByText("ByteDance")).toBeTruthy();
    expect(within(vid).getByText(c.states.plan_gated)).toBeTruthy();
    const tts = screen.getByRole("button", { name: `Details: Talk A` });
    expect(within(tts).getByText(c.notPriced)).toBeTruthy();
    expect(tts.textContent).not.toMatch(/\b0\s*(cr|credits)/);
    expect(document.body.textContent).not.toMatch(/(^|\s)0 cr/);
  });

  it("links each frame to the Studio with the channel, the tool and the model", () => {
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

  it("searches, says when nothing matches, and clears back to everything", () => {
    mount();
    const box = screen.getByRole("searchbox", { name: c.searchLabel });
    fireEvent.change(box, { target: { value: "elevenlabs" } });
    expect(screen.queryByRole("button", { name: "Details: Vid A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Details: Talk A" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "nothing-like-this" } });
    expect(screen.getByText(c.emptyFiltered)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: c.clearFilters }));
    expect(screen.getByRole("button", { name: "Details: Vid A" })).toBeTruthy();
  });

  it("says a task no model does is empty, rather than showing nothing", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${c.tasks.remove_bg}`) }));
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

  it("filters by availability and plan with real states only", () => {
    mount();
    const select = screen.getByLabelText(c.stateLabel) as HTMLSelectElement;
    // A customer is offered the states their models have, not ones that cannot occur.
    expect([...select.options].map((o) => o.value)).toEqual(["all", "available", "plan_gated"]);
    fireEvent.change(select, { target: { value: "available" } });
    expect(screen.queryByRole("button", { name: "Details: Vid A" })).toBeNull();
    fireEvent.change(screen.getByLabelText(c.planLabel), { target: { value: "premium" } });
    expect(screen.getByText(c.emptyFiltered)).toBeTruthy();
  });

  it("reads the picked model in full: settings, plan gate, rate and the Studio action", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Details: Vid A" }));
    const pane = screen.getByRole("complementary", { name: c.details });
    expect(within(pane).getByRole("heading", { name: "Vid A" })).toBeTruthy();
    expect(within(pane).getByText("Needs plan access: premium video models.")).toBeTruthy();
    expect(within(pane).getByText("0:05")).toBeTruthy();
    expect(within(pane).getByText("0:10")).toBeTruthy();
    expect(within(pane).getByText("Words, up to 2,000 characters")).toBeTruthy();
    expect(within(pane).getByText(c.inPicture)).toBeTruthy();
    const actions = within(pane).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(actions).toEqual(["/chronos/create?tool=t2v&model=vid-a", "/chronos/create?tool=i2v&model=vid-a"]);
    expect(within(pane).getByText(new RegExp(c.gatedNote))).toBeTruthy();
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
    expect(screen.queryAllByRole("link")).toHaveLength(0);
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
      expect(flat).not.toMatch(/\{(?!n\}|total\}|task\}|model\}|mb\}|length\}|res\}|when\}|code\}|gate\}|feature\}|key\}|tier\})[a-z]+\}/);
    }
  });
});

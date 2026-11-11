// @vitest-environment jsdom
/**
 * Editor follow-ups after parity 2a:
 *  * a split never leaves a piece shorter than one frame at the clip's speed (`minPieceS`, in `canSplit` and in
 *    the silence cuts): at 10x a frame is a third of a second of source, and a shorter piece was refused at save;
 *  * silence cuts are split at their source times, so at every speed every proposed cut is applied;
 *  * an organization chosen on the editor's page is switched by a form-post NAVIGATION (app/api/org/switch;
 *    tests/org-switch-route.test.ts has the route): the editor's unsaved-changes prompt runs first, and a cancel
 *    sends nothing.
 * (The Back arrow and the section shell's way home go through navigate(): tests/editor-nav.test.tsx's source test.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => window.location.pathname,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { ContextSwitcher } from "@/components/shell/ContextSwitcher";
import { formNav } from "@/lib/context-switch";
import { OrgSwitcher } from "@/components/org/OrgSwitcher";
import { documentNav } from "@/lib/editor-nav";
import {
  MIN_CLIP_S,
  canSplit,
  minPieceS,
  newDocForAsset,
  setSpeed,
  splitClip,
  toDoc,
  toModel,
  validateTimeline,
  type EditorModel,
} from "@/lib/editor";
import { applyCuts, proposeCuts } from "@/lib/editorSilence";
import { SPEEDS } from "@/lib/editor";
import type { OrgSummary } from "@/lib/orgs";

const A = "11111111-1111-4111-8111-111111111111";
const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const model = (speed: number, durationS = 60): EditorModel => {
  const m = toModel(newDocForAsset({ id: A, durationS, width: 1920, height: 1080 })!);
  return setSpeed({ ...m, clips: m.clips.map((c) => ({ ...c, audio: true })) }, m.clips[0].id, speed);
};

describe("the shortest piece a split leaves", () => {
  it("is MIN_CLIP_S, or one frame at the clip's speed when that is longer", () => {
    expect(minPieceS({ speed: 1 }, 30)).toBe(MIN_CLIP_S);
    expect(minPieceS({ speed: 3 }, 30)).toBe(MIN_CLIP_S);
    expect(minPieceS({ speed: 10 }, 30)).toBeCloseTo(1 / 3, 9);
    expect(minPieceS({ speed: 10 }, 60)).toBeCloseTo(1 / 6, 9);
  });

  it("canSplit refuses a 10x cut that would leave less than a frame, and the split it allows validates", () => {
    const m = model(10);
    const id = m.clips[0].id;
    // 0.02 s of timeline at 10x is 0.2 s of source: over MIN_CLIP_S but under one frame (0.333 s)
    expect(canSplit(m, id, 0.02)).toBe(false);
    expect(canSplit(m, id, 0.034)).toBe(true);
    const r = splitClip(m, id, 0.034)!;
    expect(validateTimeline(toDoc(r.model))).toEqual([]);
  });

  it("silence cuts on fast clips leave no piece under a frame, and applying them validates", () => {
    for (const speed of [4, 6, 10]) {
      const m = model(speed, 60);
      const c = m.clips[0];
      const silences: [number, number][] = [];
      for (let s = 0.15; s < 59; s += 1.37) silences.push([s, s + 0.9]);
      const cuts = proposeCuts(c, silences, m.fps);
      const min = minPieceS(c, m.fps);
      let prev = c.in_s;
      for (const [a, b] of cuts) {
        if (a > c.in_s) expect(a - prev).toBeGreaterThanOrEqual(min - 1e-9);
        prev = b;
      }
      const out = applyCuts(m, c.id, cuts);
      expect(out.applied, String(speed)).toBe(cuts.length);
      expect(validateTimeline(toDoc(out.model)), String(speed)).toEqual([]);
    }
  });
});

const ORGS: OrgSummary[] = [
  { id: "o1", name: "First", slug: "first", role: "owner", is_default: true },
  { id: "o2", name: "Second", slug: "second", role: "owner", is_default: false },
] as OrgSummary[];

describe("every proposed cut is applied, at every speed", () => {
  it("the review's case: 15 s at 6x and 30 fps, two cuts, both applied", () => {
    const m = model(6, 15);
    const c = m.clips[0];
    const cuts = proposeCuts(c, [[1, 2], [2, 3]], 30);
    const out = applyCuts(m, c.id, cuts);
    expect(out).toMatchObject({ applied: cuts.length, stopped: null });
    expect(validateTimeline(toDoc(out.model))).toEqual([]);
  });

  it("a seeded property: random silences on clips at every speed and rate", () => {
    let seed = 679;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let total = 0;
    for (let i = 0; i < 600; i += 1) {
      const speed = SPEEDS[Math.floor(rnd() * SPEEDS.length)];
      const fps = [24, 25, 30, 50, 60][Math.floor(rnd() * 5)];
      const m0 = model(speed, 40);
      const m = { ...m0, fps };
      const c = m.clips[0];
      const silences: [number, number][] = [];
      for (let at = c.in_s + rnd(); at < c.out_s; at += 0.3 + rnd() * 3) {
        const e = at + 0.2 + rnd() * 2;
        silences.push([Math.round(at * 1000) / 1000, Math.round(e * 1000) / 1000]);
        at = e;
      }
      const cuts = proposeCuts(c, silences, fps);
      const out = applyCuts(m, c.id, cuts);
      if (out.stopped === "full") continue;
      expect({ applied: out.applied, stopped: out.stopped, cuts: JSON.stringify(cuts), clips: out.model.clips.length }, `case ${i} at ${speed}x ${fps} fps`).toMatchObject({ applied: cuts.length, stopped: null });
      expect(validateTimeline(toDoc(out.model)), `case ${i}`).toEqual([]);
      total += cuts.length;
    }
    expect(total).toBeGreaterThan(1000);
  });

  it("says why it stopped: the clip limit, or a piece the rules refuse", () => {
    const m = model(1, 40);
    const c = m.clips[0];
    // hand-made cuts (proposeCuts would never make this one): 0.05 s is less than a clip may be
    expect(applyCuts(m, c.id, [[1, 1.05]])).toMatchObject({ applied: 0, stopped: "piece" });
    const many: [number, number][] = Array.from({ length: 80 }, (_, k) => [0.3 + k * 0.45, 0.5 + k * 0.45]);
    expect(applyCuts(m, c.id, many)).toMatchObject({ stopped: "full" });
  });

  it("two cuts closer than a frame at the clip's speed become one (nothing under a frame is left between)", () => {
    // at 10x / 30 fps a frame is 0.333 s of source; between [1.1, 1.9] and [2.15, 2.9] only 0.25 s would be left
    expect(proposeCuts({ in_s: 0, out_s: 10, speed: 10 }, [[1, 2], [2.05, 3]], 30)).toEqual([[1.1, 2.9]]);
    expect(proposeCuts({ in_s: 0, out_s: 10, speed: 1 }, [[1, 2], [2.05, 3]], 30)).toEqual([[1.1, 1.9], [2.15, 2.9]]);
  });
});

describe("switching organization from the editor's page", () => {
  const submit = vi.fn();
  const assign = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    refresh.mockReset();
    push.mockReset();
    submit.mockReset();
    assign.mockReset();
    vi.spyOn(formNav, "submit").mockImplementation(submit);
    vi.spyOn(documentNav, "assign").mockImplementation(assign);
    fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    document.querySelectorAll("form[action='/api/org/switch']").forEach((f) => f.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });
  const mountPhone = () =>
    render(
      <I18nProvider locale="en">
        <ContextSwitcher orgs={ORGS} currentOrgId="o1" channels={[]} selection={"all" as never} />
      </I18nProvider>,
    );
  const sent = () => {
    expect(submit).toHaveBeenCalledTimes(1);
    const form = submit.mock.calls[0][0] as HTMLFormElement;
    return { method: form.method, action: new URL(form.action).pathname, orgId: new FormData(form).get("orgId") };
  };

  it("the phone switcher: a form post that IS the navigation, and no switch asked for before it", () => {
    window.history.replaceState({}, "", `/chronos/editor/${PID}`);
    mountPhone();
    fireEvent.click(document.querySelector("[data-context-switcher]") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(sent()).toEqual({ method: "post", action: "/api/org/switch", orgId: "o2" });
    // a cancelled prompt sends nothing: nothing was asked of the server ahead of the navigation
    expect(fetchMock).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("the desktop switcher does the same on the editor's page", () => {
    window.history.replaceState({}, "", `/chronos/editor/${PID}`);
    render(
      <I18nProvider locale="en">
        <OrgSwitcher orgs={ORGS} currentId="o1" />
      </I18nProvider>,
    );
    fireEvent.click(screen.getAllByRole("button")[0]);
    fireEvent.click(screen.getByRole("option", { name: /Second/ }));
    expect(sent()).toEqual({ method: "post", action: "/api/org/switch", orgId: "o2" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("away from the editor both switch at once, as before, and refresh the client transition", async () => {
    window.history.replaceState({}, "", "/chronos/analytics");
    mountPhone();
    fireEvent.click(document.querySelector("[data-context-switcher]") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/all-channels"));
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/org/select")).toBe(true);
    expect(refresh).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

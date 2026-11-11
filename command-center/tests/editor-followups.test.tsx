// @vitest-environment jsdom
/**
 * Editor follow-ups after parity 2a:
 *  * a split never leaves a piece shorter than one frame at the clip's speed (`minPieceS`, in `canSplit` and in
 *    the silence cuts): at 10x a frame is a third of a second of source, and a shorter piece was refused at save;
 *  * an organization chosen on the editor's page is switched on the NEW page, after the full load committed: a
 *    person who cancels the editor's unsaved-changes prompt stays on a page whose session is still its own.
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
import { PENDING_ORG_TTL_MS, applyPendingOrganizationSwitch, deferOrganizationSwitch } from "@/lib/context-switch";
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

describe("switching organization from the editor's page", () => {
  const assign = vi.fn();
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sessionStorage.clear();
    refresh.mockReset();
    push.mockReset();
    assign.mockReset();
    vi.spyOn(documentNav, "assign").mockImplementation(assign);
    fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });
  const mount = () =>
    render(
      <I18nProvider locale="en">
        <ContextSwitcher orgs={ORGS} currentOrgId="o1" channels={[]} selection={"all" as never} />
      </I18nProvider>,
    );
  const pick = (name: string) => {
    fireEvent.click(document.querySelector("[data-context-switcher]") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
  };

  it("asks the server nothing until the new page has loaded, so a cancelled prompt changes nothing", async () => {
    window.history.replaceState({}, "", `/chronos/editor/${PID}`);
    mount();
    pick("Second");
    expect(assign).toHaveBeenCalledWith("/all-channels");
    // the person cancels the editor's prompt: the old page stays, and its session is still the first org's
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/org/select")).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it("the new page makes the switch and refreshes; a later load does not repeat it", async () => {
    window.history.replaceState({}, "", `/chronos/editor/${PID}`);
    deferOrganizationSwitch("o2", "/all-channels");
    window.history.replaceState({}, "", "/all-channels");
    mount();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const calls = fetchMock.mock.calls.filter(([u]) => String(u) === "/api/org/select");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String((calls[0][1] as RequestInit).body))).toEqual({ orgId: "o2" });
    expect(await applyPendingOrganizationSwitch("/all-channels")).toBe(false);
  });

  it("a kept switch for another page, or an old one, is dropped without asking the server", async () => {
    deferOrganizationSwitch("o2", "/all-channels", 1000);
    expect(await applyPendingOrganizationSwitch(`/chronos/editor/${PID}`, 1001)).toBe(false);
    deferOrganizationSwitch("o2", "/all-channels", 1000);
    expect(await applyPendingOrganizationSwitch("/all-channels", 1000 + PENDING_ORG_TTL_MS + 1)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("away from the editor it switches at once, as before, and refreshes the client transition", async () => {
    window.history.replaceState({}, "", "/chronos/analytics");
    mount();
    pick("Second");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/all-channels"));
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/org/select")).toBe(true);
    expect(refresh).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});

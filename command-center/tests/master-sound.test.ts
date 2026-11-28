/**
 * The finished file's sound record (lib/studio/masterSound.ts). What would break without these: a master made before S2 (no record)
 * shown as if its sound were checked, a dynamic normalisation read as linear, "already paid for" lost for a muted paid shot, or a
 * record of another file shown on this one.
 */
import { describe, expect, it } from "vitest";
import { coerceMasterSound } from "../lib/studio/masterSound";
import { coerceFilmLive, filmGraph } from "../lib/studio/liveGraph";
import { FILM, S1, filmJson, sceneJson } from "./films-fixtures";

const rec = (over: Record<string, unknown> = {}) => ({
  mix_format: 2, status: "mastered", clip_stem_shots: 0,
  master_loudness: { mode: "linear", status: "linear", measured: { I: -15.2, TP: -9.9, LRA: 5, thresh: -25.8 } },
  scenes: [], ...over,
});

describe("coerceMasterSound", () => {
  it("no record, an older mix or junk is unknown, never normal", () => {
    for (const raw of [null, undefined, {}, "x", rec({ mix_format: 1 }), rec({ master_loudness: null }), rec({ status: "other" })]) {
      expect(coerceMasterSound(raw)).toEqual({ state: "unknown" });
    }
  });

  it("a project without sound says so", () => {
    expect(coerceMasterSound(rec({ status: "no sound", master_loudness: null }))).toEqual({ state: "none" });
  });

  it("reads the mode and the measured numbers as recorded", () => {
    expect(coerceMasterSound(rec())).toEqual({ state: "ready", mode: "linear", measured: { i: -15.2, tp: -9.9, lra: 5 }, paidUnused: 0, defaultUnused: 0 });
    const dyn = coerceMasterSound(rec({ master_loudness: { mode: "dynamic", status: "dynamic (linear not possible)", measured: { I: -18, TP: null, LRA: 14 } } }));
    expect(dyn).toMatchObject({ mode: "dynamic", measured: { i: -18, tp: null, lra: 14 } });
    const silent = coerceMasterSound(rec({ master_loudness: { mode: null, status: "not applied: the mix is silent", measured: {} } }));
    expect(silent).toMatchObject({ mode: "silent" });
  });

  it("counts paid sound not played and default-muted sound apart", () => {
    const s = coerceMasterSound(rec({ scenes: [
      { scene: 1, role: "muted", source: "chosen", clip_sound: ["muted", "used"], sound_paid: [true, true], file_sound: [true, true] },
      { scene: 2, role: "muted", source: "default", clip_sound: ["muted", "no sound in the file", "lip-synced"], sound_paid: [false, false, true], file_sound: [true, false, null] },
    ] }));
    expect(s).toMatchObject({ paidUnused: 1, defaultUnused: 1 });
  });
});

describe("the final node", () => {
  const MP4 = "f1000000-0000-4000-8000-0000000000f1";
  const seg = { id: "s", status: "settled", assembly_status: "completed", assembly_asset_id: MP4, created_at: "2026-11-21T00:00:00Z" };
  const final = (master: unknown) => filmGraph(coerceFilmLive({ film: filmJson({ status: "ready" }, [sceneJson(S1, 0)]), segments: [seg], takes: [], master })!)
    .nodes.find((n) => n.id === "final")!;

  it("carries its own file's record, and unknown for another file's or none", () => {
    expect(final({ asset_id: MP4, sound: rec() }).sound).toMatchObject({ state: "ready", mode: "linear" });
    expect(final({ asset_id: "a0000000-0000-4000-8000-000000000000", sound: rec() }).sound).toEqual({ state: "unknown" });
    expect(final(null).sound).toEqual({ state: "unknown" });
    expect(FILM).toBeTruthy();
  });
});

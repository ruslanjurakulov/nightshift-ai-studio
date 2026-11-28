import { describe, expect, it } from "vitest";
import { look, storyBrief } from "./helpers/fakeSheetsDb";
import {
  REF_BYTES_MAX, SHEETS_MAX, filmLinkOf, mergeConcurrent, readSheetBrief, readSheets, withRefLine, carrySheets, mergeSheets, planSheets, refCapabilitiesOf, refGate, selectRefs, sheetPrompt, wantedView,
  type AssetFacts, type RefSheet,
} from "@/lib/brain/ref-sheets";
import { keyframePrompt, type BriefCharacter, type BriefScene } from "@/lib/brain/logic";
import { dictionaries } from "@/lib/i18n";

/**
 * The pure half of character sheets (lib/brain/ref-sheets). What would break without these: a sheet drawn from different words than
 * the scenes it steers (so the face in the sheet is not the face in the film); a child's scene steered by the adult's sheet; two
 * views of one character in one key frame; more pictures than the model takes; "Image N" numbers that do not match what the model
 * receives; and the gate opening on a guess.
 */

const b = storyBrief();
const mira = b.characters![0];
const tom = b.characters![1];
const A = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

function approved(sheets: RefSheet[]): { sheets: RefSheet[]; assets: Map<string, AssetFacts> } {
  let n = 0;
  const assets = new Map<string, AssetFacts>();
  const out = sheets.map((s) => ({ ...s, views: s.views.map((v) => {
    n += 1;
    assets.set(A(n), { bytes: 1_000_000, mime: "image/png" });
    return { ...v, status: "approved" as const, asset_id: A(n) };
  }) }));
  return { sheets: out, assets };
}
const budget = { offset: 0, offsetBytes: 0, maxPictures: 14 };

describe("the sheet plan", () => {
  it("plans front, side and back per character and per age stage", () => {
    const plan = planSheets(b);
    expect(plan.map((s) => `${s.character_id}:${s.stage}`)).toEqual(["c1:a1", "c1:a2", "c2:null"]);
    expect(plan.every((s) => s.views.map((v) => v.view).join() === "front,side,back")).toBe(true);
    expect(plan.flatMap((s) => s.views).every((v) => v.status === "planned" && v.asset_id === null)).toBe(true);
  });

  it("folds the stage's look in verbatim, the same words as the key-frame prompt, with the style, a white background and 16:9", () => {
    const front = sheetPrompt(b, mira, "a1", "front");
    expect(front).toContain("full-body, front-view portrait of character Mira (child)");
    expect(front).toContain("pure white background");
    expect(front).toContain("wide 16:9 landscape canvas");
    expect(front).toContain("Standing with arms relaxed at sides");
    for (const part of Object.values(look("Mira child"))) expect(front).toContain(part);
    expect(front).not.toContain("Mira adult face");
    expect(front).toContain("Style: soft watercolour, warm light");
    // The exact line every key frame of a scene with child Mira says.
    const line = front.split("\n").find((l) => l.startsWith("Features: "))!.slice("Features: ".length);
    expect(keyframePrompt(b, { ...b.scenes![0], in_frame: [{ character_id: "c1", age_stage: "a1" }] })).toContain(line);
    expect(sheetPrompt(b, mira, "a1", "side")).toContain("Facing left");
    expect(sheetPrompt(b, mira, "a1", "back")).toContain("No facial features should be visible");
    expect(sheetPrompt(b, tom, null, "front")).toContain("character Tom based on");
  });

  it("keeps what was made when the look is unchanged, and starts a view again (with a new attempt) when it changed", () => {
    const made = approved(planSheets(b)).sheets;
    expect(mergeSheets(made, planSheets(b))).toEqual(made);
    const changed = { ...b, characters: [mira, { ...tom, look: look("Tom older") } as BriefCharacter] };
    const merged = mergeSheets(made.map((s) => ({ ...s, views: s.views.map((v) => ({ ...v, job_id: "dddddddd-0000-4000-8000-000000000001" })) })), planSheets(changed));
    const t = merged.find((s) => s.character_id === "c2")!.views[0];
    expect(t).toMatchObject({ status: "planned", asset_id: null, attempt: 1 });
    expect(merged.find((s) => s.character_id === "c1")!.views[0].status).toBe("approved");
  });

  it("carries the stored sheets through a re-save of the BRIEF, and nothing when there are none", () => {
    const made = approved(planSheets(b)).sheets;
    expect(carrySheets({ ref_sheets: made }).ref_sheets).toHaveLength(3);
    expect(carrySheets({})).toEqual({});
    expect(carrySheets({ ref_sheets: [{ character_id: "x y", stage: null, views: [] }] })).toEqual({});
  });
});

describe("the per-scene selector", () => {
  const { sheets, assets } = approved(planSheets(b));
  const scene = (o: Partial<BriefScene>): BriefScene => ({ ...b.scenes![0], ...o });

  it("one view per in-frame character, at its stage, named Image N in order", () => {
    const sel = selectRefs(b, sheets, b.scenes![0], budget, assets);
    expect(sel.picks.map((p) => `${p.character_id}:${p.stage}:${p.view}:${p.image}`)).toEqual(["c1:a1:front:0", "c2:null:front:1"]);
    expect(sel.refs).toEqual(sel.picks.map((p) => ({ kind: "character", asset_id: p.asset_id })));
    expect(sel.line).toBe("Reference pictures: Mira (child) should reference Image 0. Tom should reference Image 1.");
    const adult = selectRefs(b, sheets, b.scenes![1], budget, assets);
    expect(adult.picks).toEqual([expect.objectContaining({ character_id: "c1", stage: "a2", view: "back", wanted: "back" })]);
  });

  it("counts Image N after the film's own pictures, which the model receives first", () => {
    const sel = selectRefs(b, sheets, b.scenes![0], { offset: 3, offsetBytes: 0, maxPictures: 14 }, assets);
    expect(sel.picks.map((p) => p.image)).toEqual([3, 4]);
    expect(sel.line).toContain("Image 3");
  });

  it("reads the facing from the camera position or the first frame, else the front", () => {
    expect(wantedView({ camera: { position: "in profile, eye level", move: "static" } })).toBe("side");
    expect(wantedView({ first_frame: "Mira seen from behind at the window" })).toBe("back");
    expect(wantedView({ camera: { position: "eye level", move: "pan" }, first_frame: "Mira smiles" })).toBe("front");
  });

  it("uses the front when the wanted view is not approved, and says so; never another stage's sheet", () => {
    const noBack = sheets.map((s) => ({ ...s, views: s.views.map((v) => (v.view === "back" ? { ...v, status: "ready" as const } : v)) }));
    const sel = selectRefs(b, noBack, b.scenes![1], budget, assets);
    expect(sel.picks[0]).toMatchObject({ wanted: "back", view: "front", stage: "a2" });
    const noAdult = sheets.filter((s) => s.stage !== "a2");
    const none = selectRefs(b, noAdult, b.scenes![1], budget, assets);
    expect(none.refs).toEqual([]);
    expect(none.missing).toEqual(["c1"]);
  });

  it("at most 4 characters, and never more pictures than the model takes", () => {
    const many = { ...b, characters: Array.from({ length: 6 }, (_, i) => ({ ...tom, id: `k${i}`, name: `K${i}` })) };
    const ms = approved(planSheets(many));
    const s6 = scene({ in_frame: many.characters.map((c) => ({ character_id: c.id, age_stage: null })) });
    expect(selectRefs(many, ms.sheets, s6, budget, ms.assets).refs).toHaveLength(4);
    expect(selectRefs(many, ms.sheets, s6, { offset: 12, offsetBytes: 0, maxPictures: 14 }, ms.assets).refs).toHaveLength(2);
  });

  it("refuses by name a picture whose size is unknown or whose type the models do not read, and stays under 14 MB", () => {
    const unknown = new Map([...assets].map(([k, v]) => [k, { ...v, bytes: null }]));
    expect(selectRefs(b, sheets, b.scenes![0], budget, unknown)).toMatchObject({ refused: "ref_size_unknown", refs: [] });
    expect(selectRefs(b, sheets, b.scenes![0], budget, new Map())).toMatchObject({ refused: "ref_size_unknown" });
    const gif = new Map([...assets].map(([k, v]) => [k, { ...v, mime: "image/gif" }]));
    expect(selectRefs(b, sheets, b.scenes![0], budget, gif)).toMatchObject({ refused: "ref_type_not_taken" });
    expect(selectRefs(b, sheets, b.scenes![0], { ...budget, offsetBytes: REF_BYTES_MAX - 1_500_000 }, assets)).toMatchObject({ refused: "refs_too_large" });
  });
});

describe("the fix round's guards", () => {
  it("re-reads a stored BRIEF through its own caps: at most 8 characters, 4 stages each, 40 sheets (Breach BR-RS-03)", () => {
    const many = { ...b, characters: Array.from({ length: 200 }, (_, i) => ({ ...mira, id: `x${i}`, name: `N${i}`,
      age_stages: Array.from({ length: 9 }, (_, k) => ({ id: `a${k}`, label: `L${k}`, look: look("x") })) })) };
    const read = readSheetBrief(many);
    expect(read.characters).toHaveLength(8);
    expect(read.characters!.every((c) => (c.age_stages ?? []).length <= 4)).toBe(true);
    expect(planSheets(read).length).toBeLessThanOrEqual(SHEETS_MAX);
    expect(SHEETS_MAX).toBe(40);
    expect(readSheets(Array.from({ length: 500 }, () => ({ character_id: "c1", stage: null, views: [] })))).toHaveLength(40);
    // Not a short film's BRIEF, or a malformed one: no characters, nothing planned.
    expect(readSheetBrief("x").characters).toEqual([]);
    expect(readSheetBrief({ characters: "x" }).kind).toBeNull();
  });

  it("merges two writers view by view: what this write changed is ours, the rest keeps the later attempt and state", () => {
    const base = planSheets(b);
    const approvedTom = base.map((s) => s.character_id === "c2" ? { ...s, views: s.views.map((v, i) => (i === 0 ? { ...v, status: "approved" as const, asset_id: A(1) } : v)) } : s);
    const redoneTom = base.map((s) => s.character_id === "c2" ? { ...s, views: s.views.map((v, i) => (i === 0 ? { ...v, status: "planned" as const, attempt: 1 } : v)) } : s);
    // Another writer approved Tom's front meanwhile; this write changed nothing of Tom: the approval is kept.
    expect(mergeConcurrent(approvedTom, base, base).find((s) => s.character_id === "c2")!.views[0].status).toBe("approved");
    // This write redid it: the redo is ours, whatever the other writer stored.
    expect(mergeConcurrent(approvedTom, redoneTom, approvedTom).find((s) => s.character_id === "c2")!.views[0]).toMatchObject({ status: "planned", attempt: 1 });
    // An intent this write saved before its create is kept over the stored "planned", and its revert after a refusal too.
    const intent = base.map((s) => ({ ...s, views: s.views.map((v) => ({ ...v, status: "making" as const, key: "sheet:" + "a".repeat(48) })) }));
    expect(mergeConcurrent(base, intent, base)[0].views[0].status).toBe("making");
    expect(mergeConcurrent(intent, base, intent)[0].views[0].status).toBe("planned");
  });

  it("adds the reference line once, replacing an older one", () => {
    expect(withRefLine("v1", "Reference pictures: A should reference Image 0.")).toBe("v1\nReference pictures: A should reference Image 0.");
    expect(withRefLine("v1\nReference pictures: old", "Reference pictures: new")).toBe("v1\nReference pictures: new");
  });

  it("reports the 5th and later in-frame characters as missing, never silently dropped", () => {
    const many = { ...b, characters: Array.from({ length: 6 }, (_, i) => ({ ...tom, id: `k${i}`, name: `K${i}` })) };
    const ms = approved(planSheets(many));
    const s6 = { ...b.scenes![0], in_frame: many.characters.map((c) => ({ character_id: c.id, age_stage: null })) };
    expect(selectRefs(many, ms.sheets, s6, budget, ms.assets).missing).toEqual(["k4", "k5"]);
  });

  it("links each BRIEF scene to the film scene save_film answered with, by position, or not at all", () => {
    const saved = { scenes: [{ id: "dddddddd-0000-4000-8000-000000000902", position: 1 }, { id: "dddddddd-0000-4000-8000-000000000901", position: 0 }] };
    expect(filmLinkOf("bbbbbbbb-0000-4000-8000-000000000002", [{ id: "s1" }, { id: "s2" }], saved)).toEqual({ film_id: "bbbbbbbb-0000-4000-8000-000000000002",
      scenes: [{ brief: "s1", film: "dddddddd-0000-4000-8000-000000000901" }, { brief: "s2", film: "dddddddd-0000-4000-8000-000000000902" }] });
    expect(filmLinkOf("bbbbbbbb-0000-4000-8000-000000000002", [{ id: "s1" }], saved)).toBeNull();
  });
});

describe("the gate", () => {
  const row = (id: string, spec: Record<string, unknown> = {}) => ({ id, spec: { inputs: { image_refs_max: 14 }, ...spec } });

  it("is closed today for every key-frame model the film can have: OpenAI's adapter takes references on edit only", () => {
    for (const id of ["openai-gpt-image-2.6-sunburst", "openai-gpt-image-2.6-flare"]) {
      expect(refGate(id, [row(id)], "adult")).toEqual({ open: false, reason: "refs_not_on_keyframe" });
    }
    // Gemini takes them on t2i, but is not on sale (terms review): not in sellable_models, so closed.
    expect(refGate("gemini-3-pro-image", [], "adult")).toEqual({ open: false, reason: "not_on_sale" });
    expect(refGate(null, [], "adult")).toEqual({ open: false, reason: "model_not_set" });
  });

  it("is closed when neither the registry nor the adapters say (unknown is never open)", () => {
    expect(refGate("fake-new", [row("fake-new")], "adult", {})).toEqual({ open: false, reason: "refs_unknown" });
    expect(refCapabilitiesOf({ inputs: { ref_capabilities: "t2i" } })).toBeNull();
    // A malformed registry field is unknown (closed), never read past to the twin.
    expect(refGate("gemini-nano-banana-2.1", [row("gemini-nano-banana-2.1", { inputs: { image_refs_max: 14, ref_capabilities: [1] } })], "adult")).toEqual({ open: false, reason: "refs_unknown" });
    // sellable_models projects the registry's `inputs` only: a top-level field never reaches the server, so it is not read.
    expect(refCapabilitiesOf({ ref_capabilities: ["t2i"] })).toBeUndefined();
  });

  it("opens for a sellable model whose registry ref_capabilities include t2i, the registry's word first", () => {
    expect(refGate("fake", [row("fake", { inputs: { image_refs_max: 14, ref_capabilities: ["t2i"] } })], "adult", {})).toEqual({ open: true, imageRefsMax: 14 });
    // The registry says edit only: the twin's t2i is not read.
    expect(refGate("fake", [row("fake", { inputs: { image_refs_max: 14, ref_capabilities: ["edit"] } })], "adult", { fake: ["t2i"] })).toEqual({ open: false, reason: "refs_not_on_keyframe" });
    // No registry field: the adapters' own declaration (Gemini-like) opens it once the model is on sale.
    expect(refGate("gemini-nano-banana-2.1", [row("gemini-nano-banana-2.1")], "adult")).toEqual({ open: true, imageRefsMax: 14 });
  });

  it("is closed for a terms-gated model, an 18+ model without the person's attestation, and a model that takes no picture", () => {
    expect(refGate("g", [row("g", { terms_gate: "terms_review_required", inputs: { image_refs_max: 14, ref_capabilities: ["t2i"] } })], "adult", {})).toEqual({ open: false, reason: "terms_gated" });
    for (const age of ["none", "unknown", "minor"] as const) {
      expect(refGate("g", [row("g", { requires_adult: true, inputs: { image_refs_max: 14, ref_capabilities: ["t2i"] } })], age, {})).toEqual({ open: false, reason: "adult_attestation_required" });
    }
    expect(refGate("g", [{ id: "g", spec: { inputs: { image_refs_max: 0, ref_capabilities: ["t2i"] } } }], "adult", {})).toEqual({ open: false, reason: "no_ref_slots" });
  });
});

describe("the words", () => {
  it("has every sheet string in en, ru and uz, Uzbek with its own apostrophes", () => {
    const keys = (o: unknown, p = ""): string[] => (o && typeof o === "object"
      ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p]);
    const en = keys(dictionaries.en.aiChat.sheets).sort();
    expect(keys(dictionaries.ru.aiChat.sheets).sort()).toEqual(en);
    expect(keys(dictionaries.uz.aiChat.sheets).sort()).toEqual(en);
    const uz = JSON.stringify(dictionaries.uz.aiChat.sheets);
    expect(uz).toContain("ʻ");
    expect(uz).not.toMatch(/[a-z]'[a-z]/i);
    expect(uz).not.toContain("‘");
    expect(dictionaries.en.aiChat.sheets.gateClosed).toBe("Your key-frame model can't use reference pictures yet; the sheets are saved and will be used when it can.");
  });
});

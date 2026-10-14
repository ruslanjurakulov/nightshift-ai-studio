/**
 * "Improve with AI" on a file, the pure half: which tools fit which file type,
 * that every one is an EXISTING Studio tool the Studio itself accepts with the
 * file chosen, how availability reads, and that the copy is complete. No
 * network, no prices: the Studio quotes.
 */
import { describe, expect, it } from "vitest";
import {
  IMPROVE_TOOLS,
  editorAddHref,
  improveAvailable,
  improveHref,
  improveTools,
  isImproveKind,
  isStudioTool,
  parseIdParam,
  sellableToolList,
  type ImproveStudioTool,
} from "@/lib/creative/improve";
import { PANEL_CAPABILITIES, needsRecording, needsSource, needsVideo, prefillFromQuery } from "@/lib/creative/studio";
import { deskFor } from "@/lib/creative/desks";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("which tools fit which file", () => {
  it("lists exactly the tools that exist for each type", () => {
    expect([...IMPROVE_TOOLS.image]).toEqual(["upscale", "remove_bg", "edit", "i2v"]);
    expect([...IMPROVE_TOOLS.video]).toEqual(["video_upscale", "captions", "dub", "voice_change"]);
    expect([...IMPROVE_TOOLS.audio]).toEqual(["voice_change", "dub"]);
  });

  it("offers nothing for a file the tools cannot take", () => {
    expect(improveTools("caption")).toEqual([]);
    expect(improveTools(undefined)).toEqual([]);
    expect(isImproveKind("caption")).toBe(false);
  });

  it("every Studio tool really starts from that type of file (never a picture tool for a sound)", () => {
    for (const tool of IMPROVE_TOOLS.image) expect(needsSource(tool)).toBe(true);
    for (const tool of IMPROVE_TOOLS.audio) expect(needsRecording(tool)).toBe(true);
    for (const tool of IMPROVE_TOOLS.video) {
      if (tool === "captions") continue;
      expect(needsVideo(tool) || needsRecording(tool), tool).toBe(true);
    }
    for (const tool of [...IMPROVE_TOOLS.audio]) expect(needsSource(tool)).toBe(false);
  });
});

describe("the Studio links", () => {
  const studio = Object.values(IMPROVE_TOOLS)
    .flat()
    .filter((t): t is ImproveStudioTool => isStudioTool(t));

  it("open the existing tool with the file chosen, and the Studio accepts that prefill", () => {
    for (const tool of studio) {
      const href = improveHref(tool, ID)!;
      expect(href).toBe(`/create?tool=${tool}&source=${ID}`);
      const q = new URL(href, "https://x.test").searchParams;
      expect(PANEL_CAPABILITIES as readonly string[]).toContain(tool);
      expect(prefillFromQuery(q.get("tool"), q.get("source")), tool).toMatchObject({ capability: tool, sourceId: ID });
      // The tool opens on a desk that has it.
      expect(deskFor(tool as never)).toBeTruthy();
    }
  });

  it("carry the editor project so the result can be added back, and drop anything that is not an id", () => {
    expect(improveHref("upscale", ID, PROJECT)).toBe(`/create?tool=upscale&source=${ID}&project=${PROJECT}`);
    expect(improveHref("upscale", ID, "../../etc")).toBe(`/create?tool=upscale&source=${ID}`);
    expect(improveHref("upscale", "not-an-id")).toBeNull();
    expect(improveHref("captions", ID)).toBeNull();
  });

  it("add-back links need two real ids", () => {
    expect(editorAddHref(PROJECT, ID)).toBe(`/editor/${PROJECT}?add=${ID}`);
    expect(editorAddHref("x", ID)).toBeNull();
    expect(editorAddHref(PROJECT, "x")).toBeNull();
    expect(parseIdParam([ID, "x"])).toBe(ID);
    expect(parseIdParam("nope")).toBeNull();
    expect(parseIdParam(undefined)).toBeNull();
  });
});

describe("availability", () => {
  it("is what the database sells; an empty list means none; unknown still offers the tools", () => {
    expect(improveAvailable("upscale", ["upscale", "dub"])).toBe(true);
    expect(improveAvailable("remove_bg", ["upscale"])).toBe(false);
    expect(improveAvailable("captions", [])).toBe(false);
    expect(improveAvailable("edit", null)).toBe(true);
  });

  it("keeps only the capabilities the menu knows", () => {
    expect(sellableToolList(["t2i", "upscale", "upscale", "captions", "tts"]).sort()).toEqual(["captions", "upscale"]);
  });
});

describe("the copy", () => {
  const keys = (o: object): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k]));
  const flat = (o: object): [string, string][] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v).map(([x, s]) => [`${k}.${x}`, s] as [string, string]) : [[k, v as string] as [string, string]]));

  it("is complete in English, Russian and Uzbek, with the same placeholders", () => {
    const base = flat(en.improveAi);
    for (const d of [ru, uz]) {
      expect(keys(d.improveAi)).toEqual(keys(en.improveAi));
      const other = Object.fromEntries(flat(d.improveAi));
      for (const [k, a] of base) {
        const b = other[k]!;
        expect(b.trim().length, k).toBeGreaterThan(0);
        expect(b.match(/\{\w+\}/g) ?? [], k).toEqual(a.match(/\{\w+\}/g) ?? []);
      }
    }
  });

  it("has a label and a hint for every tool it can offer", () => {
    for (const tool of new Set(Object.values(IMPROVE_TOOLS).flat())) {
      expect(en.improveAi.tools[tool].label.length).toBeGreaterThan(0);
      expect(en.improveAi.tools[tool].hint.length).toBeGreaterThan(0);
    }
  });

  it("names no provider, model or role, and puts no number or price in the copy", () => {
    const text = JSON.stringify([en.improveAi, ru.improveAi, uz.improveAi]).toLowerCase();
    expect(text).not.toMatch(/owner|viewer|admin|openai|gemini|kling|veo|flux|elevenlabs|higgsfield|krea|topaz|whisper|deepgram/);
    const values = [en.improveAi, ru.improveAi, uz.improveAi].flatMap((d) => flat(d).map(([, v]) => v)).join(" ");
    expect(values).not.toMatch(/\d/);
  });
});

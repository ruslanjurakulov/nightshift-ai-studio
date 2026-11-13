/**
 * The address "Improve with AI" builds into the Studio, and how the create page reads it back
 * (lib/creative/improve.ts). It fills a form and nothing else, so what matters is that nothing the panel could not
 * have meant gets through: a malformed model id, words for a tool that takes none, control characters, words past
 * the limit, or a link that is not one of the Studio's tools.
 */
import { describe, expect, it } from "vitest";
import {
  AUTO_MODEL,
  IMPROVE_PROMPT_MAX,
  cleanImprovePrompt,
  improveHref,
  improveModels,
  improveWords,
  prefillFromImprove,
} from "@/lib/creative/improve";
import { prefillFromQuery, type StudioModel } from "@/lib/creative/studio";

const FILE = "11111111-1111-4111-8111-111111111111";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const read = (href: string | null) => new URL(href!, "https://app.invalid").searchParams;

describe("improveHref", () => {
  it("keeps today's link when nothing else is picked", () => {
    expect(improveHref("upscale", FILE)).toBe(`/create?tool=upscale&source=${FILE}`);
    expect(improveHref("upscale", FILE, P1)).toBe(`/create?tool=upscale&source=${FILE}&project=${P1}`);
  });

  it("adds a well-formed model id, or auto, and drops anything else", () => {
    expect(read(improveHref("edit", FILE, null, { model: "grounded-image-1.0" })).get("model")).toBe("grounded-image-1.0");
    expect(read(improveHref("edit", FILE, null, { model: AUTO_MODEL })).get("model")).toBe("auto");
    for (const bad of ["UPPER", "a", "x&tool=t2v", "../../x", " pic-1"]) expect(read(improveHref("edit", FILE, null, { model: bad })).has("model")).toBe(false);
  });

  it("encodes the words so they cannot add or change a parameter", () => {
    const typed = "a&tool=t2v#frag ?x=1\nnext line";
    const href = improveHref("edit", FILE, null, { prompt: typed })!;
    expect(read(href).get("tool")).toBe("edit");
    expect(read(href).get("prompt")).toBe(typed);
    expect([...read(href).keys()]).toEqual(["tool", "source", "prompt"]);
  });

  it("bounds the words, strips control characters, and carries none for a tool that takes none", () => {
    expect(read(improveHref("edit", FILE, null, { prompt: "y".repeat(5000) })).get("prompt")).toHaveLength(IMPROVE_PROMPT_MAX);
    expect(read(improveHref("edit", FILE, null, { prompt: "ab\u0000c\u0007d\te" })).get("prompt")).toBe("abcd\te");
    expect(read(improveHref("edit", FILE, null, { prompt: "   " })).has("prompt")).toBe(false);
    for (const tool of ["remove_bg", "video_upscale", "dub", "voice_change"] as const) {
      expect(read(improveHref(tool, FILE, null, { prompt: "louder" })).has("prompt")).toBe(false);
    }
  });

  it("no link for captions (made in the editor) or for a file id that is not one", () => {
    expect(improveHref("captions", FILE, null, { prompt: "x" })).toBeNull();
    expect(improveHref("upscale", "nope")).toBeNull();
  });
});

describe("which tools take words (the Studio's own rule)", () => {
  it.each([
    ["edit", "required"],
    ["upscale", "optional"],
    ["i2v", "optional"],
    ["remove_bg", "none"],
    ["video_upscale", "none"],
    ["dub", "none"],
    ["voice_change", "none"],
    ["captions", "none"],
  ] as const)("%s → %s", (tool, rule) => {
    expect(improveWords(tool)).toBe(rule);
  });
});

describe("improveModels", () => {
  const M = (id: string, caps: string[]): StudioModel => ({ id, displayName: id, capabilities: caps, beta: false });
  it("only the tool's models, Auto only with a choice; unknown list stays unknown", () => {
    const list = [M("a1", ["upscale"]), M("a2", ["upscale", "edit"]), M("b", ["dub"])];
    expect(improveModels(list, "upscale")).toEqual({ models: [list[0], list[1]], auto: true });
    expect(improveModels(list, "dub")).toEqual({ models: [list[2]], auto: false });
    expect(improveModels(list, "i2v")).toEqual({ models: [], auto: false });
    expect(improveModels(null, "upscale")).toBeNull();
    expect(improveModels(list, "captions")).toEqual({ models: [], auto: false });
  });
});

describe("the create page reads it back", () => {
  const base = prefillFromQuery("edit", FILE);

  it("auto starts the form on Auto with no fixed model", () => {
    expect(prefillFromImprove(base, { model: "auto" })).toMatchObject({ capability: "edit", model: "", auto: true, sourceId: FILE });
  });

  it("the words fill the box, cleaned and bounded as the link was", () => {
    expect(prefillFromImprove(base, { prompt: "  warmer\u0000 sky " })!.prompt).toBe("warmer sky");
    expect(prefillFromImprove(base, { prompt: ["first", "second"] })!.prompt).toBe("first");
    expect(prefillFromImprove(base, { prompt: "z".repeat(9000) })!.prompt).toHaveLength(IMPROVE_PROMPT_MAX);
  });

  it("a tool that takes no words gets none, and a form that already has words keeps them", () => {
    expect(prefillFromImprove(prefillFromQuery("remove_bg", FILE), { prompt: "x" })!.prompt).toBe("");
    expect(prefillFromImprove({ ...base!, prompt: "from a template" }, { prompt: "x" })!.prompt).toBe("from a template");
  });

  it("no tool, no prefill: an address cannot make a form out of nothing", () => {
    expect(prefillFromImprove(null, { model: "auto", prompt: "x" })).toBeNull();
  });

  it("leaves a link without these parameters exactly as it was", () => {
    expect(prefillFromImprove(base, {})).toBe(base);
  });

  it("only cleans the words — it does not decide whether a model is offered (the panel does, against its own list)", () => {
    expect(cleanImprovePrompt("upscale", 42)).toBe("");
    expect(cleanImprovePrompt("upscale", "faces")).toBe("faces");
  });

  it("strips the bidi overrides and isolates and the C1 controls a crafted link could carry", () => {
    // U+202E would show "sky the move" in the box while "move the sky" is what is sent (or the reverse).
    const bidi = ["\u202A", "\u202B", "\u202C", "\u202D", "\u202E", "\u2066", "\u2067", "\u2068", "\u2069"];
    for (const c of bidi) expect(cleanImprovePrompt("edit", `move${c} the sky`)).toBe("move the sky");
    for (const code of [0x80, 0x85, 0x9b, 0x9f]) expect(cleanImprovePrompt("edit", `a${String.fromCharCode(code)}b`)).toBe("ab");
    // A line break, a tab and ordinary non-Latin words are kept.
    expect(cleanImprovePrompt("edit", "osmon\tko'k\nнебо")).toBe("osmon\tko'k\nнебо");
    // Right-to-left text itself is not a control: only the invisible direction overrides are.
    expect(cleanImprovePrompt("edit", "سماء زرقاء")).toBe("سماء زرقاء");
  });

  it("cuts at the limit on a whole character: never half of a surrogate pair (an emoji)", () => {
    const max = IMPROVE_PROMPT_MAX;
    // The limit falls between the two halves of the last emoji: it is left out whole.
    const cut = cleanImprovePrompt("edit", "a".repeat(max - 1) + "😀😀");
    expect(cut).toBe("a".repeat(max - 1));
    expect(cut.length).toBeLessThanOrEqual(max);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    // An emoji that fits is kept whole.
    const fits = cleanImprovePrompt("edit", "a".repeat(max - 2) + "😀😀");
    expect(fits).toBe("a".repeat(max - 2) + "😀");
    expect([...cleanImprovePrompt("edit", "😀".repeat(max))].every((ch) => ch === "😀")).toBe(true);
  });
});

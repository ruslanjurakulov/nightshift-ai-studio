/**
 * Effects (lib/effects/catalog.ts): the catalog is checked against the model registry, a link can only fill the Studio form it
 * names, an effect runs only on a model it was written for and this workspace is offered, and every word is in three languages.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import raw from "@/lib/effects/effects.json";
import {
  EFFECTS,
  EFFECT_IDS,
  EFFECT_PROMPT_MAX,
  SUBJECT_MAX,
  SUBJECT_SLOT,
  cleanSubject,
  effectById,
  effectFromQuery,
  effectPrefill,
  effectSection,
  fillPrompt,
  isEffectPrompt,
  parseEffect,
  parseEffects,
  publicEffectHref,
  resolveEffect,
  type Effect,
} from "@/lib/effects/catalog";
import { dictionaries, type Locale } from "@/lib/i18n";
import { afterSignupPath, studioNext } from "@/lib/safe-redirect";
import { DESKS, MEDIA_DESKS, deskFromQuery } from "@/lib/creative/desks";
import { SHOWCASE_ENTRIES } from "@/lib/site/showcase";
import { effectSample } from "@/components/effects/effect-sample";
import { PROVIDER_BRANDS } from "./helpers/brands";

const LOCALES: Locale[] = ["en", "ru", "uz"];
const ROOT = join(__dirname, "..", "..");
type RegModel = {
  id: string;
  capabilities: string[];
  aspect_ratios: string[];
  aspect_ratios_by_capability?: Record<string, string[]>;
  durations_s: number[];
  terms_gate: string | null;
  operator_preview?: boolean;
  shutdown?: { on: string } | null;
  limits?: { max_prompt_chars?: number };
};
const REGISTRY = (JSON.parse(readFileSync(join(ROOT, "schemas/model_registry.json"), "utf8")) as { models: RegModel[] }).models;
const reg = (id: string) => REGISTRY.find((m) => m.id === id);
const known = (cap: string) => new Set(REGISTRY.filter((m) => m.capabilities.includes(cap)).map((m) => m.id));
const TODAY = new Date().toISOString().slice(0, 10);

const GOOD = (raw as { effects: (Record<string, unknown> & { prompt: string })[] }).effects.find((e) => e.id === "giant-in-the-city")!;
const PIC = "11111111-2222-4333-8444-555555555555";

describe("the catalog file", () => {
  it("is not hidden by the repository's blanket *.json ignore (it would pass here and be missing from every checkout)", () => {
    const lines = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((l) => l.trim());
    expect(lines).toContain("*.json");
    expect(lines).toContain("!command-center/lib/effects/effects.json");
  });

  it("parses whole: every entry is well formed, once, in the order EFFECT_IDS gives", () => {
    const { effects, refused } = parseEffects(raw, known);
    expect(refused).toEqual([]);
    expect(effects.map((e) => e.id)).toEqual([...EFFECT_IDS]);
    expect(EFFECTS.map((e) => e.id)).toEqual([...EFFECT_IDS]);
    expect(EFFECTS.length).toBeGreaterThanOrEqual(6);
    expect(EFFECTS.length).toBeLessThanOrEqual(10);
  });

  it("names only registry models that make the effect's tool, with cleared terms and no shutdown that has come", () => {
    for (const e of EFFECTS) {
      for (const id of e.models) {
        const m = reg(id);
        expect(m, `${e.id}: ${id}`).toBeTruthy();
        expect(m!.capabilities, `${e.id}: ${id}`).toContain(e.capability);
        // A terms-gated model is never offered; listing it would promise an effect nobody can run.
        expect(m!.terms_gate, `${e.id}: ${id}`).toBeNull();
        if (m!.shutdown?.on) expect(m!.shutdown.on > TODAY, `${e.id}: ${id} is shut down`).toBe(true);
      }
    }
  });

  it("asks every listed model only for a shape and a length it makes, and words it takes", () => {
    for (const e of EFFECTS) {
      for (const id of e.models) {
        const m = reg(id)!;
        expect(m.durations_s, `${e.id}: ${id} length`).toContain(e.duration);
        // A picture effect sends no shape (the clip takes the picture's); an empty list is a model that makes its own shape.
        const shapes = m.aspect_ratios_by_capability?.[e.capability] ?? m.aspect_ratios;
        if (e.capability === "t2v" && shapes.length > 0) expect(shapes, `${e.id}: ${id} shape`).toContain(e.aspect);
        const longest = fillPrompt(e, "x".repeat(SUBJECT_MAX)).length;
        expect(longest, `${e.id}: ${id} prompt`).toBeLessThanOrEqual(m.limits?.max_prompt_chars ?? 4000);
      }
    }
  });

  it("has a real customer-sellable fallback on every effect, never only operator previews", () => {
    // The registry's view; whether it is verified by a probe and on sale is the database's (resolveEffect reads that list).
    for (const e of EFFECTS) expect(e.models.some((id) => reg(id)!.operator_preview !== true), e.id).toBe(true);
  });
});

describe("an entry is refused", () => {
  const bad = (patch: Record<string, unknown>, k?: ReadonlySet<string>) => parseEffect({ ...GOOD, ...patch }, k);

  it("when it names an unknown model, or a malformed one", () => {
    expect(bad({}, known("t2v")).ok).toBe(true);
    expect(bad({ models: ["minimax-h3", "no-such-model"] }, known("t2v"))).toEqual({ ok: false, reason: "giant-in-the-city: unknown model no-such-model" });
    // A model that exists but does not make this tool is unknown for it.
    expect(bad({ models: ["runway-gen4-turbo"] }, known("t2v")).ok).toBe(false);
    expect(bad({ models: ["Bad Id!"] }).ok).toBe(false);
    expect(bad({ models: [] }).ok).toBe(false);
    expect(bad({ models: ["minimax-h3", "minimax-h3"] }).ok).toBe(false);
  });

  it("when a words effect has no slot, two, or another one, and when a picture effect has one", () => {
    expect(bad({ prompt: String(GOOD.prompt).replace(SUBJECT_SLOT, "a cat") }).ok).toBe(false);
    expect(bad({ prompt: `${GOOD.prompt} Then ${SUBJECT_SLOT} again.` }).ok).toBe(false);
    expect(bad({ prompt: `${GOOD.prompt} In {city}.` }).ok).toBe(false);
    expect(bad({ slotHint: null }).ok).toBe(false);
    expect(bad({ capability: "i2v", input: "picture", slotHint: null }).ok).toBe(false);
  });

  it("when its tool, input, shape, length, colours or preview id are off the closed lists", () => {
    expect(bad({ id: "vanish" }).ok).toBe(false);
    expect(bad({ capability: "t2i" }).ok).toBe(false);
    expect(bad({ input: "picture" }).ok).toBe(false);
    expect(bad({ aspect: "4:3" }).ok).toBe(false);
    expect(bad({ duration: 6 }).ok).toBe(false);
    expect(bad({ hues: ["red", "#fff"] }).ok).toBe(false);
    expect(bad({ previewJobId: "not-a-uuid" }).ok).toBe(false);
    expect(bad({ prompt: "x".repeat(EFFECT_PROMPT_MAX + 1) }).ok).toBe(false);
    expect(parseEffects({ effects: [GOOD, GOOD] }).refused).toEqual(["giant-in-the-city: listed twice"]);
  });
});

describe("the words", () => {
  const giant = effectById("giant-in-the-city")!;

  it("put the subject in the slot, or the [hint] until there is one", () => {
    expect(fillPrompt(giant, "a red fox")).toContain(": a red fox, at colossal scale");
    expect(fillPrompt(giant, "")).toContain(giant.slotHint!);
    expect(fillPrompt(giant, "  ")).not.toContain(SUBJECT_SLOT);
    // `$&`, `$'` and `` $` `` are replacement patterns in String.replace: they must land as typed, never re-insert the slot or the template.
    const dollars = "$&$'$`".repeat(20);
    const filled = fillPrompt(giant, dollars);
    expect(filled).not.toContain(SUBJECT_SLOT);
    expect(filled).toContain(cleanSubject(dollars));
    expect(filled.length).toBeLessThanOrEqual(giant.prompt.length - SUBJECT_SLOT.length + SUBJECT_MAX);
    const photo = effectById("photo-to-life")!;
    expect(fillPrompt(photo, "ignored")).toBe(photo.prompt);
  });

  it("clean a subject from a link: no control, bidi or invisible characters, one line, no braces, at most 120", () => {
    expect(cleanSubject("a‮red​ fox\n\nin {snow}")).toBe("ared fox in snow");
    expect(Array.from(cleanSubject("ж".repeat(500)))).toHaveLength(SUBJECT_MAX);
    expect(cleanSubject("😀".repeat(200))).toBe("😀".repeat(SUBJECT_MAX));
    expect(cleanSubject(["a"])).toBe("");
    expect(cleanSubject(undefined)).toBe("");
  });

  it("recognise an effect's own words and nothing else", () => {
    expect(isEffectPrompt(giant, fillPrompt(giant, "a red fox"))).toBe(true);
    expect(isEffectPrompt(giant, fillPrompt(giant, ""))).toBe(false);
    expect(isEffectPrompt(giant, `${fillPrompt(giant, "a red fox")} Extra.`)).toBe(false);
    const burst = effectById("product-burst")!;
    expect(isEffectPrompt(burst, burst.prompt)).toBe(true);
    expect(isEffectPrompt(burst, `${burst.prompt} `)).toBe(false);
  });
});

describe("which model an effect uses", () => {
  const m = (id: string, caps: string[], extra: Record<string, unknown> = {}) => ({ id, displayName: id.toUpperCase(), capabilities: caps, beta: false, ...extra });
  const giant = effectById("giant-in-the-city")!;

  it("is the first of its own models that this workspace is offered, named, with its rank", () => {
    const operator = [m("minimax-hailuo-2.3", ["t2v", "i2v"]), m("minimax-h3", ["t2v", "i2v"], { preview: true })];
    expect(resolveEffect(giant, operator)).toEqual({ state: "ready", modelId: "minimax-h3", modelName: "MINIMAX-H3", rank: 0, preview: true, fixedShape: false });
    const customer = [m("minimax-hailuo-2.3", ["t2v", "i2v"], { fixedShape: true })];
    expect(resolveEffect(giant, customer)).toMatchObject({ state: "ready", modelId: "minimax-hailuo-2.3", rank: 2, preview: false, fixedShape: true });
  });

  it("is never a model the effect was not written for, nor one offered for another tool: then it is unavailable", () => {
    expect(resolveEffect(giant, [])).toEqual({ state: "unavailable" });
    expect(resolveEffect(giant, [m("veo-3.1", ["t2v", "i2v"]), m("kling-v3", ["t2v"])])).toEqual({ state: "unavailable" });
    const life = effectById("photo-to-life")!;
    expect(resolveEffect(life, [m("runway-gen4.5", ["t2v"])])).toEqual({ state: "unavailable" });
    expect(resolveEffect(life, [m("runway-gen4-turbo", ["i2v"])])).toMatchObject({ modelId: "runway-gen4-turbo" });
  });

  it("fills the composer with that model, the words, the shape and the length, and nothing that spends", () => {
    const p = effectPrefill(giant, "minimax-h3", "a red fox");
    expect(p).toEqual({ capability: "t2v", model: "minimax-h3", prompt: fillPrompt(giant, "a red fox"), aspect: "9:16", duration: 10, styleKitId: null });
    const burst = effectById("product-burst")!;
    expect(effectPrefill(burst, "minimax-h3", "", PIC)).toMatchObject({ capability: "i2v", sourceId: PIC, prompt: burst.prompt });
  });
});

describe("the links", () => {
  it("open the effect's own tool, and a link for another tool or an unknown effect fills nothing", () => {
    const giant = effectById("giant-in-the-city")!;
    expect(effectSection(giant)).toBe("/create?tool=t2v&effect=giant-in-the-city");
    expect(effectFromQuery({ tool: "t2v", effect: "giant-in-the-city", subject: "a fox‮" })).toMatchObject({ subject: "a fox", sourceId: null });
    expect(effectFromQuery({ tool: "i2v", effect: "giant-in-the-city" })).toBeNull();
    expect(effectFromQuery({ tool: "t2v", effect: "vanish" })).toBeNull();
    expect(effectFromQuery({ tool: "t2v", effect: ["giant-in-the-city"] })).toBeNull();
    expect(effectFromQuery({ effect: "giant-in-the-city" })).toBeNull();
  });

  it("keep a well-formed picture on a picture effect and drop a malformed one", () => {
    expect(effectFromQuery({ tool: "i2v", effect: "product-burst", source: PIC })).toMatchObject({ sourceId: PIC, subject: "" });
    expect(effectFromQuery({ tool: "i2v", effect: "product-burst", source: "../../x" })).toMatchObject({ sourceId: null });
  });

  it("from the public site go through sign-up to the same-origin Studio form, and fit through /welcome", () => {
    for (const e of EFFECTS) {
      const href = publicEffectHref(e);
      const u = new URL(href, "https://site.test");
      expect(u.origin).toBe("https://site.test");
      expect(u.pathname).toBe("/signup");
      const next = u.searchParams.get("next")!;
      expect(next).toBe(`/all-channels${effectSection(e)}`);
      expect(studioNext(next)).toBe(next);
      expect(afterSignupPath(next)).toBe(`/welcome?next=${encodeURIComponent(next)}`);
    }
  });

  it("make Effects a Studio desk beside Video, and an effect link open the Video desk", () => {
    expect(DESKS).toContain("effects");
    expect(DESKS).toEqual(expect.arrayContaining([...MEDIA_DESKS]));
    expect(DESKS.indexOf("effects")).toBe(DESKS.indexOf("video") + 1);
    expect(deskFromQuery({ desk: "effects" })).toBe("effects");
    for (const e of EFFECTS) {
      const q = Object.fromEntries(new URLSearchParams(effectSection(e).split("?")[1]));
      expect(deskFromQuery(q)).toBe("video");
    }
  });
});

describe("the copy", () => {
  it("names and describes every effect in every language, and asks for what it needs", () => {
    for (const locale of LOCALES) {
      const fx = dictionaries[locale].effects;
      expect(Object.keys(fx.items).sort()).toEqual([...EFFECT_IDS].sort());
      for (const e of EFFECTS) {
        const c = fx.items[e.id];
        expect(c.name.trim(), `${locale} ${e.id}`).not.toBe("");
        expect(c.line.trim(), `${locale} ${e.id}`).not.toBe("");
        if (e.input === "picture") {
          expect(c.picture?.trim(), `${locale} ${e.id}`).toBeTruthy();
          expect(c.subject).toBeUndefined();
        } else {
          expect(c.subject?.trim(), `${locale} ${e.id}`).toBeTruthy();
          expect(c.example?.trim(), `${locale} ${e.id}`).toBeTruthy();
        }
      }
      const d = dictionaries[locale].desk;
      expect(d.names.effects.trim()).not.toBe("");
      expect(d.keySub.effects.trim()).not.toBe("");
      expect(d.blurbs.effects.trim()).not.toBe("");
    }
  });

  it("names no model or maker anywhere the public site shows it, and no other product's effect", () => {
    for (const locale of LOCALES) {
      const fx = dictionaries[locale].effects;
      const shown = JSON.stringify({ items: fx.items, site: fx.site, kinds: fx.kinds, needs: fx.needs, noSample: fx.noSample, sample: fx.sample });
      expect(shown).not.toMatch(PROVIDER_BRANDS);
    }
    for (const e of EFFECTS) expect(e.prompt, e.id).not.toMatch(PROVIDER_BRANDS);
  });
});

describe("previews", () => {
  it("point only at a merged showcase entry that is this effect's own output", () => {
    for (const e of EFFECTS) {
      if (!e.previewJobId) continue;
      const entry = SHOWCASE_ENTRIES.find((s) => s.jobId === e.previewJobId);
      expect(entry, `${e.id}: ${e.previewJobId} is not in lib/site/showcase.json`).toBeTruthy();
      // The full entries, not the default client slice: only they carry the words, so only this call checks all four.
      expect(effectSample(e, SHOWCASE_ENTRIES), `${e.id}: the entry is not this effect's clip (tool, model, words or files)`).not.toBeNull();
      expect(effectSample(e), `${e.id}: the client slice has no clip for it (tool, model or files)`).not.toBeNull();
    }
  });

  it("refuse a showcase entry made with other words, another tool or a model the effect does not list", () => {
    const entry = SHOWCASE_ENTRIES.find((s) => s.kind === "video");
    expect(entry, "the gallery holds no video entry to test the refusals against").toBeTruthy();
    if (!entry) return;
    const files = { [entry.jobId]: { poster: "p", posterSm: "s", clip: { mp4: "a", webm: "b", smMp4: "c", smWebm: "d" } } };
    const as = (patch: Partial<Effect>): Effect => ({ ...effectById("product-burst")!, previewJobId: entry.jobId, ...patch });
    // The same entry, against an effect whose tool, model and words are the entry's, is a preview: so each refusal below is the one difference.
    const same = as({ capability: entry.capability as Effect["capability"], models: [entry.modelId], prompt: entry.prompt });
    expect(effectSample(same, [entry], files)?.entry.jobId).toBe(entry.jobId);
    expect(effectSample({ ...same, capability: entry.capability === "t2v" ? "i2v" : "t2v" }, [entry], files)).toBeNull();
    expect(effectSample(as({ models: ["no-such-model"] }), [entry], files)).toBeNull();
    expect(effectSample(as({ prompt: "Some other words entirely, long enough to be a template." }), [entry], files)).toBeNull();
    expect(effectSample(as({ previewJobId: PIC }), [entry], files)).toBeNull();
  });
});

describe("the operator's doc", () => {
  it("lists every effect with its first model, length and the exact words its preview must be made with", () => {
    const doc = readFileSync(join(ROOT, "docs/EFFECTS.md"), "utf8");
    for (const e of EFFECTS) {
      const section = doc.split(`### \`${e.id}\``)[1]?.split("### ")[0] ?? "";
      expect(section, e.id).not.toBe("");
      expect(section).toContain(`| Model (first choice) | \`${e.models[0]}\` |`);
      expect(section).toContain(`| Length | ${e.duration} s |`);
      const words = e.slotHint ? fillPrompt(e, e.slotHint.slice(1, -1)) : e.prompt;
      expect(section).toContain(words);
      expect(isEffectPrompt(e, words)).toBe(true);
    }
  });
});

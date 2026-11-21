/**
 * The series format templates (lib/seriesTemplates.ts) and what the form and the page do with the words around them.
 *
 * What would break without these:
 *  - the TypeScript table drifting from the Python one (both are held to samples/series_templates.json);
 *  - an unknown, empty or differently cased id read as "no format" or as another format (CLAUDE.md rule 4);
 *  - a bound that changes a price: the clamp is for the input of a preview, and the quote functions price what they are given as before;
 *  - a picker string missing in a language, or a refusal of the database shown as a raw word.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORMAT_TEMPLATES,
  TEMPLATE_IDS,
  TemplateError,
  allowedOptions,
  clampDurationsToTemplate,
  isTemplateId,
  nearestAllowed,
  templateFor,
} from "../lib/seriesTemplates";
import { EPISODE_COUNTS, EPISODE_LENGTHS_S, DEFAULT_EPISODE_LENGTH_S, planErrorKey, requestError, PLANNER_ERROR_CODES } from "../lib/seriesPlan";
import { quoteSeries } from "../lib/credits";
import { dictionaries } from "../lib/i18n";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "../../samples/series_templates.json"), "utf8")) as {
  ids: string[];
  templates: Record<string, { episodes: [number, number]; length_s: [number, number]; scenes: [number, number] }>;
  clamp_cases: { template: string | null; durations: (number | null)[]; expect: (number | null)[]; clamped: number[] }[];
  refused: string[];
};

describe("the table", () => {
  it("is the fixture's closed list and bounds, which the Python table is held to as well", () => {
    expect([...TEMPLATE_IDS]).toEqual(FIXTURE.ids);
    expect(Object.keys(FORMAT_TEMPLATES).sort()).toEqual([...FIXTURE.ids].sort());
    for (const [id, want] of Object.entries(FIXTURE.templates)) {
      const t = FORMAT_TEMPLATES[id as keyof typeof FORMAT_TEMPLATES];
      expect(t.id).toBe(id);
      expect([[...t.episodes], [...t.lengthS], [...t.scenes]], id).toEqual([want.episodes, want.length_s, want.scenes]);
    }
  });

  it("has bounds the form and the database can use", () => {
    for (const t of Object.values(FORMAT_TEMPLATES)) {
      for (const [lo, hi] of [t.episodes, t.lengthS, t.scenes]) {
        expect(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi, t.id).toBe(true);
      }
      expect(t.episodes[0]).toBeGreaterThanOrEqual(3);
      expect(t.episodes[1]).toBeLessThanOrEqual(4);
      expect(t.lengthS[0]).toBeGreaterThanOrEqual(30);
      expect(t.lengthS[1]).toBeLessThanOrEqual(3600);
      expect(allowedOptions(t.id, EPISODE_COUNTS, "episodes").length, t.id).toBeGreaterThan(0);
      expect(allowedOptions(t.id, EPISODE_LENGTHS_S, "lengthS").length, t.id).toBeGreaterThan(0);
      expect(allowedOptions(t.id, EPISODE_LENGTHS_S, "lengthS"), `${t.id} keeps the default length`).toContain(DEFAULT_EPISODE_LENGTH_S);
    }
  });

  it("is three distinct ids", () => {
    expect(TEMPLATE_IDS).toHaveLength(3);
    expect(new Set(TEMPLATE_IDS).size).toBe(3);
  });
});

describe("only the closed list passes", () => {
  it("null and undefined are no format; each id is its template", () => {
    expect(templateFor(null)).toBeNull();
    expect(templateFor(undefined)).toBeNull();
    for (const id of TEMPLATE_IDS) expect(templateFor(id)).toBe(FORMAT_TEMPLATES[id]);
  });

  it("everything else throws TemplateError and is never no format", () => {
    const hostile: unknown[] = [...FIXTURE.refused, 1, 0, true, false, 3.5, [], ["myth_vs_fact"], {}, { id: "myth_vs_fact" }, "x".repeat(100_000)];
    for (const v of hostile) {
      let caught: unknown;
      try {
        templateFor(v);
      } catch (e) {
        caught = e;
      }
      expect(caught, String(v).slice(0, 30)).toBeInstanceOf(TemplateError);
      expect((caught as TemplateError).code).toBe("bad_template");
      expect((caught as TemplateError).message).not.toContain("xxxx");
      expect(isTemplateId(v)).toBe(false);
    }
  });

  it("the empty string is not 'none'", () => {
    expect(() => templateFor("")).toThrow(TemplateError);
    expect(isTemplateId("")).toBe(false);
  });

  it("the inherited properties of an object are not formats", () => {
    for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(isTemplateId(v), v).toBe(false);
      expect(() => templateFor(v), v).toThrow(TemplateError);
    }
  });
});

describe("the options the form offers", () => {
  it("no format offers everything, a format only what it fits", () => {
    expect(allowedOptions(null, EPISODE_LENGTHS_S, "lengthS")).toEqual([...EPISODE_LENGTHS_S]);
    expect(allowedOptions("myth_vs_fact", EPISODE_LENGTHS_S, "lengthS")).toEqual([60, 180, 300, 480]);
    expect(allowedOptions("top5_countdown", EPISODE_LENGTHS_S, "lengthS")).toEqual([180, 300, 480, 600]);
    expect(allowedOptions("one_question_one_answer", EPISODE_LENGTHS_S, "lengthS")).toEqual([60, 180, 300]);
    expect(allowedOptions("myth_vs_fact", EPISODE_COUNTS, "episodes")).toEqual([3, 4]);
  });

  it("includes both bounds themselves", () => {
    expect(allowedOptions("myth_vs_fact", [59, 60, 480, 481], "lengthS")).toEqual([60, 480]);
  });

  it("moves a choice that no longer fits to the nearest one that does, and leaves a fitting one alone", () => {
    expect(nearestAllowed("one_question_one_answer", EPISODE_LENGTHS_S, "lengthS", 600)).toBe(300);
    expect(nearestAllowed("top5_countdown", EPISODE_LENGTHS_S, "lengthS", 60)).toBe(180);
    expect(nearestAllowed("myth_vs_fact", EPISODE_LENGTHS_S, "lengthS", 600)).toBe(480);
    expect(nearestAllowed("myth_vs_fact", EPISODE_LENGTHS_S, "lengthS", 300)).toBe(300);
    expect(nearestAllowed(null, EPISODE_LENGTHS_S, "lengthS", 600)).toBe(600);
    expect(nearestAllowed("myth_vs_fact", EPISODE_COUNTS, "episodes", 4)).toBe(4);
    // a tie goes to the lower option
    expect(nearestAllowed("myth_vs_fact", [60, 100], "lengthS", 80)).toBe(60);
    // nothing fits: the choice is returned unchanged, not invented
    expect(nearestAllowed("myth_vs_fact", [3000], "lengthS", 3000)).toBe(3000);
    expect(() => nearestAllowed("nope" as never, EPISODE_LENGTHS_S, "lengthS", 300)).toThrow(TemplateError);
  });
});

describe("the clamp is for a preview, and the quote functions are unchanged", () => {
  it("matches the fixture cases, which the Python clamp is held to", () => {
    for (const c of FIXTURE.clamp_cases) {
      const got = clampDurationsToTemplate(c.template, c.durations);
      expect(got.durationsS, JSON.stringify(c)).toEqual(c.expect);
      expect(got.clamped, JSON.stringify(c)).toEqual(c.clamped);
    }
  });

  it("does not mutate its input, and leaves unknown, non-finite and non-positive values as they are", () => {
    const input = [30, null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 300];
    const copy = [...input];
    const got = clampDurationsToTemplate("myth_vs_fact", input);
    expect(input).toEqual(copy);
    expect(got.durationsS[0]).toBe(60);
    expect(got.durationsS.slice(1, 6)).toEqual([null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0]);
    expect(got.clamped).toEqual([1]);
    expect(() => clampDurationsToTemplate("nope", [300])).toThrow(TemplateError);
  });

  it("feeds the unchanged quote functions: the same answer as quoting the clamped lengths directly, and no change without a format", () => {
    const prices = { video_minute: { credits_per_unit: 6, margin: 0.25 }, job_minimum: { credits_per_unit: 5, margin: 0 } } as never;
    const durations = [30, 300, 900];
    const clamped = clampDurationsToTemplate("myth_vs_fact", durations).durationsS;
    expect(clamped).toEqual([60, 300, 480]);
    expect(quoteSeries({ prices, durationsS: clamped, videos: [] })).toEqual(quoteSeries({ prices, durationsS: [60, 300, 480], videos: [] }));
    const plain = clampDurationsToTemplate(null, durations).durationsS;
    expect(quoteSeries({ prices, durationsS: plain, videos: [] })).toEqual(quoteSeries({ prices, durationsS: durations, videos: [] }));
  });

  it("is never used by the page that sends or shows a price (the database prices the length that was asked for)", () => {
    for (const file of ["components/series/PlanSeriesPanel.tsx", "components/series/SeriesPlanView.tsx", "lib/server/seriesPlans.ts"]) {
      expect(readFileSync(join(__dirname, "..", file), "utf8"), file).not.toContain("clampDurationsToTemplate");
    }
  });
});

describe("the words around it", () => {
  it("the database's refusal of a format is its own key, and an unknown one is still the generic", () => {
    expect(requestError({ code: "22023", message: "invalid_template" })).toEqual({ key: "invalid_template" });
    expect(requestError({ code: "22023", message: "invalid_something_else" })).toEqual({ key: "failed" });
  });

  it("a plan the worker ended as bad_template has its own sentence and is a problem with the request, not with the answer", () => {
    expect(PLANNER_ERROR_CODES).toContain("bad_template");
    expect(planErrorKey("bad_template")).toBe("bad_template");
    const en = dictionaries.en.seriesPlan.failed.codes as Record<string, string>;
    expect(en.bad_template).toBeTruthy();
    expect(en.bad_template).not.toBe(en.unusable_answer);
    expect(en.bad_template).not.toBe(en.unknown);
  });
});

describe("the picker strings, in all three languages", () => {
  const locales = ["en", "ru", "uz"] as const;

  it("every format has a name and a hint in each language, and the field has its label, 'none', bounds and notice", () => {
    for (const loc of locales) {
      const t = dictionaries[loc].seriesPlan.entry.template;
      for (const id of TEMPLATE_IDS) {
        expect(t[id].name.trim(), `${loc} ${id} name`).not.toBe("");
        expect(t[id].hint.trim(), `${loc} ${id} hint`).not.toBe("");
        expect(t[id].name, `${loc} ${id} name is not the raw id`).not.toBe(id);
      }
      for (const k of ["label", "none", "bounds", "notice"] as const) expect(t[k].trim(), `${loc} ${k}`).not.toBe("");
      expect(dictionaries[loc].seriesPlan.entry.errors.invalid_template.trim(), loc).not.toBe("");
      expect(dictionaries[loc].seriesPlan.failed.codes.bad_template.trim(), loc).not.toBe("");
    }
  });

  it("the three languages carry the same fillers and ru and uz are not copies of the English", () => {
    const fillers = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");
    const en = dictionaries.en.seriesPlan.entry.template;
    for (const loc of ["ru", "uz"] as const) {
      const t = dictionaries[loc].seriesPlan.entry.template;
      expect(fillers(t.bounds), loc).toBe(fillers(en.bounds));
      expect(fillers(t.bounds)).toBe("{from},{max},{min},{to}");
      for (const id of TEMPLATE_IDS) {
        expect(t[id].name, `${loc} ${id}`).not.toBe(en[id].name);
        expect(t[id].hint, `${loc} ${id}`).not.toBe(en[id].hint);
        expect(fillers(t[id].hint)).toBe("");
      }
      expect(t.label).not.toBe(en.label);
      expect(t.notice).not.toBe(en.notice);
    }
  });

  it("the notice says it is a request and the outline is not checked, in every language", () => {
    expect(dictionaries.en.seriesPlan.entry.template.notice).toMatch(/request to the model/i);
    expect(dictionaries.en.seriesPlan.entry.template.notice).toMatch(/not checked/i);
    expect(dictionaries.ru.seriesPlan.entry.template.notice).toMatch(/просьба/i);
    expect(dictionaries.ru.seriesPlan.entry.template.notice).toMatch(/не проверяется/i);
    expect(dictionaries.uz.seriesPlan.entry.template.notice).toMatch(/soʻrov/i);
    expect(dictionaries.uz.seriesPlan.entry.template.notice).toMatch(/tekshirilmaydi/i);
  });
});

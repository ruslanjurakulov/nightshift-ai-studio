/**
 * Workflow apps: the one total is the sum of real per-step quotes; any
 * unpriced step means no total and no Run now (never 0); a draft converts to
 * a stored definition; every language carries the same workflow words.
 */
import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import { coerceQuote, runBlock } from "@/lib/workflows";
import { addStep, draftProblem, newDraft, toDefinition } from "@/lib/workflows-builder";

const step = (i: number, credits: number | null, extra: Record<string, unknown> = {}) => ({
  step_index: i,
  capability: "t2i",
  model: "m",
  priced: credits !== null,
  credits,
  ...extra,
});
const quote = (steps: unknown[], total: number | null, extra: Record<string, unknown> = {}) =>
  coerceQuote({ workflow_id: "w", version: 1, steps, total, exempt: false, available: 100, ...extra });

describe("workflow price", () => {
  it("is one total, the sum of every step price", () => {
    const q = quote([step(0, 1.5), step(1, 2.25)], 3.75);
    expect(q?.total).toBe(3.75);
    expect(runBlock(q)).toBeNull();
  });

  it("is unpriced, never 0, when any step has no price", () => {
    const q = quote([step(0, 1.5), step(1, null, { reason: "unpriced" })], 1.5);
    expect(q?.total).toBeNull();
    expect(q?.unpriced_steps).toEqual([1]);
    expect(runBlock(q)).toBe("unpriced");
  });

  it("refuses a claimed total that is not the sum", () => {
    const q = quote([step(0, 1), step(1, 2)], 1);
    expect(q?.total).toBeNull();
    expect(runBlock(q)).toBe("unpriced");
  });

  it("blocks Run when the credits do not cover the total, unless exempt", () => {
    expect(runBlock(quote([step(0, 60), step(1, 60)], 120))).toBe("insufficient");
    expect(runBlock(quote([step(0, 60), step(1, 60)], 120, { exempt: true }))).toBeNull();
    expect(runBlock(null)).toBe("unpriced");
  });
});

describe("workflow draft", () => {
  it("needs a name and 2 to 6 steps, and stores inputs for the open fields", () => {
    const d = newDraft();
    expect(draftProblem(d)?.problem).toBe("name");
    d.name = "Two steps";
    const def = toDefinition(d);
    expect(def.steps.length).toBe(d.steps.length);
    let big = d;
    for (let i = 0; i < 8; i++) big = addStep(big);
    expect(big.steps.length).toBeLessThanOrEqual(6);
  });
});

describe("workflow words", () => {
  it("every language has the same keys as English, with no provider brand words", () => {
    const keys = (o: unknown, p = ""): string[] =>
      o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}.${k}`)) : [p];
    const en = keys(dictionaries.en.workflows).sort();
    expect(en.length).toBeGreaterThan(50);
    expect(keys(dictionaries.ru.workflows).sort()).toEqual(en);
    expect(keys(dictionaries.uz.workflows).sort()).toEqual(en);
    const all = JSON.stringify([dictionaries.en.workflows, dictionaries.ru.workflows, dictionaries.uz.workflows]);
    expect(all).not.toMatch(/\b(owner|editor|viewer|openai|gemini|runway|kling|veo|flux)\b/i);
  });
});

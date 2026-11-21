/**
 * The run gate's age refusals (migrations 0192/0196) on the two screens that start a run themselves: a series episode
 * (start_series_episode) and a scene repair (request_scene_regenerate). Both write a render_jobs row, and the run gate refuses it
 * with a fixed word. What would break: the person reads "failed" / "Something went wrong" with no remedy (rule 6), when the fix is
 * one box on Create. Ledger BR-832-01.
 */
import { describe, expect, it } from "vitest";
import { startError } from "@/lib/seriesPlan";
import { mapRegenError, regenErrorText } from "@/lib/sceneRegenerate";
import { dictionaries } from "@/lib/i18n";

const WORDS = ["adult_attestation_required", "adult_only_service"] as const;

describe("a series episode", () => {
  it.each(WORDS)("names %s instead of failed, with copy in every language", (word) => {
    expect(startError({ code: "NS400", message: word }).key).toBe(word);
    for (const [loc, d] of Object.entries(dictionaries)) {
      const text = d.seriesPlan.start.errors[word];
      expect(text, loc).toBeTruthy();
      expect(text, loc).not.toBe(d.seriesPlan.start.errors.failed);
    }
  });
  it("still reads an unknown word as failed (nothing is guessed)", () => {
    expect(startError({ code: "NS400", message: "something_else" }).key).toBe("failed");
  });
});

describe("a scene repair", () => {
  it("maps the words to 428 / 403, not regen_failed", () => {
    expect(mapRegenError({ code: "NS400", message: "adult_attestation_required" })).toEqual({ status: 428, body: { error: "adult_attestation_required" } });
    expect(mapRegenError({ code: "NS400", message: "adult_only_service" })).toEqual({ status: 403, body: { error: "adult_only_service" } });
  });
  it.each(WORDS)("says %s in every language, naming Create for the answer", (word) => {
    for (const [loc, d] of Object.entries(dictionaries)) {
      const text = regenErrorText({ error: word }, d.sceneRegen);
      expect(text, loc).not.toBe(d.sceneRegen.errors.failed);
      if (word === "adult_attestation_required") expect(text, loc).toMatch(/18\+/);
    }
  });
});

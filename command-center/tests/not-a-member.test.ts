/**
 * Migration 0226's refusal where it reaches a person or an assistant: a platform owner or admin with no seat in a workspace reads it
 * (support access) but never spends its credits, and every spend path refuses with NS400 `not_a_member` before anything is held.
 *
 * What would break: the refusal reading as the path's generic NS400 ("This quality is not priced yet" for a download, "bad request"
 * for an export or a scan, "invalid params" for a generation) or as a retryable failure ("could not hold credits") although nothing
 * was wrong with the request and a retry can never work; a language without the sentence; the public API's spec not naming the code.
 */
import { describe, expect, it } from "vitest";
import { mapDownloadError } from "@/lib/downloads";
import { mapStoryboardError, storyboardErrorText } from "@/lib/storyboardReview";
import { mapRegenError, regenErrorText } from "@/lib/sceneRegenerate";
import { mapRepurposeError, repurposeErrorText } from "@/lib/repurpose";
import { startError } from "@/lib/seriesPlan";
import { mapEditorError } from "@/lib/editor";
import { mapScanError } from "@/lib/adsFactory/scan";
import { mapSwapError } from "@/lib/characterStudio/model";
import { mapCreativeError } from "@/lib/creative/operations";
import { mapWorkflowError } from "@/lib/workflows-operations";
import { creditRunError } from "@/lib/credits";
import { oauthRefusalText } from "@/lib/api/mcp-oauth";
import { openApiSpec } from "@/lib/api/openapi";
import { dictionaries } from "@/lib/i18n";
import { seriesPlanEn } from "@/lib/i18n/series-plan/en";
import { seriesPlanRu } from "@/lib/i18n/series-plan/ru";
import { seriesPlanUz } from "@/lib/i18n/series-plan/uz";
import { adsBrandScanEn } from "@/lib/i18n/ads-brand-scan/en";
import { adsBrandScanRu } from "@/lib/i18n/ads-brand-scan/ru";
import { adsBrandScanUz } from "@/lib/i18n/ads-brand-scan/uz";
import { characterStudioEn } from "@/lib/i18n/character-studio/en";
import { characterStudioRu } from "@/lib/i18n/character-studio/ru";
import { characterStudioUz } from "@/lib/i18n/character-studio/uz";

const REFUSED = { code: "NS400", message: "not_a_member", details: "you are not an owner or admin member of this workspace" };
const LOCALES = ["en", "ru", "uz"] as const;

describe("each spend path's map reads not_a_member as itself, 403, never as its generic NS400", () => {
  it("download (NS400 alone is unpriced)", () => {
    expect(mapDownloadError(REFUSED)).toEqual({ error: "not_a_member", status: 403 });
    expect(mapDownloadError({ code: "NS400", message: "downloads in 1080p are not priced yet" })).toEqual({ error: "unpriced", status: 409 });
  });

  it("storyboard approval, scene repair, repurpose", () => {
    expect(mapStoryboardError(REFUSED)).toEqual({ status: 403, body: { error: "not_a_member" } });
    expect(mapRegenError(REFUSED)).toEqual({ status: 403, body: { error: "not_a_member" } });
    expect(mapRepurposeError(REFUSED)).toEqual({ status: 403, body: { error: "not_a_member" } });
  });

  it("series episode start", () => {
    expect(startError(REFUSED)).toEqual({ key: "not_a_member" });
  });

  it("paid export (NS400 alone is bad_request)", () => {
    expect(mapEditorError(REFUSED)).toEqual({ error: "not_a_member", status: 403 });
    expect(mapEditorError({ code: "NS400", message: "something else" })).toEqual({ error: "bad_request", status: 400 });
  });

  it("brand scan and character swap", () => {
    expect(mapScanError(REFUSED)).toEqual({ error: "not_a_member", status: 403 });
    expect(mapSwapError(REFUSED)).toEqual({ error: "not_a_member", status: 403 });
  });

  it("a generation and a workflow run (NS400 alone is invalid_params)", () => {
    expect(mapCreativeError(REFUSED)).toMatchObject({ status: 403, body: { error: "not_a_member" } });
    expect(mapWorkflowError(REFUSED)).toMatchObject({ status: 403, body: { error: "not_a_member" } });
  });
});

describe("every language says it, with its own words", () => {
  const seen = (texts: string[]) => {
    for (const t of texts) expect(t, "a sentence").toBeTruthy();
    expect(new Set(texts).size, "three languages, three sentences").toBe(3);
  };

  it("run, storyboard, scene repair, repurpose, download, generation, workflow step, API key, export", () => {
    const d = LOCALES.map((l) => dictionaries[l]);
    seen(d.map((x) => creditRunError({ error: "not_a_member" }, x) ?? ""));
    seen(d.map((x) => storyboardErrorText({ error: "not_a_member" }, x.storyboardReview)));
    seen(d.map((x) => regenErrorText({ error: "not_a_member" }, x.sceneRegen)));
    seen(d.map((x) => repurposeErrorText({ error: "not_a_member" }, x.repurpose)));
    seen(d.map((x) => (x as unknown as { publish: { dl: { errors: Record<string, string> } } }).publish.dl.errors.not_a_member));
    seen(d.map((x) => (x.creative.errors as Record<string, string>).not_a_member));
    seen(d.map((x) => (x.workflows.stepErrors as Record<string, string>).not_a_member));
    seen(d.map((x) => findKey(x, "keyNotAMember")));
    seen(d.map((x) => findKey(x, "not_a_member", "export_needs_quote")));
  });

  it("series, brand scan, character swap", () => {
    seen([seriesPlanEn, seriesPlanRu, seriesPlanUz].map((x) => x.start.errors.not_a_member));
    seen([adsBrandScanEn, adsBrandScanRu, adsBrandScanUz].map((x) => (x.errors as Record<string, string>).not_a_member));
    seen([characterStudioEn, characterStudioRu, characterStudioUz].map((x) => (x.errors as Record<string, string>).not_a_member));
  });

  it("Uzbek writes the okina and the apostrophe as letters (U+02BB, U+02BC), never a quote mark", () => {
    const uz = [
      creditRunError({ error: "not_a_member" }, dictionaries.uz) ?? "",
      seriesPlanUz.start.errors.not_a_member,
      (adsBrandScanUz.errors as Record<string, string>).not_a_member,
      (characterStudioUz.errors as Record<string, string>).not_a_member,
    ];
    for (const t of uz) {
      expect(t).toContain("aʼzo");
      expect(t).not.toMatch(/a['’ʻ]zo/);
    }
  });
});

describe("the public API and a connected assistant", () => {
  it("the spec lists the code", () => {
    expect(JSON.stringify(openApiSpec("https://nightshift-ai.studio"))).toContain('"not_a_member"');
  });

  it("an assistant is told who must connect instead, and that nothing was charged", () => {
    const text = oauthRefusalText({ ok: false, status: 403, code: "not_a_member", message: "", details: {} }, "https://nightshift-ai.studio");
    expect(text).toMatch(/not a member of its workspace/);
    expect(text).toMatch(/Nothing was started or charged/);
  });
});

/** The value of `key` anywhere in a dictionary (optionally inside the object that also holds `near`), for the copy whose section is deep. */
function findKey(node: unknown, key: string, near?: string): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  if (typeof o[key] === "string" && (!near || near in o)) return o[key] as string;
  for (const v of Object.values(o)) {
    const hit = findKey(v, key, near);
    if (hit) return hit;
  }
  return "";
}

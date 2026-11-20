/**
 * The adult attestation's refusals (migration 0192) where they reach a person or an assistant outside the Studio's own panel.
 *
 * What would break: a minor's download reading as "This quality is not priced yet" (0192's download gate raises NS400 with its
 * own word, and NS400 alone meant "unpriced"); the public API's spec not naming the two codes it now answers; a connected
 * assistant told a generic failure instead of what the person can do.
 */
import { describe, expect, it } from "vitest";
import { mapDownloadError } from "@/lib/downloads";
import { oauthRefusalText } from "@/lib/api/mcp-oauth";
import { openApiSpec } from "@/lib/api/openapi";
import { dictionaries } from "@/lib/i18n";

const ORIGIN = "https://nightshift-ai.studio";

describe("downloads", () => {
  it("a minor's refused download is adult_only_service (403), not unpriced", () => {
    expect(mapDownloadError({ code: "NS400", message: "adult_only_service" })).toEqual({ error: "adult_only_service", status: 403 });
    expect(mapDownloadError({ code: "NS400", message: "downloads in 1080p are not priced yet" })).toEqual({ error: "unpriced", status: 409 });
  });

  it("the refusal has copy in every language, and it names support", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const errors = (dictionaries[loc] as unknown as { publish: { dl: { errors: Record<string, string> } } }).publish.dl.errors;
      expect(errors.adult_only_service, loc).toBeTruthy();
      expect(errors.adult_only_service, loc).toMatch(/18/);
    }
    expect((dictionaries.en as unknown as { publish: { dl: { errors: Record<string, string> } } }).publish.dl.errors.adult_only_service).toMatch(/support/);
  });
});

describe("the public API's spec", () => {
  it("lists both adult codes", () => {
    const spec = JSON.stringify(openApiSpec("https://nightshift-ai.studio"));
    expect(spec).toContain('"adult_attestation_required"');
    expect(spec).toContain('"adult_only_service"');
  });
});

describe("a connected assistant's Studio refusals", () => {
  it("adult_attestation_required says the person confirms their age in the app, with the link", () => {
    const text = oauthRefusalText({ ok: false, status: 428, code: "adult_attestation_required", message: "", details: {} }, ORIGIN, { studio: "create" });
    expect(text).toMatch(/adults only/);
    expect(text).toMatch(/cannot confirm it for them/);
    expect(text).toContain(`${ORIGIN}/studio`);
    expect(text).toMatch(/Nothing was quoted or charged/);
  });

  it("adult_only_service says the service is for adults and names support", () => {
    const text = oauthRefusalText({ ok: false, status: 403, code: "adult_only_service", message: "", details: {} }, ORIGIN, { studio: "other" });
    expect(text).toMatch(/for adults \(18 or older\)/);
    expect(text).toMatch(/contact support/);
    expect(text).toContain(ORIGIN);
  });
});

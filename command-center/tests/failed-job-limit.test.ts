import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import { CREATIVE_ERRORS, mapCreativeError } from "@/lib/creative/operations";
import { failedJobLimitText, parseFailedJobLimit } from "@/lib/creative/failed-job-limit";
import { mapWorkflowError } from "@/lib/workflows-operations";
import { WAIT_CODES, stepWaitCode, workflowErrorMessage } from "@/lib/workflows";
import { openApiSpec } from "@/lib/api/openapi";
import { STUDIO_REMEDIES } from "@/lib/api/mcp";

// The failed-job cap (migration 0175). What would break, and which test says so: the refusal read as "your plan's runs are
// busy" (the remedy would be wrong: upgrading changes nothing); a count or a time shown when the database's detail could not be
// read (CLAUDE.md rule 5: never a number for an unknown); the app and the database disagreeing on the detail's shape; a sentence
// missing in a language; a waiting workflow step shown as waiting for credits; the public API or MCP not naming the code.

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/0175_failed_job_cap.sql"), "utf8");
const DETAIL = "failed=6 limit=5 retry_at=2026-11-15T18:42:07Z";

describe("the database's detail", () => {
  it("is read exactly as creative_failed_job_gate writes it", () => {
    // The format the gate writes, pinned against the migration itself.
    expect(SQL).toContain("format('failed=%s limit=%s retry_at=%s'");
    expect(SQL).toContain(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`);
    expect(parseFailedJobLimit(DETAIL)).toEqual({
      failed: 6,
      limit: 5,
      retryAt: "2026-11-15T18:42:07Z",
      date: "2026-11-15",
      time: "18:42",
    });
  });

  it.each([undefined, null, 5, "", "failed=5", "failed=x limit=5 retry_at=2026-11-15T18:42:07Z", "failed=5 limit=5 retry_at=tomorrow",
    "failed=5 limit=5 retry_at=2026-11-15T18:42:07+05:00", "active=1 limit=1"])("reads %j as unknown, never as a number", (d) => {
    expect(parseFailedJobLimit(d)).toBeNull();
  });
});

describe("the route's answer", () => {
  it("maps NS429 failed_job_limit to 429 failed_job_limit with the count, the limit and the time", () => {
    expect(CREATIVE_ERRORS).toContain("failed_job_limit");
    const out = mapCreativeError({ code: "NS429", message: "failed_job_limit", details: DETAIL });
    expect(out.status).toBe(429);
    expect(out.body).toEqual({ error: "failed_job_limit", failed: 6, limit: 5, retry_at: "2026-11-15T18:42:07Z", detail: DETAIL });
  });

  it("says null, not 0, when the detail cannot be read", () => {
    const out = mapCreativeError({ code: "NS429", message: "failed_job_limit", details: "garbled" });
    expect(out.body).toMatchObject({ error: "failed_job_limit", failed: null, limit: null, retry_at: null });
  });

  it("keeps the plan's run limit as its own answer", () => {
    const out = mapCreativeError({ code: "NS429", message: "run limit", details: "active=1 limit=1" });
    expect(out.body).toEqual({ error: "run_limit_reached", active: 1, limit: 1 });
  });

  it("is the same for a workflow start", () => {
    const out = mapWorkflowError({ code: "NS429", message: "failed_job_limit", details: DETAIL });
    expect(out.status).toBe(429);
    expect(out.body).toMatchObject({ error: "failed_job_limit", failed: 6 });
  });
});

describe("the sentence, in en / ru / uz", () => {
  for (const [lang, t] of Object.entries(dictionaries)) {
    it(`${lang}: names the count, the limit, the UTC time and the remedy, and no number without the detail`, () => {
      const known = failedJobLimitText(t, DETAIL);
      expect(known).toContain("6");
      expect(known).toContain("5");
      expect(known).toContain("2026-11-15 18:42 UTC");
      expect(known).not.toMatch(/\{\w+\}/);
      const unknown = failedJobLimitText(t, "garbled");
      expect(unknown).toBe(t.creative.failedJobLimit.unknown);
      expect(unknown.replace(/24/g, "")).not.toMatch(/\d/);
      expect(t.creative.errors.failed_job_limit.replace(/24/g, "")).not.toMatch(/\d/);
      // A workflow start refused this way reads the same words when no detail came with it.
      expect(workflowErrorMessage(t, "failed_job_limit")).toBe(t.creative.errors.failed_job_limit);
    });

    it(`${lang}: the templates carry the same placeholders as English`, () => {
      const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const en = dictionaries.en;
      expect(holes(t.creative.failedJobLimit.counted)).toEqual(holes(en.creative.failedJobLimit.counted));
      expect(holes(t.workflows.runPage.waitingFailedJobs)).toEqual(holes(en.workflows.runPage.waitingFailedJobs));
      expect(t.workflows.waitReasons.failed_job_limit).toBeTruthy();
      expect(t.workflows.stepErrors.failed_job_limit).toBeTruthy();
    });
  }
});

describe("a workflow step that waits", () => {
  it("waits under the cap's own word, not as the run limit or credits", () => {
    expect(WAIT_CODES).toContain("failed_job_limit");
    expect(stepWaitCode({ status: "pending", error_code: "failed_job_limit" })).toBe("failed_job_limit");
    expect(stepWaitCode({ status: "failed", error_code: "failed_job_limit" })).toBeNull();
  });
});

describe("the public API and the MCP server", () => {
  it("list the code and give the remedy", () => {
    expect(JSON.stringify(openApiSpec("https://example.test"))).toContain('"failed_job_limit"');
    expect(STUDIO_REMEDIES.failed_job_limit).toMatch(/retry_at/);
    expect(STUDIO_REMEDIES.failed_job_limit).toMatch(/do not retry before/);
    // The database's own sentence (api_creative_refusal) says the same thing.
    expect(SQL).toContain("Nothing was held or charged. Try again after %s %s UTC");
  });
});

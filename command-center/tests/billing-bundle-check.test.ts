import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * scripts/billing-bundle-check.mjs against a fake `.next` tree. The real lib/billing.ts is copied in, so the vendor URLs,
 * the credit price and the routing pairs the script looks for are the real ones. Each leak form here is one a check that
 * matched only field names, only one quote style or only the manifest's page lists would have let through.
 */
const CC = process.cwd();
const SCRIPT = path.join(CC, "scripts", "billing-bundle-check.mjs");
const roots: string[] = [];

function fakeBuild(opts: { billingSource?: string } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "billing-check-"));
  roots.push(root);
  mkdirSync(path.join(root, "lib"));
  writeFileSync(path.join(root, "lib", "billing.ts"), opts.billingSource ?? readFileSync(path.join(CC, "lib", "billing.ts"), "utf8"));
  for (const f of ["providers.ts", "model-keys.ts"]) copyFileSync(path.join(CC, "lib", f), path.join(root, "lib", f));
  const chunks = path.join(root, ".next", "static", "chunks");
  mkdirSync(path.join(chunks, "app", "(app)", "[channel]", "billing"), { recursive: true });
  mkdirSync(path.join(chunks, "app", "pricing"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(path.join(chunks, `${i}-filler.js`), `self.x${i}={a:.01,b:"ok"};`);
  writeFileSync(path.join(chunks, "app", "(app)", "[channel]", "billing", "page-abc.js"), 'fetch("/api/billing/settings",{payUrl:e.payUrl})');
  writeFileSync(path.join(chunks, "app", "pricing", "page-def.js"), "self.p=1;");
  mkdirSync(path.join(root, ".next", "server", "pages"), { recursive: true });
  writeFileSync(path.join(root, ".next", "server", "pages", "500.html"), "<html>500</html>");
  return root;
}

const put = (root: string, rel: string, text: string) => {
  const file = path.join(root, ".next", rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const run = (root: string) => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("billing-bundle-check", () => {
  it("passes a clean build (and a stray .01 or a vendor name alone is not a leak)", () => {
    const root = fakeBuild();
    put(root, "static/chunks/77-models.js", 'const m={name:"Runway",kind:"video"};');
    expect(run(root)).toMatchObject({ code: 0 });
  });

  it.each([
    ["a quoted routing key", "static/chunks/5-a.js", 'var r={"bytedance":"seedance"};', "routing bytedance->seedance"],
    ["a minified literal", "static/chunks/6-b.js", 'runway:{name:"Runway",billingUrl:"https://dev.runway.com/",creditUsd:.01}', "creditUsd"],
    ["an escaped JSON string", "static/chunks/7-c.js", 'JSON.parse("{\\"alibaba\\":\\"wan\\"}")', "routing alibaba->wan"],
    ["a renamed price next to its vendor", "static/chunks/8-d.js", 'x={id:"runway",title:"Runway",p:1e-2}', "credit price of Runway"],
    ["a lazy chunk no manifest lists", "static/chunks/9999-lazy.js", 'e.u="https://console.volcengine.com/finance"', "console.volcengine.com"],
    ["a prerendered .rsc payload", "server/app/pricing.rsc", '1:{"google":"gemini"}', "routing google->gemini"],
    ["a prerendered .html page", "server/app/index.html", '<a href="https://elevenlabs.io/app/subscription">', "elevenlabs.io/app/subscription"],
  ])("fails on %s", (_label, rel, text, expected) => {
    const root = fakeBuild();
    put(root, rel, text);
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(expected);
  });

  it("does not count a URL that is also the vendor's API-key console (lib/providers.ts, lib/model-keys.ts)", () => {
    const root = fakeBuild();
    put(root, "static/chunks/10-keys.js", 'k={consoleUrl:"https://kling.ai/dev"}');
    expect(run(root).code).toBe(0);
  });

  // Positive controls: a pass must never come from scanning nothing, or from a source the script can no longer read.
  it("exits 2 when the static directory is not a whole build", () => {
    const root = fakeBuild();
    rmSync(path.join(root, ".next", "static"), { recursive: true });
    mkdirSync(path.join(root, ".next", "static"));
    expect(run(root).code).toBe(2);
  });

  it("exits 2 when the Billing board is not in the build", () => {
    const root = fakeBuild();
    put(root, "static/chunks/app/(app)/[channel]/billing/page-abc.js", "self.b=1;");
    expect(run(root).code).toBe(2);
  });

  it("exits 2 when lib/billing.ts is no longer server-only", () => {
    const src = readFileSync(path.join(CC, "lib", "billing.ts"), "utf8").replace('import "server-only";', "");
    expect(run(fakeBuild({ billingSource: src })).code).toBe(2);
  });

  it("exits 2 when lib/billing.ts no longer has the routing map it reads", () => {
    const src = readFileSync(path.join(CC, "lib", "billing.ts"), "utf8").replace("export const REGISTRY_BILLING", "export const RENAMED");
    expect(run(fakeBuild({ billingSource: src })).code).toBe(2);
  });
});

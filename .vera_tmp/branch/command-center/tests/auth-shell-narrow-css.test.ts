import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Sign-in, sign-up, forgot-password and reset-password share `.st-auth`. Its
// one column used to be an implicit `auto` track, so the form's inputs (about
// 262px wide as built) became the page's minimum width and a 320px phone
// scrolled sideways (340px page). The track must be allowed to shrink.
const site = readFileSync(join(__dirname, "..", "components/site/site.css"), "utf8");
const next = readFileSync(join(__dirname, "..", "components/site/site-next.css"), "utf8");

describe(".st-auth on a narrow screen", () => {
  it("has a single column that can shrink below its content", () => {
    const rule = site.match(/\n\.st-auth \{([^}]*)\}/);
    expect(rule, ".st-auth rule").not.toBeNull();
    expect(rule![1]).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it("keeps the two-column layout for wide screens", () => {
    expect(site).toMatch(/@media \(min-width: 960px\) \{\s*\.st-auth \{ grid-template-columns: minmax\(0, 0\.9fr\) minmax\(0, 1\.1fr\); \}/);
    expect(next).toMatch(/@media \(min-width: 960px\) \{\s*\.nx\.st-auth \{ grid-template-columns: minmax\(0, 0\.95fr\) minmax\(0, 1\.05fr\); \}/);
  });

  it("does not hide the overflow instead of fixing it", () => {
    for (const sel of [/\.st-auth\s*\{[^}]*overflow-x/, /\.st-auth-main\s*\{[^}]*overflow-x/]) {
      expect(site).not.toMatch(sel);
      expect(next).not.toMatch(sel);
    }
  });
});

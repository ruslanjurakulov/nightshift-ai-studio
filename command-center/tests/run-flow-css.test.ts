/**
 * The "waiting" look of the run confirms must live in globals.css (Agents and
 * Command Center never load create/flow.css), and must not restyle other
 * aria-disabled primaries (the Library's upload label keeps its own look).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the waiting look of the run confirms", () => {
  const globals = read("app/globals.css");

  it("is in the always-loaded stylesheet, scoped to the create confirm and Run now's held confirm only", () => {
    expect(globals).toMatch(/\.fl-go\[aria-disabled="true"\],\s*\.btn-primary\[data-price-hold="loading"\]\s*\{[^}]*opacity: 0\.6/);
    expect(read("components/create/flow.css")).not.toContain("aria-disabled");
  });

  it("no rule dims every aria-disabled primary (that would restyle the Library's busy label)", () => {
    expect(globals).not.toMatch(/\.btn-primary\[aria-disabled="true"\]\s*[,{]/);
  });

  it("an aria-disabled primary does not brighten on hover", () => {
    expect(globals).toContain('.btn-primary:hover:not([aria-disabled="true"])');
    expect(globals).toContain('.studio-cta:hover:not(:disabled):not([aria-disabled="true"])');
    const redesign = read("app/(app)/app-redesign.css");
    expect(redesign).toContain('.btn-primary:hover:not([aria-disabled="true"])');
    expect(redesign).toContain('.studio-cta:hover:not(:disabled):not([aria-disabled="true"])');
  });
});

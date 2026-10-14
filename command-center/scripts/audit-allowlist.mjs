// Dev-tree advisories the "Dependency advisories" gate (audit-gate.mjs) lets pass, each with a reason and a date.
// An entry that has expired fails the gate again; an advisory that ships to production is never allowed.
export const ALLOWLIST = [
  {
    id: "GHSA-vfj7-8cjw-p6xm",
    reason:
      "braces <= 3.0.3 stack exhaustion on deeply nested patterns; no patched release exists; reached only through eslint-config-next -> @next/eslint-plugin-next -> fast-glob -> micromatch at lint time, never in the deployed app. Re-check when a fixed braces or a newer eslint-config-next ships.",
    expires: "2027-01-12",
  },
];

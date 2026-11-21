// Dev-tree advisories the "Dependency advisories" gate (audit-gate.mjs) lets pass, each with a reason and a date.
// An entry that has expired fails the gate again; an advisory that ships to production is never allowed.
// Empty on purpose: the braces entry was removed once the lockfile's braces 3.0.3 stopped being flagged.
// Add an entry here only for a high or critical dev advisory with no fix, and date it.
export const ALLOWLIST = [];

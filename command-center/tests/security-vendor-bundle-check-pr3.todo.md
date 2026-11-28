# vendor-bundle-check: forms left for PR 3 (the guard PR)

Found by Breach on #956 (tests/security-vendor-bundle-check-breach.test.ts). The fix round of #956 does not catch these,
and they are NOT written as skipped tests: each one must become a failing-then-passing case in that file when PR 3
makes scripts/vendor-bundle-check.mjs catch it. None of these forms is written by the product today.

1. **Interned model ids.** An effect's model order with each id held in a variable, so no two quoted ids are adjacent:
   `var v0="runway-gen4.5",v1="minimax-h3";x=[v0,v1]`. (A minifier can intern repeated strings like this.)

2. **Provider map as entries.** The whole display map as `[slug, name]` tuples:
   `new Map([["openai","OpenAI"],["bfl","Black Forest Labs"],...])` or `Object.entries(PROVIDER_NAMES)` serialized.

3. **Provider map as objects.** The whole display map as an array of `{ slug, name }` objects:
   `[{"slug":"openai","name":"OpenAI"},{"slug":"bfl","name":"Black Forest Labs"},...]`.

4. **Runtime-split strings (model ids and prompts).** An effect's model order or prompt assembled at run time from pieces
   (`["runway-","gen4.5"].join("")`, a template literal over variables). The ledger unit list as one split string IS
   caught (each vendor-named unit is flagged in any form) and is a passing test; the same trick on model ids or a prompt
   is not.

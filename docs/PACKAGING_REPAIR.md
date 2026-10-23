# Packaging repair

`modules/packaging_repair.py`. Switch: `NIGHTSHIFT_PACKAGING_REPAIR` (ON when empty; `off`, `0`, `false`, `no`,
`disabled`, `disable` or `none` restores the plain hold).

## The problem

In a real Chronos run (Actions run 40005569676) the fact-check held the video before the render with
`fact_check_flagged:3`. 37 of 42 claims were `likely_accurate`; the 5 flagged texts were all packaging the
generator wrote, none of them narration: the alternate opening (`hook_ab`, two sentences), the title, the A/B
title and the thumbnail text ("SECRET MAP FOUND!"). They asserted secrecy, discovery and resolution that nothing
supported. The gate was right to hold them. Of the five, three block (the two `hook_ab` sentences and the
thumbnail text) and two warn (a title and an A/B title the checker cannot judge as a bare phrase come back
`unverifiable`, which the gate treats as a warning, `fact_check_fragments_unverified:2`).

## What changed

1. **The generation rule** (`PACKAGING_CLAIM_RULE`), in the script prompt, the title planner's prompt and the
   repair prompt: no claim of secrecy, discovery, resolution or proof in the title, A/B title, alternate opening,
   hook sentence, description or thumbnail text unless the research notes in the prompt support it; prefer a
   question or a hedged-but-true framing. This is a prompt change. Its effect on real model output has not been
   measured.
2. **One repair pass.** When the early fact-check (the stop before the voice, stills and render) blocks on
   `fact_check_flagged:N` and on nothing else, and every flagged claim ships in a packaging text, those texts are
   rewritten once. The rewrite gets the flagged text, the checker's own reasoning, the narration and the research
   notes. The same fact-checker and the same grounding step then run on the rewritten claims only, and the same
   early gate (`publish_gate.evaluate_fact_check`) decides on the repaired script.
   * Passes: the run goes on with the rewritten texts in the script (they are what the voice, the A/B swap, the
     uploader and the final gate see). `script.json` (when a saved copy exists) and `fact_check.json` are
     re-saved, `packaging_repair.json` records the first round and the rewrites.
   * Still flagged, or blocked for any other reason: the run is held exactly as before, on the first round's
     script, flagged items and gate verdict, and `hold_detail.packaging_repair` also records the rewrites and what
     the re-check said.

## What it never does

* Edit narration, or run when any narration claim is flagged, any other block is present, or the checker could
  not read a batch.
* Change a verdict: an unchanged text keeps the checker's first verdict; a rewritten text gets the checker's own.
* Loosen or bypass the gate.
* Loop. Budget: one generation call (`stage = packaging_repair` in the cost ledger), at most one fact-check batch
  (only when the rewrite produced claims that were not already checked, at most 30), the grounding step once on
  those claims. A person-approved storyboard is never rewritten.

## `hold_detail.packaging_repair`

```
{
  "attempted": true,
  "status": "still_flagged" | "blocked_after_repair" | "generation_failed" | "unusable_rewrite"
          | "no_usable_rewrite" | "too_many_claims" | "recheck_misaligned" | "error:<Type>" | "repaired",
  "first_round":   [{"source", "verdict", "reasoning", "text"}],      // what was flagged, as hold_detail.flagged
  "rewrites":      [{"field", "before", "after"}],                    // each capped at 600 characters
  "calls":         {"generation": 1, "fact_check": 0 | 1},
  "rechecked":     N,                                                  // claims re-checked
  "blocks_after":  ["..."],                                            // the gate's blocks on the repaired script
  "still_flagged": [{"source", "verdict", "reasoning", "text"}],      // flagged after the rewrite
  "grounding":     {...}                                               // the re-check's evidence summary, when it ran
}
```

The key is absent when no repair was attempted (switch off, or the hold was not repairable). `hold_detail.flagged`
and `hold_detail.gate` stay the first round's. The `publish.blocked` event gains `packaging_repair: <status>`
only on a run where a repair was attempted. A run whose repair passed but is later held (auto publish off, say)
carries the same record on its row.

## Known limits

* Prompt effect unmeasured; the repair is the part that unblocks runs.
* `thumbnail_prompt_a` / `thumbnail_prompt_b` are image prompts, not claim sources, and are not rewritten.
* A rewritten opening is checked as the checker sees it (isolated sentences), exactly like the first.
* `shipped_description_unsupported` is a different, warning-only finding: a number or year in the description
  that the narration never says. The repair prompt forbids new figures in a rewritten description, and the gate
  re-checks them, but the warning is not a packaging-claim problem and is left as it was.

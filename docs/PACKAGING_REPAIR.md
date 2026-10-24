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
   measured. **The switch does NOT remove it:** `NIGHTSHIFT_PACKAGING_REPAIR=off` turns off the repair pass only;
   the rule stays in the generation prompts unconditionally (it only narrows what the model is asked to claim, and
   a prompt that changed with an environment variable would make two runs of one script incomparable).
2. **One repair pass.** When the early fact-check (the stop before the voice, stills and render) blocks on
   `fact_check_flagged:N` and on nothing else, and every flagged claim ships in a repairable packaging text (the
   title, the A/B title, the alternate opening, the hook sentence, the thumbnail text), those texts are rewritten
   once. The rewrite gets the flagged text, the checker's own reasoning, the narration and the research
   notes (all fenced as JSON inside `<data>`, `<` and `>` escaped, as the grounding prompt does). The same
   fact-checker and the same grounding step then run on the rewritten claims, and the same early gate
   (`publish_gate.evaluate_fact_check`) decides on the repaired script.
   * **The checker must see what ships.** The claim extractor deliberately skips a question, a sentence of three
     words or fewer and a call to action. So (a) a rewritten field that held a flagged claim and now yields no
     extracted claim is NOT used (its original text and verdict stay; if that claim was blocking the run is held
     as before, status `unchecked_rewrite` when no field is usable); and (b) on top of the extracted claims, the raw
     text of every rewritten field goes to the same checker: the whole text of a title, A/B title or thumbnail
     text, every sentence of an opening or hook sentence that the rewrite introduced.
     They enter the gate under the field's source, so an unverifiable opening sentence blocks and an unverifiable
     bare title stays the warning it always was.
   * **What ships is exactly what was checked.** The pipeline normalises text before the checker sees it (cue tags
     stripped, whitespace collapsed, sentences with no letter or digit dropped), and nothing strips a cue tag from
     a title or a thumbnail text before upload. So a rewrite is used only if it is plain text: any cue tag
     (`[SFX:..]`, `[MUSIC:..]`, `[PAUSE:..]`, `[VOICE:..]`, however spelled or nested; a repaired opening therefore
     has no cues), invisible, zero-width, bidi, control and separator characters, `<` and `>` (HTML tags and
     comments), markdown link syntax or a line break in a one-line field refuses it (`reason: "not_plain_text"`,
     the original stays). Whitespace runs are collapsed and the collapsed string is what is set on the script and
     what the checker is sent. A sentence of an opening or hook sentence is dropped from the check only if it is
     whitespace and punctuation alone; anything else without a letter or digit (an emoji, circled, squared,
     regional-indicator, Braille or parenthesized "spelling" of a word, a stray combining mark) is sent to the
     checker like any other sentence, and no letter-like symbol is ever an acceptable leftover.
   * **A re-check that could not be read is not a pass.** If any re-checked result is the checker's unresolved
     sentinel the repair stops (`recheck_unresolved`) and the run is held before the render, as today.
   * Passes: the run goes on with the rewritten texts in the script (they are what the voice, the A/B swap, the
     uploader and the final gate see). `script.json` (when a saved copy exists) and `fact_check.json` are
     re-saved, `packaging_repair.json` records the first round and the rewrites.
   * Still flagged, or blocked for any other reason: the run is held exactly as before, on the first round's
     script, flagged items and gate verdict, and `hold_detail.packaging_repair` also records the rewrites and what
     the re-check said.

## What it never does

* Edit narration or the description, or run when any narration or description claim is flagged, any other block
  is present, or the checker could not read a batch.
* Rewrite the description. It is multi-line free text consumed by three different publishers (the YouTube
  uploader, the social captions, the cross-post source) with three different line-stripping rules (a
  bullet-prefixed chapter line such as "- 0:00 A secret map was found" is skipped by the extractor and the
  uploader but kept by the social captions, which read the description from `script.json`), so that what ships is
  what was checked cannot be guaranteed cheaply. The real flagged items were the opening, the titles and the
  thumbnail text. **A flagged description, alone or together with titles or openings, means no repair at all:** the
  run is held exactly as before, with no extra call and no `packaging_repair` key (the repair is "not attempted",
  like any other hold that is not repairable).
* Change a verdict: an unchanged text keeps the checker's first verdict; a rewritten text gets the checker's own.
* Loosen or bypass the gate, or ship a rewritten text the checker did not see.
* Loop. A person-approved storyboard is never rewritten.

## Cost

Per repairable hold: one generation call, one fact-check batch (30 claims at most, else no repair) and, with
grounding on, one grounding judge call: about 3 Gemini calls. Worst case about 6, plus retries: the checker's
own split-and-retry on an unreadable batch adds up to 2 fact-check calls. The Gemini daily quota is a known
constraint; a run that is not repairable (any narration flagged, another block, the switch off) costs nothing
extra.

## `hold_detail.packaging_repair`

```
{
  "attempted": true,
  "status": "still_flagged" | "blocked_after_repair" | "generation_failed" | "unusable_rewrite"
          | "no_usable_rewrite" | "unchecked_rewrite" | "recheck_unresolved" | "too_many_claims"
          | "recheck_misaligned" | "error:<Type>" | "repaired",
  "first_round":   [{"source", "verdict", "reasoning", "text"}],      // what was flagged, as hold_detail.flagged
  "rewrites":      [{"field", "before", "after", "applied", "reason"?}], // each capped at 600 characters;
                                                                       // applied=false, reason: "no_checkable_claim" | "not_plain_text"
  "calls":         {"generation": 1, "fact_check": 0 | 1},
  "rechecked":     N,                                                  // claims re-checked (extracted + raw)
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
  that the narration never says. The description is not rewritten, and the warning is left as it was.
* Emoji sequences joined with a zero-width joiner (family and profession emoji) are refused with the other
  zero-width characters; single pictographs, with or without a variation selector, are accepted.

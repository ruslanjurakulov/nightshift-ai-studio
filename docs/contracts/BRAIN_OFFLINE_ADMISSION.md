# NS-399 — offline admission contract

Input: #804 commit `3253a55753000de3841a9e3162095f283c11db2a`,
tree `bf106fbc66e10e3f01374147df05a08e418407fd`.
This isolated module is unwired. Existing provider selector, parser and defaults
remain unchanged. No provider/client/action callback is accepted or called.

`check_admission` compares frozen request and approval snapshots against a
separately supplied trusted server scope and clock. It binds tenant reference,
project, task, plan revision and opaque plan bytes, explicit provider/model
revision, quote identity/version, policy version, expiration and purpose.
Only a matching nonexpired generation proposal can be
`eligible_for_further_review`; that value grants no execution authority.
Changes require renewed human approval. Audience proposals remain `review_only`,
including when someone supplies a matching approval snapshot. Their snapshot
cannot be reused as approval for a generation proposal.

Source design: #795 `AI_BRAIN_ARCHITECTURE.md` sections 4–6 and
`AI_SECURITY_POLICY.md` SEC-05 at head
`6c61d962086e1940b9c52ad27c5b6a72991f9605`. Reuse existing domain records;
there is no new approval persistence, authentication or dispatch backend.
The caller must establish server identity, human-approval provenance and current
domain authorization. Constructing these Python values does not establish them.

The NS-379 synthetic ASCII/integer golden bytes are reused only as opaque test
data. This module neither hashes client JSON nor implements a canonicalizer.
A future authoritative #795 canonicalizer must bind all generation-relevant
fields, pricing and policy, with full cross-runtime conformance. Whitespace-different
opaque bytes conservatively require review here. Model-reference strings are
bindings, not evidence of provider qualification or actual immutability.

Focused tests:

```sh
python3 -m unittest tests.test_brain_admission_contract -v
python3 -m unittest tests.test_series_provider_selection -v
```

All data is synthetic. No live identity, provider, action, billing, runner,
database or production enforcement is tested. Future runtime wiring requires
owner-reviewed trusted-record mapping, canonicalizer and live domain checks.

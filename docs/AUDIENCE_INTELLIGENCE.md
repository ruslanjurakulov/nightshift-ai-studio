# Audience Intelligence — P0 integration specification

Status: **documentation only; no automation or configuration is enabled**.
Evidence date: 2026-11-15; repository baseline
`f985b3afd371c0677357670da436ef2074fdb036` (migration files through 0174;
applied production state unknown). Extend the existing comment inbox rather than create
another inbox, approval path or billing ledger. Related specifications:
[Channel Intelligence](CHANNEL_INTELLIGENCE.md),
[Reporting Intelligence](REPORTING_INTELLIGENCE.md),
[Intelligence](INTELLIGENCE.md), [Social setup](SOCIAL_SETUP.md).

## Current implementation

`modules/comment_intelligence.py` classifies sentiment, question/topic request,
praise, criticism, spam/off-topic and possible injection. Its `classified`
state distinguishes unresolved output from an actual verdict.
`modules/audience_demand.py` groups topic requests; the intelligence poll filters
flagged and unclassified input before producing demand signals.

`modules/comment_replies.py`, migration `0081_comment_inbox.sql`, the inbox UI
and `command-center/app/api/inbox/comments/[comment]/draft/route.ts` implement
quoted draft requests and explicit exact-text reply approval. The queue worker
syncs recent YouTube comments, drafts only requested work and posts only approved
text. `NIGHTSHIFT_COMMENT_INBOX` is default off. Existing rate/quota limits,
token ownership checks, holds/refunds and ambiguous-post reconciliation remain
authoritative. This audit did not verify production activation.

The model has no tools, URL fetching or credentials in the reply prompt. Reply
output is bounded and checked for links, mentions and sensitive-looking data;
the database checks again. Prompt JSON encoding helps delimit data but does not
make a language model immune to injection. Safety rests on limited authority,
backend validation and a human approving the final text.

A stored language classification, dedicated complaint/privacy/danger escalation
workflow and rule-based automatic reply mode were not found. Language matching
exists as a drafting instruction, not a measured language detection service.

## Platform boundaries

Start with the existing YouTube adapter. [YouTube comments.insert](https://developers.google.com/youtube/v3/docs/comments/insert)
was checked on 2026-11-15: posting a reply requires authorization including
`youtube.force-ssl` and costs 50 quota units. Do not blindly retry an ambiguous
post; retain the existing reconcile-first behavior.

[Instagram comment moderation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation/)
supports comments on app-user-owned media with appropriate professional-account
permissions (`instagram_business_manage_comments` for Instagram Login) and
Advanced Access for customer accounts the app does not own/manage. Current
Nightshift OAuth requests publishing permissions, not moderation. Treat an
Instagram inbox as unavailable until consent, review, adapter and reconciliation
are verified. TikTok commercial comment/reply access was not verified; no
scraping or Research API substitution is authorized. See the full permission
matrix in [Channel Intelligence](CHANNEL_INTELLIGENCE.md).

## Proposed synchronization and classification contract

The following are logical design records only, **not migrations**:

- Comment envelope: server-derived tenant/channel/platform, source comment and
  parent ids, source version/timestamps, cleaned display text, deletion state,
  sync cursor, provenance and retention policy. Keep source IDs scoped by
  platform/account; a display name is not identity or authorization.
- Classification: language/uncertainty, sentiment, intent, spam likelihood,
  complaint/privacy/safety flags, model/version, classification status and
  evidence references. Unknown is a state, not a safe/neutral verdict.
- Review case: category, severity, permitted reviewer role, state, response
  deadline, reason codes and decision audit trail; do not copy sensitive raw
  text into general logs or reports.
- Reply proposal: source version, exact text, channel voice version, rule/model
  version, quote/hold references, approval digest, expiry and post outcome.

Use provider cursors, deduplication, edited/deleted-comment handling and bounded
backfills. A replay must neither create a second reply nor another charge.
Store only necessary personal data, apply retention/deletion rules, and retain
minimal non-sensitive action evidence where policy permits. A changed/deleted
source invalidates pending work or routes it to re-review; it never silently
retargets an approved reply.

## Reply modes and escalation

| Mode | Required behavior |
| --- | --- |
| Manual | A person writes and approves the exact final reply. Existing permission and posting gates remain. |
| AI-assisted approval | A person requests a quoted draft, reviews/edits it and explicitly approves the final text. Drafting never authorizes posting. |
| Rule-based automatic | Future capability, default off, separately gated and reviewed. Only narrowly allowlisted low-risk intents with approved templates, budgets and expiry. An AI recommendation cannot enable it. |

Complex complaints, personal/confidential information, threats, self-harm or
other dangerous appeals, legal/medical/financial advice requests, unresolved
classification and suspected injection go to a human review case. They cannot
be automatically answered. Ordinary criticism must not be erased or treated as
spam merely because it is negative. A model confidence score alone cannot
authorize posting or override escalation.

For a future rules mode, owner approval must identify the exact rule revision,
channels, intent allowlist, template set, languages, daily reply/credit quotas,
time window and expiry. That scoped approval is not blanket permission for
other replies, publishing, generation or finance. Runtime records the exact
rendered text and rule evidence for every allowed action. A rule or template
change revokes the previous authorization. Rollout approval must explicitly
permit this bounded mode; approval of this document does not.

## Security and transaction boundary

Apply [AI Security Policy](AI_SECURITY_POLICY.md). External comments, quoted posts, links, attachments and retrieved content are
hostile data. Models receive the smallest necessary cleaned excerpt, no secrets
and no arbitrary tool access. Never execute instructions, code or URLs supplied
by comments. Deterministic policy checks operate outside the model and must
refuse unknown actions or fields; schema-valid output is still untrusted.

The server establishes actor, tenant and channel membership. The narrow tool
broker checks global/org/channel kill switches, allowlisted operation,
source ownership/version, escalation state, approval, quota and rate limits at
claim time and immediately before posting. A stop prevents new sends; an
already submitted external action is reconciled rather than assumed canceled.
Posting credentials are resolved only inside the existing adapter.

An approval binds SHA-256 of canonical content including actor/tenant/channel,
source identity/version, exact reply text, rule/model version where applicable,
quoted credits/limits and expiry. The backend, not the LLM, computes and verifies
the digest. Text edits, changed plan/model, new price or expired evidence require
reapproval. Existing billing quote/hold/capture/refund functions remain the only
credit authority; quote changes cannot be hidden by creating a new ledger.

## Acceptance and staged rollout

1. Preserve current manual/assisted behavior; confirm the default-off inbox and
   all posting prerequisites against fixtures before any activation.
2. Test cross-tenant source IDs, stale/edited/deleted comments, duplicate events,
   expired approval, changed reply text, changed quote and concurrent claims.
3. Injection fixtures include Unicode controls, instruction-like channel text,
   URLs and exfiltration requests; no model output can acquire a tool, another
   tenant's data or a posting authorization.
4. Escalation fixtures cover complaint, sensitive data, danger and unclassified
   results; none posts automatically. Reviewers see only authorized cases.
5. Simulate quota exhaustion, revoked consent, provider timeouts, unknown outcome
   and kill switches between claim and send. Reconciliation must prevent blind
   duplicate posts and charges.
6. Only after a reviewed implementation and explicit channel opt-in, pilot
   assisted mode. Rules mode requires a separate acceptance review, shadow
   matches with no sends, a small bounded canary and an immediate disable path.
   No Instagram/TikTok activation without approved capabilities.

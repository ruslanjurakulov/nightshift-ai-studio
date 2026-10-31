# Nightshift Ads Automation — Product Spec / MVP

## Intent
Deliver an original Nightshift workflow: brand kit → approved product catalog → multi-format campaign concept → direct model provider generation → editable assets → review gate → export/scheduling/analytics. Do NOT depend on Krea or Higgsfield API/reseller; their new Ad Studio is a benchmark, not a provider.

### Benchmark evidence (2026-10-29)
Krea's official announcement (https://www.krea.ai/blog/introducing-ad-studio) describes a website-to-editable-brand-kit flow; logo, palette, fonts, description, audience, selling points, Shopify products; 20 product limit; 12 static image ads per batch; 1:1, 4:5, 9:16, 16:9; edits via agent; campaign ZIP and MCP. This is benchmark evidence, NOT code or permission to copy Krea internals.

## Implemented in draft PR
`/ads-studio` is a noindex, standalone concept workspace:
- Manual editable brand fields (name, tagline, audience, voice, approved claim, color), optional display-only HTTPS URL.
- Up to 20 manually entered products, optional prices and **user-approved** selling points.
- 1:1, 4:5, 9:16, 16:9 format selection; 1–12 deterministic layout concepts; three directions.
- Responsive dark Nightshift look. Explicit concept-only labeling.
- **No** scraping, uploads, Supabase writes, image AI, API calls, credits, publishing, or downloads.
- `command-center/lib/ads-studio.test.ts` tests deterministic planning and input constraints.
- This route is currently an unauthenticated preview, not an enabled production SaaS service.

## Subsequent implementation gates
1. Authenticated workspace navigation, dashboard integration, draft persistence and RLS policies for owned brands/campaigns/products.
2. Consent-based website import via server-side constrained extraction pipeline. **Block SSRF**: HTTPS domain allowlist/denylists (localhost, private and link-local IPv4/IPv6, cloud metadata), DNS rebinding protection on every redirect/connection, time/byte caps, no arbitrary remote file references, sanitize HTML, no auto-execution; user must approve extracted claims before generation. Shopify use official authenticated APIs with appropriate scopes; no unauthorized scraping.
3. Upload hub with file type/size limits, scanned media, signed URLs, tenant quotas, rate limits, provenance/license metadata; avoid leaking protected assets.
4. Direct-provider abstraction with pricing, quotas, credit hold → settle/release, immutable cost log, no hidden overbilling. Provider integration only after contract and commercial redistribution rights verified.
5. Async rendering and template/editor handoff using existing Nightshift services, exact product representation where possible, truthful claims, preview and human review.
6. Publish gate OFF by default; no auto-post to platforms, follow per-channel consent, platform API rules and release gating.
7. Campaign batch retry/idempotency, per-placement exports, brand consistency checks and analytics after explicit user authorization.
8. MCP tools gated by scoped auth and tenancy with the same credit limits and review gate.

### Exit criteria before a production-ready claim
- Test and approve brand/claims; verified user-owned product data.
- No production access or billing by concept-only preview.
- Full isolated end-to-end tests for scraper, storage, provider failover, tenant RLS, credit ledger, rendering and editor handoff.
- No merge/deploy without successful CI and explicit owner approval.

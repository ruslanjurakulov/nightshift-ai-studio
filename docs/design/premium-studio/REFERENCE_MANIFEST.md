# Uploaded reference manifest and precedence

This documents the owner's uploaded visual input without adding large reference
images or replacement brand assets to the repository. The original archive and
all twelve images were opened during read-only planning. Files remain in the
private task attachment; a GitHub reviewer needs that supplied pack to inspect
pixel references. No screenshot in this pack is an application test result.

Archive: `Nightshift_Premium_UI_Mockups_and_Codex_Prompt.zip`.

Archive SHA-256: `cdf02054f6b00a9a2692afc4cdcc2aadb41b284b9cac6e25af135fe321d81344`.

`CODEX_MASTER_PROMPT.md` SHA-256: `e6ac20fdec5f184c0cd3464fb9093799885ce6d4bb28dc8f0ac1016f64a46dc9`.

`README_FIRST.md` SHA-256: `e70bc5f3cbbdf9b0111104d6086e4d4f7e3267c745f27919764e2aa2e45b7e10`.

## Image inventory

| Archive-relative file | Dimensions | SHA-256 |
|---|---|---|
| `01_premium_mockups/01_owner_executive_overview.png` | 1672 × 941 | `f17cbb82a00776b10e12e6856e284d97b066e2cf478b1b383d3ef8c3547157dc` |
| `01_premium_mockups/02_owner_api_model_intelligence.png` | 1672 × 941 | `56e41c97cac804e8fb71c8330a4fcef2ec226026702ab6ae38a1ed9a66dcdeae` |
| `01_premium_mockups/03_owner_customers.png` | 1672 × 941 | `2670f5160cff2faed141300a1a9e2f75655e321c1cfa3e03ea3883d53a9e0d3b` |
| `01_premium_mockups/04_owner_subscriptions_payments.png` | 1672 × 941 | `e8126a7e8cafde65016be1b2af6ec0f0577b7f47b85ca4c2e080d3b4ea5541c9` |
| `01_premium_mockups/05_owner_finance_profit.png` | 1672 × 941 | `120c42f79a06dab786fc61437a4ef1907ef8c136e823b08cb2cbe48e170ff916` |
| `01_premium_mockups/06_owner_infrastructure.png` | 1672 × 941 | `31d315152def63dc2412c664d29bf3eb55d13a42b0d5b50d75e2d199275c38e8` |
| `01_premium_mockups/07_owner_security_audit.png` | 1672 × 941 | `2b0acb1b36ac7172cdfb370b1409a21bc8e43ccc63c468be5060d4af9c4db570` |
| `01_premium_mockups/08_personal_studio_canvas_timeline.png` | 1672 × 941 | `dd183bb4a069f22d620d875e4cde0866e683fe36e00816295b4eb72900ac93b1` |
| `01_premium_mockups/09_customer_dashboard.png` | 1672 × 941 | `4fc25572c2c78fdb08afe0a1ff7d1962ebb841fb5a062bc280277f3ebf5c5665` |
| `01_premium_mockups/10_customer_studio_composer.png` | 1672 × 941 | `2f6c479ed43288bc1b6c9312271b0b8261e7b01252731d0037aa5cc1161da922` |
| `02_original_brand_references/original_NIGHTSHIFT_wordmark_REFERENCE.png` | 1280 × 593 | `c79e33f464ebfce900aaadac5dc108e56b79155bc2d1226806dcda581a8cd2f7` |
| `02_original_brand_references/original_N_mark_REFERENCE.png` | 1254 × 1254 | `ef01ae6a5f2b77ef73ffa8bbe6b8d9836465f2eec7d42aa34befa5b6a56fe12d` |

## Authority

The latest written product decision in `CODEX_MASTER_PROMPT.md` wins over
contradictory pixels: Owner Command switching only inside the top-right N menu;
ordinary users never see it; owner Personal Studio uses the customer screens.
All financial/customer/provider/model/health/compliance examples are mock data.

The ten numbered images define the requested navy/charcoal/violet visual
language. Older monochrome/amber-only proposals are not the target of this
proposed signed-in redesign. Accessible light theme and current functional
parity remain mandatory. Do not copy the owner navigation into customer screens,
Stripe/SOC 2/GPU claims, a redundant large switch or imaginary model names.

Both brand images are reference-only. Use exact existing repository assets from
`command-center/brand/logo/` and the existing Wordmark/BrandMark components;
never substitute, trace or regenerate these uploaded pictures.

## Source/mockup mapping

The [visual contract](VISUAL_DESIGN_CONTRACT.md) maps all ten screen IDs onto
existing routes/components and proposed missing contracts. The [owner data
contract](OWNER_DATA_CONTRACTS.md) covers screens01–07; [customer control map](CUSTOMER_SCREEN_MAP.md)
covers08–10 and the existing customer surfaces. Missing handlers, data and
persistence must remain explicitly unavailable until implemented and verified.

## Implementation approval text

The supplied master brief says:

> Scope: source-grounded redesign plan, then separately approved implementation.

> No server, production, schema or application changes before owner approves an implementation scope.

> PHASE D — IMPLEMENT ONLY AFTER APPROVAL

These are the reason this change contains documentation only. No approval for
application code, a schema change, paid tests, merge or deployment is inferred.

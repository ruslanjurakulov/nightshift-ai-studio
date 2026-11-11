# Ads Factory (dark, `NIGHTSHIFT_ADS_FACTORY`, default off)

A person writes down a brand (later: Nightshift reads it from their own site), picks its products, plans a campaign, and gets ad
concepts, scripts and storyboards; later phases turn approved concepts into image and video ads through the model makers' own APIs,
edited in Nightshift's own editor and exported per format, and published only after a person approves.

This document is the phased plan. **Phase 1 is built**, and **Phase 2 (the brand scan) is built dark** behind
`NIGHTSHIFT_ADS_BRAND_SCAN` (default off) with its price seeded NULL, i.e. not on sale (migration 0133, see "Phase 2: brand scan").
Everything under Phase 3 to Phase 6 is a design, not code. Competitor products were used as benchmarks of what a customer expects; no code, asset or text of theirs is used,
and no customer-facing string names one (`tests/ads-factory-i18n.test.ts` runs the banned-wording list over every string).

The first draft of this idea is draft PR #651 (`feat/nightshift-ads-studio-mvp`): a public, unauthenticated concept page and a pure
planning helper. Phase 1 here keeps that helper's planning idea (cycle products and formats, at most 12 concepts per batch, the four
ratios) and ports it into `command-center/lib/adsFactory/concepts.ts`, extended with art directions, objectives, three languages, a call
to action, a visual brief and storyboard beats. It is built as an authenticated, organization-scoped workspace instead of a public page.
#651's branch is not touched.

## What is NOT built (read this first)

- **No web site is read in Phase 1.** The kit's site address is a note a person types; nothing in the database or the Command Center
  opens it. The address is checked for SHAPE only (https, a DNS name, no IP literal, no port, no password): that is not an SSRF
  control, since any name can resolve to a private address. Only Phase 2's worker reads a site, and only one whose owner proved the
  domain with a DNS TXT record and paid for the scan; it resolves the name itself and pins a public address at fetch time (see "The
  fetch" below).
- **No picture, no video, no model call.** Concept drafts are filled in from fixed templates with words the person typed. The visual
  brief is not sent to any model.
- **No price, no credit, no charge.** Nothing in Phase 1 quotes, holds, captures or refunds a credit.
- **No job.** Phase 1 adds no queue kind and no worker code.
- **"Approved" starts nothing.** It records who marked the words as final and when (CLAUDE.md rule 3: a button writes a row and stops).
- **No publishing, no export.** Phase 5 and Phase 6.
- **No Shopify / store sync, no font download, no stock media, no avatars, no real people.**

## Phase 1 (this pull request): the plan, the data model, the workspace

### Data (migration `0131_ads_factory.sql`)

| Table | What it holds | Writes |
| :-- | :-- | :-- |
| `brand_kits` | name, site address (text, shape-checked only), logo (a picture of the organization's own media library), up to 8 colours `#rrggbb`, up to 4 font NAMES, voice notes, `source` = `manual` \| `scan` | `save_brand_kit`, `delete_brand_kit` |
| `brand_products` | title, description, price as TEXT (never parsed), `source` | `save_brand_product`, `delete_brand_product` |
| `brand_product_images` | product -> media library picture, ordered, at most 4 | inside `save_brand_product` |
| `ad_campaigns` | kit, name, objective, language, formats, art directions (each from a closed list) | `save_ad_campaign`, `delete_ad_campaign` |
| `ad_campaign_products` | campaign -> products of ITS kit, ordered, at most 20 | inside `save_ad_campaign` |
| `ad_concepts` | campaign, product, format, art direction, kind (`image` \| `video`), headline, body, call to action, visual brief, storyboard beats (video only), status `draft` \| `approved` \| `archived`, who approved and when, the id of the press that added it | `add_ad_concepts`, `update_ad_concept`, `set_ad_concept_status`, `delete_ad_concept` |
| `ads_factory_cap_settings` | one row: the owner's caps | the SQL editor only |

Closed lists: formats `1:1`, `4:5`, `9:16`, `16:9` (each maps to an export preset in `schemas/export_presets.json`: `square_1080`,
`feed_4x5_1080`, `vertical_1080p`, `youtube_1080p`); objectives `awareness`, `traffic`, `sales`, `launch`, `offer`; languages `en`, `ru`,
`uz`; art directions `spotlight`, `editorial`, `minimal`, `lifestyle`, `bold` (one to three per campaign).

**Why the style-kit model (0047) and not series plans (0120).** The closest existing feature is style kits and characters: an
organization's reusable creative material built from its own media library, written by editors, read by every member, where nothing
is spent. Series plans are the model for something that queues a job and has a daily budget on a shared key, which Phase 1 does not
do. So: RLS `org_id in accessible_org_ids('viewer')` for reads, SECURITY DEFINER functions for every write (as series plans do, rather
than 0047's direct DELETE policy, so no API role holds any write privilege at all), the same editor role check, the same "another
organization's id is `not_found`" rule, and the same same-organization picture rule enforced in the function AND in a trigger.

**Who may do what.** Members (viewer and above) read. Editors and above write. anon: nothing. service_role: SELECT on the six content
tables (what a Phase 3 worker needs to read a brief it was handed), nothing on the settings, EXECUTE on nothing. No API role holds
INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on any of the seven tables.

**Caps (owner decision: the numbers).** Counted in the database from the rows, never from the client, under one advisory lock per
organization (two presses cannot both pass). `0` refuses every create of that kind (a pause with no deploy). A refusal is `limit_reached`
(NS429) with `max=N`; the page shows that number and no other.

| Setting | Default | Range |
| :-- | --: | :-- |
| `kits_per_org` | **5** | 0..100 |
| `products_per_kit` | **20** | 0..200 |
| `campaigns_per_org` | **20** | 0..1000 |
| `concepts_per_campaign` (archived included) | **24** | 0..200 |

Fixed (not settings): 4 pictures per product, 20 products per campaign, 12 concepts per press, 8 storyboard beats. Change a cap:
`update public.ads_factory_cap_settings set kits_per_org = 10;` (leaves a `security_events` row of kind `ads.factory.caps`).

**Text.** Every text is stored cleaned and length-capped by the function AND by a CHECK on the table: control characters and every
character nobody sees are removed: the class the comment inbox removes (BR-L-120: `modules/comment_replies.py`, `inbox_clean_text`, the
shared `tests/fixtures/inbox_cleaner_cases.txt`), which includes the whole Unicode tag block U+E0000-E0FFF (a hidden-instruction
channel to a model: the visual brief is what Phase 3 hands an image model), every variation selector (U+FE00-FE0F, U+E0100-E01EF; ads
text drops U+FE0E/U+FE0F too), the Hangul fillers, the braille blank, the Arabic letter mark and the Mongolian vowel separator. The
blank-looking spaces (no-break, ideographic, U+2000-200A and the like) are spaces and a run of spaces reads as one, so a name of nothing but blanks or fillers is
empty and refused. A single-line field reads a run of line breaks or tabs as one space; a multi-line field keeps line breaks only.
The text is cleaned only after sign-in and membership are checked. Nothing renders it as
HTML (`tests/ads-factory-routes.test.ts` scans for `dangerouslySetInnerHTML`). A colour reaches a style attribute only as a checked
`#rrggbb`. A font is a name of letters, digits, space, dot, underscore, apostrophe and hyphen: never a URL, a CSS value or a file.

**Locks.** No function holds a row lock while it waits for the organization's advisory lock. Each writer of a kit, a product or a
campaign reads its row without a lock, checks sign-in, membership and the editor role, takes the organization's lock, and only then
locks the row `FOR NO KEY UPDATE` and reads it again (gone meanwhile: `not_found`). What else decides the write (the kit of a new
product or campaign, the campaign of a concept press, the products a campaign names) is read again under the organization's lock too,
so a row deleted a moment ago is `not_found` or `invalid_products`, never a foreign key error. Why: the holder of the organization's
lock may be deleting a parent whose cascade must lock that row (a kit takes its products, a product its campaign lines, a campaign its
lines and concepts) or inserting a child whose foreign key check needs `FOR KEY SHARE` on it; a row lock taken first made the two wait
for each other (40P01). The concept functions lock one concept row after the membership check and take no organization lock, so a
cascade that waits for them always finishes. The lab (`tests/security/test_sec_ads_factory.py`) races each pair, with a fresh kit,
product, campaign or concept every round, and asserts no deadlock and no foreign key error.

### Known limits (Phase 1)

- **The switch hides the page, not the database.** The ten member functions are granted to `authenticated` from the moment 0131 is
  applied. While `NIGHTSHIFT_ADS_FACTORY` is off, a signed-in member can still call them directly through PostgREST (the public anon
  key plus their own session): only in an organization where they are an editor, within the caps, with every check of this page. Rows
  made that way are real rows, and the rollback refuses while any exist unless the owner sets `nightshift.ads_rollback_delete_rows`.
  To stop creates without a deploy, set every cap to 0. (The caps' numbers are the owner's decision and are not changed here.)
- **An id's existence by timing: the lock wait is closed, the compute time is not.** 0047 (style kits) locks the row it was given
  before it checks membership, so a caller guessing another organization's id could wait on its owner's write. 0131's functions read
  the row without a lock and check membership first (the lock order above), so nobody waits on another organization's busy row, and
  every answer is the same `not_found`. The time to answer still differs: a made-up id stops before `is_org_member()` runs, another
  organization's id runs it (about 0.35 ms against 1 ms in the review lab). Ids are random uuids, so this needs one already known.
  0047 itself is unchanged.
- **Membership is checked before the organization lock, not again after it.** An editor removed while their call waits on that lock
  (milliseconds: every holder is one short function) still completes that one call. Removing a member does not take the lock, and
  this was so before the lock-order change too. A later migration can close it by repeating `is_org_member(org, 'editor')` right
  after `pg_advisory_xact_lock`.
- **A hard delete of a media asset is not serialized with a product save that names it.** Nothing deletes a `media_assets` row today
  except an organization's own cascade (the purge path soft-deletes, then marks `purged_at`, and a save then answers NS400). If a hard
  purge is ever added, it can meet a product save with a deadlock (40P01) or a foreign-key error (23503) and should take the
  organization lock first.
- **The site address is a shape check, not an SSRF control** (above): Phase 2 must resolve and pin a public address when it fetches.

### The workspace (Command Center)

`/{channel}/ads`, under the app shell, behind `NIGHTSHIFT_ADS_FACTORY` (server-side; off = the page is a 404, every `/api/ads/*` route
answers 404 before it reads the session, and the navigation has no entry). With it on: create and edit brand kits by hand (logo and
product pictures picked from the media library; no external fetch), add products, create campaigns, add 1 to 12 template drafts per
press (image or video), edit drafts, approve, archive, send back to draft, delete. Every refusal is said in words; the form keeps what
was typed. en, ru and uz strings (`lib/i18n/ads-factory/`), ru and uz marked as drafts that need a native read.

Routes: `GET /api/ads`, `POST /api/ads/kits`, `PATCH|DELETE /api/ads/kits/:id`, `POST /api/ads/kits/:id/products`,
`PATCH|DELETE /api/ads/products/:id`, `POST /api/ads/campaigns`, `PATCH|DELETE /api/ads/campaigns/:id`,
`POST /api/ads/campaigns/:id/concepts`, `PATCH|DELETE /api/ads/concepts/:id`. All same-origin, the member's own session, never the
service key. `POST .../concepts` takes `{ kind, count, batch }` only; the server builds the drafts from the member's own rows; the same
`batch` again is answered with the first press's concepts and adds nothing.

### Costs and credits: none

Phase 1 is free and uncharged: no model call is made, so there is nothing to price.

### Abuse and safety in Phase 1

- **Brand impersonation.** Anyone can type any brand's name; Phase 1 stores words and makes nothing, so the harm is bounded to a
  workspace's own drafts. Phase 2 adds the ownership confirmation; Phase 3 must not generate before it (see below).
- **Claims in ads.** The templates make no claim the person did not type (no superlative, no discount, no promise, no "free"; tested
  against `docs/news/banned-claims.json`). A price is shown only as the text the person typed. The page says drafts are unchecked.
- **AI disclosure.** Nothing is generated in Phase 1. Phase 3 and 4 outputs are AI-generated and inherit the existing disclosure rules.

### Owner decisions for Phase 1

1. The four cap numbers (defaults above).
2. Whether viewers should see the workspace at all (today: yes, read-only, like style kits).
3. When to set `NIGHTSHIFT_ADS_FACTORY=on` (repository variable; "Deploy web" or a restart is enough, it is read per request).
4. A native read of the ru and uz strings and of the ru and uz concept templates (`lib/adsFactory/concepts.ts`).
5. The audit trail. Phase 1 writes no `app_audit_log` row: the rows themselves record who (`created_by`, `approved_by`, `approved_at`),
   and adding `brand_kit.*`, `brand_product.*`, `ad_campaign.*`, `ad_concepts.add` and `ad_concept.*` to the trail means replacing
   `audit_action_allowed` (0087 / 0093), which several open pull requests may also touch. Decide whether a later migration adds them.

## Phase 2: brand scan (built, dark: `NIGHTSHIFT_ADS_BRAND_SCAN`, default off; the price seeded NULL = not on sale)

The person proves they own their domain, asks for one priced scan, and a worker reads a few public pages of the site and proposes brand
fields (each with the page and the place it came from); the person reviews them next to the kit and accepts field by field. Nothing is
accepted automatically, and no model is called.

**Owner decisions (2026-11-11), as built.** Build it. Priced per scan in credits at cost (the price itself limits volume) — seeded NULL,
so `request_brand_scan` refuses `not_on_sale` until the owner sets one (proposal below). Only a generous PLATFORM-wide daily safety cap
(no per-person or per-organization daily cap). Ownership proved by DNS TXT (the strong form). Everything dark behind
`NIGHTSHIFT_ADS_BRAND_SCAN`.

### Data (migration `0133_brand_scan.sql`)

| Table | What it holds | Writes |
| :-- | :-- | :-- |
| `brand_domains` | org, host (a lower-case DNS name, never a bare public suffix or a shared hosting parent), a random token, `verified_at` / `verified_by` (who asked for the check that found the record), the last check's time and code | `request_domain_verification`; the worker's `finish_domain_check` |
| `brand_domain_checks` | one row per "Check now": who asked, when the worker took it, ok + a closed code (the worker's queue) | `check_domain_verification`; `claim_domain_check` / `finish_domain_check` |
| `brand_scans` | org, the entry URL (0131's site shape), host, the verified domain it ran under, status `requested \| running \| ready \| failed`, a closed error code, the result (bounded jsonb), credits held / charged, idempotency key + request hash, which fields were accepted into which kit | `request_brand_scan`; `claim_brand_scan` / `finish_brand_scan` / `fail_brand_scan`; `accept_brand_scan_fields` |
| `brand_scan_settings` | one row: `price_credits` (NULL = not on sale, the seed), `platform_daily_scans` (500), `platform_daily_checks` (5000), one organization's share `org_daily_scans` (20) and `org_daily_checks` (200) | the SQL editor only (a change leaves a `security_events` row of kind `ads.brand_scan.settings`) |

Members read their organization's rows (RLS, viewer and up); no API role writes any table directly; the settings are closed to every API
role. Member functions (`authenticated`, each checks sign-in, membership and the editor role itself; another organization's id is
`not_found`): `request_domain_verification(org, host)`, `check_domain_verification(domain)`, `quote_brand_scan(org)` (any member),
`request_brand_scan(org, url, idem, max_credits)`, `accept_brand_scan_fields(scan, kit, fields[])`. Worker functions (`service_role`
only, `credits_trusted_caller()`): `claim_domain_check`, `finish_domain_check`, `claim_brand_scan`, `finish_brand_scan`,
`fail_brand_scan`. Rollback: `docs/sql/rollback_0133_brand_scan.sql` (before 0131's; refuses while rows exist or a scan is in flight).

**Ownership (DNS TXT).** The person adds a TXT record **`_nightshift.<host>`** with the value **`nightshift-verify=<token>`** (an
underscore label, not the apex: the apex's TXT records are SPF and other services' tokens; RFC 8552's convention, as `_acme-challenge`
and `_dmarc`). "Check now" queues one check (a double click is the same check; a new one waits 15 s after the last; at most
`platform_daily_checks` per 24 hours platform-wide). The worker reads the record over **DNS-over-HTTPS from one fixed resolver**
(`modules/dns_txt.py`, `cloudflare-dns.com`): the stdlib has no TXT lookup and dnspython is not a dependency; a plain UDP answer could be
forged by an off-path attacker (and a forgery here would verify a domain the attacker does not own), an answer over TLS cannot; the
resolver is a fixed name, so there is no SSRF surface; the connection is the brand fetcher's own safe socket. The answer is parsed
strictly (our id, a response, not truncated, the question we asked, at most 4 KB, every name and record in bounds, compression pointers
backwards only and at most 16) and ONLY a TXT record whose owner is exactly `_nightshift.<host>` counts: a CNAME is not followed. A
definite "no" (`no_record`, `mismatch`) takes a verification away; a failure to ask (`dns_error`, `timeout`) leaves it as it was. A scan
needs a verified domain of the SAME organization that is the scan's host or a parent of it, and the worker reads the record AGAIN when
it starts the scan (`ownership_not_proven` / `ownership_unknown` fail it before any request goes to the site, credits released).
At most 10 domains per organization.

**Money.** `quote_brand_scan` shows the price (`brand_scan_price()`: the setting, rounded up to the cent; the owner EXEMPTED the scan
from `job_minimum`, so it is not raised) and the hold. `reserve_credits` refuses any hold below `job_minimum`, and no shared money function
is changed, so the HOLD is `greatest(price, job_minimum)`: with the live minimum of 30 and a price of 1, **30 credits are held while the scan
runs and 1 is charged**. `request_brand_scan` takes the price the person confirmed (`max_credits`, compared with the charged price, never
the hold; a higher price now is `price_changed`, never charged) and holds (`reserve_credits` through 0036's `creative_platform_reserve`,
after checking the editor role itself, exactly as `create_creative_job` does); without the hold available it refuses
`scan_hold_unavailable` (NS402, detail `hold=30 price=1`). The worker's `finish_brand_scan` CAPTURES exactly the price, and
`capture_credits` releases the rest of the hold in the same transaction; every failure RELEASES the whole hold (`fail_brand_scan`, and the sweeps: a scan nobody took within 2 hours, or whose worker went quiet for 15 minutes, is failed
and released by the next claim or by the organization's next request). The same press again (`idem`) answers the first scan and holds
nothing twice. The operator's (exempt) organization is not charged and only a platform admin may scan there. A hold counts as one of the
plan's parallel runs (0034), as every hold does.

**Caps.** One scan in flight per organization (a unique index). Per organization per 24 hours `org_daily_scans` (20) and
`org_daily_checks` (200), all statuses, failed ones too (a failed scan releases its hold, so without this share one organization could
use up the platform's day for nothing), counted under the organization's lock; refused `org_daily_limit` with no number. Then
platform-wide per 24 hours `platform_daily_scans` and `platform_daily_checks` under one platform lock taken after the organization's
(0127's order); the platform's refusal (`platform_busy`) names no number either. A confirmed price that is not a number between 0 and
1000 (NaN, an infinity) is `price_changed`.

**Locks.** As 0131: no function holds a row lock while it waits for an advisory lock. `request_*` / `check_*` read without a lock, check
the role, take `brand_scan:<org>`, then the platform lock where they count a cap, and only then touch rows (the credit account inside
`reserve_credits`). `accept_brand_scan_fields` takes 0131's `ads_factory:<org>` (it writes kits and products under 0131's caps), then
locks the kit row, as 0131's writers do. The worker's functions take no advisory lock. The lab races each pair.

**The result** (`brand_scan_result_ok`, at most 64 KB, exactly this shape): `pages` (up to 6 URLs read), `fields` (`name`,
`description`, `logo`, `palette`, `fonts`, `theme_color`; each `{value, source: {url, where}}`, `where` one of a closed list of places:
`og_site_name`, `jsonld_organization`, `title`, `meta_description`, `icon`, `apple_touch_icon`, `logo_palette`, `css`, ...), `products` (up
to 8 candidates: title, description, price TEXT, image), `notes` (up to 20 closed words with a URL: what was skipped and why: an SVG
logo, a robots rule, a stylesheet on another site). Every text is 0131-clean and within 0131's lengths, every colour `#rrggbb`, every
font a 0131 name, every picture a LIVE IMAGE of the organization's own library (checked in `finish_brand_scan`) — the result never
links to the site.

**Accepting.** `accept_brand_scan_fields(scan, kit, fields[])`: a READY scan of the caller's organization; `kit` NULL makes a new kit
(`source = 'scan'`; needs `name`; 0131's `kits_per_org`), otherwise only the chosen fields of that kit change. Fields: `name`,
`description` (into the kit's voice notes), `site_url` (the scanned URL), `logo`, `palette`, `theme_color` (put first in the palette),
`fonts`, `product:0` .. `product:7` (each a new product of the kit, `source = 'scan'`, with its picture; 0131's `products_per_kit`).
Every value goes through `ads_clean_text` and 0131's checks again; a picture deleted from the library since the scan is refused.

### The fetch (Python worker, never the Next server)

`modules/brand_fetch.py` (merged in #669, dark until now), with the three follow-ups its security review asked for before wiring:
(A) a failed, refused or abandoned lookup is remembered per host for the rest of the scan (`_addresses` raises the stored refusal
again): one lookup and at most one abandoned resolver thread per name per scan; (B) robots.txt patterns and paths are compared in one
spelling, with `%XX` escapes of unreserved characters (`ALPHA DIGIT - . _ ~`) decoded in both (RFC 9309 section 2.2.2; the RFC's
`/foo/bar/%62%61%7A` example is a test), reserved escapes (`%2F`) and everything else left escaped; (C) an entry host that is a bare
public suffix or a shared hosting parent is refused (`hosting_parent`: `co.uk`-style two-label country second levels, `myshopify.com`,
`github.io`, `vercel.app`, `netlify.app`, `herokuapp.com`, `s3.amazonaws.com`, `blogspot.com`, `pages.dev`, `web.app`,
`firebaseapp.com`, `azurewebsites.net`; a short explicit list, the same in 0133's `ads_hosting_parent`), and such a name is not the
"apex twin" of `www.<it>` either.

The rest is as built in #669:
- https only; port 443 only; no credentials in the URL; printable ASCII; the host urllib3 would connect to is the host that was checked.
- Every name is looked up once per scan (`getaddrinfo` of the absolute name, no resolv.conf search domain, in a thread waited for at most
  5 s or what is left of the 30 s budget, at most 4 distinct names per scan) and refused unless EVERY answer is public (the module's own
  table of special-use ranges; IPv6 only inside 2000::/3; all NAT64, 6to4 and Teredo refused). The socket goes to that address with SNI,
  Host and the certificate check on the name: DNS rebinding cannot move the target.
- Redirects: at most 3, each re-checked, only to the entry host, its subdomains, or its www / apex twin.
- Connect 5 s, read 10 s, 30 s per scan. HTML 1.5 MB, CSS 256 KB (at most 4), images 5 MB (at most 6). Content types per kind; SVG
  refused; `Accept-Encoding: identity`, a compressed answer refused.
- robots.txt first on every host (RFC 9309; `NightshiftBrandScan` / `Nightshift` groups, else `*`; unreadable = disallow all).

### The scan job (`modules/brand_scan.py`, `tools/brand_scan_worker.py`)

The worker claims a domain check (above) or a scan. A scan: read the TXT record again; `SiteScan(url).pages()` (home + up to five
same-host pages, product pages first); `modules/brand_extract.py` reads `<title>`, the meta description, Open Graph and Twitter cards,
`theme-color`, JSON-LD `Organization` (and its kinds) and `Product`, icon / logo candidates (never SVG), and font-family NAMES from inline
and up to four linked stylesheets (no font is downloaded); every string is read once by the HTML parser, then cleaned exactly as 0131's
`ads_clean_text` (the lab pins the Python and the SQL equal, character for character) and cut to 0131's length; a `<script>` that is not
JSON-LD is never read, and JSON-LD is at most 256 KB and 32 levels per script, 8 scripts per page. The logo is the first candidate the
fetcher accepts; its palette is read by `modules/brand_palette.py` in a CHILD process (argv only, no key in its environment, its own
session, `RLIMIT_AS` / `RLIMIT_CPU` / `RLIMIT_FSIZE` 0 / `RLIMIT_NOFILE` set before Pillow is imported, PNG / JPEG / WEBP only, 8192 px a
side and 40 megapixels checked from the header before any pixel is decoded). The logo and up to four product pictures are stored through
the media library (`media_library.store_generated`: the bytes sniffed, probed when ffprobe is there, `register_asset` with source
`pipeline` — never `generated`, so nothing reads as AI-made — and the scan in the provenance); the result names those assets, never a
link. `finish_brand_scan` checks it all again. When the scan fails (any failure, a refused finish, the sweeps), `brand_scan_fail_locked`
deletes those pictures from the library (`deleted_at`, as a member's delete; the media worker removes the files and the bytes go back
to the quota): only pictures of the scan's own organization with the scan's id in the provenance, never a ready scan's. The worker takes
a domain check and a scan in turn, so a queue of slow DNS checks cannot starve the scans (or the reverse). A failure is a closed word: `ownership_not_proven`, `ownership_unknown`,
`fetch_<fetcher code>` (the home page: `fetch_robots`, `fetch_not_public`, `fetch_timeout`, `fetch_hosting_parent` ...), `nothing_found`,
`invalid_result`, `worker_error`.

`tools/brand_scan_worker.py` exits at once unless `NIGHTSHIFT_ADS_BRAND_SCAN=on`; it needs `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and
(for pictures) `NIGHTSHIFT_MEDIA_DIR`. It is NOT in `deploy/docker-compose.yml` yet (a release step, below).

### The page ("Scan my site", Command Center)

On the brand kit section of `/{channel}/ads`, drawn only with `NIGHTSHIFT_ADS_BRAND_SCAN` on (server-side, read per request, on top of
`NIGHTSHIFT_ADS_FACTORY`; off = no button, and every `/api/ads/scan/*` route answers 404 before it reads the session). Three steps:
1. **Prove the site**: the person types their domain (a scheme, a path and a final dot are taken off; a hosting parent is refused before
   anything is sent), gets the TXT record to add (name and value with Copy buttons), and presses **Check now** (the panel reads again
   every few seconds while the check waits, and says what the last check found).
2. **Scan**: the quote is shown (`not on sale` hides the button; with the hold raised to job_minimum it reads "30 credits are held while
   it runs, 1 is charged", and a short balance is refused as "a scan needs 30 credits available while it runs, with 1 charged"); the button names the price and sends it as `max_credits` with a press id
   that a retry after a lost answer reuses (one scan, one hold); a different price is said with the database's number.
3. **Review and accept**: every proposal next to what the chosen kit holds now (or "a new brand kit"), with where it was found (the place
   and the page address, as text, never a link); the person ticks fields and accepts; a new kit needs the name.
Routes: `GET /api/ads/scan`, `POST /api/ads/scan`, `POST /api/ads/scan/domains`, `POST /api/ads/scan/domains/:id/check`,
`POST /api/ads/scan/:id/accept` — same-origin, the member's own session, one 0133 function each, never the service key, never a fetch.
Strings: `lib/i18n/ads-brand-scan/` (en; ru and uz are drafts that need a native read).

### Known limits (Phase 2)

- **The database is not dark.** The member functions are granted on apply. While the price is NULL nobody can request a scan; a
  signed-in editor can still ask for a domain token and queue DNS checks (at most 10 domains, one check per 15 s per domain,
  `platform_daily_checks` platform-wide), which nothing claims while the worker is off. To stop checks too:
  `update public.brand_scan_settings set platform_daily_checks = 0;` (or one organization's share: `org_daily_checks`).
- **A CDN on another domain.** The fetcher reads only the entry host, its subdomains and its www / apex twin, so a logo or product picture
  served from another domain (a shop platform's CDN) is not read; the result notes `logo_off_site` / `image_off_site` and proposes no
  picture. A stylesheet on another domain is likewise not read (`css_off_site`).
- **The resolver's cache** decides how soon a newly added TXT record is seen; the page says so, and the person presses "Check now" again.
- **DNSSEC** is not checked by us; the resolver validates signed zones itself.
- **A verification is not re-checked on a timer**; every scan re-checks it, and so does every "Check now".
- **The www / apex twin.** A redirect from the entry host to its `www.` twin (or from `www.` to the apex) is followed, and the twin is not
  verified separately: verifying `shop.com` covers `www.shop.com`, and a scan of `www.shop.com` may be redirected to `shop.com`. Both
  are the same zone's names in practice; the security review accepted this as is (Low), and it is noted here rather than changed.

Follow-ups from the final delta review (both Low; to be fixed in a later migration, not in 0133 or the page):
- **A failed scan can soft-delete a picture a person already put into a kit.** The worker stores a scan's pictures in the library before
  the scan finishes. If a member puts one of them into a brand kit (as its logo, or as a product picture) while the scan is still
  running, and the scan then fails, `brand_scan_fail_locked` marks that picture deleted (`deleted_at`), and it disappears from under
  the kit. The fix: skip the assets that `brand_kits.logo_asset_id` or `brand_product_images.asset_id` refer to.
- **No test covers the `source = 'pipeline'` filter.** A mutation that removes it from `brand_scan_fail_locked`'s delete is not
  caught. The other filters (organization, `origin = 'brand_scan'`, the scan id) are covered. The lab needs a picture with the scan's
  provenance but another source, and must check that the picture stays.

### Costs: the approved price and caps (owner decision, 2026-11-11; seeded NULL, set after merge)

**Approved values** (the owner, 2026-11-11). The migration keeps the seed NULL (not on sale); they go live in a separate settings step
after merge, in the SQL editor:

```sql
update public.brand_scan_settings set price_credits = 1, platform_daily_scans = 500, platform_daily_checks = 5000;
```

- price: **1 credit per scan** (charged; exempt from `job_minimum`, the hold is `greatest(1, job_minimum)` = 30 today and released down to 1);
- platform cap: **500 scans per 24 hours**;
- domain checks: **5,000 per 24 hours**.

**Safety defaults, not yet owner-approved** (added at the security review; they ship as the column defaults, so nothing needs setting
unless the owner chooses other numbers): one organization's share of the day, **20 scans** (`org_daily_scans`) and **200 domain
checks** (`org_daily_checks`) per 24 hours. To set them explicitly: `update public.brand_scan_settings set org_daily_scans = 20,
org_daily_checks = 200;`.

The proposal and its basis, as approved: **1 credit per scan** (`update public.brand_scan_settings set price_credits = 1;`). Cost basis (assumptions, not
measurements: our own dedicated worker server at roughly EUR 50 a month, 8 cores, inbound traffic not billed; 1 credit is about
$0.01 retail, docs/API.md): one scan holds one worker slot for at most 30 s of wall clock (mostly waiting on the site), uses at most a few
CPU-seconds (the HTML parse, one Pillow decode in the child, a thumbnail when ffmpeg is there), downloads at most about 41 MB (6 pages,
4 stylesheets, 6 pictures, all capped; typically 1-3 MB), asks the resolver twice (free), and stores at most 5 pictures in the
organization's own library quota. That is well under $0.001 of marginal cost; 1 credit is the smallest whole price, covers the scans
that fail (those are released, so they cost the person nothing) and the worst case many times over, and still makes a scan cost money
for anyone who would use it as a crawler (each scan also needs a domain they control). The charged price is not raised to the platform's
`job_minimum`; the HOLD is (reserve_credits demands it of every hold), so a person needs that many credits available while the scan runs:
`select credits_per_unit from public.credit_prices where unit = 'job_minimum';` (30.00 on 2026-11-11).

Proposed platform cap: **500 scans per 24 hours** (the seed). Each scan reads one site, at most 12 requests and about 41 MB, so 500 is
at most about 6,000 requests and 20 GB a day in the worst case, and about 5 hours of one worker slot; a scan is a once-per-brand action,
so real demand is far below it. Domain checks: **5000 per 24 hours** (one DNS-over-HTTPS query each).

### Abuse

Scanning someone else's brand: impossible without control of their DNS zone, and re-checked at every scan. The worker never follows a
link to another domain and honours robots.txt. Trademarks and logos: the scanned logo is the verified owner's own; the result keeps where
each field came from. Rate: the price, the platform cap, one scan in flight per organization. Phase 3 must still refuse to generate from
a kit with `source = 'scan'` unless its scan's domain is verified. One organization cannot use up the platform's day: 20 scans and 200
checks per organization per 24 hours (failed scans count). Accepting the same product candidate again adds no copy.

### Releasing Phase 2

1. Read the live database first (the queries in the migration header, "WHAT TO VERIFY BEFORE YOU APPLY"); 0131 must be applied.
2. Merge: the migration applies itself on deploy. Nothing can be bought while the price is NULL.
3. Add a `brand-scan-worker` service to `deploy/docker-compose.yml` (worker image, `command: ["python", "tools/brand_scan_worker.py"]`,
   uid 1000, the `media` volume rw, the worker env file, `NIGHTSHIFT_ADS_BRAND_SCAN=on`), and let outbound HTTPS reach customer sites
   and `cloudflare-dns.com`.
4. Set the approved values: `update public.brand_scan_settings set price_credits = 1, platform_daily_scans = 500, platform_daily_checks = 5000;`, and `NIGHTSHIFT_ADS_BRAND_SCAN=on`
   for the Command Center (the "Scan my site" panel).
5. Undo: the switch off (loses nothing), or the price back to NULL (no new scans), or `docs/sql/rollback_0133_brand_scan.sql`.

## Phase 3: image ads through the existing creative job pipeline (designed)

**Data.** `ad_assets`: concept, format, the creative job it came from, the media asset it produced, status. A concept gets one image per
chosen format.

**Jobs.** For an APPROVED concept only: one `create_creative_job` per format, capability `t2i` (or `edit` with the product picture as
the source), a model chosen from `sellable_models()` (never a reseller; only a first-party adapter whose real call has succeeded, per
the Definition of Done), the prompt built server-side from the brief, then passed through the creative job path's own prompt checks.
The result is stored in the media library (as every creative result is) and linked from `ad_assets`.

**Costs.** Quoted with `quote_creative_job` / `creative_price` per image and shown before anything is held; the hold is
`reserve_credits` at submit, `capture_credits` on success, `release_credits` on failure, exactly as a Studio image. A campaign batch is
the sum of its jobs; nothing is charged for a concept that was not approved.

**Abuse.** No generation from a kit with `source = 'scan'` without the ownership confirmation. Real people: no face of a real person
from a product picture; the existing provider and synthetic-only guards apply. Claims: the headline and body are the person's
approved words; the model is asked for a picture, not text claims. AI disclosure: every output is labelled AI-generated in the library
and on export, per `docs/AI_DISCLOSURE.md`.

**Owner decisions.** Which models are offered for ads; whether a batch needs a second confirmation above a credit amount.

## Phase 4: video ads through the editor and the existing video providers (designed)

A video concept's storyboard beats become an editor project (`editor_projects`, 0054): one clip slot per beat, the headline and lines
as captions, the logo as an overlay. Clips come from `i2v` / `t2v` creative jobs (priced and held as in Phase 3) or from the person's
library. The person edits in Nightshift's editor; render and export go through the existing render path. No auto-render: a person
presses render, which is priced like any editor render.

**Owner decisions.** Default length per format; whether a voice-over is offered (it would use the existing voice tools and consent rules).

## Phase 5: variants and exports per format (designed)

Each concept carries its formats; export uses `schemas/export_presets.json` (`square_1080`, `feed_4x5_1080`, `vertical_1080p`,
`youtube_1080p`) and the multi-ratio export (#661, `0129_editor_export_frame`, merged): one source, a reframe per ratio, one export per preset. Variants (headline A/B) are separate concepts.
Exports are priced as editor exports already are.

## Phase 6: approve before publish (designed)

An exported ad reaches a platform only through the existing publish requests (`publish_requests`, 0029) and the existing approval and
publish gate rules: private by default, a person's act, never the bot's. Approving a concept (Phase 1) is NOT approving a publish.
Paid ad accounts (ads managers) are out of scope until the owner decides on them; each would be a new connected account with its own
consent and review.

## Strings that need a native read

- `command-center/lib/i18n/ads-brand-scan/ru.ts` and `uz.ts` (Phase 2's "Scan my site" panel): every string.

- `command-center/lib/i18n/ads-factory/ru.ts` and `uz.ts`: every string (written by a non-native speaker, marked in the file header).
- The ru and uz concept templates in `command-center/lib/adsFactory/concepts.ts` (`RU`, `UZ`): these become ad copy a customer
  publishes, so they need the most careful read.
- The nav label `nav.ads` in `lib/i18n/ru.ts` ("Реклама") and `uz.ts` ("Reklama").

## Releasing Phase 1

1. Read the live database first (read-only; the queries are in the migration header, "WHAT TO VERIFY BEFORE YOU APPLY").
2. Merge: the migration applies itself on deploy. The page is dark while the switch is off, but the database is not: a signed-in
   editor can call the ten functions through PostgREST within the caps, and rows made that way make the rollback refuse unless told
   the rows may go (see "Known limits").
3. Set the repository variable `NIGHTSHIFT_ADS_FACTORY=on` and run "Deploy web" (a restart is enough).
4. Undo: switch it off (loses nothing). To remove the tables too: `docs/sql/rollback_0131_ads_factory.sql`, which refuses while rows
   exist unless told they may go.

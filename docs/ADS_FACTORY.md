# Ads Factory (dark, `NIGHTSHIFT_ADS_FACTORY`, default off)

A person writes down a brand (later: Nightshift reads it from their own site), picks its products, plans a campaign, and gets ad
concepts, scripts and storyboards; later phases turn approved concepts into image and video ads through the model makers' own APIs,
edited in Nightshift's own editor and exported per format, and published only after a person approves.

This document is the phased plan. **Phase 1 is the only phase that is built** (this pull request). Everything under Phase 2 to Phase 6
is a design, not code, except Phase 2's network fetcher (`modules/brand_fetch.py`), a dark module nothing calls yet (see "Built so far"
under Phase 2). Competitor products were used as benchmarks of what a customer expects; no code, asset or text of theirs is used,
and no customer-facing string names one (`tests/ads-factory-i18n.test.ts` runs the banned-wording list over every string).

The first draft of this idea is draft PR #651 (`feat/nightshift-ads-studio-mvp`): a public, unauthenticated concept page and a pure
planning helper. Phase 1 here keeps that helper's planning idea (cycle products and formats, at most 12 concepts per batch, the four
ratios) and ports it into `command-center/lib/adsFactory/concepts.ts`, extended with art directions, objectives, three languages, a call
to action, a visual brief and storyboard beats. It is built as an authenticated, organization-scoped workspace instead of a public page.
#651's branch is not touched.

## What is NOT built (read this first)

- **No web site is read.** The site address is a note a person types. Nothing in the database, the Command Center or a worker opens it.
  The brand scanner is Phase 2, designed below, and must be a worker job when it is built. The address is checked for SHAPE only
  (https, a DNS name, no IP literal, no port, no password): that is not an SSRF control, since any name can resolve to a private
  address. Phase 2's scanner must resolve the name itself and pin a public address at fetch time (see "The fetch" below).
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

## Phase 2: brand scan (a worker job; designed; only the fetcher is built, dark)

The person enters their site; a worker reads a few public pages and proposes a DRAFT brand kit plus product candidates, which the person
reviews and accepts field by field. Nothing is accepted automatically.

**Data.** `brand_scans`: org, requested_by, the normalised URL, `ownership_confirmed_by` + `ownership_confirmed_at` (the person ticked
"I own this site or may use its brand"; required, stored, never defaulted), status `requested | running | ready | failed`, error code,
the result (bounded jsonb: proposed fields, each with where it came from), the kit it produced (`brand_kits.source = 'scan'`), an
idempotency key and request hash. `brand_scan_cap_settings` (one row, as 0127): per person per day, per organization per day, and
platform-wide per day. A queue row of a new `render_jobs` kind (or a dedicated queue table, to keep `render_jobs_payment_guard` out of
it), claimed by the worker with `for update skip locked`.

**RPCs.** `request_brand_scan(org, url, confirm_ownership, idem)`: editor, confirmation required, URL shape check (0131's), caps under
the organization lock then a platform lock (0127's order), idempotent replay, returns the scan id. `finish_brand_scan(...)`:
service_role only, writes the draft. `accept_brand_scan_fields(scan, fields[])`: the person copies chosen fields into the kit.

**The fetch (Python worker, never the Next server).** Reuse and extend `modules/capabilities/safe_fetch.py` (today an allow-list of
vendor hosts, which does not fit an arbitrary customer host), as a new `modules/brand_fetch.py`:
- https only; port 443 only; no credentials in the URL; printable ASCII; the host urllib3 connects to must be the host that was checked.
- Resolve the name ONCE (`getaddrinfo`) and refuse unless EVERY address is public: refuse private, loopback, link-local, CGNAT
  (100.64/10), multicast, reserved, unspecified, IPv4-mapped and IPv4-compatible IPv6, 6to4/Teredo of a private address, NAT64 of a
  private address, and the metadata addresses (169.254.169.254, fd00:ec2::254, 100.100.100.200). Connect to the resolved IP with SNI
  and Host of the name (no second lookup: DNS rebinding cannot change the target between check and connect).
- No automatic redirects. At most 3 hops, each re-validated (scheme, port, resolution) and kept to the same registrable domain.
- Timeouts: connect 5 s, read 10 s, total wall clock 30 s per scan. Byte caps: HTML 1.5 MB, CSS 256 KB each (at most 4), each image
  5 MB (at most 6). Content-type allow-list (text/html, text/css, image/png, image/jpeg, image/webp, image/svg+xml refused or
  rasterised in a child process only). `Accept-Encoding: identity`, or a bounded decoder that stops at the cap (gzip bomb).
- At most 6 pages: the home page and product pages linked from it on the same host. robots.txt is read first and a Disallow for our
  user agent is honoured. An honest User-Agent naming Nightshift and a contact page; no cookies, no credentials, no scripts executed.
- Extraction: `<title>`, meta description, Open Graph / Twitter cards, JSON-LD `Organization` and `Product`, icon and logo candidates,
  `theme-color`, a small palette from the logo (Pillow in a child process with size caps and byte sniffing: `modules/capabilities/pictures.py`),
  font-family NAMES from inline and linked CSS (no font is downloaded). Every extracted string is untrusted: HTML-unescaped once,
  control and invisible characters stripped, length-capped to 0131's limits, never rendered as HTML, never used as a prompt without
  the prompt checks of the creative job path. Images are stored through the media library ingest path (`request_upload` /
  `register_asset` limits and sniffing), never hot-linked.
- Tests: loopback HTTPS servers and an attacker listener that must receive zero requests (private targets, redirects to them,
  rebinding by a resolver that answers differently the second time), oversize, slow-drip, gzip-bomb and hostile HTML bodies; each rule
  mutation-checked.

**Costs.** No model call is needed for extraction; a scan costs bandwidth and worker time only. Owner decision: free with caps (as
series planning), or a small fixed credit price through `reserve_credits` / `capture_credits` with release on failure.

**Abuse.** Scanning someone else's brand: the ownership confirmation is stored with who and when, and Phase 3 refuses to generate from
a scanned kit unless the confirmation exists. Trademarks and logos: the scanned logo is the person's own claim; the report keeps where
each field came from. Rate limits stop using the worker as a crawler. The worker never follows a link to another domain.

**Owner decisions.** The caps; free or priced; whether a scan may run against a domain whose WHOIS / DNS TXT does not prove ownership
(a DNS TXT verification step would be the strong form).

**Built so far: the fetcher only (`modules/brand_fetch.py`, dark).** Nothing imports it but `tests/test_brand_fetch.py` (a test pins
that across `modules/`, `tools/`, `deploy/`, `command-center/` and the entry scripts). It is "The fetch" above, minus extraction:
`SiteScan(url)` reads robots.txt, the home page and up to five same-host pages it links to (product paths first), and on request up
to 4 stylesheets and 6 pictures, and returns raw bytes, the final URL and the media type.
- The entry URL is 0131's `ads_site_url_ok` shape plus one refusal more (a backslash).
- Every name is looked up once per scan and pinned. The lookup is for the absolute name (no resolv.conf search domain), runs in a
  thread waited for at most 5 s or what is left of the 30 s budget, and a scan looks up at most 4 distinct names.
- Every answer must be public. `address_problem` uses the module's own table of special-use ranges, so a change in Python's
  `ipaddress` tables cannot widen it, and IPv6 must be inside 2000::/3. It names the class it refuses.
- The socket goes to that address with SNI, Host and certificate check on the name.
- Redirects: at most 3, each re-checked, and only to the entry host, its subdomains, or its www / apex twin. There is no
  public-suffix list, and no "registrable domain" guess either: tenants of one shared hosting domain (`*.myshopify.com`,
  `*.github.io`, `*.vercel.app`) cannot redirect the scan into each other. A home page that redirects to a sibling host
  (`www.shop.com` to `store.shop.com`) fails, and the person enters the host the site really lives on.
- All NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4 and Teredo addresses are refused, public embedding or not.
- robots.txt follows RFC 9309 (`*`, `$`, longest match, Allow wins a tie; groups for `NightshiftBrandScan` / `Nightshift`, else
  `*`). It is decoded as UTF-8 with a byte-order mark dropped and parsed whatever its content type. One that cannot be read (5xx,
  too large, compressed, off-site redirect) is read as "disallow everything". Crawl-delay is not waited for.

Not built yet, each waiting on the owner decisions above: the migration (`brand_scans`, the caps), the RPCs, the queue kind and
worker wiring, the extraction, the media library ingest of pictures, and any UI.

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
